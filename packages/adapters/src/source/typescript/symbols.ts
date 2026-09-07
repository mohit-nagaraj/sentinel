import { codeSymbolKindSchema } from "@sentinel/contracts"
import { Node, ts, type SourceFile } from "ts-morph"
import type { z } from "zod"

import type { IndexWarning } from "./errors.ts"
import { compareBy, compareNumbers, compareStrings } from "./identity.ts"
import type { IndexBudget, TypeScriptIndexLimits } from "./limits.ts"
import type { LoadedSourceFile } from "./project.ts"
import { countSourceLines, type SourceRange } from "./slices.ts"

export type CodeSymbolKind = z.infer<typeof codeSymbolKindSchema>

export interface SymbolRecord {
  readonly filePath: string
  readonly language: "typescript" | "tsx"
  /** Declared name, or `default` for an anonymous default export. */
  readonly name: string
  /** `<file path>#<declaration chain>`, stable and structural. */
  readonly qualifiedName: string
  readonly kind: CodeSymbolKind
  readonly range: SourceRange
  readonly exported: boolean
  /** Export name when exported; `default` for a default export. */
  readonly exportName: string | undefined
  /** Declaration node, used to resolve references. Never serialized. */
  readonly declaration: Node
  /** Function body or initializer, used to scope handler and call extraction. */
  readonly body: Node | undefined
}

export interface SymbolExtraction {
  readonly symbols: readonly SymbolRecord[]
  readonly byDeclaration: ReadonlyMap<Node, SymbolRecord>
  readonly warnings: readonly IndexWarning[]
  readonly nodeCount: number
}

/** Nesting depth for locally declared functions inside another declaration. */
const MAX_NESTED_DECLARATION_DEPTH = 4

const handlerNamePattern = /^(?:handle|on)[A-Z]/
const componentNamePattern = /^[A-Z][A-Za-z0-9]*$/
const apiClientFilePattern = /\.client\.tsx?$/
const apiClientNamePattern = /(?:Client|Api|API)$/

export function countCompilerNodes(node: ts.Node): number {
  let count = 0
  const visit = (current: ts.Node): void => {
    count += 1
    current.forEachChild(visit)
  }
  visit(node)
  return count
}

function containsJsx(node: ts.Node): boolean {
  let found = false
  const visit = (current: ts.Node): void => {
    if (found) return
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current)
    ) {
      found = true
      return
    }
    current.forEachChild(visit)
  }
  visit(node)
  return found
}

function rangeOf(node: Node): SourceRange {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  }
}

interface ClassifyInput {
  readonly name: string
  readonly filePath: string
  readonly language: "typescript" | "tsx"
  readonly member: boolean
  readonly isClass: boolean
  readonly isObjectLiteral: boolean
  readonly hasJsx: boolean
}

/**
 * Maps a declaration onto the closed contracts symbol-kind enum.
 *
 * The order is significant: a JSX-returning `handleFoo` is a handler first and a
 * component second, because that is how the Code Explorer will want to follow it
 * from a JSX binding.
 */
export function classifySymbol(input: ClassifyInput): CodeSymbolKind {
  if (input.isClass) return "class"
  if (handlerNamePattern.test(input.name)) return "handler"
  if (
    input.language === "tsx" &&
    componentNamePattern.test(input.name) &&
    input.hasJsx
  ) {
    return "component"
  }
  if (input.member) return "method"
  if (input.isObjectLiteral) {
    return apiClientFilePattern.test(input.filePath) ||
      apiClientNamePattern.test(input.name)
      ? "service"
      : "module"
  }
  return "function"
}

function isFunctionLike(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isFunctionDeclaration(node))
  )
}

interface SymbolDraft {
  filePath: string
  language: "typescript" | "tsx"
  name: string
  qualifiedName: string
  kind: CodeSymbolKind
  range: SourceRange
  exported: boolean
  exportName: string | undefined
  declaration: Node
  body: Node | undefined
}

/**
 * Extracts navigable declarations from one source file.
 *
 * Only executable declarations are recorded — functions, classes and their
 * members, and object literals with function-valued members (the shape the
 * Hi.Events API clients use). Type aliases, interfaces, and plain value
 * constants are deliberately skipped: they are not call targets and would
 * swamp the Code Explorer's search results.
 */
export function extractSymbols(
  file: LoadedSourceFile,
  limits: TypeScriptIndexLimits,
  budget: IndexBudget
): SymbolExtraction {
  const { path: filePath, language, sourceFile } = file
  const nodeCount = countCompilerNodes(sourceFile.compilerNode)
  const warnings: IndexWarning[] = []
  const drafts: SymbolDraft[] = []
  const byDeclaration = new Map<Node, SymbolDraft>()

  if (nodeCount > limits.maxNodesPerFile) {
    warnings.push({
      reason: "node_budget_exhausted",
      path: filePath,
      detail: `${nodeCount} nodes exceeds the per-file budget`,
    })
    return {
      symbols: [],
      byDeclaration: new Map(),
      warnings: Object.freeze(warnings),
      nodeCount,
    }
  }
  budget.countNodes(nodeCount)

  let budgetReported = false
  const push = (draft: SymbolDraft): void => {
    if (drafts.length >= limits.maxSymbolsPerFile) {
      if (!budgetReported) {
        budgetReported = true
        warnings.push({
          reason: "symbol_budget_exhausted",
          path: filePath,
          detail: `more than ${limits.maxSymbolsPerFile} symbols`,
        })
      }
      return
    }
    drafts.push(draft)
    byDeclaration.set(draft.declaration, draft)
  }

  const record = (options: {
    declaration: Node
    name: string
    chain: readonly string[]
    body: Node | undefined
    member: boolean
    isClass: boolean
    isObjectLiteral: boolean
    exported: boolean
    exportName: string | undefined
  }): SymbolDraft => {
    const bodyNode = options.body
    const draft: SymbolDraft = {
      filePath,
      language,
      name: options.name,
      qualifiedName: `${filePath}#${options.chain.join(".")}`,
      kind: classifySymbol({
        name: options.name,
        filePath,
        language,
        member: options.member,
        isClass: options.isClass,
        isObjectLiteral: options.isObjectLiteral,
        hasJsx: bodyNode !== undefined && containsJsx(bodyNode.compilerNode),
      }),
      range: rangeOf(options.declaration),
      exported: options.exported,
      exportName: options.exportName,
      declaration: options.declaration,
      body: bodyNode,
    }
    push(draft)
    return draft
  }

  /**
   * Direct statements of a function body, without descending into nested
   * functions. Used to find locally declared handlers.
   */
  const bodyStatements = (node: Node | undefined): readonly Node[] => {
    if (node === undefined) return []
    if (Node.isBlock(node)) return node.getStatements()
    if (
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node)
    ) {
      const body = node.getBody()
      return body !== undefined && Node.isBlock(body)
        ? body.getStatements()
        : []
    }
    return []
  }

  /**
   * Records function-like declarations nested inside another declaration's body.
   *
   * React components declare their handlers as body locals — Hi.Events'
   * `handleTicketLookup` lives inside `Login` — so a top-level-only walk would
   * leave every JSX handler binding unresolved. Nesting is bounded because the
   * value of deeply nested closures to a Code Explorer drops off quickly.
   */
  const recordNested = (
    body: Node | undefined,
    chain: readonly string[],
    depth: number
  ): void => {
    if (depth > MAX_NESTED_DECLARATION_DEPTH) return
    for (const statement of bodyStatements(body)) {
      if (Node.isFunctionDeclaration(statement)) {
        const name = statement.getName()
        if (name === undefined) continue
        record({
          declaration: statement,
          name,
          chain: [...chain, name],
          body: statement.getBody(),
          member: false,
          isClass: false,
          isObjectLiteral: false,
          exported: false,
          exportName: undefined,
        })
        recordNested(statement.getBody(), [...chain, name], depth + 1)
        continue
      }
      if (!Node.isVariableStatement(statement)) continue
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer()
        if (!isFunctionLike(initializer)) continue
        const name = declaration.getName()
        record({
          declaration,
          name,
          chain: [...chain, name],
          body: initializer,
          member: false,
          isClass: false,
          isObjectLiteral: false,
          exported: false,
          exportName: undefined,
        })
        recordNested(initializer, [...chain, name], depth + 1)
      }
    }
  }

  const recordObjectMembers = (
    objectLiteral: Node,
    chain: readonly string[]
  ): void => {
    if (!Node.isObjectLiteralExpression(objectLiteral)) return
    for (const property of objectLiteral.getProperties()) {
      if (Node.isMethodDeclaration(property)) {
        record({
          declaration: property,
          name: property.getName(),
          chain: [...chain, property.getName()],
          body: property.getBody(),
          member: true,
          isClass: false,
          isObjectLiteral: false,
          exported: false,
          exportName: undefined,
        })
        recordNested(property.getBody(), [...chain, property.getName()], 1)
        continue
      }
      if (!Node.isPropertyAssignment(property)) continue
      const initializer = property.getInitializer()
      if (!isFunctionLike(initializer)) continue
      const name = property.getName().replace(/^["']|["']$/g, "")
      record({
        declaration: property,
        name,
        chain: [...chain, name],
        body: initializer,
        member: true,
        isClass: false,
        isObjectLiteral: false,
        exported: false,
        exportName: undefined,
      })
      recordNested(initializer, [...chain, name], 1)
    }
  }

  const recordClassMembers = (
    declaration: Node,
    chain: readonly string[]
  ): void => {
    if (!Node.isClassDeclaration(declaration)) return
    for (const method of declaration.getMethods()) {
      record({
        declaration: method,
        name: method.getName(),
        chain: [...chain, method.getName()],
        body: method.getBody(),
        member: true,
        isClass: false,
        isObjectLiteral: false,
        exported: false,
        exportName: undefined,
      })
      recordNested(method.getBody(), [...chain, method.getName()], 1)
    }
    for (const property of declaration.getProperties()) {
      const initializer = property.getInitializer()
      if (!isFunctionLike(initializer)) continue
      record({
        declaration: property,
        name: property.getName(),
        chain: [...chain, property.getName()],
        body: initializer,
        member: true,
        isClass: false,
        isObjectLiteral: false,
        exported: false,
        exportName: undefined,
      })
      recordNested(initializer, [...chain, property.getName()], 1)
    }
  }

  // Every file gets a module symbol so file-level facts — imports above all —
  // have a symbol to hang off. Its qualified name is the bare file path, with no
  // `#` separator, which is what distinguishes it from a declaration.
  const moduleDraft: SymbolDraft = {
    filePath,
    language,
    name: filePath.split("/").at(-1) ?? filePath,
    qualifiedName: filePath,
    kind: "module",
    // Counted from the text rather than `getEndLineNumber()`, which treats the
    // position after a trailing newline as an extra line and would put the
    // module range one line past anything a slice can return.
    range: {
      startLine: 1,
      endLine: Math.max(1, countSourceLines(sourceFile.getFullText())),
    },
    exported: false,
    exportName: undefined,
    declaration: sourceFile,
    body: sourceFile,
  }
  push(moduleDraft)

  for (const statement of sourceFile.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      const name = statement.getName() ?? "default"
      record({
        declaration: statement,
        name,
        chain: [name],
        body: statement.getBody(),
        member: false,
        isClass: false,
        isObjectLiteral: false,
        exported: statement.isExported(),
        exportName: statement.isDefaultExport() ? "default" : name,
      })
      recordNested(statement.getBody(), [name], 1)
      continue
    }

    if (Node.isClassDeclaration(statement)) {
      const name = statement.getName() ?? "default"
      record({
        declaration: statement,
        name,
        chain: [name],
        body: undefined,
        member: false,
        isClass: true,
        isObjectLiteral: false,
        exported: statement.isExported(),
        exportName: statement.isDefaultExport() ? "default" : name,
      })
      recordClassMembers(statement, [name])
      continue
    }

    if (Node.isVariableStatement(statement)) {
      const exported = statement.isExported()
      for (const declaration of statement.getDeclarations()) {
        const name = declaration.getName()
        const initializer = declaration.getInitializer()
        if (isFunctionLike(initializer)) {
          record({
            declaration,
            name,
            chain: [name],
            body: initializer,
            member: false,
            isClass: false,
            isObjectLiteral: false,
            exported,
            exportName: exported ? name : undefined,
          })
          recordNested(initializer, [name], 1)
          continue
        }
        if (
          initializer !== undefined &&
          Node.isObjectLiteralExpression(initializer)
        ) {
          record({
            declaration,
            name,
            chain: [name],
            body: initializer,
            member: false,
            isClass: false,
            isObjectLiteral: true,
            exported,
            exportName: exported ? name : undefined,
          })
          recordObjectMembers(initializer, [name])
        }
      }
      continue
    }

    // `export default Login` for a declaration made earlier in the file. This is
    // the shape every Hi.Events route component uses, and route `lazy()`
    // resolution depends on finding it.
    if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      const expression = statement.getExpression()
      if (Node.isIdentifier(expression)) {
        const target = expression
          .getSymbol()
          ?.getDeclarations()
          .map((candidate) =>
            Node.isVariableDeclaration(candidate) ||
            Node.isFunctionDeclaration(candidate) ||
            Node.isClassDeclaration(candidate)
              ? byDeclaration.get(candidate)
              : undefined
          )
          .find((candidate) => candidate !== undefined)
        if (target !== undefined) {
          target.exported = true
          target.exportName = "default"
          continue
        }
      }
      if (
        isFunctionLike(expression) ||
        Node.isObjectLiteralExpression(expression)
      ) {
        record({
          declaration: statement,
          name: "default",
          chain: ["default"],
          body: expression,
          member: false,
          isClass: false,
          isObjectLiteral: Node.isObjectLiteralExpression(expression),
          exported: true,
          exportName: "default",
        })
      }
    }
  }

  const symbols = drafts
    .map((draft) => Object.freeze({ ...draft }) as SymbolRecord)
    .sort((left, right) =>
      compareBy(
        compareNumbers(left.range.startLine, right.range.startLine),
        compareStrings(left.qualifiedName, right.qualifiedName)
      )
    )
  const resolved = new Map<Node, SymbolRecord>(
    symbols.map((symbol) => [symbol.declaration, symbol])
  )

  return {
    symbols: Object.freeze(symbols),
    byDeclaration: resolved,
    warnings: Object.freeze(warnings),
    nodeCount,
  }
}
