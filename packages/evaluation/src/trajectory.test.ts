import { readFile } from "node:fs/promises"

import { beforeAll, describe, expect, it } from "vitest"

import {
  evaluationDatasetSchema,
  type EvaluationCase,
  type EvaluationDataset,
} from "./schema.ts"
import { createGoldenObservation, findEvaluationCase } from "./testing.ts"
import { evaluateTrajectory } from "./trajectory.ts"

let evaluationCase: EvaluationCase

beforeAll(async () => {
  const dataset: EvaluationDataset = evaluationDatasetSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../fixtures/hi-events-pr-1338.golden.json", import.meta.url),
        "utf8"
      )
    )
  )
  evaluationCase = findEvaluationCase(dataset, "graph.attribution.links")
})

describe("trajectory evaluation", () => {
  it("accepts varied ordering inside flexible phases", () => {
    const observation = createGoldenObservation(evaluationCase)
    const [load, validateRuntime, validateRoute, publish, abstain] =
      observation.trajectory
    observation.trajectory = [
      load!,
      validateRoute!,
      validateRuntime!,
      abstain!,
      publish!,
    ]

    const result = evaluateTrajectory(
      evaluationCase.expected.trajectory,
      observation.trajectory,
      observation.terminalStatus
    )

    expect(
      result.metrics.find(({ name }) => name === "trajectory_required_recall")
        ?.value
    ).toBe(1)
  })

  it("rejects a trajectory that crosses ordered phase boundaries", () => {
    const observation = createGoldenObservation(evaluationCase)
    observation.trajectory = [
      observation.trajectory[1]!,
      observation.trajectory[0]!,
      ...observation.trajectory.slice(2),
    ]

    const result = evaluateTrajectory(
      evaluationCase.expected.trajectory,
      observation.trajectory,
      observation.terminalStatus
    )

    expect(
      result.metrics.find(({ name }) => name === "trajectory_required_recall")
        ?.value
    ).toBe(0)
  })
})
