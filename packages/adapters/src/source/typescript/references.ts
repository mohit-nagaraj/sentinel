import { Node, type Symbol as TsSymbol, type SourceFile } from "ts-morph"

import type { IndexWarning, UnresolvedReason } from "./errors.ts"
import { compareBy, compareNumbers, compareStrings } from "./identity.ts"
import type { TypeScriptIndexLimits } from "./limits.ts"
import { toRepositoryPath, type LoadedSourceFile } from "./project.ts"
import type { SourceRange } from "./slices.ts"
import type { SymbolRecord } from "./symbols.ts"

export interface ImportBinding {
  readonly local: string
  /** Imported name, `default` for a default import, or `*` for a namespace. */
  readonly imported: string
}

export interface ImportRecord {
  readonly filePath: string
  readonly moduleSpecifier: string
  /** Repository-relative path of the resolved module, when it is indexed. */
  readonly resolvedPath: string | undefined
  readonly unresolvedReason: UnresolvedReason | undefined
  readonly isReexport: boolean
  readonly bindings: readonly ImportBinding[]
  readonly range: SourceRange
}

export type ReferenceKind = "call" | "import" | "reference"

export interface ReferenceRecord {
  readonly filePath: string
  readonly fromQualifiedName: string
  readonly kind: ReferenceKind
  readonly targetQualifiedName: string | undefined
  readonly targetFilePath: string | undefined
  /** Bounded source text of the target expression when it cannot be resolved. */
  readonly unresolvedTarget: string | undefined
  readonly unresolvedReason: UnresolvedReason | undefined
  readonly range: SourceRange
}

export interface ReferenceExtraction {
  readonly imports: readonly ImportRecord[]
  readonly references: readonly ReferenceRecord[]
  readonly warnings: readonly IndexWarning[]
}

const MAX_UNRESOLVED_TARGET_LENGTH = 256

export function rangeOf(node: Node): SourceRange {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  }
}

export function boundTargetText(node: Node): string {
  const text = node.getText().replace(/\s+/g, " ").trim()
  return (text.length > 0 ? text : "<unknown>").slice(
    0,
    MAX_UNRESOLVED_TARGET_LENGTH
  )
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/")
}

/**
 * Follows import and export aliases to the symbol that actually owns the
 * declaration, so `import { eventsClient } from "..."` resolves to the object
 * literal rather than to the local binding.
 */
function unwrapAlias(symbol: TsSymbol | undefined): TsSymbol | undefined {
  if (symbol === undefined) return undefined
  let current = symbol
  for (let depth = 0; depth < 8; depth += 1) {
    const aliased = current.getAliasedSymbol()
    if (aliased === undefined) return current
    current = aliased
  }
  return current
}

export function resolveToIndexedSymbol(
  symbol: TsSymbol | undefined,
  byDeclaration: ReadonlyMap<Node, SymbolRecord>
): SymbolRecord | undefined {
  const target = unwrapAlias(symbol)
  if (target === undefined) return undefined
  for (const declaration of target.getDeclarations()) {
    const direct = byDeclaration.get(declaration)
    if (direct !== undefined) return direct
    // A `const x = () => {}` alias resolves to the initializer; walk up to the
    // variable declaration the symbol index actually keys on.
    const parent = declaration.getParent()
    if (parent !== undefined) {
      const viaParent = byDeclaration.get(parent)
      if (viaParent !== undefined) return viaParent
    }
  }
  return undefined
}

export function isInTypePosition(node: Node): boolean {
  let current: Node | undefined = node
  for (let depth = 0; depth < 24 && current !== undefined; depth += 1) {
    if (Node.isTypeNode(current) || Node.isTypeAliasDeclaration(current)) {
      return true
    }
    if (
      Node.isInterfaceDeclaration(current) ||
      Node.isTypeParameterDeclaration(current)
    ) {
      return true
    }
    if (Node.isStatement(current) || Node.isSourceFile(current)) return false
    current = current.getParent()
  }
  return false
}

export function enclosingSymbol(
  node: Node,
  byDeclaration: ReadonlyMap<Node, SymbolRecord>,
  fallback: SymbolRecord
): SymbolRecord {
  let current: Node | undefined = node.getParent()
  while (current !== undefined) {
    const match = byDeclaration.get(current)
    if (match !== undefined) return match
    current = current.getParent()
  }
  return fallback
}

function resolvedRepositoryPath(
  sourceFile: SourceFile | undefined
): string | undefined {
  return sourceFile === undefined
    ? undefined
    : toRepositoryPath(sourceFile.getFilePath())
}

function extractImports(
  file: LoadedSourceFile,
  moduleSymbol: SymbolRecord,
  byDeclaration: ReadonlyMap<Node, SymbolRecord>
): { imports: ImportRecord[]; references: ReferenceRecord[] } {
  const imports: ImportRecord[] = []
  const references: ReferenceRecord[] = []

  const addRecord = (options: {
    node: Node
    specifier: string
    resolved: SourceFile | undefined
    bindings: readonly ImportBinding[]
    isReexport: boolean
  }): void => {
    const resolvedPath = resolvedRepositoryPath(options.resolved)
    const unresolvedReason: UnresolvedReason | undefined =
      resolvedPath !== undefined
        ? undefined
        : isRelativeSpecifier(options.specifier)
          ? "unresolved_import"
          : "external_module"
    imports.push({
      filePath: file.path,
      moduleSpecifier: options.specifier,
      resolvedPath,
      unresolvedReason,
      isReexport: options.isReexport,
      bindings: Object.freeze([...options.bindings]),
      range: rangeOf(options.node),
    })

    // One reference edge per binding, so the graph records what was imported and
    // not merely that a module was touched.
    for (const binding of options.bindings) {
      const target =
        options.resolved === undefined
          ? undefined
          : resolveToIndexedSymbol(
              binding.imported === "default"
                ? options.resolved.getDefaultExportSymbol()
                : options.resolved
                    .getExportSymbols()
                    .find(
                      (candidate) => candidate.getName() === binding.imported
                    ),
              byDeclaration
            )
      references.push({
        filePath: file.path,
        fromQualifiedName: moduleSymbol.qualifiedName,
        kind: "import",
        targetQualifiedName: target?.qualifiedName,
        targetFilePath: target?.filePath ?? resolvedPath,
        unresolvedTarget:
          target === undefined
            ? `${options.specifier}#${binding.imported}`.slice(
                0,
                MAX_UNRESOLVED_TARGET_LENGTH
              )
            : undefined,
        unresolvedReason: target === undefined ? unresolvedReason : undefined,
        range: rangeOf(options.node),
      })
    }
  }

  for (const declaration of file.sourceFile.getImportDeclarations()) {
    const bindings: ImportBinding[] = []
    const defaultImport = declaration.getDefaultImport()
    if (defaultImport !== undefined) {
      bindings.push({ local: defaultImport.getText(), imported: "default" })
    }
    const namespaceImport = declaration.getNamespaceImport()
    if (namespaceImport !== undefined) {
      bindings.push({ local: namespaceImport.getText(), imported: "*" })
    }
    for (const named of declaration.getNamedImports()) {
      const imported = named.getName()
      bindings.push({
        local: named.getAliasNode()?.getText() ?? imported,
        imported,
      })
    }
    addRecord({
      node: declaration,
      specifier: declaration.getModuleSpecifierValue(),
      resolved: declaration.getModuleSpecifierSourceFile(),
      bindings,
      isReexport: false,
    })
  }

  for (const declaration of file.sourceFile.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue()
    if (specifier === undefined) continue
    const bindings: ImportBinding[] = declaration.isNamespaceExport()
      ? [{ local: "*", imported: "*" }]
      : declaration.getNamedExports().map((named) => ({
          local: named.getAliasNode()?.getText() ?? named.getName(),
          imported: named.getName(),
        }))
    addRecord({
      node: declaration,
      specifier,
      resolved: declaration.getModuleSpecifierSourceFile(),
      bindings,
      isReexport: true,
    })
  }

  return { imports, references }
}

/**
 * Extracts import, call, and reference edges for one file.
 *
 * Only real expression nodes produce edges. A call-shaped sequence inside a
 * comment is trivia and is never visited; one inside a string literal is a
 * `StringLiteral`, not a `CallExpression`; and identifiers in type positions are
 * filtered out explicitly. That is what keeps documentation and fixture text out
 * of the executable-call graph.
 */
export function extractReferences(
  file: LoadedSourceFile,
  fileSymbols: readonly SymbolRecord[],
  byDeclaration: ReadonlyMap<Node, SymbolRecord>,
  indexedNames: ReadonlySet<string>,
  limits: TypeScriptIndexLimits
): ReferenceExtraction {
  const warnings: IndexWarning[] = []
  const moduleSymbol = fileSymbols.find(
    (symbol) => symbol.qualifiedName === file.path
  )
  if (moduleSymbol === undefined) {
    return {
      imports: Object.freeze([]),
      references: Object.freeze([]),
      warnings: Object.freeze([]),
    }
  }

  const { imports, references } = extractImports(
    file,
    moduleSymbol,
    byDeclaration
  )
  let budgetReported = false
  const addReference = (record: ReferenceRecord): void => {
    if (references.length >= limits.maxReferencesPerFile) {
      if (!budgetReported) {
        budgetReported = true
        warnings.push({
          reason: "node_budget_exhausted",
          path: file.path,
          detail: `more than ${limits.maxReferencesPerFile} references`,
        })
      }
      return
    }
    references.push(record)
  }

  file.sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      if (isInTypePosition(node)) return
      const callee = node.getExpression()
      const from = enclosingSymbol(node, byDeclaration, moduleSymbol)
      const nameNode = Node.isPropertyAccessExpression(callee)
        ? callee.getNameNode()
        : Node.isIdentifier(callee)
          ? callee
          : undefined
      const target =
        nameNode === undefined
          ? undefined
          : resolveToIndexedSymbol(nameNode.getSymbol(), byDeclaration)
      addReference({
        filePath: file.path,
        fromQualifiedName: from.qualifiedName,
        kind: "call",
        targetQualifiedName: target?.qualifiedName,
        targetFilePath: target?.filePath,
        unresolvedTarget:
          target === undefined ? boundTargetText(callee) : undefined,
        unresolvedReason:
          target === undefined
            ? nameNode === undefined
              ? "unsupported_syntax"
              : "unresolved_import"
            : undefined,
        range: rangeOf(node),
      })
      return
    }

    if (!Node.isIdentifier(node)) return
    // Resolving every identifier through the type checker is the dominant cost
    // in a naive implementation, so only identifiers that could name an indexed
    // symbol are resolved at all.
    if (!indexedNames.has(node.getText())) return
    if (isInTypePosition(node)) return
    const parent = node.getParent()
    if (parent === undefined) return
    // Import and export clauses are already covered by the import records.
    if (
      Node.isImportSpecifier(parent) ||
      Node.isExportSpecifier(parent) ||
      Node.isImportClause(parent) ||
      Node.isNamespaceImport(parent) ||
      Node.isExportAssignment(parent)
    ) {
      return
    }
    // Skip the identifier that *names* a declaration; the identifier in the
    // value position of the same node is a genuine reference.
    if (Node.hasName(parent) && parent.getNameNode() === node) return
    if (Node.isCallExpression(parent) && parent.getExpression() === node) return
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getNameNode() === node &&
      Node.isCallExpression(parent.getParent())
    ) {
      return
    }

    const target = resolveToIndexedSymbol(node.getSymbol(), byDeclaration)
    if (target === undefined) return
    const from = enclosingSymbol(node, byDeclaration, moduleSymbol)
    if (target.qualifiedName === from.qualifiedName) return
    addReference({
      filePath: file.path,
      fromQualifiedName: from.qualifiedName,
      kind: "reference",
      targetQualifiedName: target.qualifiedName,
      targetFilePath: target.filePath,
      unresolvedTarget: undefined,
      unresolvedReason: undefined,
      range: rangeOf(node),
    })
  })

  const sortedReferences = references.sort((left, right) =>
    compareBy(
      compareNumbers(left.range.startLine, right.range.startLine),
      compareStrings(left.kind, right.kind),
      compareStrings(left.fromQualifiedName, right.fromQualifiedName),
      compareStrings(
        left.targetQualifiedName ?? left.unresolvedTarget ?? "",
        right.targetQualifiedName ?? right.unresolvedTarget ?? ""
      )
    )
  )

  return {
    imports: Object.freeze(
      imports.sort((left, right) =>
        compareBy(
          compareNumbers(left.range.startLine, right.range.startLine),
          compareStrings(left.moduleSpecifier, right.moduleSpecifier)
        )
      )
    ),
    references: Object.freeze(sortedReferences),
    warnings: Object.freeze(warnings),
  }
}
