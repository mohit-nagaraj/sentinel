import {
  createRunScopedEvidenceId,
  hashCanonical,
  parseCodeFactEnvelope,
  type ApplicationId,
  type CodeFactEnvelope,
  type CodeFileId,
  type CodeSymbolId,
  type CommitSha,
  type ContentHash,
  type EvidenceId,
  type FrontendRouteId,
  type RunId,
} from "@sentinel/contracts"
import type { Node } from "ts-morph"

import {
  extractApiCalls,
  type ApiCallCandidate,
  type QueryHookRecord,
} from "./api-calls.ts"
import {
  TypeScriptIndexerError,
  throwIfAborted,
  type IndexWarning,
  type UnresolvedReason,
} from "./errors.ts"
import {
  compareBy,
  compareNumbers,
  compareStrings,
  createCodeFileId,
  createCodeSymbolId,
  createFrontendRouteId,
  typeScriptExtractorIdentity,
  TYPESCRIPT_INDEXER_VERSION,
  type CommitScope,
  type IndexRepositoryIdentity,
} from "./identity.ts"
import {
  extractJsx,
  type HandlerBindingRecord,
  type JsxElementRecord,
} from "./jsx.ts"
import { resolveIndexLimits, type TypeScriptIndexLimits } from "./limits.ts"
import { defaultIndexPolicy, type IndexPolicy } from "./policy.ts"
import { loadTypeScriptProject, type DetectedProjectConfig } from "./project.ts"
import {
  extractReferences,
  type ImportRecord,
  type ReferenceKind,
} from "./references.ts"
import { extractRoutes, type RouteRecord } from "./routes.ts"
import { countSourceLines, type SourceRange } from "./slices.ts"
import {
  extractSymbols,
  type CodeSymbolKind,
  type SymbolRecord,
} from "./symbols.ts"
import type { TypeScriptSourceReader } from "./reader.ts"

const CODE_REFERENCE_EVIDENCE_KIND = "code_reference"

export interface TypeScriptIndexRequest {
  readonly reader: TypeScriptSourceReader
  readonly applicationId: ApplicationId
  readonly runId: RunId
  readonly repository: IndexRepositoryIdentity
  readonly commitSha: CommitSha
  /** Repository-relative source roots. Empty means the whole repository. */
  readonly roots?: readonly string[]
  readonly policy?: IndexPolicy
  readonly limits?: Partial<TypeScriptIndexLimits>
  readonly tsconfigPath?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface CodeFileRecord {
  readonly id: CodeFileId
  readonly path: string
  readonly language: "typescript" | "tsx"
  readonly contentHash: ContentHash
  readonly sizeBytes: number
  readonly lineCount: number
}

export interface CodeSymbolRecord {
  readonly id: CodeSymbolId
  readonly fileId: CodeFileId
  readonly filePath: string
  readonly qualifiedName: string
  readonly name: string
  readonly kind: CodeSymbolKind
  readonly language: "typescript" | "tsx"
  readonly range: SourceRange
  readonly exported: boolean
  readonly exportName: string | undefined
}

export interface CodeReferenceRecord {
  readonly id: EvidenceId
  /**
   * Run-independent digest of the edge. Ordinals are assigned from a sort over
   * this value, which is what makes evidence IDs reproducible for a given
   * commit, policy, and indexer version.
   */
  readonly referenceKey: ContentHash
  readonly ordinal: number
  readonly kind: ReferenceKind
  readonly filePath: string
  readonly sourceSymbolId: CodeSymbolId
  readonly sourceQualifiedName: string
  readonly targetSymbolId: CodeSymbolId | undefined
  readonly targetQualifiedName: string | undefined
  readonly unresolvedTarget: string | undefined
  readonly unresolvedReason: UnresolvedReason | undefined
  readonly range: SourceRange
}

export interface FrontendRouteRecord extends RouteRecord {
  readonly id: FrontendRouteId
  readonly componentSymbolIds: readonly CodeSymbolId[]
  readonly layoutSymbolIds: readonly CodeSymbolId[]
}

export interface JsxElementIndexRecord extends JsxElementRecord {
  readonly ownerSymbolId: CodeSymbolId
}

export interface HandlerBindingIndexRecord extends HandlerBindingRecord {
  readonly ownerSymbolId: CodeSymbolId
  readonly handlerSymbolId: CodeSymbolId | undefined
}

export interface ApiCallCandidateRecord extends ApiCallCandidate {
  readonly ownerSymbolId: CodeSymbolId
}

export interface QueryHookIndexRecord extends QueryHookRecord {
  readonly ownerSymbolId: CodeSymbolId
  readonly callTargetSymbolIds: readonly CodeSymbolId[]
}

export interface ModuleRecord {
  /** Repository-relative directory path; the empty string is the root. */
  readonly path: string
  readonly fileCount: number
  readonly symbolCount: number
  readonly childDirectories: readonly string[]
}

/**
 * Deterministic counts derived from the indexed tree. Wall-clock timing is
 * deliberately kept out of here — see {@link TypeScriptSourceIndex.elapsedMs} —
 * so a consumer can treat this whole object as reproducible.
 */
export interface IndexStatistics {
  readonly fileCount: number
  readonly symbolCount: number
  readonly referenceCount: number
  readonly routeCount: number
  readonly nodeCount: number
  readonly totalBytes: number
}

export interface TypeScriptSourceIndex {
  readonly indexerVersion: string
  readonly indexFingerprint: ContentHash
  readonly applicationId: ApplicationId
  readonly runId: RunId
  readonly repository: IndexRepositoryIdentity
  readonly commitSha: CommitSha
  readonly roots: readonly string[]
  readonly policy: IndexPolicy
  readonly limits: TypeScriptIndexLimits
  readonly config: DetectedProjectConfig
  readonly modules: readonly ModuleRecord[]
  readonly files: readonly CodeFileRecord[]
  readonly symbols: readonly CodeSymbolRecord[]
  readonly references: readonly CodeReferenceRecord[]
  readonly imports: readonly ImportRecord[]
  readonly routes: readonly FrontendRouteRecord[]
  readonly jsxElements: readonly JsxElementIndexRecord[]
  readonly handlerBindings: readonly HandlerBindingIndexRecord[]
  readonly apiCallCandidates: readonly ApiCallCandidateRecord[]
  readonly queryHooks: readonly QueryHookIndexRecord[]
  readonly warnings: readonly IndexWarning[]
  /**
   * Contract-validated fact envelopes for the kinds `@sentinel/contracts`
   * models today: code files, symbols, references, and frontend routes.
   */
  readonly facts: readonly CodeFactEnvelope[]
  readonly statistics: IndexStatistics
  /**
   * Measured wall-clock duration of the index. This is the only part of the
   * result that varies between runs over identical inputs.
   */
  readonly elapsedMs: number
}

function buildModules(
  files: readonly CodeFileRecord[],
  symbols: readonly CodeSymbolRecord[]
): readonly ModuleRecord[] {
  const fileCounts = new Map<string, number>()
  const symbolCounts = new Map<string, number>()
  const children = new Map<string, Set<string>>()

  const ensure = (directory: string): void => {
    if (!fileCounts.has(directory)) fileCounts.set(directory, 0)
    if (!symbolCounts.has(directory)) symbolCounts.set(directory, 0)
    if (!children.has(directory)) children.set(directory, new Set())
  }

  const directoryOf = (path: string): string => {
    const index = path.lastIndexOf("/")
    return index === -1 ? "" : path.slice(0, index)
  }

  const registerAncestors = (directory: string): void => {
    ensure(directory)
    const segments = directory.split("/").filter(Boolean)
    for (let depth = segments.length; depth > 0; depth -= 1) {
      const current = segments.slice(0, depth).join("/")
      const parent = segments.slice(0, depth - 1).join("/")
      ensure(current)
      ensure(parent)
      children.get(parent)?.add(current)
    }
  }

  for (const file of files) {
    const directory = directoryOf(file.path)
    registerAncestors(directory)
    fileCounts.set(directory, (fileCounts.get(directory) ?? 0) + 1)
  }
  for (const symbol of symbols) {
    const directory = directoryOf(symbol.filePath)
    ensure(directory)
    symbolCounts.set(directory, (symbolCounts.get(directory) ?? 0) + 1)
  }

  return Object.freeze(
    [...fileCounts.keys()].sort(compareStrings).map((path) => ({
      path,
      fileCount: fileCounts.get(path) ?? 0,
      symbolCount: symbolCounts.get(path) ?? 0,
      childDirectories: Object.freeze(
        [...(children.get(path) ?? [])].sort(compareStrings)
      ),
    }))
  )
}

/**
 * Builds a deterministic structural index of a TypeScript/React source tree.
 *
 * The sequence is fixed — load, symbols, references, React structures, assemble
 * — because reference and route resolution both need the complete symbol index
 * before they can resolve across files. Every collection is sorted by a
 * documented comparator before it is returned, so two indexes over identical
 * inputs are byte-identical.
 */
export async function indexTypeScriptSource(
  request: TypeScriptIndexRequest
): Promise<TypeScriptSourceIndex> {
  const limits = resolveIndexLimits(request.limits ?? {})
  const policy = request.policy ?? defaultIndexPolicy
  const roots =
    (request.roots ?? [""]).length === 0 ? [""] : [...(request.roots ?? [""])]
  const scope: CommitScope = {
    applicationId: request.applicationId,
    repository: request.repository,
    commitSha: request.commitSha,
  }

  const loaded = await loadTypeScriptProject({
    reader: request.reader,
    roots,
    policy,
    limits,
    ...(request.tsconfigPath === undefined
      ? {}
      : { tsconfigPath: request.tsconfigPath }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.now === undefined ? {} : { now: request.now }),
  })

  try {
    const { budget } = loaded
    const warnings: IndexWarning[] = [...loaded.warnings]

    // Pass 1 — symbols for every admitted file, so later passes can resolve
    // across file boundaries.
    const byDeclaration = new Map<Node, SymbolRecord>()
    const symbolsByFile = new Map<string, readonly SymbolRecord[]>()
    let nodeCount = 0
    for (const file of loaded.files) {
      throwIfAborted(request.signal)
      if (budget.timedOut) {
        warnings.push({ reason: "time_budget_exhausted", path: file.path })
        continue
      }
      if (budget.nodesExhausted) {
        warnings.push({ reason: "node_budget_exhausted", path: file.path })
        continue
      }
      const extraction = extractSymbols(file, limits, budget)
      nodeCount += extraction.nodeCount
      symbolsByFile.set(file.path, extraction.symbols)
      warnings.push(...extraction.warnings)
      for (const [declaration, symbol] of extraction.byDeclaration) {
        byDeclaration.set(declaration, symbol)
      }
    }

    const files: CodeFileRecord[] = loaded.files.map((file) => ({
      id: createCodeFileId(scope, file.path),
      path: file.path,
      language: file.language,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      lineCount: countSourceLines(file.sourceFile.getFullText()),
    }))
    const fileIdByPath = new Map(files.map((file) => [file.path, file.id]))

    const symbols: CodeSymbolRecord[] = []
    const symbolIdByQualifiedName = new Map<string, CodeSymbolId>()
    for (const file of loaded.files) {
      for (const symbol of symbolsByFile.get(file.path) ?? []) {
        const fileId = fileIdByPath.get(symbol.filePath)
        if (fileId === undefined) continue
        const id = createCodeSymbolId(
          scope,
          symbol.filePath,
          symbol.qualifiedName,
          symbol.kind
        )
        symbolIdByQualifiedName.set(symbol.qualifiedName, id)
        symbols.push({
          id,
          fileId,
          filePath: symbol.filePath,
          qualifiedName: symbol.qualifiedName,
          name: symbol.name,
          kind: symbol.kind,
          language: symbol.language,
          range: symbol.range,
          exported: symbol.exported,
          exportName: symbol.exportName,
        })
      }
    }

    const indexedNames = new Set(
      [...symbolsByFile.values()].flatMap((entries) =>
        entries.map((symbol) => symbol.name)
      )
    )

    // Pass 2 — references, React structures, and API candidates.
    const imports: ImportRecord[] = []
    const routes: FrontendRouteRecord[] = []
    const jsxElements: JsxElementIndexRecord[] = []
    const handlerBindings: HandlerBindingIndexRecord[] = []
    const apiCallCandidates: ApiCallCandidateRecord[] = []
    const queryHooks: QueryHookIndexRecord[] = []
    interface PendingReference {
      readonly kind: ReferenceKind
      readonly filePath: string
      readonly sourceSymbolId: CodeSymbolId
      readonly sourceQualifiedName: string
      readonly targetSymbolId: CodeSymbolId | undefined
      readonly targetQualifiedName: string | undefined
      readonly unresolvedTarget: string | undefined
      readonly unresolvedReason: UnresolvedReason | undefined
      readonly range: SourceRange
      readonly referenceKey: ContentHash
    }
    const pending: PendingReference[] = []

    for (const file of loaded.files) {
      throwIfAborted(request.signal)
      if (budget.timedOut) {
        warnings.push({ reason: "time_budget_exhausted", path: file.path })
        continue
      }
      const fileSymbols = symbolsByFile.get(file.path) ?? []
      if (fileSymbols.length === 0) continue

      const referenceExtraction = extractReferences(
        file,
        fileSymbols,
        byDeclaration,
        indexedNames,
        limits
      )
      imports.push(...referenceExtraction.imports)
      warnings.push(...referenceExtraction.warnings)
      for (const reference of referenceExtraction.references) {
        const sourceSymbolId = symbolIdByQualifiedName.get(
          reference.fromQualifiedName
        )
        if (sourceSymbolId === undefined) continue
        const targetSymbolId =
          reference.targetQualifiedName === undefined
            ? undefined
            : symbolIdByQualifiedName.get(reference.targetQualifiedName)
        pending.push({
          kind: reference.kind,
          filePath: reference.filePath,
          sourceSymbolId,
          sourceQualifiedName: reference.fromQualifiedName,
          targetSymbolId,
          targetQualifiedName: reference.targetQualifiedName,
          unresolvedTarget: reference.unresolvedTarget,
          unresolvedReason: reference.unresolvedReason,
          range: reference.range,
          referenceKey: hashCanonical({
            kind: reference.kind,
            range: reference.range,
            source: reference.fromQualifiedName,
            target: reference.targetQualifiedName ?? null,
            unresolved: reference.unresolvedTarget ?? null,
          }),
        })
      }

      const routeExtraction = extractRoutes(
        file,
        loaded.project,
        byDeclaration,
        symbolsByFile,
        limits
      )
      warnings.push(...routeExtraction.warnings)
      for (const route of routeExtraction.routes) {
        const componentSymbolIds = route.componentQualifiedNames
          .map((name) => symbolIdByQualifiedName.get(name))
          .filter((id): id is CodeSymbolId => id !== undefined)
        const layoutSymbolIds = route.layoutQualifiedNames
          .map((name) => symbolIdByQualifiedName.get(name))
          .filter((id): id is CodeSymbolId => id !== undefined)
        routes.push({
          ...route,
          id: createFrontendRouteId(scope, route.pathPattern),
          componentSymbolIds: Object.freeze(componentSymbolIds),
          layoutSymbolIds: Object.freeze(layoutSymbolIds),
        })
      }

      const jsxExtraction = extractJsx(file, fileSymbols, byDeclaration, limits)
      warnings.push(...jsxExtraction.warnings)
      for (const element of jsxExtraction.elements) {
        const ownerSymbolId = symbolIdByQualifiedName.get(
          element.ownerQualifiedName
        )
        if (ownerSymbolId === undefined) continue
        jsxElements.push({ ...element, ownerSymbolId })
      }
      for (const handler of jsxExtraction.handlers) {
        const ownerSymbolId = symbolIdByQualifiedName.get(
          handler.ownerQualifiedName
        )
        if (ownerSymbolId === undefined) continue
        handlerBindings.push({
          ...handler,
          ownerSymbolId,
          handlerSymbolId:
            handler.handlerQualifiedName === undefined
              ? undefined
              : symbolIdByQualifiedName.get(handler.handlerQualifiedName),
        })
      }

      const apiExtraction = extractApiCalls(
        file,
        fileSymbols,
        byDeclaration,
        limits
      )
      warnings.push(...apiExtraction.warnings)
      for (const candidate of apiExtraction.candidates) {
        const ownerSymbolId = symbolIdByQualifiedName.get(
          candidate.ownerQualifiedName
        )
        if (ownerSymbolId === undefined) continue
        apiCallCandidates.push({ ...candidate, ownerSymbolId })
      }
      for (const hook of apiExtraction.hooks) {
        const ownerSymbolId = symbolIdByQualifiedName.get(
          hook.ownerQualifiedName
        )
        if (ownerSymbolId === undefined) continue
        queryHooks.push({
          ...hook,
          ownerSymbolId,
          callTargetSymbolIds: Object.freeze(
            hook.callTargetQualifiedNames
              .map((name) => symbolIdByQualifiedName.get(name))
              .filter((id): id is CodeSymbolId => id !== undefined)
          ),
        })
      }
    }

    // Ordinals come from the run-independent reference key, so the same commit
    // always produces the same evidence IDs for a given run.
    const references: CodeReferenceRecord[] = pending
      .sort((left, right) =>
        compareStrings(left.referenceKey, right.referenceKey)
      )
      .map((reference, ordinal) => ({
        ...reference,
        ordinal,
        id: createRunScopedEvidenceId({
          applicationId: request.applicationId,
          runId: request.runId,
          sourceId: reference.sourceSymbolId,
          kind: CODE_REFERENCE_EVIDENCE_KIND,
          ordinal,
        }),
      }))

    const sortedFiles = Object.freeze(
      files.sort((left, right) => compareStrings(left.path, right.path))
    )
    const sortedSymbols = Object.freeze(
      symbols.sort((left, right) =>
        compareBy(
          compareStrings(left.filePath, right.filePath),
          compareNumbers(left.range.startLine, right.range.startLine),
          compareStrings(left.qualifiedName, right.qualifiedName)
        )
      )
    )
    const sortedRoutes = Object.freeze(
      routes.sort((left, right) =>
        compareBy(
          compareStrings(left.pathPattern, right.pathPattern),
          compareStrings(left.filePath, right.filePath),
          compareNumbers(left.range.startLine, right.range.startLine)
        )
      )
    )

    const contentHashByPath = new Map(
      loaded.files.map((file) => [file.path, file.contentHash])
    )
    const provenanceFor = (
      path: string | undefined
    ): {
      readonly sourceKind: "repository"
      readonly repository: IndexRepositoryIdentity
      readonly commitSha: CommitSha
      readonly contentHash?: ContentHash
    } => {
      const contentHash =
        path === undefined ? undefined : contentHashByPath.get(path)
      return {
        sourceKind: "repository",
        repository: request.repository,
        commitSha: request.commitSha,
        ...(contentHash === undefined ? {} : { contentHash }),
      }
    }

    const facts: CodeFactEnvelope[] = []
    for (const file of sortedFiles) {
      facts.push(
        parseCodeFactEnvelope({
          schemaVersion: 1,
          extractor: typeScriptExtractorIdentity,
          provenance: provenanceFor(file.path),
          factKind: "code_file",
          fact: {
            id: file.id,
            applicationId: request.applicationId,
            repository: request.repository,
            commitSha: request.commitSha,
            path: file.path,
            language: file.language,
            contentHash: file.contentHash,
          },
        })
      )
    }
    for (const symbol of sortedSymbols) {
      facts.push(
        parseCodeFactEnvelope({
          schemaVersion: 1,
          extractor: typeScriptExtractorIdentity,
          provenance: provenanceFor(symbol.filePath),
          factKind: "code_symbol",
          fact: {
            id: symbol.id,
            applicationId: request.applicationId,
            repository: request.repository,
            commitSha: request.commitSha,
            language: symbol.language,
            kind: symbol.kind,
            qualifiedName: symbol.qualifiedName,
            filePath: symbol.filePath,
            range: symbol.range,
          },
        })
      )
    }
    for (const reference of references) {
      facts.push(
        parseCodeFactEnvelope({
          schemaVersion: 1,
          extractor: typeScriptExtractorIdentity,
          provenance: provenanceFor(reference.filePath),
          factKind: "code_reference",
          fact: {
            id: reference.id,
            applicationId: request.applicationId,
            sourceSymbolId: reference.sourceSymbolId,
            ...(reference.targetSymbolId === undefined
              ? {}
              : { targetSymbolId: reference.targetSymbolId }),
            ...(reference.targetSymbolId !== undefined ||
            reference.unresolvedTarget === undefined
              ? {}
              : { unresolvedTarget: reference.unresolvedTarget }),
            kind: reference.kind,
            range: reference.range,
          },
        })
      )
    }
    for (const route of sortedRoutes) {
      // The contract requires at least one component, so an unresolved route
      // stays an indexer record and never becomes a published fact.
      if (route.componentSymbolIds.length === 0) continue
      facts.push(
        parseCodeFactEnvelope({
          schemaVersion: 1,
          extractor: typeScriptExtractorIdentity,
          provenance: provenanceFor(route.filePath),
          factKind: "frontend_route",
          fact: {
            id: route.id,
            applicationId: request.applicationId,
            repository: request.repository,
            commitSha: request.commitSha,
            pathPattern: route.pathPattern,
            componentSymbolIds: [...route.componentSymbolIds],
            sourceRange: route.range,
          },
        })
      )
    }

    const indexFingerprint = hashCanonical({
      commitSha: request.commitSha,
      files: sortedFiles.map((file) => ({
        contentHash: file.contentHash,
        path: file.path,
      })),
      indexerVersion: TYPESCRIPT_INDEXER_VERSION,
      limits,
      policy,
      repository: request.repository,
      roots: [...roots].sort(compareStrings),
      tsconfigPath: loaded.config.tsconfigPath,
    })

    return {
      indexerVersion: TYPESCRIPT_INDEXER_VERSION,
      indexFingerprint,
      applicationId: request.applicationId,
      runId: request.runId,
      repository: request.repository,
      commitSha: request.commitSha,
      roots: Object.freeze([...roots]),
      policy,
      limits,
      config: loaded.config,
      modules: buildModules(sortedFiles, sortedSymbols),
      files: sortedFiles,
      symbols: sortedSymbols,
      references: Object.freeze(references),
      imports: Object.freeze(
        imports.sort((left, right) =>
          compareBy(
            compareStrings(left.filePath, right.filePath),
            compareNumbers(left.range.startLine, right.range.startLine),
            compareStrings(left.moduleSpecifier, right.moduleSpecifier)
          )
        )
      ),
      routes: sortedRoutes,
      jsxElements: Object.freeze(
        jsxElements.sort((left, right) =>
          compareBy(
            compareStrings(left.filePath, right.filePath),
            compareNumbers(left.range.startLine, right.range.startLine),
            compareStrings(left.tagName, right.tagName)
          )
        )
      ),
      handlerBindings: Object.freeze(
        handlerBindings.sort((left, right) =>
          compareBy(
            compareStrings(left.filePath, right.filePath),
            compareNumbers(left.range.startLine, right.range.startLine),
            compareStrings(left.event, right.event)
          )
        )
      ),
      apiCallCandidates: Object.freeze(
        apiCallCandidates.sort((left, right) =>
          compareBy(
            compareStrings(left.filePath, right.filePath),
            compareNumbers(left.range.startLine, right.range.startLine),
            compareStrings(left.method ?? "", right.method ?? ""),
            compareStrings(left.pathTemplate ?? "", right.pathTemplate ?? "")
          )
        )
      ),
      queryHooks: Object.freeze(
        queryHooks.sort((left, right) =>
          compareBy(
            compareStrings(left.filePath, right.filePath),
            compareNumbers(left.range.startLine, right.range.startLine),
            compareStrings(left.hook, right.hook)
          )
        )
      ),
      warnings: Object.freeze(
        warnings.sort((left, right) =>
          compareBy(
            compareStrings(left.path, right.path),
            compareStrings(left.reason, right.reason),
            compareStrings(left.detail ?? "", right.detail ?? "")
          )
        )
      ),
      facts: Object.freeze(facts),
      statistics: {
        fileCount: sortedFiles.length,
        symbolCount: sortedSymbols.length,
        referenceCount: references.length,
        routeCount: sortedRoutes.length,
        nodeCount,
        totalBytes: budget.bytes,
      },
      elapsedMs: budget.elapsedMs,
    }
  } catch (error) {
    if (error instanceof TypeScriptIndexerError) throw error
    throw new TypeScriptIndexerError(
      "read_failed",
      error instanceof Error ? error.message : "TypeScript indexing failed"
    )
  } finally {
    // Releases the language service's compiler caches, which are not reclaimed
    // by garbage collection and would otherwise grow across runs.
    loaded.dispose()
  }
}
