import {
  MAX_PR_INVESTIGATED_SYMBOLS,
  MAX_PR_INVESTIGATION_GROUPS,
  MAX_PR_SYMBOLS_PER_GROUP,
  hashCanonical,
  prInvestigationBaselineOutcomeSchema,
  prInvestigationChangeGroupSchema,
  prInvestigationPreparedInputSchema,
  prInvestigationUnknownSchema,
  type BaselineCompatibility,
  type ChangedSymbol,
  type PrDiffAnalysis,
  type PrInvestigationBaselineOutcome,
  type PrInvestigationChangeGroup,
  type PrInvestigationRelationshipHint,
  type PrInvestigationUnknown,
} from "@sentinel/contracts"

interface ChangeUnit {
  readonly key: string
  readonly symbolIds: readonly string[]
  readonly filePaths: readonly string[]
  readonly parentSymbolIds: readonly string[]
  readonly endpointIds: readonly string[]
  readonly domainEntityIds: readonly string[]
  readonly operation: ChangedSymbol["operation"]
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export interface GroupedPrChanges {
  readonly groups: readonly PrInvestigationChangeGroup[]
  readonly unknowns: readonly PrInvestigationUnknown[]
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings)
}

function intersects(
  left: readonly string[],
  right: readonly string[]
): boolean {
  const values = new Set(left)
  return right.some((value) => values.has(value))
}

function symbolIds(symbol: ChangedSymbol): string[] {
  return sortedUnique([
    ...(symbol.base === undefined ? [] : [symbol.base.id]),
    ...(symbol.head === undefined ? [] : [symbol.head.id]),
  ])
}

function relationshipHints(
  symbol: ChangedSymbol,
  hints: ReadonlyMap<string, PrInvestigationRelationshipHint>
) {
  const selected = symbolIds(symbol)
    .map((id) => hints.get(id))
    .filter((value) => value !== undefined)
  return {
    endpointIds: sortedUnique(
      selected.flatMap(({ endpointIds }) => endpointIds)
    ),
    domainEntityIds: sortedUnique(
      selected.flatMap(({ domainEntityIds }) => domainEntityIds)
    ),
  }
}

function toUnit(
  symbol: ChangedSymbol,
  hints: ReadonlyMap<string, PrInvestigationRelationshipHint>
): ChangeUnit {
  const relationships = relationshipHints(symbol, hints)
  const ids = symbolIds(symbol)
  return {
    key: hashCanonical({
      operation: symbol.operation,
      symbolIds: ids,
      baseRanges: symbol.baseRanges,
      headRanges: symbol.headRanges,
    }),
    symbolIds: ids,
    filePaths: sortedUnique([
      ...(symbol.base === undefined ? [] : [symbol.base.filePath]),
      ...(symbol.head === undefined ? [] : [symbol.head.filePath]),
    ]),
    parentSymbolIds: sortedUnique([
      ...(symbol.base?.parentSymbolIds ?? []),
      ...(symbol.head?.parentSymbolIds ?? []),
    ]),
    endpointIds: relationships.endpointIds,
    domainEntityIds: relationships.domainEntityIds,
    operation: symbol.operation,
  }
}

function areRelated(left: ChangeUnit, right: ChangeUnit): boolean {
  return (
    intersects(left.filePaths, right.filePaths) ||
    intersects(left.parentSymbolIds, right.parentSymbolIds) ||
    intersects(left.parentSymbolIds, right.symbolIds) ||
    intersects(right.parentSymbolIds, left.symbolIds) ||
    intersects(left.endpointIds, right.endpointIds) ||
    intersects(left.domainEntityIds, right.domainEntityIds)
  )
}

function groupingReasons(units: readonly ChangeUnit[]) {
  const reasons = new Set<
    PrInvestigationChangeGroup["groupingReasons"][number]
  >()
  for (let leftIndex = 0; leftIndex < units.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < units.length;
      rightIndex += 1
    ) {
      const left = units[leftIndex]!
      const right = units[rightIndex]!
      if (intersects(left.filePaths, right.filePaths)) reasons.add("same_file")
      if (
        intersects(left.parentSymbolIds, right.parentSymbolIds) ||
        intersects(left.parentSymbolIds, right.symbolIds) ||
        intersects(right.parentSymbolIds, left.symbolIds)
      ) {
        reasons.add("structural_parent")
      }
      if (intersects(left.endpointIds, right.endpointIds)) {
        reasons.add("shared_endpoint")
      }
      if (intersects(left.domainEntityIds, right.domainEntityIds)) {
        reasons.add("shared_domain_entity")
      }
    }
  }
  if (reasons.size === 0) reasons.add("standalone_change")
  return [...reasons].sort()
}

function groupFrom(units: readonly ChangeUnit[]): PrInvestigationChangeGroup {
  const draft = {
    schemaVersion: 1,
    symbolIds: sortedUnique(units.flatMap(({ symbolIds }) => symbolIds)),
    filePaths: sortedUnique(units.flatMap(({ filePaths }) => filePaths)),
    endpointIds: sortedUnique(units.flatMap(({ endpointIds }) => endpointIds)),
    domainEntityIds: sortedUnique(
      units.flatMap(({ domainEntityIds }) => domainEntityIds)
    ),
    operations: sortedUnique(units.map(({ operation }) => operation)),
    groupingReasons: groupingReasons(units),
  }
  return prInvestigationChangeGroupSchema.parse({
    ...draft,
    id: hashCanonical({ kind: "pr-change-group", version: 1, ...draft }),
  })
}

function unknown(input: {
  readonly kind: "file" | "symbol"
  readonly filePaths: readonly string[]
  readonly symbolIds: readonly string[]
  readonly classifications?: readonly string[]
  readonly unresolvedReasons: readonly string[]
  readonly summary: string
}): PrInvestigationUnknown {
  const draft = {
    schemaVersion: 1,
    kind: input.kind,
    filePaths: sortedUnique(input.filePaths),
    symbolIds: sortedUnique(input.symbolIds),
    classifications: sortedUnique(input.classifications ?? []),
    unresolvedReasons: sortedUnique(input.unresolvedReasons),
    summary: input.summary,
  }
  return prInvestigationUnknownSchema.parse({
    ...draft,
    id: hashCanonical({
      identityKind: "pr-investigation-unknown",
      version: 1,
      ...draft,
    }),
  })
}

function fileUnknowns(analysis: PrDiffAnalysis): PrInvestigationUnknown[] {
  const classificationReason = {
    configuration: "configuration_change",
    schema: "schema_change",
    generated: "generated_change",
    lockfile: "lockfile_change",
    binary: "binary_change",
    unsupported: "unsupported_change",
  } as const
  return analysis.files.flatMap((file) => {
    const special = file.classifications.some((classification) =>
      [
        "configuration",
        "schema",
        "generated",
        "lockfile",
        "binary",
        "unsupported",
      ].includes(classification)
    )
    if (
      !special &&
      file.mappingStatus !== "unmapped" &&
      file.mappingStatus !== "partially_mapped"
    ) {
      return []
    }
    const paths = [
      ...(file.oldPath === undefined ? [] : [file.oldPath]),
      ...(file.newPath === undefined ? [] : [file.newPath]),
    ]
    const fallbackReason =
      file.classifications
        .map((classification) =>
          classification in classificationReason
            ? classificationReason[
                classification as keyof typeof classificationReason
              ]
            : undefined
        )
        .find((reason) => reason !== undefined) ?? "no_enclosing_symbol"
    return [
      unknown({
        kind: "file",
        filePaths: paths,
        symbolIds: [...file.baseSymbolIds, ...file.headSymbolIds],
        classifications: file.classifications,
        unresolvedReasons:
          file.unresolvedReasons.length === 0
            ? [fallbackReason]
            : file.unresolvedReasons,
        summary:
          file.mappingStatus === "partially_mapped"
            ? "Part of the changed file is not mapped to an investigated symbol"
            : "Changed file is retained without a confident symbol mapping",
      }),
    ]
  })
}

function components(units: readonly ChangeUnit[]): ChangeUnit[][] {
  const parents = units.map((_, index) => index)
  const find = (index: number): number => {
    let current = index
    while (parents[current] !== current) {
      parents[current] = parents[parents[current]!]!
      current = parents[current]!
    }
    return current
  }
  const union = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot === rightRoot) return
    const [first, second] = [leftRoot, rightRoot].sort((a, b) => a - b)
    parents[second!] = first!
  }
  for (let left = 0; left < units.length; left += 1) {
    for (let right = left + 1; right < units.length; right += 1) {
      if (areRelated(units[left]!, units[right]!)) union(left, right)
    }
  }
  const grouped = new Map<number, ChangeUnit[]>()
  units.forEach((unit, index) => {
    const root = find(index)
    grouped.set(root, [...(grouped.get(root) ?? []), unit])
  })
  return [...grouped.values()]
    .map((values) =>
      values.sort((left, right) => compareStrings(left.key, right.key))
    )
    .sort((left, right) => compareStrings(left[0]!.key, right[0]!.key))
}

function boundedChunks(units: readonly ChangeUnit[]): ChangeUnit[][] {
  const chunks: ChangeUnit[][] = []
  let current: ChangeUnit[] = []
  let currentSymbols = 0
  for (const unit of units) {
    if (
      current.length > 0 &&
      currentSymbols + unit.symbolIds.length > MAX_PR_SYMBOLS_PER_GROUP
    ) {
      chunks.push(current)
      current = []
      currentSymbols = 0
    }
    current.push(unit)
    currentSymbols += unit.symbolIds.length
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export function baselineOutcome(
  compatibility: BaselineCompatibility
): PrInvestigationBaselineOutcome {
  return prInvestigationBaselineOutcomeSchema.parse({
    compatibility,
    disposition: compatibility.assessmentAllowed
      ? compatibility.status === "exact"
        ? "proceed"
        : "proceed_with_warning"
      : "action_required",
    action: compatibility.assessmentAllowed
      ? "none"
      : compatibility.status === "stale_relevant"
        ? "refresh_graph"
        : "reconnect_baseline",
  })
}

export function groupPrChanges(inputValue: {
  readonly analysis: PrDiffAnalysis
  readonly hints?: readonly PrInvestigationRelationshipHint[]
}): GroupedPrChanges {
  const input = prInvestigationPreparedInputSchema.parse({
    analysis: inputValue.analysis,
    hints: inputValue.hints ?? [],
  })
  const hints = new Map(input.hints.map((hint) => [hint.symbolId, hint]))
  const allUnits = input.analysis.symbols
    .map((symbol) => toUnit(symbol, hints))
    .sort((left, right) => compareStrings(left.key, right.key))
  const acceptedUnits: ChangeUnit[] = []
  const unknowns = fileUnknowns(input.analysis)
  let symbolCount = 0
  for (const unit of allUnits) {
    if (symbolCount + unit.symbolIds.length > MAX_PR_INVESTIGATED_SYMBOLS) {
      unknowns.push(
        unknown({
          kind: "symbol",
          filePaths: unit.filePaths,
          symbolIds: unit.symbolIds,
          unresolvedReasons: ["investigation_symbol_limit"],
          summary:
            "Changed symbol was retained after the investigation symbol limit",
        })
      )
      continue
    }
    acceptedUnits.push(unit)
    symbolCount += unit.symbolIds.length
  }

  const chunks = components(acceptedUnits).flatMap(boundedChunks)
  const selected = chunks.slice(0, MAX_PR_INVESTIGATION_GROUPS)
  for (const unit of chunks.slice(MAX_PR_INVESTIGATION_GROUPS).flat()) {
    unknowns.push(
      unknown({
        kind: "symbol",
        filePaths: unit.filePaths,
        symbolIds: unit.symbolIds,
        unresolvedReasons: ["investigation_group_limit"],
        summary:
          "Changed symbol was retained after the investigation group limit",
      })
    )
  }

  return {
    groups: selected
      .map(groupFrom)
      .sort((left, right) => compareStrings(left.id, right.id)),
    unknowns: [
      ...new Map(unknowns.map((item) => [item.id, item])).values(),
    ].sort((left, right) => compareStrings(left.id, right.id)),
  }
}
