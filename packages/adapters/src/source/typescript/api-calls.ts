import { httpMethodSchema } from "@sentinel/contracts"
import { Node } from "ts-morph"
import type { z } from "zod"

import type { IndexWarning, UnresolvedReason } from "./errors.ts"
import { compareBy, compareNumbers, compareStrings } from "./identity.ts"
import type { TypeScriptIndexLimits } from "./limits.ts"
import type { LoadedSourceFile } from "./project.ts"
import {
  boundTargetText,
  enclosingSymbol,
  rangeOf,
  resolveToIndexedSymbol,
} from "./references.ts"
import type { SourceRange } from "./slices.ts"
import type { SymbolRecord } from "./symbols.ts"

export type HttpMethod = z.infer<typeof httpMethodSchema>

export const REACT_QUERY_MODULE = "@tanstack/react-query"

export const reactQueryHookNames = Object.freeze([
  "useInfiniteQuery",
  "useMutation",
  "useQueries",
  "useQuery",
  "useSuspenseInfiniteQuery",
  "useSuspenseQuery",
] as const)

export type ReactQueryHookName = (typeof reactQueryHookNames)[number]

const httpMethodMembers = new Map<string, HttpMethod>([
  ["delete", "DELETE"],
  ["get", "GET"],
  ["head", "HEAD"],
  ["options", "OPTIONS"],
  ["patch", "PATCH"],
  ["post", "POST"],
  ["put", "PUT"],
])

const queryFunctionProperties = new Set([
  "mutationFn",
  "queryFn",
  "queryFunction",
])

/** Placeholder standing in for a value the indexer refuses to guess. */
export const PATH_PARAMETER_PLACEHOLDER = "{param}"

const MAX_PATH_LENGTH = 2_048

export interface ApiCallCandidate {
  readonly filePath: string
  /** Enclosing declaration that issues the request. */
  readonly ownerQualifiedName: string
  readonly client: "axios" | "fetch"
  readonly method: HttpMethod | undefined
  /**
   * Normalized request path with a leading slash and `{param}` for every
   * non-literal operand, or `undefined` when nothing literal survived.
   *
   * This is a frontend-side template only. Matching it to a backend endpoint is
   * deliberately not attempted here.
   */
  readonly pathTemplate: string | undefined
  /** Bounded source text of the path argument, for provenance. */
  readonly rawPath: string
  readonly hasQueryString: boolean
  readonly range: SourceRange
  readonly unresolvedReasons: readonly UnresolvedReason[]
}

export interface QueryHookRecord {
  readonly filePath: string
  readonly ownerQualifiedName: string
  readonly hook: ReactQueryHookName
  readonly range: SourceRange
  /** Indexed symbols the hook's query or mutation function calls. */
  readonly callTargetQualifiedNames: readonly string[]
  readonly unresolvedReasons: readonly UnresolvedReason[]
}

export interface ApiCallExtraction {
  readonly candidates: readonly ApiCallCandidate[]
  readonly hooks: readonly QueryHookRecord[]
  readonly warnings: readonly IndexWarning[]
}

type PathPart =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "parameter"; readonly expressionText: string }

/**
 * Flattens a request-path expression into literal and parameter parts.
 *
 * Handles the three shapes Hi.Events uses: a bare string literal, a `+`
 * concatenation of literals and expressions, and a template literal with
 * substitutions.
 */
export function collectPathParts(expression: Node): readonly PathPart[] {
  if (Node.isStringLiteral(expression)) {
    return [{ kind: "literal", text: expression.getLiteralValue() }]
  }
  if (Node.isNoSubstitutionTemplateLiteral(expression)) {
    return [{ kind: "literal", text: expression.getLiteralValue() }]
  }
  if (Node.isTemplateExpression(expression)) {
    const parts: PathPart[] = [
      { kind: "literal", text: expression.getHead().getLiteralText() },
    ]
    for (const span of expression.getTemplateSpans()) {
      parts.push({
        kind: "parameter",
        expressionText: span.getExpression().getText(),
      })
      parts.push({ kind: "literal", text: span.getLiteral().getLiteralText() })
    }
    return parts
  }
  if (
    Node.isBinaryExpression(expression) &&
    expression.getOperatorToken().getText() === "+"
  ) {
    return [
      ...collectPathParts(expression.getLeft()),
      ...collectPathParts(expression.getRight()),
    ]
  }
  if (Node.isParenthesizedExpression(expression)) {
    return collectPathParts(expression.getExpression())
  }
  return [{ kind: "parameter", expressionText: expression.getText() }]
}

export interface NormalizedRequestPath {
  readonly pathTemplate: string | undefined
  readonly hasQueryString: boolean
  readonly reasons: readonly UnresolvedReason[]
}

/**
 * Turns path parts into a normalized template.
 *
 * Query strings are separated out rather than folded into the path: a literal
 * `?` splits the template, and a trailing substitution appended to a literal
 * segment is treated as a query string when its own source text contains a `?`.
 * That is what makes `` `events/${id}/stats${qs ? '?' + qs : ''}` `` normalize to
 * `/events/{param}/stats` instead of growing a bogus trailing segment.
 */
export function normalizeRequestPath(
  parts: readonly PathPart[]
): NormalizedRequestPath {
  const reasons = new Set<UnresolvedReason>()
  const hasLiteral = parts.some(
    (part) => part.kind === "literal" && part.text.length > 0
  )
  if (!hasLiteral) {
    return {
      pathTemplate: undefined,
      hasQueryString: false,
      reasons: Object.freeze(["computed_request_path"]),
    }
  }

  let hasQueryString = false
  const kept: PathPart[] = []
  for (const [index, part] of parts.entries()) {
    if (part.kind === "literal") {
      const questionIndex = part.text.indexOf("?")
      if (questionIndex === -1) {
        kept.push(part)
        continue
      }
      hasQueryString = true
      kept.push({ kind: "literal", text: part.text.slice(0, questionIndex) })
      break
    }
    // A substitution whose own expression builds a query string terminates the
    // path rather than contributing a segment.
    if (part.expressionText.includes("?")) {
      const previous = parts[index - 1]
      const followsSeparator =
        previous === undefined ||
        (previous.kind === "literal" && previous.text.endsWith("/"))
      if (!followsSeparator) {
        hasQueryString = true
        break
      }
    }
    kept.push(part)
  }

  const raw = kept
    .map((part) =>
      part.kind === "literal" ? part.text : PATH_PARAMETER_PLACEHOLDER
    )
    .join("")
  const [pathPortion, ...queryPortions] = raw.split("?")
  if (queryPortions.length > 0) hasQueryString = true

  const segments = (pathPortion ?? "")
    .split("/")
    .filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    return {
      pathTemplate: undefined,
      hasQueryString,
      reasons: Object.freeze(["computed_request_path"]),
    }
  }
  if (parts.some((part) => part.kind === "parameter")) {
    reasons.add("computed_request_path")
  }

  return {
    pathTemplate: `/${segments.join("/")}`.slice(0, MAX_PATH_LENGTH),
    hasQueryString,
    reasons: Object.freeze([...reasons]),
  }
}

/**
 * Recognizes an Axios client binding structurally: a variable initialized with
 * `axios.create(...)`, or a binding imported from the `axios` package. Naming
 * conventions alone are not enough, because a local `api` object need not be an
 * HTTP client at all.
 */
function isAxiosInstanceDeclaration(declaration: Node): boolean {
  if (!Node.isVariableDeclaration(declaration)) return false
  const initializer = declaration.getInitializer()
  return (
    initializer !== undefined &&
    Node.isCallExpression(initializer) &&
    /(?:^|\.)axios\.create$/.test(initializer.getExpression().getText())
  )
}

function isAxiosPackageImport(declaration: Node): boolean {
  return declaration
    .getAncestors()
    .some(
      (ancestor) =>
        Node.isImportDeclaration(ancestor) &&
        ancestor.getModuleSpecifierValue() === "axios"
    )
}

function isAxiosClient(node: Node): boolean {
  if (!Node.isIdentifier(node)) return false
  const symbol = node.getSymbol()
  if (symbol === undefined) return node.getText() === "axios"
  const declarations = [
    ...symbol.getDeclarations(),
    ...(symbol.getAliasedSymbol()?.getDeclarations() ?? []),
  ]
  return (
    declarations.some(isAxiosInstanceDeclaration) ||
    declarations.some(isAxiosPackageImport) ||
    node.getText() === "axios"
  )
}

function literalStringOf(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined
  if (Node.isStringLiteral(node)) return node.getLiteralValue()
  if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue()
  return undefined
}

function methodFromOptions(node: Node | undefined): HttpMethod | undefined {
  if (node === undefined || !Node.isObjectLiteralExpression(node)) {
    return undefined
  }
  const property = node.getProperty("method")
  if (property === undefined || !Node.isPropertyAssignment(property)) {
    return undefined
  }
  const literal = literalStringOf(property.getInitializer())
  if (literal === undefined) return undefined
  const parsed = httpMethodSchema.safeParse(literal.toUpperCase())
  return parsed.success ? parsed.data : undefined
}

function reactQueryHookImports(
  file: LoadedSourceFile
): ReadonlyMap<string, ReactQueryHookName> {
  const bindings = new Map<string, ReactQueryHookName>()
  for (const declaration of file.sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== REACT_QUERY_MODULE) continue
    for (const named of declaration.getNamedImports()) {
      const imported = named.getName()
      const match = reactQueryHookNames.find((name) => name === imported)
      if (match === undefined) continue
      bindings.set(named.getAliasNode()?.getText() ?? imported, match)
    }
  }
  return bindings
}

export function extractApiCalls(
  file: LoadedSourceFile,
  fileSymbols: readonly SymbolRecord[],
  byDeclaration: ReadonlyMap<Node, SymbolRecord>,
  limits: TypeScriptIndexLimits
): ApiCallExtraction {
  const moduleSymbol = fileSymbols.find(
    (symbol) => symbol.qualifiedName === file.path
  )
  if (moduleSymbol === undefined) {
    return {
      candidates: Object.freeze([]),
      hooks: Object.freeze([]),
      warnings: Object.freeze([]),
    }
  }

  const candidates: ApiCallCandidate[] = []
  const hooks: QueryHookRecord[] = []
  const warnings: IndexWarning[] = []
  const hookBindings = reactQueryHookImports(file)
  let budgetReported = false

  const addCandidate = (candidate: ApiCallCandidate): void => {
    if (candidates.length >= limits.maxReferencesPerFile) {
      if (!budgetReported) {
        budgetReported = true
        warnings.push({
          reason: "node_budget_exhausted",
          path: file.path,
          detail: `more than ${limits.maxReferencesPerFile} API call candidates`,
        })
      }
      return
    }
    candidates.push(candidate)
  }

  const recordRequest = (options: {
    node: Node
    client: "axios" | "fetch"
    method: HttpMethod | undefined
    pathArgument: Node | undefined
  }): void => {
    const owner = enclosingSymbol(options.node, byDeclaration, moduleSymbol)
    if (options.pathArgument === undefined) {
      addCandidate({
        filePath: file.path,
        ownerQualifiedName: owner.qualifiedName,
        client: options.client,
        method: options.method,
        pathTemplate: undefined,
        rawPath: boundTargetText(options.node),
        hasQueryString: false,
        range: rangeOf(options.node),
        unresolvedReasons: Object.freeze(["computed_request_path"]),
      })
      return
    }
    const normalized = normalizeRequestPath(
      collectPathParts(options.pathArgument)
    )
    addCandidate({
      filePath: file.path,
      ownerQualifiedName: owner.qualifiedName,
      client: options.client,
      method: options.method,
      pathTemplate: normalized.pathTemplate,
      rawPath: boundTargetText(options.pathArgument),
      hasQueryString: normalized.hasQueryString,
      range: rangeOf(options.node),
      unresolvedReasons: Object.freeze([...normalized.reasons]),
    })
  }

  file.sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return
    const callee = node.getExpression()
    const args = node.getArguments()

    // `fetch(url, { method })`
    if (Node.isIdentifier(callee) && callee.getText() === "fetch") {
      recordRequest({
        node,
        client: "fetch",
        method: methodFromOptions(args[1]) ?? "GET",
        pathArgument: args[0],
      })
      return
    }

    if (Node.isPropertyAccessExpression(callee)) {
      const receiver = callee.getExpression()
      const member = callee.getNameNode().getText()
      if (!isAxiosClient(receiver)) return

      // `api.get(path, ...)`
      const method = httpMethodMembers.get(member)
      if (method !== undefined) {
        recordRequest({ node, client: "axios", method, pathArgument: args[0] })
        return
      }
      // `api.request({ method, url })`
      if (member === "request") {
        const options = args[0]
        const urlProperty =
          options !== undefined && Node.isObjectLiteralExpression(options)
            ? options.getProperty("url")
            : undefined
        recordRequest({
          node,
          client: "axios",
          method: methodFromOptions(options),
          pathArgument:
            urlProperty !== undefined && Node.isPropertyAssignment(urlProperty)
              ? urlProperty.getInitializer()
              : undefined,
        })
      }
      return
    }

    // `axios({ method, url })`
    if (Node.isIdentifier(callee) && isAxiosClient(callee)) {
      const options = args[0]
      const urlProperty =
        options !== undefined && Node.isObjectLiteralExpression(options)
          ? options.getProperty("url")
          : undefined
      recordRequest({
        node,
        client: "axios",
        method: methodFromOptions(options),
        pathArgument:
          urlProperty !== undefined && Node.isPropertyAssignment(urlProperty)
            ? urlProperty.getInitializer()
            : undefined,
      })
    }
  })

  // React Query hooks, matched against what the file actually imported from
  // @tanstack/react-query rather than by name alone.
  if (hookBindings.size > 0) {
    file.sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return
      const callee = node.getExpression()
      if (!Node.isIdentifier(callee)) return
      const hook = hookBindings.get(callee.getText())
      if (hook === undefined) return

      const owner = enclosingSymbol(node, byDeclaration, moduleSymbol)
      const reasons = new Set<UnresolvedReason>()
      const targets = new Set<string>()
      const options = node.getArguments().at(0)
      const functionProperties =
        options !== undefined && Node.isObjectLiteralExpression(options)
          ? options
              .getProperties()
              .filter(
                (property) =>
                  (Node.isPropertyAssignment(property) ||
                    Node.isMethodDeclaration(property)) &&
                  queryFunctionProperties.has(property.getName())
              )
          : []
      if (functionProperties.length === 0) {
        reasons.add("unsupported_syntax")
      }
      for (const property of functionProperties) {
        for (const descendant of property.getDescendants()) {
          if (!Node.isCallExpression(descendant)) continue
          const innerCallee = descendant.getExpression()
          const nameNode = Node.isPropertyAccessExpression(innerCallee)
            ? innerCallee.getNameNode()
            : Node.isIdentifier(innerCallee)
              ? innerCallee
              : undefined
          const target =
            nameNode === undefined
              ? undefined
              : resolveToIndexedSymbol(nameNode.getSymbol(), byDeclaration)
          if (target === undefined) {
            reasons.add("unresolved_import")
            continue
          }
          targets.add(target.qualifiedName)
        }
      }

      hooks.push({
        filePath: file.path,
        ownerQualifiedName: owner.qualifiedName,
        hook,
        range: rangeOf(node),
        callTargetQualifiedNames: Object.freeze(
          [...targets].sort(compareStrings)
        ),
        unresolvedReasons: Object.freeze([...reasons].sort(compareStrings)),
      })
    })
  }

  return {
    candidates: Object.freeze(
      candidates.sort((left, right) =>
        compareBy(
          compareNumbers(left.range.startLine, right.range.startLine),
          compareStrings(left.method ?? "", right.method ?? ""),
          compareStrings(left.pathTemplate ?? "", right.pathTemplate ?? "")
        )
      )
    ),
    hooks: Object.freeze(
      hooks.sort((left, right) =>
        compareBy(
          compareNumbers(left.range.startLine, right.range.startLine),
          compareStrings(left.hook, right.hook)
        )
      )
    ),
    warnings: Object.freeze(warnings),
  }
}
