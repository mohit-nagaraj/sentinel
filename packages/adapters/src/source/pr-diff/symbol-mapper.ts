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

function compareSymbols(left: AffectedSymbol, right: AffectedSymbol): number {
  return (
    rangeSize(left.range) - rangeSize(right.range) ||
    compareStrings(left.qualifiedName, right.qualifiedName) ||
    compareStrings(left.id, right.id)
  )
}

class SymbolHeap {
  private readonly values: AffectedSymbol[] = []

  peek(): AffectedSymbol | undefined {
    return this.values[0]
  }

  push(value: AffectedSymbol): void {
    this.values.push(value)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compareSymbols(this.values[parent]!, value) <= 0) break
      this.values[index] = this.values[parent]!
      index = parent
    }
    this.values[index] = value
  }

  pop(): AffectedSymbol | undefined {
    const first = this.values[0]
    const last = this.values.pop()
    if (first === undefined || last === undefined || this.values.length === 0) {
      return first
    }
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      if (left >= this.values.length) break
      const child =
        right < this.values.length &&
        compareSymbols(this.values[right]!, this.values[left]!) < 0
          ? right
          : left
      if (compareSymbols(this.values[child]!, last) >= 0) break
      this.values[index] = this.values[child]!
      index = child
    }
    this.values[index] = last
    return first
  }
}

function enclosingSymbolsByLine(
  symbols: readonly AffectedSymbol[],
  lines: readonly number[]
): ReadonlyMap<
  number,
  { readonly symbol: AffectedSymbol; readonly ambiguous: boolean }
> {
  const orderedSymbols = [...symbols].sort(
    (left, right) =>
      left.range.startLine - right.range.startLine ||
      compareSymbols(left, right)
  )
  const heap = new SymbolHeap()
  const selections = new Map<
    number,
    { readonly symbol: AffectedSymbol; readonly ambiguous: boolean }
  >()
  let symbolIndex = 0
  const discardExpired = (line: number): void => {
    while ((heap.peek()?.range.endLine ?? line) < line) heap.pop()
  }
  for (const line of lines) {
    while (
      orderedSymbols[symbolIndex] !== undefined &&
      orderedSymbols[symbolIndex]!.range.startLine <= line
    ) {
      heap.push(orderedSymbols[symbolIndex]!)
      symbolIndex += 1
    }
    discardExpired(line)
    const symbol = heap.pop()
    if (symbol === undefined) continue
    discardExpired(line)
    const next = heap.peek()
    selections.set(line, {
      symbol,
      ambiguous:
        next !== undefined && rangeSize(next.range) === rangeSize(symbol.range),
    })
    heap.push(symbol)
  }
  return selections
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

function groupByStructure(
  occurrences: readonly SymbolOccurrence[]
): ReadonlyMap<string, readonly SymbolOccurrence[]> {
  const groups = new Map<string, SymbolOccurrence[]>()
  for (const occurrence of occurrences) {
    const key = structuralKey(occurrence.symbol)
    const selected = groups.get(key) ?? []
    selected.push(occurrence)
    groups.set(key, selected)
  }
  return groups
}

function moveIdentity(occurrence: SymbolOccurrence): string {
  return `${structuralKey(occurrence.symbol)}\0${occurrence.symbol.contentHash}`
}

function groupByMoveIdentity(
  occurrences: readonly SymbolOccurrence[]
): ReadonlyMap<string, readonly SymbolOccurrence[]> {
  const groups = new Map<string, SymbolOccurrence[]>()
  for (const occurrence of occurrences) {
    const key = moveIdentity(occurrence)
    const selected = groups.get(key) ?? []
    selected.push(occurrence)
    groups.set(key, selected)
  }
  return groups
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
  readonly occurrencesByFile: ReadonlyMap<string, readonly SymbolOccurrence[]>
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
  const symbolsByPath = new Map<string, AffectedSymbol[]>()
  for (const symbol of index.symbols) {
    const selected = symbolsByPath.get(symbol.filePath) ?? []
    selected.push(symbol)
    symbolsByPath.set(symbol.filePath, selected)
  }
  for (const file of files) {
    const path = side === "base" ? file.oldPath : file.newPath
    const ranges = side === "base" ? file.baseRanges : file.headRanges
    if (path === undefined) continue
    const changedLines = [
      ...new Set(
        ranges.flatMap((range) => {
          const lines: number[] = []
          for (let line = range.startLine; line <= range.endLine; line += 1) {
            lines.push(line)
          }
          return lines
        })
      ),
    ].sort((left, right) => left - right)
    const selections = enclosingSymbolsByLine(
      symbolsByPath.get(path) ?? [],
      changedLines
    )
    for (const [line, selection] of selections) {
      const range = { startLine: line, endLine: line }
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
      mappedLinesByFile.set(fileKey, (mappedLinesByFile.get(fileKey) ?? 0) + 1)
    }
    if (file.operation === "renamed") {
      for (const symbol of symbolsByPath.get(path) ?? []) {
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
  const occurrences = Object.freeze(
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
  )
  const occurrencesByFile = new Map<string, SymbolOccurrence[]>()
  for (const occurrence of occurrences) {
    const key = relationKey(occurrence.file)
    const selected = occurrencesByFile.get(key) ?? []
    selected.push(occurrence)
    occurrencesByFile.set(key, selected)
  }
  return {
    occurrences,
    occurrencesByFile,
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
  const baseOccurrences = base.occurrencesByFile.get(key) ?? []
  const headOccurrences = head.occurrencesByFile.get(key) ?? []
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
    const baseCandidates = base.occurrencesByFile.get(key) ?? []
    const headCandidates = head.occurrencesByFile.get(key) ?? []
    const baseByStructure = groupByStructure(baseCandidates)
    const headByStructure = groupByStructure(headCandidates)
    const signatures = new Set([
      ...baseByStructure.keys(),
      ...headByStructure.keys(),
    ])
    for (const signature of [...signatures].sort(compareStrings)) {
      const oldMatches = baseByStructure.get(signature) ?? []
      const newMatches = headByStructure.get(signature) ?? []
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
  const unmatchedBaseByMove = groupByMoveIdentity(unmatchedBase)
  const unmatchedHeadByMove = groupByMoveIdentity(unmatchedHead)
  const moveKeys = new Set(unmatchedBaseByMove.keys())
  for (const key of [...moveKeys].sort(compareStrings)) {
    const oldMatches = unmatchedBaseByMove.get(key) ?? []
    const newMatches = unmatchedHeadByMove.get(key) ?? []
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
