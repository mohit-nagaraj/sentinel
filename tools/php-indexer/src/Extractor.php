<?php declare(strict_types=1);

namespace Sentinel\PhpIndexer;

use Composer\InstalledVersions;
use PhpParser\Error;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\ParserFactory;
use Throwable;

final class Extractor
{
    /** @param array<string, mixed> $request
     *  @return array<string, mixed>
     */
    public function extract(array $request): array
    {
        [$root, $files, $limits, $sourceIdentity] = $this->validateRequest($request);
        Protocol::configureSource($sourceIdentity);
        $parser = (new ParserFactory())->createForNewestSupportedVersion();
        $results = [];
        $totalBytes = 0;
        $totalFacts = 0;

        foreach ($files as $path) {
            $absolute = $this->safeFile($root, $path);
            $size = filesize($absolute);
            if (!is_int($size) || $size > $limits['maxFileBytes']) {
                throw new IndexerException('limit_exceeded');
            }
            $source = file_get_contents($absolute, false, null, 0, $limits['maxFileBytes'] + 1);
            if (!is_string($source)) {
                throw new IndexerException('read_error');
            }
            $actualSize = strlen($source);
            if ($actualSize > $limits['maxFileBytes']) {
                throw new IndexerException('limit_exceeded');
            }
            $totalBytes += $actualSize;
            if ($totalBytes > $limits['maxTotalBytes']) {
                throw new IndexerException('limit_exceeded');
            }
            if (str_starts_with($source, "\xEF\xBB\xBF")) {
                $source = substr($source, 3);
            }
            $file = [
                'path' => $path,
                'contentHash' => 'sha256:' . hash('sha256', $source),
                'symbols' => [],
                'relationships' => [],
                'routes' => [],
                'errors' => [],
            ];
            try {
                $ast = $parser->parse($source);
                if ($ast === null) {
                    $ast = [];
                }
                $resolver = new NodeTraverser(new NameResolver(null, [
                    'preserveOriginalNames' => true,
                    'replaceNodes' => true,
                ]));
                $resolvedAst = $resolver->traverse($ast);
                $visitor = new StructuralVisitor($path, $limits['maxStringLength']);
                (new NodeTraverser($visitor))->traverse($resolvedAst);
                $file['symbols'] = $visitor->symbols();
                $file['relationships'] = $visitor->relationships();
                $file['routes'] = (new LaravelRouteExtractor($path, $limits['maxStringLength']))->extract($resolvedAst);
            } catch (Error $error) {
                $file['errors'][] = [
                    'code' => 'parse_error',
                    'message' => 'PHP parser rejected this file',
                    'line' => max(1, $error->getStartLine()),
                ];
            } catch (IndexerException $error) {
                throw $error;
            } catch (Throwable) {
                $file['errors'][] = [
                    'code' => 'extraction_error',
                    'message' => 'PHP structural extraction failed for this file',
                ];
            }
            $this->sortFile($file);
            $totalFacts += count($file['symbols']) + count($file['relationships']) + count($file['routes']);
            if ($totalFacts > $limits['maxFacts']) {
                throw new IndexerException('limit_exceeded');
            }
            $results[] = $file;
        }

        $this->linkTargets($results);
        return $this->response($results, $sourceIdentity);
    }

    /** @param array<string, mixed> $request
     *  @return array{string, list<string>, array{maxFiles: int, maxFileBytes: int, maxTotalBytes: int, maxPathDepth: int, maxFacts: int, maxStringLength: int, maxRequestBytes: int, timeoutMs: int}, array{applicationId: string, repository: array{host: string, owner: string, name: string}, commitSha: string}}
     */
    private function validateRequest(array $request): array
    {
        if (($request['schemaVersion'] ?? null) !== 1 || !is_string($request['root'] ?? null) || !is_array($request['files'] ?? null) || !is_array($request['limits'] ?? null) || !is_array($request['source'] ?? null)) {
            throw new IndexerException('invalid_input');
        }
        $sourceIdentity = $this->validateSourceIdentity($request['source']);
        $root = realpath($request['root']);
        if ($root === false || !is_dir($root) || is_link($root)) {
            throw new IndexerException('unsafe_path');
        }
        $limits = [];
        $maximums = [
            'maxFiles' => 10_000,
            'maxFileBytes' => 16 * 1024 * 1024,
            'maxTotalBytes' => 256 * 1024 * 1024,
            'maxPathDepth' => 128,
            'maxFacts' => 1_000_000,
            'maxStringLength' => 1_024,
            'maxRequestBytes' => 4 * 1024 * 1024,
            'timeoutMs' => 10 * 60_000,
        ];
        foreach ($maximums as $name => $maximum) {
            $value = $request['limits'][$name] ?? null;
            if (!is_int($value) || $value < 1 || $value > $maximum) {
                throw new IndexerException('invalid_input');
            }
            $limits[$name] = $value;
        }
        if ($limits['maxFileBytes'] > $limits['maxTotalBytes']) {
            throw new IndexerException('invalid_input');
        }
        if (count($request['files']) < 1 || count($request['files']) > $limits['maxFiles']) {
            throw new IndexerException('limit_exceeded');
        }
        $files = [];
        foreach ($request['files'] as $path) {
            if (!is_string($path)) {
                throw new IndexerException('invalid_input');
            }
            $this->validatePath($path, $limits['maxPathDepth']);
            $files[$path] = true;
        }
        if (count($files) !== count($request['files'])) {
            throw new IndexerException('invalid_input');
        }
        $paths = array_keys($files);
        sort($paths, SORT_STRING);
        return [$root, $paths, $limits, $sourceIdentity];
    }

    private function validatePath(string $path, int $maxDepth): void
    {
        if ($path === '' || strlen($path) > 2048 || str_contains($path, "\0") || str_contains($path, '\\')
            || str_starts_with($path, '/') || preg_match('/^[A-Za-z]:/', $path) === 1 || !str_ends_with(strtolower($path), '.php')) {
            throw new IndexerException('unsafe_path');
        }
        $segments = explode('/', $path);
        if (count($segments) > $maxDepth) {
            throw new IndexerException('limit_exceeded');
        }
        foreach ($segments as $segment) {
            if ($segment === '' || $segment === '.' || $segment === '..' || str_ends_with($segment, '.') || str_ends_with($segment, ' ')
                || preg_match('/[<>:"|?*\x00-\x1F\x7F]/', $segment) === 1) {
                throw new IndexerException('unsafe_path');
            }
        }
    }

    private function safeFile(string $root, string $path): string
    {
        $candidate = $root;
        foreach (explode('/', $path) as $segment) {
            $candidate .= DIRECTORY_SEPARATOR . $segment;
            if (is_link($candidate)) {
                throw new IndexerException('unsafe_path');
            }
        }
        $resolved = realpath($candidate);
        if ($resolved === false || !is_file($resolved)) {
            throw new IndexerException('unsafe_path');
        }
        $rootPrefix = rtrim(str_replace('\\', '/', $root), '/') . '/';
        $normalized = str_replace('\\', '/', $resolved);
        if (!str_starts_with(strtolower($normalized . '/'), strtolower($rootPrefix))) {
            throw new IndexerException('unsafe_path');
        }
        return $resolved;
    }

    /** @param array<string, mixed> $file */
    private function sortFile(array &$file): void
    {
        $sort = static fn (array $left, array $right): int => [$left['range']['startFilePos'], $left['id']] <=> [$right['range']['startFilePos'], $right['id']];
        foreach ($file['symbols'] as &$symbol) {
            usort(
                $symbol['declarationRanges'],
                static fn (array $left, array $right): int => [$left['startFilePos'], $left['endFilePos']] <=> [$right['startFilePos'], $right['endFilePos']],
            );
        }
        unset($symbol);
        usort($file['symbols'], $sort);
        usort($file['relationships'], $sort);
        usort($file['routes'], $sort);
    }

    /** @param list<array<string, mixed>> $files */
    private function linkTargets(array &$files): void
    {
        $symbols = [];
        foreach ($files as $file) {
            foreach ($file['symbols'] as $symbol) {
                $symbols[strtolower($symbol['qualifiedName'])] = $symbol['id'];
            }
        }
        $parents = [];
        foreach ($files as &$file) {
            foreach ($file['relationships'] as &$relationship) {
                $target = $relationship['resolvedTarget'] ?? null;
                if (is_string($target) && isset($symbols[strtolower($target)])) {
                    $relationship['targetSymbolId'] = $symbols[strtolower($target)];
                }
                if ($relationship['kind'] === 'extends' && is_string($target)) {
                    $parents[$relationship['sourceSymbolId']] = $target;
                }
            }
            unset($relationship);
        }
        unset($file);

        $rolesById = [];
        foreach ($files as &$file) {
            foreach ($file['symbols'] as &$symbol) {
                if ($this->inheritsFrom($symbol['id'], 'Illuminate\\Foundation\\Http\\FormRequest', $parents, $symbols, [])) {
                    $symbol['role'] = 'form_request';
                } elseif ($this->inheritsFrom($symbol['id'], 'Illuminate\\Http\\Resources\\Json\\JsonResource', $parents, $symbols, [])) {
                    $symbol['role'] = 'json_resource';
                }
                $rolesById[$symbol['id']] = $symbol['role'];
            }
            unset($symbol);
        }
        unset($file);

        $associationSources = ['constructor_dependency', 'parameter_type', 'return_type', 'property_type', 'instantiates'];
        foreach ($files as &$file) {
            $associations = [];
            foreach ($file['relationships'] as $relationship) {
                $targetId = $relationship['targetSymbolId'] ?? null;
                $role = is_string($targetId) ? ($rolesById[$targetId] ?? null) : null;
                if (!in_array($relationship['kind'], $associationSources, true)
                    || ($role !== 'form_request' && $role !== 'json_resource')) {
                    continue;
                }
                $association = $relationship;
                $association['kind'] = $role;
                $association['id'] = Protocol::id('php-relationship', [
                    $file['path'],
                    $association['sourceSymbolId'],
                    $role,
                    $association['originalTarget'],
                    $association['resolvedTarget'] ?? null,
                    $association['range']['startFilePos'],
                    $association['range']['endFilePos'],
                ]);
                $associations[] = $association;
            }
            array_push($file['relationships'], ...$associations);
            foreach ($file['routes'] as &$route) {
                $target = $route['action']['resolvedName'] ?? null;
                $method = $route['action']['method'] ?? null;
                if (is_string($target) && is_string($method) && isset($symbols[strtolower($target . '::' . $method)])) {
                    $route['action']['targetSymbolId'] = $symbols[strtolower($target . '::' . $method)];
                } elseif (is_string($target) && $method === null && isset($symbols[strtolower($target . '::__invoke')])) {
                    $route['action']['targetSymbolId'] = $symbols[strtolower($target . '::__invoke')];
                } elseif (is_string($target) && $method === null && isset($symbols[strtolower($target)])) {
                    $route['action']['targetSymbolId'] = $symbols[strtolower($target)];
                }
            }
            unset($route);
            $this->sortFile($file);
        }
        unset($file);
    }

    /** @param array<string, string> $parents
     *  @param array<string, string> $symbols
     *  @param array<string, true> $visited
     */
    private function inheritsFrom(string $symbolId, string $baseName, array $parents, array $symbols, array $visited): bool
    {
        if (isset($visited[$symbolId])) {
            return false;
        }
        $visited[$symbolId] = true;
        $parent = $parents[$symbolId] ?? null;
        if (!is_string($parent)) {
            return false;
        }
        if (strcasecmp($parent, $baseName) === 0) {
            return true;
        }
        $parentId = $symbols[strtolower($parent)] ?? null;
        return is_string($parentId)
            && $this->inheritsFrom($parentId, $baseName, $parents, $symbols, $visited);
    }

    /** @param list<array<string, mixed>> $files
     *  @return array<string, mixed>
     */
    private function response(array $files, array $sourceIdentity): array
    {
        $summary = [
            'fileCount' => count($files),
            'symbolCount' => 0,
            'relationshipCount' => 0,
            'routeCount' => 0,
            'errorCount' => 0,
        ];
        foreach ($files as $file) {
            $summary['symbolCount'] += count($file['symbols']);
            $summary['relationshipCount'] += count($file['relationships']);
            $summary['routeCount'] += count($file['routes']);
            $summary['errorCount'] += count($file['errors']);
        }
        return [
            'schemaVersion' => 1,
            'source' => $sourceIdentity,
            'parser' => [
                'name' => 'nikic/php-parser',
                'version' => ltrim(InstalledVersions::getPrettyVersion('nikic/php-parser') ?? '0.0.0', 'v'),
            ],
            'files' => $files,
            'summary' => $summary,
        ];
    }

    /** @param array<string, mixed> $source
     *  @return array{applicationId: string, repository: array{host: string, owner: string, name: string}, commitSha: string}
     */
    private function validateSourceIdentity(array $source): array
    {
        $applicationId = $source['applicationId'] ?? null;
        $repository = $source['repository'] ?? null;
        $commitSha = $source['commitSha'] ?? null;
        if (!is_string($applicationId)
            || preg_match('/^application:v1:[a-f0-9]{64}$/', $applicationId) !== 1
            || !is_array($repository)
            || !is_string($commitSha)
            || preg_match('/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/', $commitSha) !== 1) {
            throw new IndexerException('invalid_input');
        }
        $host = $repository['host'] ?? null;
        $owner = $repository['owner'] ?? null;
        $name = $repository['name'] ?? null;
        if (!is_string($host) || !is_string($owner) || !is_string($name)
            || $host === '' || strlen($host) > 253
            || $owner === '' || strlen($owner) > 100
            || $name === '' || strlen($name) > 100
            || strtolower($host) !== $host) {
            throw new IndexerException('invalid_input');
        }
        return [
            'applicationId' => $applicationId,
            'repository' => ['host' => $host, 'owner' => $owner, 'name' => $name],
            'commitSha' => $commitSha,
        ];
    }
}
