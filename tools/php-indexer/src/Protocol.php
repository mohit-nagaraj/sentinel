<?php declare(strict_types=1);

namespace Sentinel\PhpIndexer;

use PhpParser\Node;
use PhpParser\Node\ComplexType;
use PhpParser\Node\Identifier;
use PhpParser\Node\IntersectionType;
use PhpParser\Node\Name;
use PhpParser\Node\NullableType;
use PhpParser\Node\UnionType;

final class Protocol
{
    /** @var array{applicationId: string, repository: array{host: string, owner: string, name: string}, commitSha: string}|null */
    private static ?array $sourceIdentity = null;

    /** @param array{applicationId: string, repository: array{host: string, owner: string, name: string}, commitSha: string} $sourceIdentity */
    public static function configureSource(array $sourceIdentity): void
    {
        self::$sourceIdentity = $sourceIdentity;
    }

    /** @return array{startLine: int, endLine: int, startFilePos: int, endFilePos: int, startTokenPos: int, endTokenPos: int} */
    public static function range(Node $node): array
    {
        return [
            'startLine' => max(1, $node->getStartLine()),
            'endLine' => max(1, $node->getEndLine()),
            'startFilePos' => max(0, $node->getStartFilePos()),
            'endFilePos' => max(0, $node->getEndFilePos()),
            'startTokenPos' => max(0, $node->getStartTokenPos()),
            'endTokenPos' => max(0, $node->getEndTokenPos()),
        ];
    }

    /** @param list<string|int|bool|null> $parts */
    public static function id(string $kind, array $parts): string
    {
        if (self::$sourceIdentity === null) {
            throw new IndexerException('process_failed');
        }
        $encoded = self::canonicalSerialize([
            'parts' => $parts,
            'source' => self::$sourceIdentity,
        ]);
        return sprintf('%s:v1:%s', $kind, hash('sha256', $encoded));
    }

    public static function codeSymbolId(string $path, string $qualifiedName, string $symbolKind): string
    {
        if (self::$sourceIdentity === null) {
            throw new IndexerException('process_failed');
        }
        $identity = [
            'kind' => 'code-symbol',
            'applicationId' => self::$sourceIdentity['applicationId'],
            'repository' => self::$sourceIdentity['repository'],
            'commitSha' => self::$sourceIdentity['commitSha'],
            'filePath' => $path,
            'qualifiedName' => $qualifiedName,
            'symbolKind' => $symbolKind,
        ];
        return 'code-symbol:v1:' . hash('sha256', self::canonicalSerialize([
            'identity' => $identity,
            'kind' => 'code-symbol',
            'version' => 1,
        ]));
    }

    /** @return array{originalName: string, resolvedName: string} */
    public static function nameEvidence(Name $name): array
    {
        $original = $name->getAttribute('originalName');
        $originalName = $original instanceof Name ? $original->toString() : $name->toString();
        $namespaced = $name->getAttribute('namespacedName');
        $resolvedName = $namespaced instanceof Name ? $namespaced->toString() : $name->toString();
        return [
            'originalName' => ltrim($originalName, '\\'),
            'resolvedName' => ltrim($resolvedName, '\\'),
        ];
    }

    /** @return list<array{originalName: string, resolvedName: string}> */
    public static function typeNames(Node|Identifier|Name|ComplexType|null $type): array
    {
        if ($type instanceof Name) {
            return [self::nameEvidence($type)];
        }
        if ($type instanceof NullableType) {
            return self::typeNames($type->type);
        }
        if ($type instanceof UnionType || $type instanceof IntersectionType) {
            $names = [];
            foreach ($type->types as $inner) {
                array_push($names, ...self::typeNames($inner));
            }
            return $names;
        }
        return [];
    }

    public static function role(string $qualifiedName): string
    {
        $normalized = ltrim($qualifiedName, '\\');
        return match (true) {
            str_ends_with($normalized, 'Action') => 'action',
            str_ends_with($normalized, 'Controller') => 'controller',
            str_ends_with($normalized, 'Handler') => 'handler',
            str_ends_with($normalized, 'Service') => 'service',
            str_ends_with($normalized, 'Repository') => 'repository',
            str_contains($normalized, '\\Models\\') || str_ends_with($normalized, 'Model') => 'model',
            default => 'other',
        };
    }

    public static function isDomainName(string $qualifiedName): bool
    {
        return str_contains($qualifiedName, '\\Domain\\')
            || str_contains($qualifiedName, '\\Models\\')
            || str_ends_with($qualifiedName, 'Model');
    }

    public static function bounded(string $value, int $maxLength): string
    {
        if ($value === '' || strlen($value) > $maxLength || preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', $value) === 1) {
            throw new IndexerException('limit_exceeded');
        }
        return $value;
    }

    private static function canonicalSerialize(mixed $value): string
    {
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_int($value)) {
            return (string) $value;
        }
        if (is_string($value)) {
            return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        if (!is_array($value)) {
            throw new IndexerException('process_failed');
        }
        if (array_is_list($value)) {
            return '[' . implode(',', array_map(self::canonicalSerialize(...), $value)) . ']';
        }
        ksort($value, SORT_STRING);
        $properties = [];
        foreach ($value as $key => $child) {
            $properties[] = self::canonicalSerialize((string) $key) . ':' . self::canonicalSerialize($child);
        }
        return '{' . implode(',', $properties) . '}';
    }
}
