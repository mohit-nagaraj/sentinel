<?php declare(strict_types=1);

namespace Sentinel\PhpIndexer;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\Node\Name\FullyQualified;
use PhpParser\Node\Param;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;

final class StructuralVisitor extends NodeVisitorAbstract
{
    /** @var list<array<string, mixed>> */
    private array $symbols = [];

    /** @var list<array<string, mixed>> */
    private array $relationships = [];

    /** @var list<string> */
    private array $scopeStack = [];

    /** @var list<array{id: string, name: string, parent: ?array, propertyTypes: array<string, array{originalName: string, resolvedName: string}>}> */
    private array $classStack = [];

    /** @var list<array{variables: array<string, array{originalName: string, resolvedName: string}>}> */
    private array $functionStack = [];

    /** @var array<int, true> */
    private array $pushedScopes = [];

    /** @var array<int, true> */
    private array $pushedFunctionContexts = [];

    private ?string $namespaceSymbolId = null;

    public function __construct(
        private readonly string $path,
        private readonly int $maxStringLength,
    ) {
    }

    /** @return list<array<string, mixed>> */
    public function symbols(): array
    {
        return $this->symbols;
    }

    /** @return list<array<string, mixed>> */
    public function relationships(): array
    {
        return $this->relationships;
    }

    public function enterNode(Node $node): int|null
    {
        if ($node instanceof Stmt\Namespace_) {
            $this->enterNamespace($node);
            return null;
        }
        if ($node instanceof Stmt\Use_ || $node instanceof Stmt\GroupUse) {
            $this->addImports($node);
            return null;
        }
        if ($node instanceof Stmt\ClassLike) {
            if ($node->name === null) {
                return NodeTraverser::DONT_TRAVERSE_CHILDREN;
            }
            $this->enterClassLike($node);
            return null;
        }
        if ($node instanceof Stmt\Function_) {
            $qualifiedName = $node->namespacedName?->toString() ?? $node->name->toString();
            $id = $this->addSymbol($node, 'function', $qualifiedName, $node->name->toString());
            $this->pushScope($node, $id);
            $this->pushFunctionContext($node, $this->parameterTypes($node->params));
            $this->addAttributes($id, $node->attrGroups);
            $this->addTypeRelationships($id, $node->returnType, 'return_type', $node);
            return null;
        }
        if ($node instanceof Stmt\ClassMethod) {
            $this->enterMethod($node);
            return null;
        }
        if ($node instanceof Expr\Closure || $node instanceof Expr\ArrowFunction) {
            $this->enterAnonymousFunction($node);
            return null;
        }
        if ($node instanceof Stmt\Property) {
            $this->addProperties($node);
            return null;
        }
        if ($node instanceof Stmt\TraitUse) {
            $source = $this->currentClass()['id'] ?? null;
            if (is_string($source)) {
                foreach ($node->traits as $trait) {
                    $this->addNameRelationship($source, 'uses_trait', Protocol::nameEvidence($trait), $trait);
                }
            }
            return null;
        }
        if ($node instanceof Expr\Assign) {
            $this->learnAssignment($node);
            return null;
        }
        if ($node instanceof Expr\MethodCall || $node instanceof Expr\NullsafeMethodCall) {
            $this->addMethodCall($node);
            return null;
        }
        if ($node instanceof Expr\StaticCall) {
            $this->addStaticCall($node);
            return null;
        }
        if ($node instanceof Expr\FuncCall) {
            $this->addFunctionCall($node);
            return null;
        }
        if ($node instanceof Expr\New_) {
            $this->addInstantiation($node);
            return null;
        }
        if ($node instanceof Expr\ClassConstFetch && $node->class instanceof Name) {
            $source = $this->currentSource();
            if ($source !== null) {
                $this->addNameRelationship($source, 'references', Protocol::nameEvidence($node->class), $node);
            }
        }
        return null;
    }

    public function leaveNode(Node $node): null
    {
        $objectId = spl_object_id($node);
        if (isset($this->pushedScopes[$objectId])) {
            array_pop($this->scopeStack);
            unset($this->pushedScopes[$objectId]);
            if ($node instanceof Stmt\ClassLike) {
                array_pop($this->classStack);
            }
        }
        if (isset($this->pushedFunctionContexts[$objectId])) {
            array_pop($this->functionStack);
            unset($this->pushedFunctionContexts[$objectId]);
        }
        if ($node instanceof Stmt\Namespace_) {
            $this->namespaceSymbolId = null;
        }
        return null;
    }

    private function enterNamespace(Stmt\Namespace_ $node): void
    {
        if ($node->name === null) {
            $this->namespaceSymbolId = null;
            return;
        }
        $name = $node->name->toString();
        $this->namespaceSymbolId = $this->addSymbol($node, 'namespace', $name, $name, null);
    }

    private function addImports(Stmt\Use_|Stmt\GroupUse $node): void
    {
        foreach ($node->uses as $use) {
            $name = $node instanceof Stmt\GroupUse
                ? Name::concat($node->prefix, $use->name)->toString()
                : $use->name->toString();
            $alias = $use->alias?->toString() ?? $use->name->getLast();
            $kind = match ($use->type === Stmt\Use_::TYPE_UNKNOWN ? $node->type : $use->type) {
                Stmt\Use_::TYPE_FUNCTION => 'function',
                Stmt\Use_::TYPE_CONSTANT => 'constant',
                default => 'class',
            };
            $qualified = sprintf('%s import %s as %s', $kind, $name, $alias);
            $this->addSymbol($use, 'import', $qualified, $name, $this->namespaceSymbolId);
        }
    }

    private function enterClassLike(Stmt\ClassLike $node): void
    {
        if ($node->name === null) {
            return;
        }
        $qualifiedName = $node->namespacedName?->toString() ?? $node->name->toString();
        $kind = match (true) {
            $node instanceof Stmt\Interface_ => 'interface',
            $node instanceof Stmt\Trait_ => 'trait',
            $node instanceof Stmt\Enum_ => 'enum',
            default => 'class',
        };
        $id = $this->addSymbol($node, $kind, $qualifiedName, $node->name->toString());
        $parent = null;
        if ($node instanceof Stmt\Class_ && $node->extends !== null) {
            $parent = Protocol::nameEvidence($node->extends);
            $this->addNameRelationship($id, 'extends', $parent, $node->extends);
        }
        if ($node instanceof Stmt\Class_) {
            foreach ($node->implements as $interface) {
                $this->addNameRelationship($id, 'implements', Protocol::nameEvidence($interface), $interface);
            }
        }
        if ($node instanceof Stmt\Interface_) {
            foreach ($node->extends as $interface) {
                $this->addNameRelationship($id, 'extends', Protocol::nameEvidence($interface), $interface);
            }
        }
        if ($node instanceof Stmt\Enum_) {
            foreach ($node->implements as $interface) {
                $this->addNameRelationship($id, 'implements', Protocol::nameEvidence($interface), $interface);
            }
        }
        $this->addAttributes($id, $node->attrGroups);
        $this->classStack[] = [
            'id' => $id,
            'name' => $qualifiedName,
            'parent' => $parent,
            'propertyTypes' => $this->collectPropertyTypes($node),
        ];
        $this->pushScope($node, $id);
    }

    private function enterMethod(Stmt\ClassMethod $node): void
    {
        $class = $this->currentClass();
        if ($class === null) {
            return;
        }
        $methodName = $node->name->toString();
        $id = $this->addSymbol($node, 'method', $class['name'] . '::' . $methodName, $methodName, $class['id']);
        $this->pushScope($node, $id);
        $variables = $this->parameterTypes($node->params);
        $this->pushFunctionContext($node, $variables);
        $dependencyKind = strtolower($methodName) === '__construct' ? 'constructor_dependency' : 'parameter_type';
        foreach ($node->params as $param) {
            if ($param->flags !== 0 && is_string($param->var->name)) {
                $propertyName = $param->var->name;
                $propertyId = $this->addSymbol(
                    $param,
                    'property',
                    $class['name'] . '::$' . $propertyName,
                    '$' . $propertyName,
                    $class['id'],
                    $param,
                );
                $this->addTypeRelationships($propertyId, $param->type, 'property_type', $param);
                $this->addAttributes($propertyId, $param->attrGroups);
            }
            $this->addTypeRelationships($id, $param->type, $dependencyKind, $param);
        }
        $this->addTypeRelationships($id, $node->returnType, 'return_type', $node);
        $this->addAttributes($id, $node->attrGroups);
    }

    private function addProperties(Stmt\Property $node): void
    {
        $class = $this->currentClass();
        if ($class === null) {
            return;
        }
        foreach ($node->props as $property) {
            $name = $property->name->toString();
            $id = $this->addSymbol($property, 'property', $class['name'] . '::$' . $name, '$' . $name, $class['id'], $node);
            $this->addTypeRelationships($id, $node->type, 'property_type', $node);
            $this->addAttributes($id, $node->attrGroups);
        }
    }

    private function enterAnonymousFunction(Expr\Closure|Expr\ArrowFunction $node): void
    {
        $outerVariables = $this->currentFunction()['variables'];
        $variables = $node instanceof Expr\ArrowFunction ? $outerVariables : [];
        if ($node instanceof Expr\Closure) {
            foreach ($node->uses as $use) {
                if (is_string($use->var->name) && isset($outerVariables[$use->var->name])) {
                    $variables[$use->var->name] = $outerVariables[$use->var->name];
                }
            }
        }
        foreach ($node->params as $param) {
            if (is_string($param->var->name)) {
                unset($variables[$param->var->name]);
            }
        }
        foreach ($this->parameterTypes($node->params) as $name => $type) {
            $variables[$name] = $type;
        }
        $this->pushFunctionContext($node, $variables);
    }

    /** @param list<Param> $params
     *  @return array<string, array{originalName: string, resolvedName: string}>
     */
    private function parameterTypes(array $params): array
    {
        $types = [];
        foreach ($params as $param) {
            if (!is_string($param->var->name)) {
                continue;
            }
            $names = Protocol::typeNames($param->type);
            if (count($names) === 1) {
                $types[$param->var->name] = $names[0];
            }
        }
        return $types;
    }

    /** @return array<string, array{originalName: string, resolvedName: string}> */
    private function collectPropertyTypes(Stmt\ClassLike $class): array
    {
        $types = [];
        foreach ($class->stmts as $statement) {
            if ($statement instanceof Stmt\Property) {
                $names = Protocol::typeNames($statement->type);
                if (count($names) === 1) {
                    foreach ($statement->props as $property) {
                        $types[$property->name->toString()] = $names[0];
                    }
                }
            }
            if ($statement instanceof Stmt\ClassMethod && strtolower($statement->name->toString()) === '__construct') {
                foreach ($statement->params as $param) {
                    if ($param->flags === 0 || !is_string($param->var->name)) {
                        continue;
                    }
                    $names = Protocol::typeNames($param->type);
                    if (count($names) === 1) {
                        $types[$param->var->name] = $names[0];
                    }
                }
            }
        }
        return $types;
    }

    private function learnAssignment(Expr\Assign $node): void
    {
        $classIndex = array_key_last($this->classStack);
        if ($classIndex === null
            || !$node->var instanceof Expr\PropertyFetch
            || !$node->var->var instanceof Expr\Variable
            || $node->var->var->name !== 'this'
            || !$node->var->name instanceof Identifier) {
            return;
        }
        $type = null;
        if ($node->expr instanceof Expr\Variable && is_string($node->expr->name)) {
            $type = $this->currentFunction()['variables'][$node->expr->name] ?? null;
        } elseif ($node->expr instanceof Expr\New_ && $node->expr->class instanceof Name) {
            $type = Protocol::nameEvidence($node->expr->class);
        }
        if ($type !== null) {
            $this->classStack[$classIndex]['propertyTypes'][$node->var->name->toString()] = $type;
        }
    }

    private function addMethodCall(Expr\MethodCall|Expr\NullsafeMethodCall $node): void
    {
        $source = $this->currentSource();
        if ($source === null) {
            return;
        }
        $method = $node->name instanceof Identifier ? $node->name->toString() : null;
        $class = $this->resolveExpressionClass($node->var);
        if ($method === null || $class === null) {
            $label = $method === null ? 'dynamic-method' : 'dynamic-method:' . $method;
            $this->addRelationship($source, 'unresolved_dynamic', $label, null, $node, true, $method);
            return;
        }
        $this->addRelationship(
            $source,
            'calls',
            $class['originalName'] . '::' . $method,
            $class['resolvedName'] . '::' . $method,
            $node,
            false,
            $method,
        );
    }

    private function addStaticCall(Expr\StaticCall $node): void
    {
        $source = $this->currentSource();
        $method = $node->name instanceof Identifier ? $node->name->toString() : null;
        if ($source === null) {
            return;
        }
        if (!$node->class instanceof Name || $method === null) {
            $this->addRelationship($source, 'unresolved_dynamic', 'dynamic-static-call', null, $node, true, $method);
            return;
        }
        $class = $this->normalizeSelfReference(Protocol::nameEvidence($node->class));
        $this->addRelationship(
            $source,
            'static_calls',
            $class['originalName'] . '::' . $method,
            $class['resolvedName'] . '::' . $method,
            $node,
            false,
            $method,
        );
    }

    private function addFunctionCall(Expr\FuncCall $node): void
    {
        $source = $this->currentSource();
        if ($source === null) {
            return;
        }
        if (!$node->name instanceof Name || !$node->name instanceof FullyQualified) {
            $name = $node->name instanceof Name ? $node->name->toString() : 'dynamic-function';
            $this->addRelationship($source, 'unresolved_dynamic', 'function:' . $name, null, $node, true);
            return;
        }
        $target = Protocol::nameEvidence($node->name);
        $this->addNameRelationship($source, 'calls', $target, $node);
    }

    private function addInstantiation(Expr\New_ $node): void
    {
        $source = $this->currentSource();
        if ($source === null) {
            return;
        }
        if (!$node->class instanceof Name) {
            $this->addRelationship($source, 'unresolved_dynamic', 'dynamic-new', null, $node, true);
            return;
        }
        $this->addNameRelationship(
            $source,
            'instantiates',
            $this->normalizeSelfReference(Protocol::nameEvidence($node->class)),
            $node,
        );
    }

    /** @return array{originalName: string, resolvedName: string}|null */
    private function resolveExpressionClass(Expr $expression): ?array
    {
        if ($expression instanceof Expr\Variable && is_string($expression->name)) {
            if ($expression->name === 'this') {
                $class = $this->currentClass();
                return $class === null ? null : ['originalName' => 'self', 'resolvedName' => $class['name']];
            }
            return $this->currentFunction()['variables'][$expression->name] ?? null;
        }
        if ($expression instanceof Expr\PropertyFetch
            && $expression->var instanceof Expr\Variable
            && $expression->var->name === 'this'
            && $expression->name instanceof Identifier) {
            return $this->currentClass()['propertyTypes'][$expression->name->toString()] ?? null;
        }
        if ($expression instanceof Expr\New_ && $expression->class instanceof Name) {
            return $this->normalizeSelfReference(Protocol::nameEvidence($expression->class));
        }
        return null;
    }

    /** @param array{originalName: string, resolvedName: string} $target
     *  @return array{originalName: string, resolvedName: string}
     */
    private function normalizeSelfReference(array $target): array
    {
        $name = strtolower($target['resolvedName']);
        $class = $this->currentClass();
        if ($class === null) {
            return $target;
        }
        if ($name === 'self' || $name === 'static') {
            $target['resolvedName'] = $class['name'];
        } elseif ($name === 'parent' && $class['parent'] !== null) {
            $target['resolvedName'] = $class['parent']['resolvedName'];
        }
        return $target;
    }

    private function addTypeRelationships(string $source, Node|Identifier|Name|null $type, string $kind, Node $rangeNode): void
    {
        foreach (Protocol::typeNames($type) as $name) {
            $this->addNameRelationship($source, $kind, $name, $rangeNode);
        }
    }

    /** @param list<Node\AttributeGroup> $groups */
    private function addAttributes(string $source, array $groups): void
    {
        foreach ($groups as $group) {
            foreach ($group->attrs as $attribute) {
                $this->addNameRelationship($source, 'attribute', Protocol::nameEvidence($attribute->name), $attribute);
            }
        }
    }

    /** @param array{originalName: string, resolvedName: string} $target */
    private function addNameRelationship(string $source, string $kind, array $target, Node $node): void
    {
        $target = $this->normalizeSelfReference($target);
        $this->addRelationship(
            $source,
            $kind,
            $target['originalName'],
            $target['resolvedName'],
            $node,
            false,
        );
    }

    private function addRelationship(
        string $source,
        string $kind,
        string $originalTarget,
        ?string $resolvedTarget,
        Node $node,
        bool $dynamic,
        ?string $memberName = null,
    ): void {
        $originalTarget = Protocol::bounded($originalTarget, $this->maxStringLength);
        $resolvedTarget = $resolvedTarget === null
            ? null
            : Protocol::bounded($resolvedTarget, $this->maxStringLength);
        $range = Protocol::range($node);
        $relationship = [
            'id' => Protocol::id('php-relationship', [
                $this->path,
                $source,
                $kind,
                $originalTarget,
                $resolvedTarget,
                $memberName,
                $range['startFilePos'],
                $range['endFilePos'],
            ]),
            'kind' => $kind,
            'sourceSymbolId' => $source,
            'originalTarget' => $originalTarget,
            'dynamic' => $dynamic,
            'range' => $range,
        ];
        if ($resolvedTarget !== null) {
            $relationship['resolvedTarget'] = $resolvedTarget;
        }
        if ($memberName !== null) {
            $relationship['memberName'] = Protocol::bounded($memberName, $this->maxStringLength);
        }
        $this->relationships[] = $relationship;
        if (!$dynamic && $resolvedTarget !== null && Protocol::isDomainName($resolvedTarget) && $kind !== 'domain_reference') {
            $this->addRelationship($source, 'domain_reference', $originalTarget, $resolvedTarget, $node, false, $memberName);
        }
    }

    /** @param list<Node\AttributeGroup> $attributeGroups */
    private function attributeEvidence(array $attributeGroups): array
    {
        $attributes = [];
        foreach ($attributeGroups as $group) {
            foreach ($group->attrs as $attribute) {
                $attributes[] = Protocol::nameEvidence($attribute->name);
            }
        }
        return $attributes;
    }

    private function addSymbol(
        Node $node,
        string $kind,
        string $qualifiedName,
        string $originalName,
        ?string $containerId = null,
        ?Node $modifierNode = null,
    ): string {
        $qualifiedName = Protocol::bounded(ltrim($qualifiedName, '\\'), $this->maxStringLength);
        $originalName = Protocol::bounded($originalName, $this->maxStringLength);
        $range = Protocol::range($modifierNode ?? $node);
        $id = Protocol::codeSymbolId($this->path, $qualifiedName, $kind);
        $symbol = [
            'id' => $id,
            'kind' => $kind,
            'role' => in_array($kind, ['class', 'interface', 'trait', 'enum'], true)
                ? Protocol::role($qualifiedName)
                : 'other',
            'name' => $originalName,
            'qualifiedName' => $qualifiedName,
            'originalName' => $originalName,
            'static' => method_exists($modifierNode ?? $node, 'isStatic') && ($modifierNode ?? $node)->isStatic(),
            'abstract' => method_exists($modifierNode ?? $node, 'isAbstract') && ($modifierNode ?? $node)->isAbstract(),
            'final' => method_exists($modifierNode ?? $node, 'isFinal') && ($modifierNode ?? $node)->isFinal(),
            'attributes' => property_exists($modifierNode ?? $node, 'attrGroups')
                ? $this->attributeEvidence(($modifierNode ?? $node)->attrGroups)
                : [],
            'range' => $range,
        ];
        if ($containerId !== null) {
            $symbol['containerSymbolId'] = $containerId;
        }
        $visibility = $this->visibility($modifierNode ?? $node);
        if ($visibility !== null) {
            $symbol['visibility'] = $visibility;
        }
        $this->symbols[] = $symbol;
        return $id;
    }

    private function visibility(Node $node): ?string
    {
        if (method_exists($node, 'isPrivate') && $node->isPrivate()) {
            return 'private';
        }
        if (method_exists($node, 'isProtected') && $node->isProtected()) {
            return 'protected';
        }
        if (method_exists($node, 'isPublic') && $node->isPublic()) {
            return 'public';
        }
        return null;
    }

    private function pushScope(Node $node, string $id): void
    {
        $this->scopeStack[] = $id;
        $this->pushedScopes[spl_object_id($node)] = true;
    }

    /** @param array<string, array{originalName: string, resolvedName: string}> $variables */
    private function pushFunctionContext(Node $node, array $variables): void
    {
        $this->functionStack[] = ['variables' => $variables];
        $this->pushedFunctionContexts[spl_object_id($node)] = true;
    }

    private function currentSource(): ?string
    {
        $key = array_key_last($this->scopeStack);
        return $key === null ? $this->namespaceSymbolId : $this->scopeStack[$key];
    }

    /** @return array{id: string, name: string, parent: ?array, propertyTypes: array<string, array{originalName: string, resolvedName: string}>}|null */
    private function currentClass(): ?array
    {
        $key = array_key_last($this->classStack);
        return $key === null ? null : $this->classStack[$key];
    }

    /** @return array{variables: array<string, array{originalName: string, resolvedName: string}>} */
    private function currentFunction(): array
    {
        $key = array_key_last($this->functionStack);
        return $key === null ? ['variables' => []] : $this->functionStack[$key];
    }
}
