import {
  codeSymbolIdSchema,
  codeToolObservationSchema,
  createRunScopedEvidenceId,
  createStableKey,
  hashCanonical,
  type ApplicationId,
  type CodeExplorerEntity,
  type CodeSourceEvidence,
  type CodeStructuralEdge,
  type CodeSymbolId,
  type CodeToolObservation,
  type CodeUnresolvedBoundary,
  type EvidenceId,
  type RunId,
} from "@sentinel/contracts"
import { persistedTextSchema } from "@sentinel/contracts"

import type { CheckoutSnapshot } from "../source/github/checkout.ts"
import type { EndpointEvidence } from "../source/endpoint/schema.ts"
import {
  createEndpointTemplate,
  normalizeEndpointPath,
} from "../source/endpoint/normalize.ts"
import type {
  CodeReferenceRecord,
  CodeSymbolRecord,
  TypeScriptSourceIndex,
} from "../source/typescript/indexer.ts"
import type { TypeScriptIndexQuery } from "../source/typescript/query.ts"
import type { PhpRelationship, PhpSymbol } from "../php-laravel/schema.ts"
import { PhpCodeIndex } from "../php-laravel/queries.ts"

export type CodeLanguage = "php" | "tsx" | "typescript"
type Language = CodeLanguage
type HttpMethod = EndpointEvidence["endpoint"]["method"]

export interface CodeRepositoryScope {
  readonly repositoryPaths: readonly string[]
  readonly languages: readonly Language[]
}

export interface CodeRepositoryLimits {
  readonly maxResults: number
  readonly maxHops: number
  readonly maxSourceLines: number
  readonly maxSourceCharacters: number
}

export interface TypeScriptCodeSource {
  readonly index: TypeScriptSourceIndex
  readonly query: TypeScriptIndexQuery
}

export interface PhpCodeSource {
  readonly index: PhpCodeIndex
  readonly snapshot: CheckoutSnapshot
}

export interface CodeExplorerRepositoryOptions {
  readonly applicationId: ApplicationId
  readonly runId: RunId
  readonly typescript?: TypeScriptCodeSource
  readonly php?: PhpCodeSource
  readonly endpoints?: readonly EndpointEvidence[]
}

export class CodeExplorerRepositoryError extends Error {
  readonly code = "identity_mismatch" as const

  constructor() {
    super(
      "Code Explorer repository sources do not share one immutable identity"
    )
    this.name = "CodeExplorerRepositoryError"
  }
}

export interface RepositoryTextQuery {
  readonly query: string
  readonly caseSensitive?: boolean | undefined
  readonly pathPrefix?: string | undefined
  readonly languages?: readonly Language[] | undefined
  readonly limit?: number | undefined
}

export interface RepositorySymbolQuery {
  readonly query: string
  readonly pathPrefix?: string | undefined
  readonly languages?: readonly Language[] | undefined
  readonly limit?: number | undefined
}

export interface RepositoryTraceQuery {
  readonly symbolId: CodeSymbolId
  readonly maxHops?: number | undefined
  readonly limit?: number | undefined
}

export interface RepositoryEndpointQuery {
  readonly method: HttpMethod
  readonly normalizedPath: string
  readonly limit?: number | undefined
}

export type RepositoryTestQuery =
  | {
      readonly targetKind: "symbol"
      readonly symbolId: CodeSymbolId
      readonly limit?: number | undefined
    }
  | {
      readonly targetKind: "endpoint"
      readonly method: HttpMethod
      readonly normalizedPath: string
      readonly limit?: number | undefined
    }
  | {
      readonly targetKind: "text"
      readonly query: string
      readonly limit?: number | undefined
    }

interface UnifiedSymbol {
  readonly entity: Extract<CodeExplorerEntity, { entityType: "symbol" }>
  readonly origin: "typescript" | "php"
  readonly typescript?: CodeSymbolRecord
  readonly php?: PhpSymbol
}

interface EvidenceParts {
  readonly evidence: readonly CodeSourceEvidence[]
  readonly edges: readonly CodeStructuralEdge[]
  readonly unresolved: readonly CodeUnresolvedBoundary[]
}

const allLanguages = ["php", "tsx", "typescript"] as const

function compareStrings(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function repositoryKey(repository: {
  readonly host: string
  readonly owner: string
  readonly name: string
}): string {
  return `${repository.host}\0${repository.owner}\0${repository.name}`
}

function directoryOf(path: string): string {
  const separator = path.lastIndexOf("/")
  return separator < 0 ? "" : path.slice(0, separator)
}

function parentDirectories(path: string): readonly string[] {
  const directory = directoryOf(path)
  const parts = directory.split("/").filter(Boolean)
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"))
}

function isWithinPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function pathAllowed(path: string, scope: CodeRepositoryScope): boolean {
  return scope.repositoryPaths.some((prefix) => isWithinPath(path, prefix))
}

function languageAllowed(
  language: Language,
  scope: CodeRepositoryScope,
  requested?: readonly Language[]
): boolean {
  return (
    scope.languages.includes(language) &&
    (requested === undefined || requested.includes(language))
  )
}

function endpointEvidenceAllowed(
  evidence: EndpointEvidence,
  scope: CodeRepositoryScope
): boolean {
  if (
    evidence.provenance.filePath !== undefined &&
    !pathAllowed(evidence.provenance.filePath, scope)
  ) {
    return false
  }
  if (
    evidence.sourceKind === "laravel" ||
    evidence.sourceKind === "route_list"
  ) {
    return scope.languages.includes("php")
  }
  if (evidence.sourceKind === "frontend") {
    return (
      scope.languages.includes("typescript") || scope.languages.includes("tsx")
    )
  }
  return true
}

function isTestPath(path: string): boolean {
  return (
    /(^|\/)(?:__tests__|tests?|spec)(?:\/|$)/i.test(path) ||
    /\.(?:test|spec)\.[^.\/]+$/i.test(path)
  )
}

function phpLanguage(): Language {
  return "php"
}

function phpSymbolKind(symbol: PhpSymbol): string {
  return symbol.role === "other" ? symbol.kind : symbol.role
}

function sourceLineCount(range: {
  startLine: number
  endLine: number
}): number {
  return range.endLine - range.startLine + 1
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const candidate = key(value)
    if (seen.has(candidate)) return false
    seen.add(candidate)
    return true
  })
}

function observation(input: {
  readonly toolName: CodeToolObservation["toolName"]
  readonly summary: string
  readonly entities?: readonly CodeExplorerEntity[]
  readonly edges?: readonly CodeStructuralEdge[]
  readonly sourceSlices?: CodeToolObservation["sourceSlices"]
  readonly evidence?: readonly CodeSourceEvidence[]
  readonly unresolved?: readonly CodeUnresolvedBoundary[]
  readonly traversalHops?: number
}): CodeToolObservation {
  const entities = uniqueBy(input.entities ?? [], (entity) =>
    "id" in entity ? entity.id : entity.key
  )
  const edges = uniqueBy(
    input.edges ?? [],
    (edge) =>
      `${edge.kind}\0${edge.sourceId}\0${edge.targetId ?? edge.unresolvedTarget}`
  )
  const sourceSlices = uniqueBy(
    input.sourceSlices ?? [],
    (slice) =>
      `${slice.filePath}\0${slice.range.startLine}\0${slice.range.endLine}`
  )
  const evidence = uniqueBy(
    input.evidence ?? [],
    ({ evidenceId }) => evidenceId
  )
  const unresolved = uniqueBy(
    input.unresolved ?? [],
    (boundary) =>
      `${boundary.kind}\0${boundary.reasonCode}\0${boundary.question}`
  )
  const sortEntities = [...entities].sort((left, right) =>
    compareStrings(
      "id" in left ? left.id : left.key,
      "id" in right ? right.id : right.key
    )
  )
  const sortEdges = [...edges].sort((left, right) =>
    compareStrings(
      `${left.sourceId}\0${left.kind}\0${left.targetId ?? left.unresolvedTarget}`,
      `${right.sourceId}\0${right.kind}\0${right.targetId ?? right.unresolvedTarget}`
    )
  )
  const sortEvidence = [...evidence].sort((left, right) =>
    compareStrings(left.evidenceId, right.evidenceId)
  )
  const sortUnresolved = [...unresolved].sort((left, right) =>
    compareStrings(
      `${left.kind}\0${left.reasonCode}\0${left.question}`,
      `${right.kind}\0${right.reasonCode}\0${right.question}`
    )
  )
  const chargedRanges = uniqueBy(
    [
      ...sourceSlices.map(({ filePath, range }) => ({ filePath, range })),
      ...sortEntities.flatMap((entity) =>
        entity.entityType === "text_match"
          ? [{ filePath: entity.filePath, range: entity.range }]
          : []
      ),
    ],
    ({ filePath, range }) => `${filePath}\0${range.startLine}\0${range.endLine}`
  )
  const sourceLines = chargedRanges.reduce(
    (total, { range }) => total + sourceLineCount(range),
    0
  )
  const contentBytes =
    sourceSlices.reduce(
      (total, slice) => total + Buffer.byteLength(slice.text, "utf8"),
      0
    ) +
    sortEntities.reduce(
      (total, entity) =>
        total +
        (entity.entityType === "text_match"
          ? Buffer.byteLength(entity.text, "utf8")
          : 0),
      0
    )
  return codeToolObservationSchema.parse({
    schemaVersion: 1,
    toolName: input.toolName,
    summary: input.summary,
    entities: sortEntities,
    edges: sortEdges,
    sourceSlices,
    evidence: sortEvidence,
    unresolved: sortUnresolved,
    metrics: {
      sourceLines,
      contentBytes,
      resultItems:
        sortEntities.length +
        sortEdges.length +
        sourceSlices.length +
        sortEvidence.length +
        sortUnresolved.length,
      traversalHops: input.traversalHops ?? 0,
    },
  })
}

export class CodeExplorerRepository {
  private readonly symbols: readonly UnifiedSymbol[]
  private readonly symbolsById: ReadonlyMap<CodeSymbolId, UnifiedSymbol>
  private readonly phpFileBySymbolId: ReadonlyMap<string, string>
  private readonly phpRelationshipEvidenceIds: ReadonlyMap<string, EvidenceId>
  private readonly endpointEvidenceIds: ReadonlyMap<number, EvidenceId>
  private readonly phpFileIds: ReadonlyMap<
    string,
    NonNullable<CodeSourceEvidence["sourceEntityId"]>
  >
  private readonly endpoints: readonly EndpointEvidence[]

  constructor(private readonly options: CodeExplorerRepositoryOptions) {
    const applicationIds = [
      options.applicationId,
      options.typescript?.index.applicationId,
      options.php?.index.response.source.applicationId,
      ...(options.endpoints ?? []).map(
        ({ endpoint }) => endpoint.applicationId
      ),
    ].filter((value): value is ApplicationId => value !== undefined)
    const commitShas = [
      options.typescript?.index.commitSha,
      options.php?.index.response.source.commitSha,
      options.php?.snapshot.metadata.commitSha,
      ...(options.endpoints ?? []).map(
        ({ provenance }) => provenance.commitSha
      ),
    ].filter((value): value is string => value !== undefined)
    const repositories = [
      options.typescript?.index.repository,
      options.php?.index.response.source.repository,
      ...(options.endpoints ?? []).map(
        ({ provenance }) => provenance.repository
      ),
    ].filter(
      (
        value
      ): value is {
        readonly host: string
        readonly owner: string
        readonly name: string
      } => value !== undefined
    )
    if (
      applicationIds.some((id) => id !== options.applicationId) ||
      (options.typescript !== undefined &&
        options.typescript.index.runId !== options.runId) ||
      new Set(commitShas).size > 1 ||
      new Set(repositories.map(repositoryKey)).size > 1
    ) {
      throw new CodeExplorerRepositoryError()
    }
    const typescriptSymbols = (options.typescript?.index.symbols ?? []).map(
      (symbol): UnifiedSymbol => ({
        origin: "typescript",
        typescript: symbol,
        entity: {
          entityType: "symbol",
          id: symbol.id,
          qualifiedName: symbol.qualifiedName,
          name: symbol.name,
          language: symbol.language,
          kind: symbol.kind,
          filePath: symbol.filePath,
          range: symbol.range,
        },
      })
    )
    const phpFileBySymbolId = new Map<string, string>()
    const phpSymbols = (options.php?.index.response.files ?? []).flatMap(
      (file) =>
        file.symbols.map((symbol): UnifiedSymbol => {
          phpFileBySymbolId.set(symbol.id, file.path)
          return {
            origin: "php",
            php: symbol,
            entity: {
              entityType: "symbol",
              id: symbol.id,
              qualifiedName: symbol.qualifiedName,
              name: symbol.name,
              language: phpLanguage(),
              kind: phpSymbolKind(symbol),
              filePath: file.path,
              range: {
                startLine: symbol.range.startLine,
                endLine: symbol.range.endLine,
              },
            },
          }
        })
    )
    this.symbols = Object.freeze(
      [...typescriptSymbols, ...phpSymbols].sort((left, right) =>
        compareStrings(
          `${left.entity.filePath}\0${left.entity.range.startLine.toString().padStart(10, "0")}\0${left.entity.qualifiedName}`,
          `${right.entity.filePath}\0${right.entity.range.startLine.toString().padStart(10, "0")}\0${right.entity.qualifiedName}`
        )
      )
    )
    this.symbolsById = new Map(
      this.symbols.map((entry) => [entry.entity.id, entry])
    )
    this.phpFileBySymbolId = phpFileBySymbolId
    this.phpFileIds = new Map(
      (options.php?.index.response.files ?? []).map((file) => [
        file.path,
        createStableKey({
          kind: "code-file",
          applicationId: options.applicationId,
          repository: options.php!.index.response.source.repository,
          commitSha: options.php!.index.response.source.commitSha,
          path: file.path,
        }),
      ])
    )
    const phpRelationshipEvidenceIds = new Map<string, EvidenceId>()
    const relationships = (options.php?.index.response.files ?? [])
      .flatMap((file) => file.relationships)
      .sort((left, right) => compareStrings(left.id, right.id))
    const ordinalBySourceKind = new Map<string, number>()
    for (const relationship of relationships) {
      const kind = relationship.dynamic
        ? "unresolved_dynamic"
        : relationship.kind === "calls" || relationship.kind === "static_calls"
          ? "call"
          : "reference"
      const key = `${relationship.sourceSymbolId}\0${kind}`
      const ordinal = ordinalBySourceKind.get(key) ?? 0
      ordinalBySourceKind.set(key, ordinal + 1)
      phpRelationshipEvidenceIds.set(
        relationship.id,
        createRunScopedEvidenceId({
          applicationId: options.applicationId,
          runId: options.runId,
          sourceId: relationship.sourceSymbolId,
          kind,
          ordinal,
        })
      )
    }
    this.phpRelationshipEvidenceIds = phpRelationshipEvidenceIds
    this.endpoints = Object.freeze(
      [...(options.endpoints ?? [])].sort((left, right) =>
        compareStrings(
          `${left.endpoint.id}\0${left.sourceKind}\0${left.handler?.qualifiedName ?? ""}`,
          `${right.endpoint.id}\0${right.sourceKind}\0${right.handler?.qualifiedName ?? ""}`
        )
      )
    )
    this.endpointEvidenceIds = new Map(
      this.endpoints.map((entry, ordinal) => [
        ordinal,
        createRunScopedEvidenceId({
          applicationId: options.applicationId,
          runId: options.runId,
          sourceId: entry.endpoint.id,
          kind:
            entry.handler === undefined ? "openapi_operation" : "route_handler",
          ordinal,
        }),
      ])
    )
  }

  private clampLimit(
    requested: number | undefined,
    limits: CodeRepositoryLimits
  ): number {
    return Math.max(
      1,
      Math.min(requested ?? limits.maxResults, limits.maxResults)
    )
  }

  private selectedSymbols(
    scope: CodeRepositoryScope,
    query: {
      pathPrefix?: string | undefined
      languages?: readonly Language[] | undefined
    }
  ): readonly UnifiedSymbol[] {
    return this.symbols.filter(
      ({ entity }) =>
        pathAllowed(entity.filePath, scope) &&
        (query.pathPrefix === undefined ||
          isWithinPath(entity.filePath, query.pathPrefix)) &&
        languageAllowed(entity.language, scope, query.languages)
    )
  }

  private symbol(
    symbolId: CodeSymbolId,
    scope: CodeRepositoryScope
  ): UnifiedSymbol | undefined {
    const symbol = this.symbolsById.get(symbolId)
    return symbol !== undefined &&
      pathAllowed(symbol.entity.filePath, scope) &&
      languageAllowed(symbol.entity.language, scope)
      ? symbol
      : undefined
  }

  isSymbolInScope(symbolId: CodeSymbolId, scope: CodeRepositoryScope): boolean {
    return this.symbol(symbolId, scope) !== undefined
  }

  private evidenceId(input: {
    sourceId: NonNullable<CodeSourceEvidence["sourceEntityId"]>
    kind: string
    ordinal: number
  }): EvidenceId {
    return createRunScopedEvidenceId({
      applicationId: this.options.applicationId,
      runId: this.options.runId,
      ...input,
    })
  }

  private typescriptReferenceParts(
    reference: CodeReferenceRecord,
    scope: CodeRepositoryScope
  ): EvidenceParts {
    const source = this.symbolsById.get(reference.sourceSymbolId)
    if (
      source === undefined ||
      !pathAllowed(reference.filePath, scope) ||
      !languageAllowed(source.entity.language, scope)
    ) {
      return { evidence: [], edges: [], unresolved: [] }
    }
    const kind = reference.kind
    const scopedTarget =
      reference.targetSymbolId === undefined
        ? undefined
        : this.symbol(reference.targetSymbolId, scope)
    const targetId = scopedTarget?.entity.id
    const unresolvedTarget =
      targetId === undefined
        ? (reference.targetQualifiedName ?? reference.unresolvedTarget)
        : undefined
    const targetOutsideScope =
      reference.targetSymbolId !== undefined && targetId === undefined
    const evidence: CodeSourceEvidence = {
      evidenceId: reference.id,
      kind,
      strength: targetId === undefined ? "unresolved" : "structural",
      filePath: reference.filePath,
      range: reference.range,
      sourceEntityId: reference.sourceSymbolId,
      ...(targetId === undefined ? {} : { targetEntityId: targetId }),
      ...(reference.unresolvedReason === undefined && !targetOutsideScope
        ? {}
        : {
            detail: targetOutsideScope
              ? "target_outside_scope"
              : reference.unresolvedReason,
          }),
    }
    const edge: CodeStructuralEdge | undefined =
      targetId !== undefined
        ? {
            kind,
            sourceId: reference.sourceSymbolId,
            targetId,
            evidenceIds: [reference.id],
          }
        : unresolvedTarget === undefined
          ? undefined
          : {
              kind,
              sourceId: reference.sourceSymbolId,
              unresolvedTarget,
              evidenceIds: [reference.id],
            }
    const unresolved: CodeUnresolvedBoundary[] =
      targetId !== undefined || unresolvedTarget === undefined
        ? []
        : [
            {
              kind:
                reference.unresolvedReason?.startsWith("computed") === true
                  ? "computed_url"
                  : "unresolved_reference",
              question: persistedTextSchema.parse(
                `Resolve ${unresolvedTarget} from ${reference.sourceQualifiedName}.`
              ),
              reasonCode: targetOutsideScope
                ? "target_outside_scope"
                : (reference.unresolvedReason ?? "unresolved_reference"),
              evidenceIds: [reference.id],
              suggestedAgent: "application",
            },
          ]
    return {
      evidence: [evidence],
      edges: edge === undefined ? [] : [edge],
      unresolved,
    }
  }

  private phpRelationshipParts(
    relationship: PhpRelationship,
    scope: CodeRepositoryScope
  ): EvidenceParts {
    const source = this.symbolsById.get(relationship.sourceSymbolId)
    const filePath = this.phpFileBySymbolId.get(relationship.sourceSymbolId)
    const evidenceId = this.phpRelationshipEvidenceIds.get(relationship.id)
    if (
      source === undefined ||
      filePath === undefined ||
      evidenceId === undefined ||
      !pathAllowed(filePath, scope) ||
      !languageAllowed("php", scope)
    ) {
      return { evidence: [], edges: [], unresolved: [] }
    }
    const kind = relationship.dynamic
      ? "unresolved_dynamic"
      : relationship.kind === "calls" || relationship.kind === "static_calls"
        ? "call"
        : "reference"
    const scopedTarget =
      relationship.targetSymbolId === undefined
        ? undefined
        : this.symbol(relationship.targetSymbolId, scope)
    const targetId = scopedTarget?.entity.id
    const targetOutsideScope =
      relationship.targetSymbolId !== undefined && targetId === undefined
    const evidence: CodeSourceEvidence = {
      evidenceId,
      kind,
      strength:
        relationship.dynamic || targetId === undefined
          ? "unresolved"
          : "structural",
      filePath,
      range: {
        startLine: relationship.range.startLine,
        endLine: relationship.range.endLine,
      },
      sourceEntityId: relationship.sourceSymbolId,
      ...(targetId === undefined ? {} : { targetEntityId: targetId }),
      detail: targetOutsideScope ? "target_outside_scope" : relationship.kind,
    }
    const unresolvedTarget =
      targetId === undefined
        ? (relationship.resolvedTarget ?? relationship.originalTarget)
        : undefined
    const edge: CodeStructuralEdge = {
      kind,
      sourceId: relationship.sourceSymbolId,
      ...(targetId === undefined
        ? { unresolvedTarget: unresolvedTarget! }
        : { targetId }),
      evidenceIds: [evidenceId],
    }
    const unresolved: CodeUnresolvedBoundary[] =
      relationship.dynamic || targetId === undefined
        ? [
            {
              kind:
                relationship.kind === "unresolved_dynamic"
                  ? "dynamic_call"
                  : "unresolved_reference",
              question: persistedTextSchema.parse(
                `Resolve dynamic target ${relationship.originalTarget}.`
              ),
              reasonCode: targetOutsideScope
                ? "target_outside_scope"
                : relationship.kind,
              evidenceIds: [evidenceId],
              suggestedAgent: "application",
            },
          ]
        : []
    return { evidence: [evidence], edges: [edge], unresolved }
  }

  listModules(
    scope: CodeRepositoryScope,
    query: {
      pathPrefix?: string | undefined
      languages?: readonly Language[] | undefined
      limit?: number | undefined
    },
    limits: CodeRepositoryLimits
  ): CodeToolObservation {
    const selected = this.selectedSymbols(scope, query)
    const files = new Map<
      string,
      { languages: Set<Language>; symbols: number }
    >()
    for (const symbol of selected) {
      for (const path of parentDirectories(symbol.entity.filePath)) {
        if (
          query.pathPrefix !== undefined &&
          !isWithinPath(path, query.pathPrefix)
        )
          continue
        const entry = files.get(path) ?? {
          languages: new Set<Language>(),
          symbols: 0,
        }
        entry.languages.add(symbol.entity.language)
        entry.symbols += 1
        files.set(path, entry)
      }
    }
    const entities: CodeExplorerEntity[] = [...files]
      .sort(([left], [right]) => compareStrings(left, right))
      .slice(0, this.clampLimit(query.limit, limits))
      .map(([path, value]) => ({
        entityType: "module",
        key: `module:${path}`,
        path,
        languages: [...value.languages].sort(compareStrings),
        fileCount: new Set(
          selected
            .filter(({ entity }) => isWithinPath(entity.filePath, path))
            .map(({ entity }) => entity.filePath)
        ).size,
        symbolCount: value.symbols,
      }))
    return observation({
      toolName: "list_repository_modules",
      summary: `Returned ${entities.length} indexed repository modules.`,
      entities,
    })
  }

  searchSymbols(
    scope: CodeRepositoryScope,
    query: RepositorySymbolQuery,
    limits: CodeRepositoryLimits
  ): CodeToolObservation {
    const needle = query.query.toLowerCase()
    const entities = this.selectedSymbols(scope, query)
      .filter(({ entity }) =>
        `${entity.name}\0${entity.qualifiedName}`.toLowerCase().includes(needle)
      )
      .slice(0, this.clampLimit(query.limit, limits))
      .map(({ entity }) => entity)
    return observation({
      toolName: "search_symbols",
      summary: `Returned ${entities.length} lexical symbol candidates; inspect structural evidence before claiming a relationship.`,
      entities,
    })
  }

  async searchText(
    scope: CodeRepositoryScope,
    query: RepositoryTextQuery,
    limits: CodeRepositoryLimits
  ): Promise<CodeToolObservation> {
    const wanted =
      query.caseSensitive === true ? query.query : query.query.toLowerCase()
    const maxResults = this.clampLimit(query.limit, limits)
    const matches: Extract<CodeExplorerEntity, { entityType: "text_match" }>[] =
      []
    const evidence: CodeSourceEvidence[] = []
    const addMatch = (input: {
      path: string
      line: number
      text: string
      language: Language
      sourceId: NonNullable<CodeSourceEvidence["sourceEntityId"]>
    }): void => {
      if (matches.length >= maxResults) return
      const evidenceId = this.evidenceId({
        sourceId: input.sourceId,
        kind: "lexical_match",
        ordinal: input.line,
      })
      matches.push({
        entityType: "text_match",
        key: hashCanonical({
          kind: "code_text_match",
          path: input.path,
          line: input.line,
          text: input.text,
        }),
        language: input.language,
        filePath: input.path,
        range: { startLine: input.line, endLine: input.line },
        text: input.text.trim().slice(0, 512),
      })
      evidence.push({
        evidenceId,
        kind: "lexical_match",
        strength: "lexical",
        filePath: input.path,
        range: { startLine: input.line, endLine: input.line },
        sourceEntityId: input.sourceId,
      })
    }

    if (
      this.options.typescript !== undefined &&
      (query.languages === undefined ||
        query.languages.some((language) => language !== "php"))
    ) {
      const prefixes =
        query.pathPrefix === undefined
          ? scope.repositoryPaths
          : [query.pathPrefix]
      for (const prefix of prefixes) {
        const results = await this.options.typescript.query.searchText({
          query: query.query,
          ...(query.caseSensitive === undefined
            ? {}
            : { caseSensitive: query.caseSensitive }),
          pathPrefix: prefix,
          limit: maxResults,
        })
        for (const match of results) {
          const file = this.options.typescript.index.files.find(
            ({ path }) => path === match.path
          )
          if (
            file === undefined ||
            !pathAllowed(match.path, scope) ||
            !languageAllowed(file.language, scope, query.languages)
          ) {
            continue
          }
          addMatch({
            path: match.path,
            line: match.line,
            text: match.text,
            language: file.language,
            sourceId: file.id,
          })
        }
      }
    }

    if (
      this.options.php !== undefined &&
      languageAllowed("php", scope, query.languages) &&
      matches.length < maxResults
    ) {
      for (const file of this.options.php.index.response.files) {
        if (
          !pathAllowed(file.path, scope) ||
          (query.pathPrefix !== undefined &&
            !isWithinPath(file.path, query.pathPrefix))
        ) {
          continue
        }
        const text = await this.options.php.snapshot.readText(file.path)
        for (const [offset, line] of text.split(/\r\n|\n|\r/).entries()) {
          const haystack =
            query.caseSensitive === true ? line : line.toLowerCase()
          if (!haystack.includes(wanted)) continue
          const sourceId = this.phpFileIds.get(file.path)
          if (sourceId !== undefined) {
            addMatch({
              path: file.path,
              line: offset + 1,
              text: line,
              language: "php",
              sourceId,
            })
          }
          if (matches.length >= maxResults) break
        }
        if (matches.length >= maxResults) break
      }
    }

    return observation({
      toolName: "search_code_text",
      summary: `Returned ${matches.length} lexical text matches; comments and strings are not structural proof.`,
      entities: matches,
      evidence,
    })
  }

  findDefinition(
    scope: CodeRepositoryScope,
    input: {
      qualifiedName: string
      languages?: readonly Language[] | undefined
    },
    limits: CodeRepositoryLimits
  ): CodeToolObservation {
    const matches = this.selectedSymbols(scope, {
      ...(input.languages === undefined ? {} : { languages: input.languages }),
    })
      .filter(({ entity }) => entity.qualifiedName === input.qualifiedName)
      .slice(0, limits.maxResults)
    const evidence = matches.map(({ entity }, ordinal): CodeSourceEvidence => ({
      evidenceId: this.evidenceId({
        sourceId: entity.id,
        kind: "definition",
        ordinal,
      }),
      kind: "definition",
      strength: "structural",
      filePath: entity.filePath,
      range: entity.range,
      sourceEntityId: entity.id,
    }))
    return observation({
      toolName: "find_definition",
      summary: `Returned ${matches.length} exact qualified-name definitions.`,
      entities: matches.map(({ entity }) => entity),
      evidence,
    })
  }

  async inspectSymbol(
    scope: CodeRepositoryScope,
    symbolId: CodeSymbolId,
    limits: CodeRepositoryLimits
  ): Promise<CodeToolObservation> {
    const selected = this.symbol(symbolId, scope)
    if (selected === undefined) {
      return observation({
        toolName: "inspect_symbol",
        summary:
          "The requested symbol is absent or outside the admitted mission scope.",
      })
    }
    const sourceSlices: CodeToolObservation["sourceSlices"][number][] = []
    const evidence: CodeSourceEvidence[] = []
    const edges: CodeStructuralEdge[] = []
    const unresolved: CodeUnresolvedBoundary[] = []
    if (selected.origin === "typescript") {
      const inspection = await this.options.typescript!.query.inspectSymbol(
        selected.entity.qualifiedName
      )
      const sliceLines = Math.min(
        sourceLineCount(inspection.slice),
        limits.maxSourceLines
      )
      const lines = inspection.slice.text
        .split(/\r\n|\n|\r/)
        .slice(0, sliceLines)
      const text = lines.join("\n").slice(0, limits.maxSourceCharacters)
      const endLine = inspection.slice.startLine + Math.max(0, lines.length - 1)
      const evidenceId = this.evidenceId({
        sourceId: symbolId,
        kind: "source_slice",
        ordinal: 0,
      })
      sourceSlices.push({
        filePath: selected.entity.filePath,
        language: selected.entity.language,
        range: { startLine: inspection.slice.startLine, endLine },
        text,
        contentHash: hashCanonical({ kind: "code_explorer_slice", text }),
        truncated:
          inspection.slice.truncated ||
          lines.length < sourceLineCount(inspection.slice) ||
          text.length < lines.join("\n").length,
        evidenceId,
      })
      evidence.push({
        evidenceId,
        kind: "source_slice",
        strength: "structural",
        filePath: selected.entity.filePath,
        range: { startLine: inspection.slice.startLine, endLine },
        sourceEntityId: symbolId,
      })
      for (const reference of [
        ...inspection.outgoing,
        ...inspection.incoming,
      ]) {
        const parts = this.typescriptReferenceParts(reference, scope)
        evidence.push(...parts.evidence)
        edges.push(...parts.edges)
        unresolved.push(...parts.unresolved)
      }
    } else {
      const symbol = selected.php!
      let remainingLines = limits.maxSourceLines
      for (const [
        ordinal,
        declarationRange,
      ] of symbol.declarationRanges.entries()) {
        if (remainingLines <= 0) break
        const slice = await this.options.php!.index.sourceSlice(
          this.options.php!.snapshot,
          { symbol, declarationRange },
          {
            contextLines: 1,
            maxLines: remainingLines,
            maxCharacters: limits.maxSourceCharacters,
          }
        )
        const evidenceId = this.evidenceId({
          sourceId: symbolId,
          kind: "source_slice",
          ordinal,
        })
        sourceSlices.push({
          filePath: slice.path,
          language: "php",
          range: { startLine: slice.startLine, endLine: slice.endLine },
          text: slice.text,
          contentHash: hashCanonical({
            kind: "code_explorer_slice",
            text: slice.text,
          }),
          truncated:
            sourceLineCount(slice) <
            declarationRange.endLine - declarationRange.startLine + 3,
          evidenceId,
        })
        evidence.push({
          evidenceId,
          kind: "source_slice",
          strength: "structural",
          filePath: slice.path,
          range: { startLine: slice.startLine, endLine: slice.endLine },
          sourceEntityId: symbolId,
        })
        remainingLines -= sourceLineCount(slice)
      }
      const neighborhood = this.options.php!.index.neighborhood(symbolId, {
        maxDepth: 1,
        maxSymbols: limits.maxResults,
        maxRelationships: limits.maxResults,
      })
      for (const relationship of neighborhood.relationships) {
        const parts = this.phpRelationshipParts(relationship, scope)
        evidence.push(...parts.evidence)
        edges.push(...parts.edges)
        unresolved.push(...parts.unresolved)
      }
    }
    return observation({
      toolName: "inspect_symbol",
      summary: `Inspected ${selected.entity.qualifiedName} using bounded source and structural edges.`,
      entities: [selected.entity],
      sourceSlices,
      evidence,
      edges,
      unresolved,
      traversalHops: 1,
    })
  }

  findReferences(
    scope: CodeRepositoryScope,
    symbolId: CodeSymbolId,
    requestedLimit: number | undefined,
    limits: CodeRepositoryLimits
  ): CodeToolObservation {
    const selected = this.symbol(symbolId, scope)
    if (selected === undefined) {
      return observation({
        toolName: "find_references",
        summary:
          "The requested symbol is absent or outside the admitted mission scope.",
      })
    }
    const maxResults = this.clampLimit(requestedLimit, limits)
    const parts: EvidenceParts[] = []
    if (selected.origin === "typescript") {
      for (const reference of this.options
        .typescript!.query.findReferences(selected.entity.qualifiedName, {
          limit: maxResults,
        })
        .slice(0, maxResults)) {
        parts.push(this.typescriptReferenceParts(reference, scope))
      }
    } else {
      const relationships = this.options
        .php!.index.response.files.flatMap((file) => file.relationships)
        .filter(
          (relationship) =>
            relationship.sourceSymbolId === symbolId ||
            relationship.targetSymbolId === symbolId
        )
        .slice(0, maxResults)
      relationships.forEach((relationship) =>
        parts.push(this.phpRelationshipParts(relationship, scope))
      )
    }
    return observation({
      toolName: "find_references",
      summary: `Returned ${parts.length} bounded structural reference records.`,
      edges: parts.flatMap(({ edges }) => edges),
      evidence: parts.flatMap(({ evidence }) => evidence),
      unresolved: parts.flatMap(({ unresolved }) => unresolved),
      traversalHops: parts.length === 0 ? 0 : 1,
    })
  }

  trace(
    direction: "callers" | "callees",
    scope: CodeRepositoryScope,
    query: RepositoryTraceQuery,
    limits: CodeRepositoryLimits
  ): CodeToolObservation {
    const toolName = direction === "callers" ? "trace_callers" : "trace_callees"
    const selected = this.symbol(query.symbolId, scope)
    if (selected === undefined) {
      return observation({
        toolName,
        summary:
          "The requested symbol is absent or outside the admitted mission scope.",
      })
    }
    const maxHops = Math.max(
      1,
      Math.min(query.maxHops ?? limits.maxHops, limits.maxHops)
    )
    const maxResults = this.clampLimit(query.limit, limits)
    const entities: CodeExplorerEntity[] = []
    const parts: EvidenceParts[] = []
    let traversalHops = 0
    if (selected.origin === "typescript") {
      const steps =
        direction === "callers"
          ? this.options.typescript!.query.traceCallers(
              selected.entity.qualifiedName,
              {
                depth: maxHops,
                limit: maxResults,
              }
            )
          : this.options.typescript!.query.traceCallees(
              selected.entity.qualifiedName,
              {
                depth: maxHops,
                limit: maxResults,
              }
            )
      for (const step of steps) {
        const symbol = this.symbolsById.get(step.symbol.id)
        if (
          symbol !== undefined &&
          pathAllowed(symbol.entity.filePath, scope)
        ) {
          entities.push(symbol.entity)
        }
        const reference = this.options.typescript!.index.references.find(
          ({ id }) => id === step.viaReferenceId
        )
        if (reference !== undefined)
          parts.push(this.typescriptReferenceParts(reference, scope))
        traversalHops = Math.max(traversalHops, step.depth)
      }
    } else {
      const relationships = this.options.php!.index.response.files.flatMap(
        (file) => file.relationships
      )
      const visited = new Set<CodeSymbolId>([query.symbolId])
      let frontier = [query.symbolId]
      for (let depth = 1; depth <= maxHops && frontier.length > 0; depth += 1) {
        const next: CodeSymbolId[] = []
        for (const relationship of relationships) {
          if (
            relationship.kind !== "calls" &&
            relationship.kind !== "static_calls"
          )
            continue
          const candidate =
            direction === "callees" &&
            frontier.includes(relationship.sourceSymbolId)
              ? relationship.targetSymbolId
              : direction === "callers" &&
                  relationship.targetSymbolId !== undefined &&
                  frontier.includes(relationship.targetSymbolId)
                ? relationship.sourceSymbolId
                : undefined
          if (candidate === undefined || visited.has(candidate)) continue
          const symbol = this.symbol(candidate, scope)
          if (symbol === undefined) continue
          visited.add(candidate)
          next.push(candidate)
          entities.push(symbol.entity)
          parts.push(this.phpRelationshipParts(relationship, scope))
          traversalHops = depth
          if (entities.length >= maxResults) break
        }
        if (entities.length >= maxResults) break
        frontier = next
      }
    }
    return observation({
      toolName,
      summary: `Returned ${entities.length} ${direction} across ${traversalHops} structural hops.`,
      entities,
      edges: parts.flatMap(({ edges }) => edges),
      evidence: parts.flatMap(({ evidence }) => evidence),
      unresolved: parts.flatMap(({ unresolved }) => unresolved),
      traversalHops,
    })
  }

  findEndpointHandler(
    scope: CodeRepositoryScope,
    query: RepositoryEndpointQuery,
    limits: CodeRepositoryLimits
  ): CodeToolObservation {
    const normalizedPath = normalizeEndpointPath(query.normalizedPath, {
      templateSyntax: true,
    })
    const selected = this.endpoints
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.endpoint.method === query.method &&
          entry.endpoint.normalizedPath === normalizedPath &&
          endpointEvidenceAllowed(entry, scope)
      )
      .slice(0, this.clampLimit(query.limit, limits))
    const byEndpoint = new Map<string, EndpointEvidence[]>()
    selected.forEach(({ entry }) => {
      const values = byEndpoint.get(entry.endpoint.id) ?? []
      values.push(entry)
      byEndpoint.set(entry.endpoint.id, values)
    })
    const entities: CodeExplorerEntity[] = [...byEndpoint.values()].map(
      (entries) => ({
        entityType: "endpoint",
        id: entries[0]!.endpoint.id,
        method: entries[0]!.endpoint.method,
        normalizedPath: entries[0]!.endpoint.normalizedPath,
        sourceKinds: [
          ...new Set(entries.map(({ sourceKind }) => sourceKind)),
        ].sort(compareStrings),
        handlerSymbolIds: [
          ...new Set(
            entries.flatMap(({ handler }) => {
              const parsed = codeSymbolIdSchema.safeParse(handler?.symbolId)
              return parsed.success && this.isSymbolInScope(parsed.data, scope)
                ? [parsed.data]
                : []
            })
          ),
        ].sort(compareStrings),
      })
    )
    const evidence: CodeSourceEvidence[] = []
    const edges: CodeStructuralEdge[] = []
    const unresolved: CodeUnresolvedBoundary[] = []
    for (const { entry, index } of selected) {
      if (
        entry.provenance.filePath === undefined ||
        entry.provenance.range === undefined ||
        !pathAllowed(entry.provenance.filePath, scope)
      ) {
        continue
      }
      const evidenceId = this.endpointEvidenceIds.get(index)!
      const parsedTarget = codeSymbolIdSchema.safeParse(entry.handler?.symbolId)
      const targetId =
        parsedTarget.success && this.isSymbolInScope(parsedTarget.data, scope)
          ? parsedTarget.data
          : undefined
      evidence.push({
        evidenceId,
        kind: targetId === undefined ? "openapi_operation" : "route_handler",
        strength: targetId === undefined ? "corroborating" : "structural",
        filePath: entry.provenance.filePath,
        range: entry.provenance.range,
        sourceEntityId: entry.endpoint.id,
        ...(targetId === undefined ? {} : { targetEntityId: targetId }),
      })
      if (targetId !== undefined) {
        edges.push({
          kind: "route_handler",
          sourceId: entry.endpoint.id,
          targetId,
          evidenceIds: [evidenceId],
        })
      } else if (entry.handler !== undefined) {
        edges.push({
          kind: "route_handler",
          sourceId: entry.endpoint.id,
          unresolvedTarget: entry.handler.qualifiedName,
          evidenceIds: [evidenceId],
        })
        unresolved.push({
          kind: "dependency_injection",
          question: persistedTextSchema.parse(
            `Resolve endpoint handler ${entry.handler.qualifiedName} to an indexed symbol.`
          ),
          reasonCode: "handler_symbol_unresolved",
          evidenceIds: [evidenceId],
          suggestedAgent: "application",
        })
      }
    }
    if (selected.length === 0) {
      unresolved.push({
        kind: "unmapped_endpoint",
        question: persistedTextSchema.parse(
          `Resolve ${query.method} ${normalizedPath} to indexed endpoint evidence.`
        ),
        reasonCode: "endpoint_not_indexed",
        evidenceIds: [],
        suggestedAgent: "application",
      })
    }
    return observation({
      toolName: "find_endpoint_handler",
      summary: `Returned ${entities.length} exact normalized endpoints and ${edges.length} handler edges.`,
      entities,
      evidence,
      edges,
      unresolved,
      traversalHops: edges.length === 0 ? 0 : 1,
    })
  }

  findFrontendCallers(
    scope: CodeRepositoryScope,
    query: RepositoryEndpointQuery,
    limits: CodeRepositoryLimits
  ): CodeToolObservation {
    if (this.options.typescript === undefined) {
      return observation({
        toolName: "find_frontend_callers",
        summary: "No TypeScript index is available in this repository map.",
      })
    }
    const normalizedPath = normalizeEndpointPath(query.normalizedPath, {
      templateSyntax: true,
    })
    const endpoint =
      this.endpoints.find(
        (entry) =>
          entry.endpoint.method === query.method &&
          entry.endpoint.normalizedPath === normalizedPath
      )?.endpoint ??
      createEndpointTemplate({
        applicationId: this.options.applicationId,
        method: query.method,
        path: normalizedPath,
      })
    const callers = this.options.typescript.query
      .findFrontendCallersForPath({
        method: query.method,
        pathTemplate: normalizedPath,
        limit: this.clampLimit(query.limit, limits),
      })
      .filter(({ ownerSymbol }) => pathAllowed(ownerSymbol.filePath, scope))
    const entities: CodeExplorerEntity[] = []
    const evidence: CodeSourceEvidence[] = []
    const edges: CodeStructuralEdge[] = []
    for (const [ordinal, caller] of callers.entries()) {
      const owner = this.symbolsById.get(caller.ownerSymbol.id)
      if (owner === undefined || !languageAllowed(owner.entity.language, scope))
        continue
      entities.push(owner.entity)
      const evidenceId = this.evidenceId({
        sourceId: caller.ownerSymbol.id,
        kind: "frontend_call",
        ordinal,
      })
      evidence.push({
        evidenceId,
        kind: "frontend_call",
        strength: "structural",
        filePath: caller.candidate.filePath,
        range: caller.candidate.range,
        sourceEntityId: caller.ownerSymbol.id,
        targetEntityId: endpoint.id,
      })
      edges.push({
        kind: "frontend_call",
        sourceId: caller.ownerSymbol.id,
        targetId: endpoint.id,
        evidenceIds: [evidenceId],
      })
      for (const route of caller.routes) {
        for (const componentId of route.componentSymbolIds) {
          const component = this.symbolsById.get(componentId)
          if (
            component !== undefined &&
            pathAllowed(component.entity.filePath, scope)
          ) {
            entities.push(component.entity)
          }
        }
      }
    }
    entities.push({
      entityType: "endpoint",
      id: endpoint.id,
      method: endpoint.method,
      normalizedPath: endpoint.normalizedPath,
      sourceKinds: ["frontend"],
      handlerSymbolIds: [],
    })
    return observation({
      toolName: "find_frontend_callers",
      summary: `Returned ${callers.length} structural frontend callers for the normalized endpoint.`,
      entities,
      evidence,
      edges,
      traversalHops: callers.length === 0 ? 0 : 1,
    })
  }

  async inspectTests(
    scope: CodeRepositoryScope,
    query: RepositoryTestQuery,
    limits: CodeRepositoryLimits
  ): Promise<CodeToolObservation> {
    const maxResults = this.clampLimit(query.limit, limits)
    const entities: CodeExplorerEntity[] = []
    const evidence: CodeSourceEvidence[] = []
    const edges: CodeStructuralEdge[] = []
    const targetSymbol =
      query.targetKind === "symbol"
        ? this.symbol(query.symbolId, scope)
        : undefined
    const add = (input: {
      symbol: UnifiedSymbol
      range: { startLine: number; endLine: number }
      targetId?: CodeStructuralEdge["targetId"]
      ordinal: number
    }): void => {
      if (
        entities.length >= maxResults ||
        !isTestPath(input.symbol.entity.filePath)
      )
        return
      const evidenceId = this.evidenceId({
        sourceId: input.symbol.entity.id,
        kind: "test_corroboration",
        ordinal: input.ordinal,
      })
      entities.push({
        entityType: "test",
        key: hashCanonical({
          kind: "code_test",
          symbolId: input.symbol.entity.id,
          range: input.range,
        }),
        language: input.symbol.entity.language,
        filePath: input.symbol.entity.filePath,
        range: input.range,
        name: input.symbol.entity.name,
        corroboratesOnly: true,
      })
      evidence.push({
        evidenceId,
        kind: "test_corroboration",
        strength: "corroborating",
        filePath: input.symbol.entity.filePath,
        range: input.range,
        sourceEntityId: input.symbol.entity.id,
        ...(input.targetId === undefined
          ? {}
          : { targetEntityId: input.targetId }),
      })
      if (input.targetId !== undefined) {
        edges.push({
          kind: "test_corroboration",
          sourceId: input.symbol.entity.id,
          targetId: input.targetId,
          evidenceIds: [evidenceId],
        })
      }
    }

    if (query.targetKind === "symbol" && targetSymbol !== undefined) {
      if (targetSymbol.origin === "typescript") {
        this.options
          .typescript!.index.references.filter(
            (reference) =>
              reference.targetSymbolId === query.symbolId &&
              isTestPath(reference.filePath)
          )
          .forEach((reference, ordinal) => {
            const source = this.symbolsById.get(reference.sourceSymbolId)
            if (source !== undefined) {
              add({
                symbol: source,
                range: reference.range,
                targetId: query.symbolId,
                ordinal,
              })
            }
          })
      } else {
        this.options
          .php!.index.response.files.flatMap((file) => file.relationships)
          .filter(
            (relationship) =>
              relationship.targetSymbolId === query.symbolId &&
              isTestPath(
                this.phpFileBySymbolId.get(relationship.sourceSymbolId) ?? ""
              )
          )
          .forEach((relationship, ordinal) => {
            const source = this.symbolsById.get(relationship.sourceSymbolId)
            if (source !== undefined) {
              add({
                symbol: source,
                range: {
                  startLine: relationship.range.startLine,
                  endLine: relationship.range.endLine,
                },
                targetId: query.symbolId,
                ordinal,
              })
            }
          })
      }
    } else if (query.targetKind !== "symbol") {
      const search = await this.searchText(
        scope,
        {
          query:
            query.targetKind === "endpoint"
              ? normalizeEndpointPath(query.normalizedPath, {
                  templateSyntax: true,
                })
              : query.query,
          limit: maxResults,
        },
        limits
      )
      for (const [ordinal, match] of search.entities
        .filter(
          (
            entity
          ): entity is Extract<
            CodeExplorerEntity,
            { entityType: "text_match" }
          > => entity.entityType === "text_match" && isTestPath(entity.filePath)
        )
        .entries()) {
        const owner = this.symbols.find(
          ({ entity }) =>
            entity.filePath === match.filePath &&
            entity.range.startLine <= match.range.startLine &&
            entity.range.endLine >= match.range.endLine
        )
        if (owner !== undefined)
          add({ symbol: owner, range: match.range, ordinal })
      }
    }
    return observation({
      toolName: "inspect_tests",
      summary: `Returned ${entities.length} focused tests as corroboration only, never runtime proof.`,
      entities,
      evidence,
      edges,
    })
  }
}

export { allLanguages as codeExplorerLanguages }
