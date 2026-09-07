import { z } from "zod"

export const typeScriptIndexLimitsSchema = z.strictObject({
  /** Maximum admitted source files per index. */
  maxFiles: z.number().int().positive().max(50_000),
  /** Maximum bytes for a single source file. */
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1_024 * 1_024),
  /** Maximum cumulative bytes loaded into the compiler host. */
  maxTotalBytes: z
    .number()
    .int()
    .positive()
    .max(512 * 1_024 * 1_024),
  /** Maximum AST nodes visited within a single file. */
  maxNodesPerFile: z.number().int().positive().max(2_000_000),
  /** Maximum AST nodes visited across the whole index. */
  maxTotalNodes: z.number().int().positive().max(50_000_000),
  /** Maximum symbols recorded per file. */
  maxSymbolsPerFile: z.number().int().positive().max(20_000),
  /** Maximum JSX elements recorded per file. */
  maxJsxElementsPerFile: z.number().int().positive().max(20_000),
  /** Maximum references recorded per file. */
  maxReferencesPerFile: z.number().int().positive().max(50_000),
  /** Maximum routes recorded per index. */
  maxRoutes: z.number().int().positive().max(20_000),
  /** Maximum lines returned in a bounded display slice. */
  maxSliceLines: z.number().int().positive().max(2_000),
  /** Maximum bytes returned in a bounded display slice. */
  maxSliceBytes: z
    .number()
    .int()
    .positive()
    .max(1_024 * 1_024),
  /** Maximum results a single query may return. */
  maxQueryResults: z.number().int().positive().max(1_000),
  /** Maximum hops a caller/callee traversal may follow. */
  maxTraceDepth: z.number().int().positive().max(32),
  /** Wall-clock budget for a whole index. */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60_000),
})

export type TypeScriptIndexLimits = z.infer<typeof typeScriptIndexLimitsSchema>

export const defaultTypeScriptIndexLimits: TypeScriptIndexLimits = {
  maxFiles: 5_000,
  maxFileBytes: 1_024 * 1_024,
  maxTotalBytes: 96 * 1_024 * 1_024,
  maxNodesPerFile: 200_000,
  maxTotalNodes: 8_000_000,
  maxSymbolsPerFile: 2_000,
  maxJsxElementsPerFile: 2_000,
  maxReferencesPerFile: 5_000,
  maxRoutes: 2_000,
  maxSliceLines: 200,
  maxSliceBytes: 32 * 1_024,
  maxQueryResults: 100,
  maxTraceDepth: 6,
  timeoutMs: 120_000,
}

export function resolveIndexLimits(
  overrides: Partial<TypeScriptIndexLimits> = {}
): TypeScriptIndexLimits {
  return typeScriptIndexLimitsSchema.parse({
    ...defaultTypeScriptIndexLimits,
    ...overrides,
  })
}

/**
 * Tracks the budgets that span an entire index run. Callers check
 * {@link IndexBudget.exhausted} and record a `*_budget_exhausted` reason rather
 * than truncating output silently.
 */
export class IndexBudget {
  #nodes = 0
  #bytes = 0
  #files = 0
  readonly #limits: TypeScriptIndexLimits
  readonly #startedAtMs: number
  readonly #now: () => number

  constructor(limits: TypeScriptIndexLimits, now: () => number = Date.now) {
    this.#limits = limits
    this.#now = now
    this.#startedAtMs = now()
  }

  get nodes(): number {
    return this.#nodes
  }

  get bytes(): number {
    return this.#bytes
  }

  get files(): number {
    return this.#files
  }

  get elapsedMs(): number {
    return this.#now() - this.#startedAtMs
  }

  get timedOut(): boolean {
    return this.elapsedMs > this.#limits.timeoutMs
  }

  get nodesExhausted(): boolean {
    return this.#nodes >= this.#limits.maxTotalNodes
  }

  get filesExhausted(): boolean {
    return this.#files >= this.#limits.maxFiles
  }

  get exhausted(): boolean {
    return this.timedOut || this.nodesExhausted || this.filesExhausted
  }

  countNodes(count: number): void {
    this.#nodes += count
  }

  countFile(sizeBytes: number): void {
    this.#files += 1
    this.#bytes += sizeBytes
  }

  get bytesExceeded(): boolean {
    return this.#bytes > this.#limits.maxTotalBytes
  }
}
