import { mkdir, readFile, writeFile } from "node:fs/promises"

import {
  renderEvaluationMarkdown,
  renderEvaluationSummaryJson,
} from "../src/report.ts"
import { runEvaluation } from "../src/runner.ts"
import { evaluationDatasetSchema } from "../src/schema.ts"
import { createGoldenObservation, findEvaluationCase } from "../src/testing.ts"

const dataset = evaluationDatasetSchema.parse(
  JSON.parse(
    await readFile(
      new URL("../fixtures/hi-events-pr-1338.golden.json", import.meta.url),
      "utf8"
    )
  )
)

const report = await runEvaluation(
  dataset,
  {
    execute(request) {
      return createGoldenObservation(
        findEvaluationCase(dataset, request.caseId)
      )
    },
  },
  {
    runId: "snt-033-deterministic-baseline",
    repetitions: 100,
    seed: 1338,
    mode: "deterministic",
    model: "scripted-golden-fixture",
    provider: "sentinel",
    modelConfig: { temperature: 0 },
    templateVersion: "eval-template-v1",
    splits: ["development", "held_out"],
  },
  { now: () => new Date("2026-09-09T12:00:00.000Z") }
)

const outputDirectory = new URL("../../../docs/evaluation/", import.meta.url)
await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  writeFile(
    new URL("snt-033-baseline.json", outputDirectory),
    renderEvaluationSummaryJson(report),
    "utf8"
  ),
  writeFile(
    new URL("snt-033-baseline.md", outputDirectory),
    renderEvaluationMarkdown(report),
    "utf8"
  ),
])
