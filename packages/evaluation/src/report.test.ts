import { readFile } from "node:fs/promises"

import { beforeAll, describe, expect, it } from "vitest"

import {
  renderEvaluationJson,
  renderEvaluationMarkdown,
  renderEvaluationSummaryJson,
} from "./report.ts"
import { runEvaluation } from "./runner.ts"
import {
  evaluationDatasetSchema,
  type EvaluationDataset,
  type EvaluationRunReport,
} from "./schema.ts"
import { createGoldenObservation, findEvaluationCase } from "./testing.ts"

let report: EvaluationRunReport

beforeAll(async () => {
  const dataset: EvaluationDataset = evaluationDatasetSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../fixtures/hi-events-pr-1338.golden.json", import.meta.url),
        "utf8"
      )
    )
  )
  report = await runEvaluation(
    dataset,
    {
      execute(request) {
        return createGoldenObservation(
          findEvaluationCase(dataset, request.caseId)
        )
      },
    },
    {
      runId: "snapshot-run",
      repetitions: 2,
      seed: 17,
      mode: "deterministic",
      model: "scripted-fixture",
      provider: "sentinel",
      modelConfig: { temperature: 0 },
      templateVersion: "eval-template-v1",
      splits: ["held_out"],
    },
    { now: () => new Date("2026-09-09T10:00:00.000Z") }
  )
})

describe("evaluation report", () => {
  it("renders the canonical QA-facing Markdown snapshot", () => {
    expect(renderEvaluationMarkdown(report)).toMatchSnapshot()
  })

  it("renders stable machine-readable JSON", () => {
    const first = renderEvaluationJson(report)
    const second = renderEvaluationJson(report)

    expect(first).toBe(second)
    expect(JSON.parse(first)).toMatchObject({
      dataset: { id: "hi-events-pr-1338-attribution" },
      summary: { passRate: 1, hardFailures: 0 },
    })
    expect(JSON.parse(renderEvaluationSummaryJson(report))).not.toHaveProperty(
      "results"
    )
  })
})
