import type { CodeSymbolId } from "@sentinel/contracts"

import { unsafeIndexerPath } from "./errors.ts"
import { compareBy, compareNumbers, compareStrings } from "./identity.ts"
import type {
  ApiCallCandidateRecord,
  CodeFileRecord,
  CodeReferenceRecord,
  CodeSymbolRecord,
  FrontendRouteRecord,
  HandlerBindingIndexRecord,
  JsxElementIndexRecord,
  ModuleRecord,
  QueryHookIndexRecord,
  TypeScriptSourceIndex,
} from "./indexer.ts"
import {
  isWithinRoot,
  normalizeIndexPath,
  normalizeRootPrefix,
} from "./reader.ts"
import type { TypeScriptSourceReader } from "./reader.ts"
import {
  readSourceSlice,
  type SourceRange,
  type SourceSlice,
} from "./slices.ts"
import type { CodeSymbolKind } from "./symbols.ts"

export interface BoundedQuery {
  readonly limit?: number
}

export interface ListModulesQuery extends BoundedQuery {
  readonly pathPrefix?: string
}

export interface SearchSymbolsQuery extends BoundedQuery {
  readonly query: string
  readonly kinds?: readonly CodeSymbolKind[]
  readonly pathPrefix?: string
  readonly exportedOnly?: boolean
}

export interface SearchTextQuery extends BoundedQuery {
  readonly query: string
  readonly pathPrefix?: string
  readonly caseSensitive?: boolean
}

export interface TextMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

export interface SymbolInspection {
  readonly symbol: CodeSymbolRecord
  readonly file: CodeFileRecord
  readonly slice: SourceSlice
  readonly outgoing: readonly CodeReferenceRecord[]
  readonly incoming: readonly CodeReferenceRecord[]
  readonly jsxElements: readonly JsxElementIndexRecord[]
  readonly handlerBindings: readonly HandlerBindingIndexRecord[]
  readonly apiCallCandidates: readonly ApiCallCandidateRecord[]
  readonly queryHooks: readonly QueryHookIndexRecord[]
}

export interface TraceStep {
  readonly symbol: CodeSymbolRecord
  readonly depth: number
  readonly viaReferenceId: CodeReferenceRecord["id"]
}

export interface ReadSliceQuery {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
}

export interface FrontendCallerQuery extends BoundedQuery {
  readonly pathTemplate: string
  readonly method?: ApiCallCandidateRecord["method"]
}

export interface FrontendCaller {
  readonly candidate: ApiCallCandidateRecord
  readonly ownerSymbol: CodeSymbolRecord
  /** Routes whose component tree reaches the calling symbol. */
  readonly routes: readonly FrontendRouteRecord[]
}

export interface TypeScriptIndexQuery {
  listModules(query?: ListModulesQuery): readonly ModuleRecord[]
  searchSymbols(query: SearchSymbolsQuery): readonly CodeSymbolRecord[]
  searchText(query: SearchTextQuery): Promise<readonly TextMatch[]>
  findDefinition(qualifiedName: string): CodeSymbolRecord | undefined
  findReferences(
    qualifiedName: string,
    query?: BoundedQuery
  ): readonly CodeReferenceRecord[]
  inspectSymbol(qualifiedName: string): Promise<SymbolInspection>
  traceCallers(
    qualifiedName: string,
    query?: BoundedQuery & { readonly depth?: number }
  ): readonly TraceStep[]
  traceCallees(
    qualifiedName: string,
    query?: BoundedQuery & { readonly depth?: number }
  ): readonly TraceStep[]
  listRoutes(
    query?: BoundedQuery & { readonly pathPrefix?: string }
  ): readonly FrontendRouteRecord[]
  findFrontendCallersForPath(
    query: FrontendCallerQuery
  ): readonly FrontendCaller[]
  readSlice(query: ReadSliceQuery): Promise<SourceSlice>
}

/**
 * Creates the bounded read-only surface the Code Explorer navigates.
 *
 * Every function clamps its result count to the index's own limits, and every
 * path argument must resolve to a file the index actually admitted. The reader
 * is retained only for on-demand slices; nothing here re-parses source, walks
 * the filesystem, or re-reads the repository outside the admitted set.
 */
export function createTypeScriptIndexQuery(
  index: TypeScriptSourceIndex,
  reader: TypeScriptSourceReader
): TypeScriptIndexQuery {
  const { limits } = index
  const filesByPath = new Map(index.files.map((file) => [file.path, file]))
  const symbolsByQualifiedName = new Map(
    index.symbols.map((symbol) => [symbol.qualifiedName, symbol])
  )
  const symbolsById = new Map(
    index.symbols.map((symbol) => [symbol.id, symbol])
  )

  const outgoingBySymbol = new Map<CodeSymbolId, CodeReferenceRecord[]>()
  const incomingBySymbol = new Map<CodeSymbolId, CodeReferenceRecord[]>()
  for (const reference of index.references) {
    const outgoing = outgoingBySymbol.get(reference.sourceSymbolId) ?? []
    outgoing.push(reference)
    outgoingBySymbol.set(reference.sourceSymbolId, outgoing)
    if (reference.targetSymbolId !== undefined) {
      const incoming = incomingBySymbol.get(reference.targetSymbolId) ?? []
      incoming.push(reference)
      incomingBySymbol.set(reference.targetSymbolId, incoming)
    }
  }

  const clamp = (limit: number | undefined): number =>
    Math.max(
      1,
      Math.min(limit ?? limits.maxQueryResults, limits.maxQueryResults)
    )

  const clampDepth = (depth: number | undefined): number =>
    Math.max(1, Math.min(depth ?? limits.maxTraceDepth, limits.maxTraceDepth))

  /**
   * Normalizes a caller-supplied path and refuses anything the index did not
   * admit. This is what stops a query from reading an excluded, vendored, or
   * out-of-root file even though the underlying snapshot exposes it.
   */
  const assertAdmittedPath = (path: string): CodeFileRecord => {
    const normalized = normalizeIndexPath(path)
    const file = filesByPath.get(normalized)
    if (file === undefined) {
      unsafeIndexerPath("Requested path is not part of the indexed source set")
    }
    return file
  }

  const withinPrefix = (path: string, prefix: string | undefined): boolean =>
    prefix === undefined || isWithinRoot(path, normalizeRootPrefix(prefix))

  const trace = (
    qualifiedName: string,
    direction: "callers" | "callees",
    query: (BoundedQuery & { readonly depth?: number }) | undefined
  ): readonly TraceStep[] => {
    const origin = symbolsByQualifiedName.get(qualifiedName)
    if (origin === undefined) return Object.freeze([])
    const maxDepth = clampDepth(query?.depth)
    const maxResults = clamp(query?.limit)
    const steps: TraceStep[] = []
    const seen = new Set<CodeSymbolId>([origin.id])
    let frontier: readonly CodeSymbolId[] = [origin.id]

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const next: CodeSymbolId[] = []
      for (const current of frontier) {
        const edges = (
          direction === "callers"
            ? incomingBySymbol.get(current)
            : outgoingBySymbol.get(current)
        )?.filter((reference) => reference.kind === "call")
        for (const reference of edges ?? []) {
          const neighbourId =
            direction === "callers"
              ? reference.sourceSymbolId
              : reference.targetSymbolId
          if (neighbourId === undefined || seen.has(neighbourId)) continue
          const neighbour = symbolsById.get(neighbourId)
          if (neighbour === undefined) continue
          seen.add(neighbourId)
          next.push(neighbourId)
          steps.push({
            symbol: neighbour,
            depth,
            viaReferenceId: reference.id,
          })
          if (steps.length >= maxResults) return Object.freeze(steps)
        }
      }
      if (next.length === 0) break
      frontier = next
    }
    return Object.freeze(steps)
  }

  return {
    listModules: (query) =>
      Object.freeze(
        index.modules
          .filter((module) => withinPrefix(module.path, query?.pathPrefix))
          .slice(0, clamp(query?.limit))
      ),

    searchSymbols: (query) => {
      const needle = query.query.trim().toLowerCase()
      const kinds = query.kinds === undefined ? undefined : new Set(query.kinds)
      return Object.freeze(
        index.symbols
          .filter(
            (symbol) =>
              (needle.length === 0 ||
                symbol.name.toLowerCase().includes(needle) ||
                symbol.qualifiedName.toLowerCase().includes(needle)) &&
              (kinds === undefined || kinds.has(symbol.kind)) &&
              withinPrefix(symbol.filePath, query.pathPrefix) &&
              (query.exportedOnly !== true || symbol.exported)
          )
          .slice(0, clamp(query.limit))
      )
    },

    searchText: async (query) => {
      const needle =
        query.caseSensitive === true ? query.query : query.query.toLowerCase()
      if (needle.length === 0) return Object.freeze([])
      const maxResults = clamp(query.limit)
      const matches: TextMatch[] = []
      for (const file of index.files) {
        if (!withinPrefix(file.path, query.pathPrefix)) continue
        if (matches.length >= maxResults) break
        const text = await reader.readText(file.path, limits.maxFileBytes)
        const lines = text.split(/\r\n|\n|\r/)
        for (const [offset, line] of lines.entries()) {
          const haystack =
            query.caseSensitive === true ? line : line.toLowerCase()
          if (!haystack.includes(needle)) continue
          matches.push({
            path: file.path,
            line: offset + 1,
            text: line.trim().slice(0, 512),
          })
          if (matches.length >= maxResults) break
        }
      }
      return Object.freeze(matches)
    },

    findDefinition: (qualifiedName) =>
      symbolsByQualifiedName.get(qualifiedName),

    findReferences: (qualifiedName, query) => {
      const symbol = symbolsByQualifiedName.get(qualifiedName)
      if (symbol === undefined) return Object.freeze([])
      return Object.freeze(
        [
          ...(incomingBySymbol.get(symbol.id) ?? []),
          ...(outgoingBySymbol.get(symbol.id) ?? []),
        ]
          .sort((left, right) =>
            compareBy(
              compareStrings(left.filePath, right.filePath),
              compareNumbers(left.range.startLine, right.range.startLine),
              compareNumbers(left.ordinal, right.ordinal)
            )
          )
          .slice(0, clamp(query?.limit))
      )
    },

    inspectSymbol: async (qualifiedName) => {
      const symbol = symbolsByQualifiedName.get(qualifiedName)
      if (symbol === undefined) {
        unsafeIndexerPath("Requested symbol is not part of the index")
      }
      const file = assertAdmittedPath(symbol.filePath)
      const text = await reader.readText(file.path, limits.maxFileBytes)
      const maxResults = clamp(undefined)
      return {
        symbol,
        file,
        slice: readSourceSlice(text, symbol.range, limits),
        outgoing: Object.freeze(
          (outgoingBySymbol.get(symbol.id) ?? []).slice(0, maxResults)
        ),
        incoming: Object.freeze(
          (incomingBySymbol.get(symbol.id) ?? []).slice(0, maxResults)
        ),
        jsxElements: Object.freeze(
          index.jsxElements
            .filter((element) => element.ownerSymbolId === symbol.id)
            .slice(0, maxResults)
        ),
        handlerBindings: Object.freeze(
          index.handlerBindings
            .filter(
              (handler) =>
                handler.ownerSymbolId === symbol.id ||
                handler.handlerSymbolId === symbol.id
            )
            .slice(0, maxResults)
        ),
        apiCallCandidates: Object.freeze(
          index.apiCallCandidates
            .filter((candidate) => candidate.ownerSymbolId === symbol.id)
            .slice(0, maxResults)
        ),
        queryHooks: Object.freeze(
          index.queryHooks
            .filter(
              (hook) =>
                hook.ownerSymbolId === symbol.id ||
                hook.callTargetSymbolIds.includes(symbol.id)
            )
            .slice(0, maxResults)
        ),
      }
    },

    traceCallers: (qualifiedName, query) =>
      trace(qualifiedName, "callers", query),

    traceCallees: (qualifiedName, query) =>
      trace(qualifiedName, "callees", query),

    listRoutes: (query) =>
      Object.freeze(
        index.routes
          .filter(
            (route) =>
              query?.pathPrefix === undefined ||
              route.pathPattern.startsWith(query.pathPrefix)
          )
          .slice(0, clamp(query?.limit))
      ),

    findFrontendCallersForPath: (query) => {
      const wanted = query.pathTemplate
      const maxResults = clamp(query.limit)
      const routesBySymbol = new Map<CodeSymbolId, FrontendRouteRecord[]>()
      for (const route of index.routes) {
        for (const symbolId of [
          ...route.componentSymbolIds,
          ...route.layoutSymbolIds,
        ]) {
          const entries = routesBySymbol.get(symbolId) ?? []
          entries.push(route)
          routesBySymbol.set(symbolId, entries)
        }
      }
      return Object.freeze(
        index.apiCallCandidates
          .filter(
            (candidate) =>
              candidate.pathTemplate === wanted &&
              (query.method === undefined || candidate.method === query.method)
          )
          .map((candidate) => {
            const ownerSymbol = symbolsById.get(candidate.ownerSymbolId)
            if (ownerSymbol === undefined) return undefined
            // Walk call edges backwards to find route components that reach the
            // calling symbol, bounded by the configured trace depth.
            const reached = new Set<CodeSymbolId>([candidate.ownerSymbolId])
            let frontier: readonly CodeSymbolId[] = [candidate.ownerSymbolId]
            const routes: FrontendRouteRecord[] = []
            for (
              let depth = 0;
              depth < limits.maxTraceDepth && frontier.length > 0;
              depth += 1
            ) {
              const next: CodeSymbolId[] = []
              for (const current of frontier) {
                for (const route of routesBySymbol.get(current) ?? []) {
                  if (!routes.includes(route)) routes.push(route)
                }
                for (const reference of incomingBySymbol.get(current) ?? []) {
                  if (reached.has(reference.sourceSymbolId)) continue
                  reached.add(reference.sourceSymbolId)
                  next.push(reference.sourceSymbolId)
                }
              }
              frontier = next
            }
            return {
              candidate,
              ownerSymbol,
              routes: Object.freeze(
                routes.sort((left, right) =>
                  compareStrings(left.pathPattern, right.pathPattern)
                )
              ),
            } satisfies FrontendCaller
          })
          .filter((caller): caller is FrontendCaller => caller !== undefined)
          .slice(0, maxResults)
      )
    },

    readSlice: async (query) => {
      const file = assertAdmittedPath(query.path)
      const text = await reader.readText(file.path, limits.maxFileBytes)
      const range: SourceRange = {
        startLine: query.startLine,
        endLine: query.endLine,
      }
      return readSourceSlice(text, range, limits)
    },
  }
}
