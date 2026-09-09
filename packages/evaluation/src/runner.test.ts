import { readFile } from "node:fs/promises"

import { beforeAll, describe, expect, it } from "vitest"

import { runEvaluation, type EvaluationTargetRequest } from "./runner.ts"
import {
  evaluationDatasetSchema,
  PAID_EVALUATION_CONFIRMATION,
  type EvaluationDataset,
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

describe("evaluation runner", () => {
  it("executes whole-graph, node, partial, and checkpoint cases without label leakage", async () => {
    const requests: EvaluationTargetRequest[] = []
    const report = await runEvaluation(
      dataset,
      {
        execute(request) {
          requests.push(request)
          expect(request).not.toHaveProperty("expected")
          expect(request.input).not.toHaveProperty("expected")
          return createGoldenObservation(
            findEvaluationCase(dataset, request.caseId)
          )
        },
      },
      configuration({ splits: ["development", "held_out"] }),
      fixedClock()
    )

    expect(report.summary).toMatchObject({
      caseExecutions: 4,
      passed: 4,
      failed: 0,
      hardFailures: 0,
      passRate: 1,
    })
    expect(requests.map(({ execution }) => execution.scope).sort()).toEqual([
      "checkpoint",
      "node",
      "partial",
      "whole_graph",
    ])
  })

  it("proves deterministic normalized evidence stability across 100 runs", async () => {
    const report = await runEvaluation(
      dataset,
      {
        execute(request) {
          return createGoldenObservation(
            findEvaluationCase(dataset, request.caseId)
          )
        },
      },
      configuration({
        repetitions: 100,
        splits: ["development"],
        caseIds: ["docs.attribution.requirements"],
      }),
      fixedClock()
    )

    expect(report.summary.caseExecutions).toBe(100)
    expect(report.summary.metrics.normalized_stability).toMatchObject({
      minimum: 1,
      maximum: 1,
      mean: 1,
      standardDeviation: 0,
    })
    expect(new Set(report.results.map(({ seed }) => seed)).size).toBe(100)
  })

  it("reports instability as a distribution instead of selecting a best run", async () => {
    const report = await runEvaluation(
      dataset,
      {
        execute(request) {
          const observation = createGoldenObservation(
            findEvaluationCase(dataset, request.caseId)
          )
          if (request.repetition === 2) {
            observation.normalizedEvidence["variance:nonessential"] =
              "alternate"
          }
          return observation
        },
      },
      configuration({
        repetitions: 3,
        splits: ["held_out"],
      }),
      fixedClock()
    )

    expect(report.summary.metrics.normalized_stability).toMatchObject({
      count: 3,
      minimum: 2 / 3,
      maximum: 2 / 3,
      mean: 2 / 3,
    })
    expect(report.results).toHaveLength(3)
  })

  it("normalizes ordering for set-like evidence collections", async () => {
    const report = await runEvaluation(
      dataset,
      {
        execute(request) {
          const observation = createGoldenObservation(
            findEvaluationCase(dataset, request.caseId)
          )
          if (request.repetition === 2) {
            observation.facts.reverse()
            observation.acceptedLinks.reverse()
            observation.citations.reverse()
            observation.citations[0]?.evidenceIds.reverse()
            observation.impactedIds.reverse()
            observation.visibleUnknownIds.reverse()
          }
          return observation
        },
      },
      configuration({
        repetitions: 2,
        splits: ["held_out"],
      }),
      fixedClock()
    )

    expect(report.summary.metrics.normalized_stability.mean).toBe(1)
  })

  it("requires explicit cost confirmation before any live model execution", async () => {
    let calls = 0
    const target = {
      execute(request: EvaluationTargetRequest) {
        calls += 1
        return createGoldenObservation(
          findEvaluationCase(dataset, request.caseId)
        )
      },
    }
    const liveConfiguration = configuration({
      mode: "live_model",
      splits: ["held_out"],
      estimatedUsage: {
        toolCalls: 8,
        modelCalls: 5,
        inputTokens: 20000,
        outputTokens: 5000,
        sourceLines: 1000,
        documentSections: 20,
        browserActions: 0,
        elapsedMs: 120000,
        estimatedCostUsd: 1.25,
      },
    })

    await expect(
      runEvaluation(dataset, target, liveConfiguration, fixedClock())
    ).rejects.toThrow(PAID_EVALUATION_CONFIRMATION)
    expect(calls).toBe(0)

    const report = await runEvaluation(
      dataset,
      {
        execute(request) {
          const observation = target.execute(request)
          observation.usage.actualCostUsd = 0.83
          return observation
        },
      },
      {
        ...liveConfiguration,
        paidConfirmation: PAID_EVALUATION_CONFIRMATION,
      },
      fixedClock()
    )
    expect(report.estimatedUsage).toEqual({
      toolCalls: 8,
      modelCalls: 5,
      inputTokens: 20000,
      outputTokens: 5000,
      sourceLines: 1000,
      documentSections: 20,
      browserActions: 0,
      elapsedMs: 120000,
      estimatedCostUsd: 1.25,
    })
    expect(report.usage).toMatchObject({
      actualCostUsd: 0.83,
    })
  })

  it("rejects invalid report metadata before target execution", async () => {
    let calls = 0
    await expect(
      runEvaluation(
        dataset,
        {
          execute(request) {
            calls += 1
            return createGoldenObservation(
              findEvaluationCase(dataset, request.caseId)
            )
          },
        },
        configuration({ runId: "invalid run id" }),
        fixedClock()
      )
    ).rejects.toThrow()
    expect(calls).toBe(0)
  })
})

function configuration(
  overrides: Partial<Parameters<typeof runEvaluation>[2]> = {}
): Parameters<typeof runEvaluation>[2] {
  return {
    runId: "test-run",
    repetitions: 1,
    seed: 73,
    mode: "deterministic",
    model: "scripted-fixture",
    provider: "sentinel",
    modelConfig: { temperature: 0 },
    templateVersion: "eval-template-v1",
    splits: ["development"],
    ...overrides,
  }
}

function fixedClock(): { now: () => Date } {
  return { now: () => new Date("2026-09-09T10:00:00.000Z") }
}
