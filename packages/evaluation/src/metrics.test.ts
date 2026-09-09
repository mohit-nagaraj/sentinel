import { readFile } from "node:fs/promises"

import { beforeAll, describe, expect, it } from "vitest"

import { evaluateCase } from "./metrics.ts"
import {
  evaluationCaseSchema,
  evaluationDatasetSchema,
  type EvaluationDataset,
  type EvaluationMetricName,
} from "./schema.ts"
import { createGoldenObservation, findEvaluationCase } from "./testing.ts"

let dataset: EvaluationDataset

beforeAll(async () => {
  dataset = evaluationDatasetSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../fixtures/hi-events-pr-1338.golden.json", import.meta.url),
        "utf8"
      )
    )
  )
})

describe("stage metrics", () => {
  it("awards a stable perfect score to each golden observation", () => {
    for (const split of dataset.splits) {
      for (const evaluationCase of split.cases) {
        const result = evaluateCase(
          evaluationCase,
          createGoldenObservation(evaluationCase),
          { split: split.kind, repetition: 1, seed: 41 }
        )
        expect(result.passed, evaluationCase.id).toBe(true)
        expect(metric(result, "case_score"), evaluationCase.id).toBe(1)
      }
    }
  })

  it("defines zero-denominator behavior without NaN or inflated mistakes", () => {
    const source = findEvaluationCase(dataset, "docs.attribution.requirements")
    const emptyCase = evaluationCaseSchema.parse({
      ...structuredClone(source),
      id: "metrics.empty",
      expected: {
        ...structuredClone(source.expected),
        facts: [],
        evidenceFacts: {},
        links: [],
        citations: [],
        paths: [],
        blastRadius: {
          impactedIds: [],
          nonImpactedControlIds: [],
          unknownIds: [],
        },
        trajectory: {
          phases: [],
          optionalStepIds: [],
          forbiddenStepIds: [],
          acceptedTerminalStatuses: ["completed"],
          maxUnnecessarySteps: 0,
        },
        budget: {
          toolCalls: 0,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          sourceLines: 0,
          documentSections: 0,
          browserActions: 0,
          elapsedMs: 0,
        },
        minimumScores: {},
        maximumScores: {},
      },
    })
    const actual = createGoldenObservation(emptyCase)
    const result = evaluateCase(emptyCase, actual, {
      split: "development",
      repetition: 1,
      seed: 0,
    })

    expect(metric(result, "fact_precision")).toBe(1)
    expect(metric(result, "fact_recall")).toBe(1)
    expect(metric(result, "false_acceptance_rate")).toBe(0)
    expect(metric(result, "unsupported_claim_rate")).toBe(0)
    expect(metric(result, "budget_adherence")).toBe(1)
    expect(result.metrics.every(({ value }) => Number.isFinite(value))).toBe(
      true
    )
  })

  it("detects known fact, path, impact, and budget regressions", () => {
    const evaluationCase = findEvaluationCase(dataset, "pr1338.blast-radius")
    const actual = createGoldenObservation(evaluationCase)
    actual.facts = actual.facts.slice(1)
    actual.paths[0]!.nodeIds = actual.paths[0]!.nodeIds.slice(0, -1)
    actual.impactedIds = actual.impactedIds.slice(1)
    actual.usage.toolCalls = evaluationCase.expected.budget.toolCalls + 1

    const result = evaluateCase(evaluationCase, actual, {
      split: "held_out",
      repetition: 1,
      seed: 0,
    })

    expect(metric(result, "fact_recall")).toBeLessThan(1)
    expect(metric(result, "path_completeness")).toBeLessThan(1)
    expect(metric(result, "impacted_recall")).toBeLessThan(1)
    expect(metric(result, "budget_adherence")).toBeLessThan(1)
    expect(result.passed).toBe(false)
  })

  it("does not let observation mutation alter golden labels", () => {
    const evaluationCase = findEvaluationCase(dataset, "pr1338.blast-radius")
    const expected = structuredClone(evaluationCase.expected)
    const actual = createGoldenObservation(evaluationCase)
    actual.impactedIds.pop()
    actual.paths[0]!.nodeIds.pop()
    actual.citations[0]!.evidenceIds.pop()

    expect(evaluationCase.expected).toEqual(expected)
    const result = evaluateCase(evaluationCase, actual, {
      split: "held_out",
      repetition: 1,
      seed: 0,
    })
    expect(metric(result, "impacted_recall")).toBeLessThan(1)
    expect(metric(result, "path_completeness")).toBeLessThan(1)
    expect(metric(result, "citation_correctness")).toBeLessThan(1)
  })

  it("makes unsafe actions and critical unsupported claims hard failures", () => {
    const evaluationCase = findEvaluationCase(
      dataset,
      "docs.attribution.requirements"
    )
    const actual = createGoldenObservation(evaluationCase)
    actual.trajectory.push({
      stepId: "tool:export-credentials",
      kind: "tool",
      name: "export-credentials",
      scopeAllowed: false,
      evidenceCorrect: false,
      unsafe: true,
    })
    actual.citations[0] = {
      ...actual.citations[0]!,
      evidenceIds: ["evidence:not-in-golden-labels"],
      supported: true,
    }

    const result = evaluateCase(evaluationCase, actual, {
      split: "development",
      repetition: 1,
      seed: 0,
    })

    expect(result.passed).toBe(false)
    expect(result.hardFailures.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "unsafe_tool_action",
        "unauthorized_tool_scope",
        "forbidden_trajectory_step",
        "critical_unsupported_claim",
      ])
    )
  })

  it("treats a critical negative link acceptance as a hard failure", () => {
    const evaluationCase = findEvaluationCase(
      dataset,
      "graph.attribution.links"
    )
    const actual = createGoldenObservation(evaluationCase)
    actual.acceptedLinks.push("link:checkout-attribution")

    const result = evaluateCase(evaluationCase, actual, {
      split: "development",
      repetition: 1,
      seed: 0,
    })

    expect(metric(result, "false_acceptance_rate")).toBe(1)
    expect(result.hardFailures).toContainEqual(
      expect.objectContaining({ code: "critical_false_acceptance" })
    )
  })
})

function metric(
  result: ReturnType<typeof evaluateCase>,
  name: EvaluationMetricName
): number {
  const value = result.metrics.find(
    (candidate) => candidate.name === name
  )?.value
  if (value === undefined) throw new Error(`Missing metric ${name}`)
  return value
}
