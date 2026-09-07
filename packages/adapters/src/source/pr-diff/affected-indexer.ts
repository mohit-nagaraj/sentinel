import {
  hashCanonical,
  type ApplicationId,
  type CodeSymbolId,
  type CommitSha,
  type ContentHash,
  type RunId,
} from "@sentinel/contracts"

import {
  PhpLaravelIndexer,
  type PhpIndexerResponse,
  type PhpSymbol,
} from "../../php-laravel/index.ts"
import type { CheckoutSnapshot } from "../github/checkout.ts"
import type { GitHubRepositoryIdentity } from "../github/normalization.ts"
import {
  indexTypeScriptSource,
  type CodeSymbolRecord,
} from "../typescript/indexer.ts"
import type { TypeScriptIndexLimits } from "../typescript/limits.ts"
import type {
  TypeScriptSourceEntry,
  TypeScriptSourceReader,
} from "../typescript/reader.ts"
import { splitSourceLines } from "../typescript/slices.ts"

export interface AffectedSymbol {
  readonly id: CodeSymbolId
  readonly filePath: string
  readonly qualifiedName: string
  readonly name: string
  readonly kind: string
  readonly language: "typescript" | "tsx" | "php"
  readonly range: { readonly startLine: number; readonly endLine: number }
  readonly parentSymbolIds: readonly CodeSymbolId[]
  readonly contentHash: ContentHash
}

export interface AffectedIndexFailure {
  readonly path: string
  readonly reason: "indexer_unavailable" | "indexer_failed"
}

export interface AffectedSymbolIndex {
  readonly symbols: readonly AffectedSymbol[]
  readonly failures: readonly AffectedIndexFailure[]
}

export interface AffectedSymbolIndexRequest {
  readonly snapshot: CheckoutSnapshot
  readonly applicationId: ApplicationId
  readonly runId: RunId
  readonly repository: GitHubRepositoryIdentity
  readonly commitSha: CommitSha
  readonly paths: readonly string[]
  readonly signal?: AbortSignal
}

export interface AffectedSymbolIndexer {
  index(request: AffectedSymbolIndexRequest): Promise<AffectedSymbolIndex>
}

export interface DefaultAffectedSymbolIndexerOptions {
  readonly phpIndexer?: Pick<PhpLaravelIndexer, "indexCheckout">
  readonly typeScriptLimits?: Partial<TypeScriptIndexLimits>
}

function compareStrings(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/")
  return index < 0 ? "" : path.slice(0, index)
}

function isAncestorDirectory(directory: string, path: string): boolean {
  return directory.length === 0 || path.startsWith(`${directory}/`)
}

function selectedConfig(
  path: string,
  configs: readonly string[]
): string | undefined {
  return configs
    .filter((config) => isAncestorDirectory(directoryOf(config), path))
    .sort(
      (left, right) =>
        directoryOf(right).split("/").length -
          directoryOf(left).split("/").length || compareStrings(left, right)
    )[0]
}

function maskedReader(
  snapshot: CheckoutSnapshot,
  allowedPaths: ReadonlySet<string>
): TypeScriptSourceReader {
  const entries = snapshot
    .enumerate("")
    .filter(({ path }) => allowedPaths.has(path))
    .map(({ kind, path, sizeBytes }): TypeScriptSourceEntry => ({
      kind,
      path,
      sizeBytes,
    }))
  return {
    enumerate: (prefix = "") =>
      Object.freeze(
        entries.filter(
          ({ path }) =>
            prefix.length === 0 ||
            path === prefix ||
            path.startsWith(`${prefix}/`)
        )
      ),
    readText: async (path, maxBytes) => {
      if (!allowedPaths.has(path)) {
        throw new Error("Affected source reader rejected an unselected path")
      }
      return await snapshot.readText(path, maxBytes)
    },
  }
}

function rangeSize(range: { startLine: number; endLine: number }): number {
  return range.endLine - range.startLine
}

function typescriptParents(
  symbol: CodeSymbolRecord,
  symbols: readonly CodeSymbolRecord[]
): readonly CodeSymbolId[] {
  return Object.freeze(
    symbols
      .filter(
        (candidate) =>
          candidate.id !== symbol.id &&
          candidate.filePath === symbol.filePath &&
          candidate.range.startLine <= symbol.range.startLine &&
          candidate.range.endLine >= symbol.range.endLine
      )
      .sort(
        (left, right) =>
          rangeSize(left.range) - rangeSize(right.range) ||
          compareStrings(left.qualifiedName, right.qualifiedName)
      )
      .map(({ id }) => id)
  )
}

function phpParents(
  symbol: PhpSymbol,
  byId: ReadonlyMap<string, PhpSymbol>
): readonly CodeSymbolId[] {
  const parents: CodeSymbolId[] = []
  const visited = new Set<string>()
  let parentId = symbol.containerSymbolId
  while (parentId !== undefined && !visited.has(parentId)) {
    visited.add(parentId)
    parents.push(parentId)
    parentId = byId.get(parentId)?.containerSymbolId
  }
  return Object.freeze(parents)
}

function contentHash(
  source: string,
  range: { readonly startLine: number; readonly endLine: number }
): ContentHash {
  const lines = splitSourceLines(source)
  const text = lines.slice(range.startLine - 1, range.endLine).join("\n")
  return hashCanonical({ kind: "changed_symbol_source", text, version: 1 })
}

async function convertTypeScriptSymbols(
  snapshot: CheckoutSnapshot,
  requestedPaths: ReadonlySet<string>,
  symbols: readonly CodeSymbolRecord[]
): Promise<readonly AffectedSymbol[]> {
  const selected = symbols.filter(({ filePath }) =>
    requestedPaths.has(filePath)
  )
  const sourceByPath = new Map<string, string>()
  for (const path of requestedPaths) {
    sourceByPath.set(path, await snapshot.readText(path))
  }
  return Object.freeze(
    selected.map((symbol) => ({
      id: symbol.id,
      filePath: symbol.filePath,
      qualifiedName: symbol.qualifiedName,
      name: symbol.name,
      kind: symbol.kind,
      language: symbol.language,
      range: symbol.range,
      parentSymbolIds: typescriptParents(symbol, selected),
      contentHash: contentHash(
        sourceByPath.get(symbol.filePath)!,
        symbol.range
      ),
    }))
  )
}

async function convertPhpSymbols(
  snapshot: CheckoutSnapshot,
  response: PhpIndexerResponse
): Promise<readonly AffectedSymbol[]> {
  const symbols = response.files.flatMap(({ symbols: values }) => values)
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]))
  const sourceByPath = new Map<string, string>()
  for (const file of response.files) {
    sourceByPath.set(file.path, await snapshot.readText(file.path))
  }
  return Object.freeze(
    response.files.flatMap((file) =>
      file.symbols.map((symbol) => ({
        id: symbol.id,
        filePath: file.path,
        qualifiedName: symbol.qualifiedName,
        name: symbol.name,
        kind: symbol.kind,
        language: "php" as const,
        range: {
          startLine: symbol.range.startLine,
          endLine: symbol.range.endLine,
        },
        parentSymbolIds: phpParents(symbol, byId),
        contentHash: contentHash(sourceByPath.get(file.path)!, symbol.range),
      }))
    )
  )
}

export class DefaultAffectedSymbolIndexer implements AffectedSymbolIndexer {
  private readonly phpIndexer: Pick<PhpLaravelIndexer, "indexCheckout">
  private readonly typeScriptLimits: Partial<TypeScriptIndexLimits>

  constructor(options: DefaultAffectedSymbolIndexerOptions = {}) {
    this.phpIndexer = options.phpIndexer ?? new PhpLaravelIndexer()
    this.typeScriptLimits = options.typeScriptLimits ?? {}
  }

  async index(
    request: AffectedSymbolIndexRequest
  ): Promise<AffectedSymbolIndex> {
    const paths = [...new Set(request.paths)].sort(compareStrings)
    const typescriptPaths = paths.filter((path) => /\.tsx?$/i.test(path))
    const phpPaths = paths.filter((path) => /\.php$/i.test(path))
    const symbols: AffectedSymbol[] = []
    const failures: AffectedIndexFailure[] = []

    if (typescriptPaths.length > 0) {
      const configs = request.snapshot
        .enumerate("")
        .filter(
          ({ kind, path }) =>
            kind === "file" &&
            (path === "tsconfig.json" || path.endsWith("/tsconfig.json"))
        )
        .map(({ path }) => path)
        .sort(compareStrings)
      const grouped = new Map<string, string[]>()
      for (const path of typescriptPaths) {
        const config = selectedConfig(path, configs)
        if (config === undefined) {
          failures.push({ path, reason: "indexer_unavailable" })
          continue
        }
        const group = grouped.get(config) ?? []
        group.push(path)
        grouped.set(config, group)
      }
      for (const [config, group] of [...grouped].sort(([left], [right]) =>
        compareStrings(left, right)
      )) {
        const selected = new Set([config, ...group])
        try {
          const index = await indexTypeScriptSource({
            reader: maskedReader(request.snapshot, selected),
            applicationId: request.applicationId,
            runId: request.runId,
            repository: request.repository,
            commitSha: request.commitSha,
            roots: [directoryOf(config)],
            tsconfigPath: config,
            limits: this.typeScriptLimits,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          symbols.push(
            ...(await convertTypeScriptSymbols(
              request.snapshot,
              new Set(group),
              index.symbols
            ))
          )
        } catch {
          failures.push(
            ...group.map((path) => ({
              path,
              reason: "indexer_failed" as const,
            }))
          )
        }
      }
    }

    if (phpPaths.length > 0) {
      try {
        const response = await this.phpIndexer.indexCheckout(
          request.snapshot,
          phpPaths,
          {
            applicationId: request.applicationId,
            repository: request.repository,
            commitSha: request.commitSha,
          },
          request.signal
        )
        symbols.push(...(await convertPhpSymbols(request.snapshot, response)))
      } catch {
        failures.push(
          ...phpPaths.map((path) => ({
            path,
            reason: "indexer_failed" as const,
          }))
        )
      }
    }

    return Object.freeze({
      symbols: Object.freeze(
        symbols.sort(
          (left, right) =>
            compareStrings(left.filePath, right.filePath) ||
            left.range.startLine - right.range.startLine ||
            compareStrings(left.qualifiedName, right.qualifiedName)
        )
      ),
      failures: Object.freeze(
        failures.sort((left, right) => compareStrings(left.path, right.path))
      ),
    })
  }
}
