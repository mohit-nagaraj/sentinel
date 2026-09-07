import type {
  ChangedFile,
  ChangedSymbol,
  ChangedSymbolSide,
} from "@sentinel/contracts"

import type { AffectedSymbol, AffectedSymbolIndex } from "./affected-indexer.ts"
import type {
  ChangedFileUnresolvedReason,
  DiffRange,
  ParsedDiffFile,
} from "./diff-parser.ts"

interface SymbolOccurrence {
  readonly symbol: AffectedSymbol
  readonly ranges: readonly DiffRange[]
  readonly file: ParsedDiffFile
  readonly ambiguous: boolean
}

export interface SymbolMappingResult {
  readonly files: readonly ChangedFile[]
  readonly symbols: readonly ChangedSymbol[]
}

type PrDiffProvenance = ChangedFile["provenance"]

function compareStrings(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function rangeSize(range: DiffRange): number {
  return range.endLine - range.startLine
}

function uniqueRanges(ranges: readonly DiffRange[]): readonly DiffRange[] {
  const merged: DiffRange[] = []
  for (const range of [...ranges].sort(
    (left, right) =>
      left.startLine - right.startLine || left.endLine - right.endLine
  )) {
    const previous = merged.at(-1)
    if (previous !== undefined && range.startLine <= previous.endLine + 1) {
      merged[merged.length - 1] = {
        startLine: previous.startLine,
        endLine: Math.max(previous.endLine, range.endLine),
      }
    } else {
      merged.push(range)
    }
  }
  return Object.freeze(merged)
}

function smallestEnclosing(
  symbols: readonly AffectedSymbol[],
  path: string,
  range: DiffRange
):
  { readonly symbol: AffectedSymbol; readonly ambiguous: boolean } | undefined {
  const candidates = symbols
    .filter(
      (symbol) =>
        symbol.filePath === path &&
        symbol.range.startLine <= range.startLine &&
        symbol.range.endLine >= range.endLine
    )
    .sort(
      (left, right) =>
        rangeSize(left.range) - rangeSize(right.range) ||
        compareStrings(left.qualifiedName, right.qualifiedName)
    )
  const symbol = candidates[0]
  if (symbol === undefined) return undefined
  return {
    symbol,
    ambiguous:
      candidates[1] !== undefined &&
      rangeSize(candidates[1].range) === rangeSize(symbol.range),
  }
}

function structuralName(symbol: AffectedSymbol): string {
  if (symbol.language === "typescript" || symbol.language === "tsx") {
    return symbol.qualifiedName === symbol.filePath
      ? "@module"
      : symbol.qualifiedName.slice(`${symbol.filePath}#`.length)
  }
  return symbol.qualifiedName
}

function structuralKey(symbol: AffectedSymbol): string {
  return `${symbol.language}\0${symbol.kind}\0${structuralName(symbol)}`
}

function relationKey(file: ParsedDiffFile): string {
  return `${file.oldPath ?? ""}\0${file.newPath ?? ""}`
}

function sideSummary(symbol: AffectedSymbol): ChangedSymbolSide {
  return {
    id: symbol.id,
    filePath: symbol.filePath,
    qualifiedName: symbol.qualifiedName,
    name: symbol.name,
    kind: symbol.kind,
    language: symbol.language,
    range: symbol.range,
    parentSymbolIds: [...symbol.parentSymbolIds],
    contentHash: symbol.contentHash,
  }
}

function groupOccurrences(
  files: readonly ParsedDiffFile[],
  index: AffectedSymbolIndex,
  side: "base" | "head"
): {
  readonly occurrences: readonly SymbolOccurrence[]
  readonly mappedLinesByFile: ReadonlyMap<string, number>
} {
  const bySymbol = new Map<
    string,
    {
      symbol: AffectedSymbol
      ranges: DiffRange[]
      file: ParsedDiffFile
      ambiguous: boolean
    }
  >()
  const mappedLinesByFile = new Map<string, number>()
  for (const file of files) {
    const path = side === "base" ? file.oldPath : file.newPath
    const ranges = side === "base" ? file.baseRanges : file.headRanges
    if (path === undefined) continue
    for (const changedRange of ranges) {
      for (
        let line = changedRange.startLine;
        line <= changedRange.endLine;
        line += 1
      ) {
        const range = { startLine: line, endLine: line }
        const selection = smallestEnclosing(index.symbols, path, range)
        if (selection === undefined) continue
        const { symbol } = selection
        const key = `${relationKey(file)}\0${symbol.id}`
        const existing = bySymbol.get(key)
        if (existing === undefined) {
          bySymbol.set(key, {
            symbol,
            ranges: [range],
            file,
            ambiguous: selection.ambiguous,
          })
        } else {
          existing.ranges.push(range)
          existing.ambiguous ||= selection.ambiguous
        }
        const fileKey = relationKey(file)
        mappedLinesByFile.set(
          fileKey,
          (mappedLinesByFile.get(fileKey) ?? 0) + 1
        )
      }
    }
    if (file.operation === "renamed") {
      for (const symbol of index.symbols.filter(
        (candidate) => candidate.filePath === path
      )) {
        const key = `${relationKey(file)}\0${symbol.id}`
        if (!bySymbol.has(key)) {
          bySymbol.set(key, { symbol, ranges: [], file, ambiguous: false })
        }
      }
    }
  }
  const structuralCounts = new Map<string, number>()
  for (const { symbol, file } of bySymbol.values()) {
    const key = `${relationKey(file)}\0${structuralKey(symbol)}`
    structuralCounts.set(key, (structuralCounts.get(key) ?? 0) + 1)
  }
  return {
    occurrences: Object.freeze(
      [...bySymbol.values()].map(({ symbol, ranges, file, ambiguous }) => ({
        symbol,
        ranges: uniqueRanges(ranges),
        file,
        ambiguous:
          ambiguous ||
          (structuralCounts.get(
            `${relationKey(file)}\0${structuralKey(symbol)}`
          ) ?? 0) > 1,
      }))
    ),
    mappedLinesByFile,
  }
}

function failureReason(
  index: AffectedSymbolIndex,
  path: string | undefined
): ChangedFileUnresolvedReason | undefined {
  if (path === undefined) return undefined
  return index.failures.find((failure) => failure.path === path)?.reason
}

function asChangedFile(
  file: ParsedDiffFile,
  base: ReturnType<typeof groupOccurrences>,
  head: ReturnType<typeof groupOccurrences>,
  baseIndex: AffectedSymbolIndex,
  headIndex: AffectedSymbolIndex,
  provenance: PrDiffProvenance
): ChangedFile {
  const key = relationKey(file)
  const baseOccurrences = base.occurrences.filter(
    ({ file: candidate }) => relationKey(candidate) === key
  )
  const headOccurrences = head.occurrences.filter(
    ({ file: candidate }) => relationKey(candidate) === key
  )
  const expectedLines = [...file.baseRanges, ...file.headRanges].reduce(
    (total, range) => total + range.endLine - range.startLine + 1,
    0
  )
  const mappedLines =
    (base.mappedLinesByFile.get(key) ?? 0) +
    (head.mappedLinesByFile.get(key) ?? 0)
  const reasons = new Set<ChangedFileUnresolvedReason>(file.unresolvedReasons)
  const baseFailure = failureReason(baseIndex, file.oldPath)
  const headFailure = failureReason(headIndex, file.newPath)
  if (baseFailure !== undefined) reasons.add(baseFailure)
  if (headFailure !== undefined) reasons.add(headFailure)
  if (expectedLines > mappedLines && file.language !== undefined) {
    reasons.add("no_enclosing_symbol")
  }
  const mappingStatus =
    ((expectedLines > 0 && mappedLines === expectedLines) ||
      (file.operation === "renamed" &&
        baseOccurrences.length > 0 &&
        headOccurrences.length > 0)) &&
    reasons.size === 0
      ? "mapped"
      : mappedLines > 0 ||
          baseOccurrences.length > 0 ||
          headOccurrences.length > 0
        ? "partially_mapped"
        : "unmapped"
  const baseSymbolIds = [
    ...new Set(baseOccurrences.map(({ symbol }) => symbol.id)),
  ].sort(compareStrings)
  const headSymbolIds = [
    ...new Set(headOccurrences.map(({ symbol }) => symbol.id)),
  ].sort(compareStrings)
  return {
    operation: file.operation,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    ...(file.newPath === undefined ? {} : { newPath: file.newPath }),
    ...(file.oldMode === undefined ? {} : { oldMode: file.oldMode }),
    ...(file.newMode === undefined ? {} : { newMode: file.newMode }),
    ...(file.similarity === undefined ? {} : { similarity: file.similarity }),
    ...(file.language === undefined ? {} : { language: file.language }),
    classifications: [...file.classifications],
    baseRanges: [...file.baseRanges],
    headRanges: [...file.headRanges],
    binary: file.binary,
    noNewlineAtEnd: file.noNewlineAtEnd,
    mappingStatus,
    baseSymbolIds,
    headSymbolIds,
    unresolvedReasons: [...reasons].sort(compareStrings),
    provenance,
  }
}

function changedSymbol(
  operation: ChangedSymbol["operation"],
  base: SymbolOccurrence | undefined,
  head: SymbolOccurrence | undefined,
  matchStrategy: ChangedSymbol["matchStrategy"],
  provenance: PrDiffProvenance
): ChangedSymbol {
  const unresolvedReasons =
    base?.ambiguous === true || head?.ambiguous === true
      ? (["symbol_match_ambiguous"] as const)
      : []
  return {
    operation,
    ...(base === undefined ? {} : { base: sideSummary(base.symbol) }),
    ...(head === undefined ? {} : { head: sideSummary(head.symbol) }),
    baseRanges: base === undefined ? [] : [...base.ranges],
    headRanges: head === undefined ? [] : [...head.ranges],
    matchStrategy,
    unresolvedReasons: [...unresolvedReasons],
    provenance,
  }
}

export function mapDiffSymbols(
  files: readonly ParsedDiffFile[],
  baseIndex: AffectedSymbolIndex,
  headIndex: AffectedSymbolIndex,
  provenance: PrDiffProvenance
): SymbolMappingResult {
  const base = groupOccurrences(files, baseIndex, "base")
  const head = groupOccurrences(files, headIndex, "head")
  const consumedBase = new Set<SymbolOccurrence>()
  const consumedHead = new Set<SymbolOccurrence>()
  const symbols: ChangedSymbol[] = []

  for (const file of files) {
    const key = relationKey(file)
    const baseCandidates = base.occurrences.filter(
      (occurrence) => relationKey(occurrence.file) === key
    )
    const headCandidates = head.occurrences.filter(
      (occurrence) => relationKey(occurrence.file) === key
    )
    const signatures = new Set([
      ...baseCandidates.map(({ symbol }) => structuralKey(symbol)),
      ...headCandidates.map(({ symbol }) => structuralKey(symbol)),
    ])
    for (const signature of [...signatures].sort(compareStrings)) {
      const oldMatches = baseCandidates.filter(
        ({ symbol }) => structuralKey(symbol) === signature
      )
      const newMatches = headCandidates.filter(
        ({ symbol }) => structuralKey(symbol) === signature
      )
      if (
        oldMatches.length !== 1 ||
        newMatches.length !== 1 ||
        oldMatches[0]!.ambiguous ||
        newMatches[0]!.ambiguous
      ) {
        continue
      }
      const oldMatch = oldMatches[0]!
      const newMatch = newMatches[0]!
      consumedBase.add(oldMatch)
      consumedHead.add(newMatch)
      symbols.push(
        changedSymbol(
          file.operation === "renamed" ? "renamed" : "modified",
          oldMatch,
          newMatch,
          file.operation === "renamed"
            ? "git_rename_structure"
            : "same_structure",
          provenance
        )
      )
    }
  }

  const unmatchedBase = base.occurrences.filter(
    (occurrence) => !consumedBase.has(occurrence)
  )
  const unmatchedHead = head.occurrences.filter(
    (occurrence) => !consumedHead.has(occurrence)
  )
  const moveKeys = new Set(
    unmatchedBase.map(
      ({ symbol }) => `${structuralKey(symbol)}\0${symbol.contentHash}`
    )
  )
  for (const key of [...moveKeys].sort(compareStrings)) {
    const oldMatches = unmatchedBase.filter(
      ({ symbol }) => `${structuralKey(symbol)}\0${symbol.contentHash}` === key
    )
    const newMatches = unmatchedHead.filter(
      ({ symbol }) => `${structuralKey(symbol)}\0${symbol.contentHash}` === key
    )
    if (
      oldMatches.length !== 1 ||
      newMatches.length !== 1 ||
      oldMatches[0]!.ambiguous ||
      newMatches[0]!.ambiguous ||
      oldMatches[0]!.symbol.filePath === newMatches[0]!.symbol.filePath
    ) {
      continue
    }
    const oldMatch = oldMatches[0]!
    const newMatch = newMatches[0]!
    consumedBase.add(oldMatch)
    consumedHead.add(newMatch)
    symbols.push(
      changedSymbol(
        "moved",
        oldMatch,
        newMatch,
        "unique_exact_content",
        provenance
      )
    )
  }

  for (const occurrence of base.occurrences) {
    if (!consumedBase.has(occurrence)) {
      symbols.push(
        changedSymbol("deleted", occurrence, undefined, "unmatched", provenance)
      )
    }
  }
  for (const occurrence of head.occurrences) {
    if (!consumedHead.has(occurrence)) {
      symbols.push(
        changedSymbol("added", undefined, occurrence, "unmatched", provenance)
      )
    }
  }

  return Object.freeze({
    files: Object.freeze(
      files.map((file) =>
        asChangedFile(file, base, head, baseIndex, headIndex, provenance)
      )
    ),
    symbols: Object.freeze(
      symbols.sort((left, right) =>
        compareStrings(
          `${left.base?.filePath ?? ""}\0${left.head?.filePath ?? ""}\0${left.base?.qualifiedName ?? left.head?.qualifiedName ?? ""}\0${left.operation}`,
          `${right.base?.filePath ?? ""}\0${right.head?.filePath ?? ""}\0${right.base?.qualifiedName ?? right.head?.qualifiedName ?? ""}\0${right.operation}`
        )
      )
    ),
  })
}
