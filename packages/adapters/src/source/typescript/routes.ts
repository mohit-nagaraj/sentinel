import { Node, type Project } from "ts-morph"

import type { IndexWarning, UnresolvedReason } from "./errors.ts"
import { compareBy, compareNumbers, compareStrings } from "./identity.ts"
import type { TypeScriptIndexLimits } from "./limits.ts"
import { resolveModuleSpecifier, type LoadedSourceFile } from "./project.ts"
import {
  boundTargetText,
  rangeOf,
  resolveToIndexedSymbol,
} from "./references.ts"
import type { SourceRange } from "./slices.ts"
import type { SymbolRecord } from "./symbols.ts"

export interface RouteRecord {
  /** Composed pattern with a leading slash, keeping `:param` and `:param?`. */
  readonly pathPattern: string
  /** Segment exactly as declared, before composition. */
  readonly declaredSegment: string
  readonly filePath: string
  readonly range: SourceRange
  readonly isIndexRoute: boolean
  /** Components this route renders directly. */
  readonly componentQualifiedNames: readonly string[]
  /** Layout components inherited from ancestor routes, outermost first. */
  readonly layoutQualifiedNames: readonly string[]
  readonly unresolvedReasons: readonly UnresolvedReason[]
  /** Bounded source text of component expressions that did not resolve. */
  readonly unresolvedComponents: readonly string[]
}

export interface RouteExtraction {
  readonly routes: readonly RouteRecord[]
  readonly warnings: readonly IndexWarning[]
}

const routerFactoryNames = new Set([
  "createBrowserRouter",
  "createHashRouter",
  "createMemoryRouter",
  "createRoutesFromElements",
  "createStaticRouter",
])

const componentProperties = ["element", "Component"] as const

/**
 * Joins a parent pattern with a child segment.
 *
 * An absolute child segment replaces the parent, an empty segment or index route
 * inherits it, and everything else is appended. Parameter syntax is preserved
 * verbatim so `:eventsState?` survives into the emitted pattern.
 */
export function composeRoutePattern(parent: string, segment: string): string {
  const trimmed = segment.trim()
  if (trimmed.startsWith("/")) {
    return `/${trimmed.split("/").filter(Boolean).join("/")}`
  }
  const parentSegments = parent.split("/").filter(Boolean)
  const childSegments = trimmed.split("/").filter(Boolean)
  const joined = [...parentSegments, ...childSegments].join("/")
  return `/${joined}`
}

interface ComponentResolution {
  readonly qualifiedNames: readonly string[]
  readonly reasons: readonly UnresolvedReason[]
  readonly unresolved: readonly string[]
}

const emptyResolution: ComponentResolution = {
  qualifiedNames: [],
  reasons: [],
  unresolved: [],
}

function mergeResolutions(
  ...resolutions: readonly ComponentResolution[]
): ComponentResolution {
  return {
    qualifiedNames: resolutions.flatMap(({ qualifiedNames }) => qualifiedNames),
    reasons: resolutions.flatMap(({ reasons }) => reasons),
    unresolved: resolutions.flatMap(({ unresolved }) => unresolved),
  }
}

interface RouteContext {
  readonly file: LoadedSourceFile
  readonly project: Project
  readonly byDeclaration: ReadonlyMap<Node, SymbolRecord>
  readonly symbolsByFile: ReadonlyMap<string, readonly SymbolRecord[]>
}

function resolveIdentifierComponent(
  node: Node,
  context: RouteContext
): ComponentResolution {
  const target = resolveToIndexedSymbol(node.getSymbol(), context.byDeclaration)
  return target === undefined
    ? {
        qualifiedNames: [],
        reasons: ["dynamic_component"],
        unresolved: [boundTargetText(node)],
      }
    : { qualifiedNames: [target.qualifiedName], reasons: [], unresolved: [] }
}

/**
 * Resolves the `element={<Login />}` shape by treating the JSX tag name as a
 * component reference.
 */
function resolveJsxComponent(
  node: Node,
  context: RouteContext
): ComponentResolution {
  const tagName = Node.isJsxSelfClosingElement(node)
    ? node.getTagNameNode()
    : Node.isJsxElement(node)
      ? node.getOpeningElement().getTagNameNode()
      : undefined
  if (tagName === undefined) {
    return {
      qualifiedNames: [],
      reasons: ["dynamic_component"],
      unresolved: [boundTargetText(node)],
    }
  }
  return resolveIdentifierComponent(tagName, context)
}

function defaultExportSymbolOf(
  filePath: string,
  context: RouteContext
): SymbolRecord | undefined {
  return context.symbolsByFile
    .get(filePath)
    ?.find((symbol) => symbol.exportName === "default")
}

/**
 * Resolves the `async lazy() { const M = await import("..."); return { Component: M.default } }`
 * shape by following the dynamic import specifier to that module's default
 * export. This is how every lazily loaded Hi.Events route names its component.
 */
function resolveLazyComponent(
  node: Node,
  context: RouteContext
): ComponentResolution {
  // A dynamic `import(...)` parses as a call whose expression is the import
  // keyword, so it is matched on the callee text rather than a node kind.
  const dynamicImports = node
    .getDescendants()
    .filter(
      (descendant): descendant is Node =>
        Node.isCallExpression(descendant) &&
        descendant.getExpression().getText() === "import"
    )
  const resolutions: ComponentResolution[] = []
  for (const dynamicImport of dynamicImports) {
    if (!Node.isCallExpression(dynamicImport)) continue
    const [argument] = dynamicImport.getArguments()
    if (argument === undefined || !Node.isStringLiteral(argument)) {
      resolutions.push({
        qualifiedNames: [],
        reasons: ["dynamic_component"],
        unresolved: [boundTargetText(dynamicImport)],
      })
      continue
    }
    const specifier = argument.getLiteralValue()
    const resolvedPath = resolveModuleSpecifier(
      context.project,
      context.file.path,
      specifier
    )
    const target =
      resolvedPath === undefined
        ? undefined
        : defaultExportSymbolOf(resolvedPath, context)
    resolutions.push(
      target === undefined
        ? {
            qualifiedNames: [],
            reasons: ["dynamic_component"],
            unresolved: [specifier.slice(0, 256)],
          }
        : {
            qualifiedNames: [target.qualifiedName],
            reasons: [],
            unresolved: [],
          }
    )
  }
  return resolutions.length === 0
    ? {
        qualifiedNames: [],
        reasons: ["dynamic_component"],
        unresolved: [boundTargetText(node)],
      }
    : mergeResolutions(...resolutions)
}

function resolveComponentExpression(
  expression: Node,
  context: RouteContext
): ComponentResolution {
  if (Node.isIdentifier(expression)) {
    return resolveIdentifierComponent(expression, context)
  }
  if (
    Node.isJsxSelfClosingElement(expression) ||
    Node.isJsxElement(expression)
  ) {
    return resolveJsxComponent(expression, context)
  }
  if (Node.isJsxExpression(expression)) {
    const inner = expression.getExpression()
    return inner === undefined
      ? {
          qualifiedNames: [],
          reasons: ["dynamic_component"],
          unresolved: [boundTargetText(expression)],
        }
      : resolveComponentExpression(inner, context)
  }
  if (Node.isPropertyAccessExpression(expression)) {
    return resolveIdentifierComponent(expression.getNameNode(), context)
  }
  return {
    qualifiedNames: [],
    reasons: ["dynamic_component"],
    unresolved: [boundTargetText(expression)],
  }
}

function readStringPath(
  expression: Node | undefined
): { value: string; resolved: true } | { resolved: false } {
  if (expression === undefined) return { resolved: false }
  if (Node.isStringLiteral(expression)) {
    return { value: expression.getLiteralValue(), resolved: true }
  }
  if (Node.isNoSubstitutionTemplateLiteral(expression)) {
    return { value: expression.getLiteralValue(), resolved: true }
  }
  if (Node.isJsxExpression(expression)) {
    return readStringPath(expression.getExpression())
  }
  return { resolved: false }
}

interface WalkState {
  readonly parentPattern: string
  readonly layouts: readonly string[]
  readonly depth: number
}

const MAX_ROUTE_DEPTH = 24

export function extractRoutes(
  file: LoadedSourceFile,
  project: Project,
  byDeclaration: ReadonlyMap<Node, SymbolRecord>,
  symbolsByFile: ReadonlyMap<string, readonly SymbolRecord[]>,
  limits: TypeScriptIndexLimits
): RouteExtraction {
  const context: RouteContext = { file, project, byDeclaration, symbolsByFile }
  const routes: RouteRecord[] = []
  const warnings: IndexWarning[] = []
  // A single route node can be reached by more than one detection strategy (a
  // `<Routes>` tree assigned to a variable, for example). Tracking node identity
  // deduplicates exactly, where a pattern-plus-line key would wrongly collapse a
  // parent and its index child declared on the same line.
  const visited = new Set<Node>()
  let budgetReported = false

  const push = (record: RouteRecord): boolean => {
    if (routes.length >= limits.maxRoutes) {
      if (!budgetReported) {
        budgetReported = true
        warnings.push({
          reason: "file_budget_exhausted",
          path: file.path,
          detail: `more than ${limits.maxRoutes} routes`,
        })
      }
      return false
    }
    routes.push(record)
    return true
  }

  const walkObjectRoute = (objectLiteral: Node, state: WalkState): void => {
    if (
      !Node.isObjectLiteralExpression(objectLiteral) ||
      state.depth > MAX_ROUTE_DEPTH
    ) {
      return
    }
    const pathProperty = objectLiteral.getProperty("path")
    const indexProperty = objectLiteral.getProperty("index")
    const childrenProperty = objectLiteral.getProperty("children")
    const hasComponent = componentProperties.some(
      (name) => objectLiteral.getProperty(name) !== undefined
    )
    // Only `lazy` is a code-splitting hook. `loader` is React Router's data
    // fetcher, and resolving it as a component source would either invent a
    // dynamic_component reason on an already-resolved route or attribute a
    // module the loader happens to import as the route's component.
    const lazyProperty = objectLiteral.getProperty("lazy")
    const isRouteShape =
      pathProperty !== undefined ||
      indexProperty !== undefined ||
      childrenProperty !== undefined ||
      hasComponent
    if (!isRouteShape) return
    if (visited.has(objectLiteral)) return
    visited.add(objectLiteral)

    const reasons: UnresolvedReason[] = []
    let declaredSegment = ""
    if (pathProperty !== undefined && Node.isPropertyAssignment(pathProperty)) {
      const parsed = readStringPath(pathProperty.getInitializer())
      if (parsed.resolved) {
        declaredSegment = parsed.value
      } else {
        reasons.push("computed_route_path")
      }
    }
    const isIndexRoute =
      indexProperty !== undefined &&
      Node.isPropertyAssignment(indexProperty) &&
      indexProperty.getInitializer()?.getText() === "true"

    const pattern = composeRoutePattern(state.parentPattern, declaredSegment)

    let resolution = emptyResolution
    for (const name of componentProperties) {
      const property = objectLiteral.getProperty(name)
      if (property === undefined) continue
      if (Node.isPropertyAssignment(property)) {
        const initializer = property.getInitializer()
        if (initializer !== undefined) {
          resolution = mergeResolutions(
            resolution,
            resolveComponentExpression(initializer, context)
          )
        }
      }
    }
    if (lazyProperty !== undefined) {
      resolution = mergeResolutions(
        resolution,
        resolveLazyComponent(lazyProperty, context)
      )
    }

    const record: RouteRecord = {
      pathPattern: pattern,
      declaredSegment,
      filePath: file.path,
      range: rangeOf(objectLiteral),
      isIndexRoute,
      componentQualifiedNames: Object.freeze([
        ...new Set(resolution.qualifiedNames),
      ]),
      layoutQualifiedNames: Object.freeze([...state.layouts]),
      unresolvedReasons: Object.freeze([
        ...new Set([...reasons, ...resolution.reasons]),
      ]),
      unresolvedComponents: Object.freeze([...new Set(resolution.unresolved)]),
    }
    if (!push(record)) return

    if (
      childrenProperty !== undefined &&
      Node.isPropertyAssignment(childrenProperty)
    ) {
      const children = childrenProperty.getInitializer()
      if (children !== undefined && Node.isArrayLiteralExpression(children)) {
        const childState: WalkState = {
          parentPattern: pattern,
          layouts: [...state.layouts, ...record.componentQualifiedNames],
          depth: state.depth + 1,
        }
        for (const element of children.getElements()) {
          walkObjectRoute(element, childState)
        }
      }
    }
  }

  const walkJsxRoute = (element: Node, state: WalkState): void => {
    if (state.depth > MAX_ROUTE_DEPTH) return
    const opening = Node.isJsxElement(element)
      ? element.getOpeningElement()
      : Node.isJsxSelfClosingElement(element)
        ? element
        : undefined
    if (opening === undefined) return
    if (opening.getTagNameNode().getText() !== "Route") return
    if (visited.has(element)) return
    visited.add(element)

    const reasons: UnresolvedReason[] = []
    const pathAttribute = opening.getAttribute("path")
    let declaredSegment = ""
    if (pathAttribute !== undefined && Node.isJsxAttribute(pathAttribute)) {
      const parsed = readStringPath(pathAttribute.getInitializer())
      if (parsed.resolved) {
        declaredSegment = parsed.value
      } else {
        reasons.push("computed_route_path")
      }
    }
    const isIndexRoute = opening.getAttribute("index") !== undefined
    const pattern = composeRoutePattern(state.parentPattern, declaredSegment)

    let resolution = emptyResolution
    for (const name of componentProperties) {
      const attribute = opening.getAttribute(name)
      if (attribute === undefined || !Node.isJsxAttribute(attribute)) continue
      const initializer = attribute.getInitializer()
      if (initializer !== undefined) {
        resolution = mergeResolutions(
          resolution,
          resolveComponentExpression(initializer, context)
        )
      }
    }

    const record: RouteRecord = {
      pathPattern: pattern,
      declaredSegment,
      filePath: file.path,
      range: rangeOf(element),
      isIndexRoute,
      componentQualifiedNames: Object.freeze([
        ...new Set(resolution.qualifiedNames),
      ]),
      layoutQualifiedNames: Object.freeze([...state.layouts]),
      unresolvedReasons: Object.freeze([
        ...new Set([...reasons, ...resolution.reasons]),
      ]),
      unresolvedComponents: Object.freeze([...new Set(resolution.unresolved)]),
    }
    if (!push(record)) return

    if (Node.isJsxElement(element)) {
      const childState: WalkState = {
        parentPattern: pattern,
        layouts: [...state.layouts, ...record.componentQualifiedNames],
        depth: state.depth + 1,
      }
      for (const child of element.getJsxChildren()) {
        walkJsxRoute(child, childState)
      }
    }
  }

  const rootState: WalkState = {
    parentPattern: "/",
    layouts: [],
    depth: 0,
  }

  // Route-object arrays assigned to a variable, the `export const router:
  // RouteObject[] = [...]` shape Hi.Events uses.
  for (const statement of file.sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer()
      if (initializer === undefined) continue
      if (!Node.isArrayLiteralExpression(initializer)) continue
      for (const element of initializer.getElements()) {
        walkObjectRoute(element, rootState)
      }
    }
  }

  // Route arrays handed to a router factory.
  file.sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return
    const callee = node.getExpression()
    const name = Node.isPropertyAccessExpression(callee)
      ? callee.getNameNode().getText()
      : callee.getText()
    if (!routerFactoryNames.has(name)) return
    for (const argument of node.getArguments()) {
      if (Node.isArrayLiteralExpression(argument)) {
        for (const element of argument.getElements()) {
          walkObjectRoute(element, rootState)
        }
        continue
      }
      walkJsxRoute(argument, rootState)
    }
  })

  // Standalone `<Routes>`/`<Route>` trees rendered inside a component.
  file.sourceFile.forEachDescendant((node) => {
    if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) return
    const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node
    if (opening.getTagNameNode().getText() !== "Routes") return
    if (!Node.isJsxElement(node)) return
    for (const child of node.getJsxChildren()) {
      walkJsxRoute(child, rootState)
    }
  })

  // Declaration order is the final tiebreak so a parent route always precedes
  // its index child, which shares both the pattern and the source line. The walk
  // order is itself deterministic, so this keeps the whole ordering reproducible.
  const declarationOrder = new Map(
    routes.map((route, ordinal) => [route, ordinal])
  )

  return {
    routes: Object.freeze(
      routes.sort((left, right) =>
        compareBy(
          compareStrings(left.pathPattern, right.pathPattern),
          compareNumbers(left.range.startLine, right.range.startLine),
          compareNumbers(
            declarationOrder.get(left) ?? 0,
            declarationOrder.get(right) ?? 0
          )
        )
      )
    ),
    warnings: Object.freeze(warnings),
  }
}
