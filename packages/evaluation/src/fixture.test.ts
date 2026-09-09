import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { evaluationDatasetSchema, type EvaluationDataset } from "./schema.ts"

async function loadFixtureValue(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/hi-events-pr-1338.golden.json", import.meta.url),
      "utf8"
    )
  )
}

describe("evaluation dataset", () => {
  it("validates the sanitized real-PR fixture and all execution scopes", async () => {
    const dataset = evaluationDatasetSchema.parse(await loadFixtureValue())

    expect(dataset.target).toMatchObject({
      pullRequest: 1338,
      baseSha: "2064f88ff7590e93c738efb8becaa7d732063619",
      headSha: "f68df0dabd18d04df5e6c7e873aac2b5e5201584",
      sanitized: true,
    })
    expect(dataset.splits.map(({ kind }) => kind).sort()).toEqual([
      "development",
      "held_out",
    ])
    expect(
      dataset.splits
        .flatMap(({ cases }) => cases)
        .map(({ execution }) => execution.scope)
        .sort()
    ).toEqual(["checkpoint", "node", "partial", "whole_graph"])
  })

  it("rejects split leakage, duplicate identities, and unknown fields", async () => {
    const dataset = evaluationDatasetSchema.parse(await loadFixtureValue())
    const leaked = structuredClone(dataset)
    leaked.splits[1]!.cases[0]!.inputFingerprint =
      leaked.splits[0]!.cases[0]!.inputFingerprint
    expect(() => evaluationDatasetSchema.parse(leaked)).toThrow(
      /duplicates development case/
    )

    const duplicate = structuredClone(dataset)
    duplicate.splits[1]!.cases[0]!.id = duplicate.splits[0]!.cases[0]!.id
    expect(() => evaluationDatasetSchema.parse(duplicate)).toThrow(
      /identities must be unique/
    )

    const unknown = {
      ...dataset,
      hiddenAnswer: "must not be silently accepted",
    } as EvaluationDataset & { hiddenAnswer: string }
    expect(() => evaluationDatasetSchema.parse(unknown)).toThrow(
      /Unrecognized key/
    )
  })
})
