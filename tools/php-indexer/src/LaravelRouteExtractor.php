<?php declare(strict_types=1);

namespace Sentinel\PhpIndexer;

use PhpParser\Node;
use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\Node\Scalar\String_;
use PhpParser\Node\Stmt;

final class LaravelRouteExtractor
{
    /** @var list<array<string, mixed>> */
    private array $routes = [];

    public function __construct(
        private readonly string $path,
        private readonly int $maxStringLength,
    ) {
    }

    /** @param list<Stmt> $statements
     *  @return list<array<string, mixed>>
     */
    public function extract(array $statements): array
    {
        $this->walk($statements, [
            'prefix' => '',
            'dynamicPrefix' => false,
            'middleware' => [],
            'routerVariables' => $this->discoverRouterVariables($statements),
        ]);
        return $this->routes;
    }

    /** @param list<Stmt> $statements
     *  @param array{prefix: string, dynamicPrefix: bool, middleware: list<string>, routerVariables: list<string>} $context
     */
    private function walk(array $statements, array $context): void
    {
        foreach ($statements as $statement) {
            if ($statement instanceof Stmt\Expression) {
                $chain = $this->routeChain($statement->expr, $context['routerVariables']);
                if ($chain !== null) {
                    $group = $this->groupClosure($chain);
                    if ($group !== null) {
                        $this->walk(
                            $group['closure']->stmts,
                            $this->groupContext($chain, $context, $group['index'], $group['closure']),
                        );
                        continue;
                    }
                    $route = $this->routeFromChain($chain, $context);
                    if ($route !== null) {
                        $this->routes[] = $route;
                    }
                }
            }
            if ($statement instanceof Stmt\If_) {
                $this->walk($statement->stmts, $context);
                foreach ($statement->elseifs as $elseif) {
                    $this->walk($elseif->stmts, $context);
                }
                if ($statement->else !== null) {
                    $this->walk($statement->else->stmts, $context);
                }
            }
        }
    }

    /** @param list<string> $routerVariables
     *  @return list<array{name: string, args: list<Arg>, node: Expr}>|null
     */
    private function routeChain(Expr $expression, array $routerVariables): ?array
    {
        if ($expression instanceof Expr\Variable
            && is_string($expression->name)
            && in_array($expression->name, $routerVariables, true)) {
            return [];
        }
        if ($expression instanceof Expr\StaticCall) {
            if (!$expression->class instanceof Name || !$expression->name instanceof Identifier) {
                return null;
            }
            $class = Protocol::nameEvidence($expression->class);
            if (strcasecmp($class['resolvedName'], 'Illuminate\\Support\\Facades\\Route') !== 0) {
                return null;
            }
            return [[
                'name' => strtolower($expression->name->toString()),
                'args' => $expression->args,
                'node' => $expression,
            ]];
        }
        if ($expression instanceof Expr\MethodCall && $expression->name instanceof Identifier) {
            $base = $this->routeChain($expression->var, $routerVariables);
            if ($base === null) {
                return null;
            }
            $base[] = [
                'name' => strtolower($expression->name->toString()),
                'args' => $expression->args,
                'node' => $expression,
            ];
            return $base;
        }
        return null;
    }

    /** @param list<array{name: string, args: list<Arg>, node: Expr}> $chain
     *  @return array{index: int, closure: Expr\Closure}|null
     */
    private function groupClosure(array $chain): ?array
    {
        foreach ($chain as $index => $call) {
            if ($call['name'] !== 'group') {
                continue;
            }
            foreach (array_reverse($call['args']) as $argument) {
                if ($argument->value instanceof Expr\Closure) {
                    return ['index' => $index, 'closure' => $argument->value];
                }
            }
        }
        return null;
    }

    /** @param list<array{name: string, args: list<Arg>, node: Expr}> $chain
     *  @param array{prefix: string, dynamicPrefix: bool, middleware: list<string>, routerVariables: list<string>} $context
     *  @return array{prefix: string, dynamicPrefix: bool, middleware: list<string>, routerVariables: list<string>}
     */
    private function groupContext(array $chain, array $context, int $groupIndex, Expr\Closure $closure): array
    {
        $prefix = $context['prefix'];
        $dynamicPrefix = $context['dynamicPrefix'];
        $middleware = $context['middleware'];
        foreach ($chain as $index => $call) {
            if ($index > $groupIndex) {
                break;
            }
            if ($call['name'] === 'prefix') {
                $value = $this->stringArgument($call['args'][0] ?? null);
                if ($value !== null) {
                    $prefix = $this->joinPath($prefix, $value);
                } else {
                    $dynamicPrefix = true;
                }
            }
            if ($call['name'] === 'middleware') {
                array_push($middleware, ...$this->stringListArgument($call['args'][0] ?? null));
            }
            if ($call['name'] === 'group' && isset($call['args'][0]) && $call['args'][0]->value instanceof Expr\Array_) {
                foreach ($call['args'][0]->value->items as $item) {
                    if ($item === null || !$item->key instanceof String_) {
                        continue;
                    }
                    if ($item->key->value === 'prefix' && $item->value instanceof String_) {
                        $prefix = $this->joinPath($prefix, $item->value->value);
                    } elseif ($item->key->value === 'prefix') {
                        $dynamicPrefix = true;
                    }
                    if ($item->key->value === 'middleware') {
                        array_push($middleware, ...$this->stringsFromExpression($item->value));
                    }
                }
            }
        }
        $routerVariables = $context['routerVariables'];
        foreach ($closure->params as $param) {
            if (!is_string($param->var->name)) {
                continue;
            }
            foreach (Protocol::typeNames($param->type) as $type) {
                if ($type['resolvedName'] === 'Illuminate\\Routing\\Router') {
                    $routerVariables[] = $param->var->name;
                }
            }
        }
        return [
            'prefix' => $prefix,
            'dynamicPrefix' => $dynamicPrefix,
            'middleware' => array_values(array_unique($middleware)),
            'routerVariables' => array_values(array_unique($routerVariables)),
        ];
    }

    /** @param list<array{name: string, args: list<Arg>, node: Expr}> $chain
     *  @param array{prefix: string, dynamicPrefix: bool, middleware: list<string>, routerVariables: list<string>} $context
     *  @return array<string, mixed>|null
     */
    private function routeFromChain(array $chain, array $context): ?array
    {
        $httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match'];
        $routeCall = null;
        $routeIndex = null;
        foreach ($chain as $index => $call) {
            if (in_array($call['name'], $httpMethods, true)) {
                $routeCall = $call;
                $routeIndex = $index;
                break;
            }
        }
        if ($routeCall === null || $routeIndex === null) {
            return null;
        }
        $methodEvidence = $this->methods($routeCall['name'], $routeCall['args'][0] ?? null);
        $methods = $methodEvidence['methods'];
        $pathArgumentIndex = $routeCall['name'] === 'match' ? 1 : 0;
        $actionArgumentIndex = $pathArgumentIndex + 1;
        $pathValue = $this->stringArgument($routeCall['args'][$pathArgumentIndex] ?? null);
        $path = $pathValue === null || $context['dynamicPrefix']
            ? null
            : $this->joinPath($context['prefix'], $pathValue);
        $middleware = $context['middleware'];
        $name = null;
        foreach ($chain as $call) {
            if ($call['name'] === 'middleware') {
                array_push($middleware, ...$this->stringListArgument($call['args'][0] ?? null));
            }
            if ($call['name'] === 'name') {
                $name = $this->stringArgument($call['args'][0] ?? null);
            }
        }
        $action = $this->action($routeCall['args'][$actionArgumentIndex] ?? null);
        $range = Protocol::range($routeCall['node']);
        $dynamic = $path === null || $action['dynamic'] || $methodEvidence['dynamic'];
        $route = [
            'id' => Protocol::id('php-route', [
                $this->path,
                $methods,
                $path,
                $action['originalName'],
                $action['resolvedName'] ?? null,
                $range['startFilePos'],
                $range['endFilePos'],
            ]),
            'methods' => $methods,
            'path' => $path,
            'middleware' => array_values(array_unique($middleware)),
            'action' => $action,
            'dynamic' => $dynamic,
            'range' => $range,
        ];
        if ($name !== null) {
            $route['name'] = Protocol::bounded($name, $this->maxStringLength);
        }
        return $route;
    }

    /** @return array{methods: list<string>, dynamic: bool} */
    private function methods(string $method, ?Arg $argument): array
    {
        if ($method === 'any') {
            return ['methods' => ['ANY'], 'dynamic' => false];
        }
        if ($method !== 'match') {
            return ['methods' => [strtoupper($method)], 'dynamic' => false];
        }
        if ($argument === null) {
            return ['methods' => ['ANY'], 'dynamic' => true];
        }
        $rawMethods = $this->stringsFromExpression($argument->value);
        $methods = array_map('strtoupper', $rawMethods);
        $allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
        $methods = array_values(array_unique(array_filter($methods, fn (string $value): bool => in_array($value, $allowed, true))));
        return [
            'methods' => $methods === [] ? ['ANY'] : $methods,
            'dynamic' => $rawMethods === [] || count($methods) !== count($rawMethods),
        ];
    }

    /** @return array{originalName: string, resolvedName?: string, method?: string, dynamic: bool} */
    private function action(?Arg $argument): array
    {
        if ($argument === null) {
            return ['originalName' => 'missing-action', 'dynamic' => true];
        }
        $value = $argument->value;
        if ($value instanceof Expr\ClassConstFetch
            && $value->class instanceof Name
            && $value->name instanceof Identifier
            && strtolower($value->name->toString()) === 'class') {
            $name = Protocol::nameEvidence($value->class);
            return [
                'originalName' => $name['originalName'],
                'resolvedName' => $name['resolvedName'],
                'dynamic' => false,
            ];
        }
        if ($value instanceof Expr\Array_ && count($value->items) === 2) {
            $classItem = $value->items[0]?->value;
            $methodItem = $value->items[1]?->value;
            if ($classItem instanceof Expr\ClassConstFetch
                && $classItem->class instanceof Name
                && $classItem->name instanceof Identifier
                && strtolower($classItem->name->toString()) === 'class'
                && $methodItem instanceof String_) {
                $name = Protocol::nameEvidence($classItem->class);
                return [
                    'originalName' => $name['originalName'],
                    'resolvedName' => $name['resolvedName'],
                    'method' => Protocol::bounded($methodItem->value, $this->maxStringLength),
                    'dynamic' => false,
                ];
            }
        }
        if ($value instanceof String_) {
            return [
                'originalName' => Protocol::bounded($value->value, $this->maxStringLength),
                'dynamic' => true,
            ];
        }
        return ['originalName' => 'dynamic-action:' . $value->getType(), 'dynamic' => true];
    }

    private function stringArgument(?Arg $argument): ?string
    {
        return $argument?->value instanceof String_
            ? Protocol::bounded($argument->value->value, $this->maxStringLength)
            : null;
    }

    /** @return list<string> */
    private function stringListArgument(?Arg $argument): array
    {
        return $argument === null ? [] : $this->stringsFromExpression($argument->value);
    }

    /** @return list<string> */
    private function stringsFromExpression(Expr $expression): array
    {
        if ($expression instanceof String_) {
            return [Protocol::bounded($expression->value, $this->maxStringLength)];
        }
        if ($expression instanceof Expr\Array_) {
            $values = [];
            foreach ($expression->items as $item) {
                if ($item?->value instanceof String_) {
                    $values[] = Protocol::bounded($item->value->value, $this->maxStringLength);
                }
            }
            return $values;
        }
        return [];
    }

    private function joinPath(string $prefix, string $path): string
    {
        $segments = array_filter(
            array_merge(explode('/', trim($prefix, '/')), explode('/', trim($path, '/'))),
            static fn (string $segment): bool => $segment !== '',
        );
        return Protocol::bounded('/' . implode('/', $segments), $this->maxStringLength);
    }

    /** @param list<Stmt> $statements
     *  @return list<string>
     */
    private function discoverRouterVariables(array $statements): array
    {
        $variables = [];
        foreach ($statements as $statement) {
            if (!$statement instanceof Stmt\Expression
                || !$statement->expr instanceof Expr\Assign
                || !$statement->expr->var instanceof Expr\Variable
                || !is_string($statement->expr->var->name)
                || !$statement->expr->expr instanceof Expr\MethodCall
                || !$statement->expr->expr->name instanceof Identifier
                || strtolower($statement->expr->expr->name->toString()) !== 'get') {
                continue;
            }
            $argument = $statement->expr->expr->args[0] ?? null;
            $receiver = $statement->expr->expr->var;
            if (!$argument?->value instanceof String_
                || strtolower($argument->value->value) !== 'router'
                || !$receiver instanceof Expr\FuncCall
                || !$receiver->name instanceof Name
                || strtolower($receiver->name->toString()) !== 'app') {
                continue;
            }
            $variables[] = $statement->expr->var->name;
        }
        return array_values(array_unique($variables));
    }
}
