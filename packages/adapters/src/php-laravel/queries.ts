import { createHash } from "node:crypto"

import { contentHashSchema } from "@sentinel/contracts"

import type { CheckoutSnapshot } from "../source/github/checkout.ts"
import { PhpIndexerError } from "./errors.ts"
import type {
  PhpIndexerResponse,
  PhpRelationship,
  PhpSourceRange,
  PhpSymbol,
} from "./schema.ts"

export interface PhpSourceSlice {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly text: string
  readonly contentHash: string
}

export interface PhpRelationshipNeighborhood {
  readonly symbols: readonly PhpSymbol[]
  readonly relationships: readonly PhpRelationship[]
  readonly truncated: boolean
}

function rangeSize(range: PhpSourceRange): number {
  return range.endFilePos - range.startFilePos
}

export class PhpCodeIndex {
  private readonly symbols: readonly PhpSymbol[]
  private readonly relationships: readonly PhpRelationship[]
  private readonly symbolsById: ReadonlyMap<string, PhpSymbol>

  constructor(readonly response: PhpIndexerResponse) {
    this.symbols = response.files.flatMap((file) => file.symbols)
    this.relationships = response.files.flatMap((file) => file.relationships)
    this.symbolsById = new Map(
      this.symbols.map((symbol) => [symbol.id, symbol])
    )
  }

  findSmallestEnclosingSymbol(
    path: string,
    startLine: number,
    endLine = startLine
  ): PhpSymbol | undefined {
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      throw new PhpIndexerError(
        "invalid_input",
        "Changed PHP line range is invalid"
      )
    }
    return this.response.files
      .find((file) => file.path === path)
      ?.symbols.filter(
        (symbol) =>
          symbol.range.startLine <= startLine && symbol.range.endLine >= endLine
      )
      .sort(
        (left, right) =>
          rangeSize(left.range) - rangeSize(right.range) ||
          left.qualifiedName.localeCompare(right.qualifiedName, "en")
      )[0]
  }

  searchSymbols(query: string, maxResults = 20): readonly PhpSymbol[] {
    const normalized = query.trim().toLowerCase()
    if (
      normalized.length < 1 ||
      normalized.length > 512 ||
      !Number.isSafeInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 100
    ) {
      throw new PhpIndexerError("invalid_input", "PHP symbol query is invalid")
    }
    return this.symbols
      .filter((symbol) =>
        `${symbol.qualifiedName}\0${symbol.originalName}`
          .toLowerCase()
          .includes(normalized)
      )
      .slice(0, maxResults)
  }

  neighborhood(
    symbolId: string,
    options: {
      readonly maxDepth?: number
      readonly maxSymbols?: number
      readonly maxRelationships?: number
    } = {}
  ): PhpRelationshipNeighborhood {
    const maxDepth = options.maxDepth ?? 2
    const maxSymbols = options.maxSymbols ?? 50
    const maxRelationships = options.maxRelationships ?? 100
    if (
      !this.symbolsById.has(symbolId) ||
      !Number.isSafeInteger(maxDepth) ||
      maxDepth < 0 ||
      maxDepth > 5 ||
      !Number.isSafeInteger(maxSymbols) ||
      maxSymbols < 1 ||
      maxSymbols > 200 ||
      !Number.isSafeInteger(maxRelationships) ||
      maxRelationships < 1 ||
      maxRelationships > 500
    ) {
      throw new PhpIndexerError(
        "invalid_input",
        "PHP relationship query is invalid"
      )
    }
    const visited = new Set<string>([symbolId])
    const selectedRelationships = new Map<string, PhpRelationship>()
    let frontier = [symbolId]
    let truncated = false
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = []
      for (const relationship of this.relationships) {
        const targetId = relationship.targetSymbolId
        const touches =
          frontier.includes(relationship.sourceSymbolId) ||
          (targetId !== undefined && frontier.includes(targetId))
        if (!touches) continue
        if (
          !selectedRelationships.has(relationship.id) &&
          selectedRelationships.size >= maxRelationships
        ) {
          truncated = true
          continue
        }
        selectedRelationships.set(relationship.id, relationship)
        for (const candidate of [relationship.sourceSymbolId, targetId]) {
          if (candidate === undefined || visited.has(candidate)) continue
          if (visited.size >= maxSymbols) {
            truncated = true
            continue
          }
          visited.add(candidate)
          next.push(candidate)
        }
      }
      frontier = next
    }
    return {
      symbols: [...visited]
        .map((id) => this.symbolsById.get(id))
        .filter((symbol): symbol is PhpSymbol => symbol !== undefined),
      relationships: [...selectedRelationships.values()],
      truncated,
    }
  }

  async sourceSlice(
    snapshot: CheckoutSnapshot,
    symbolId: string,
    options: {
      readonly contextLines?: number
      readonly maxLines?: number
      readonly maxCharacters?: number
    } = {}
  ): Promise<PhpSourceSlice> {
    const symbol = this.symbolsById.get(symbolId)
    const contextLines = options.contextLines ?? 2
    const maxLines = options.maxLines ?? 120
    const maxCharacters = options.maxCharacters ?? 32_768
    if (
      symbol === undefined ||
      !Number.isSafeInteger(contextLines) ||
      contextLines < 0 ||
      contextLines > 20 ||
      !Number.isSafeInteger(maxLines) ||
      maxLines < 1 ||
      maxLines > 500 ||
      !Number.isSafeInteger(maxCharacters) ||
      maxCharacters < 1 ||
      maxCharacters > 131_072
    ) {
      throw new PhpIndexerError(
        "invalid_input",
        "PHP source slice request is invalid"
      )
    }
    const source = await snapshot.readText(
      symbolFilePath(this.response, symbolId)
    )
    const lines = source.split(/\r?\n/)
    const startLine = Math.max(1, symbol.range.startLine - contextLines)
    const desiredEnd = Math.min(
      lines.length,
      symbol.range.endLine + contextLines
    )
    const endLine = Math.min(desiredEnd, startLine + maxLines - 1)
    const text = lines.slice(startLine - 1, endLine).join("\n")
    if (text.length > maxCharacters) {
      throw new PhpIndexerError(
        "limit_exceeded",
        "PHP source slice exceeds its character limit",
        { compatibility: true }
      )
    }
    return {
      path: symbolFilePath(this.response, symbolId),
      startLine,
      endLine,
      text,
      contentHash: contentHashSchema.parse(
        `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
      ),
    }
  }
}

function symbolFilePath(
  response: PhpIndexerResponse,
  symbolId: string
): string {
  const file = response.files.find((candidate) =>
    candidate.symbols.some((symbol) => symbol.id === symbolId)
  )
  if (file === undefined) {
    throw new PhpIndexerError("invalid_input", "PHP symbol is not indexed")
  }
  return file.path
}
