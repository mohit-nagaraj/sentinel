// @vitest-environment node

import {
  artifactIdSchema,
  createEventId,
  runIdSchema,
  type RunEvent,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { projectActivityEvent, projectActivityFeed } from "./activity-projector"

const contractRunId = runIdSchema.parse(
  "run:33333333-3333-4333-8333-333333333333"
)

function event(sequence: number, overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    schemaVersion: 1,
    id: createEventId(contractRunId, sequence),
    runId: contractRunId,
    sequence,
    occurredAt: `2026-09-09T00:00:0${sequence}.000Z`,
    graphName: "synthetic_parallel_run",
    kind: "node_completed",
    nodeName: "inspect_state",
    status: "completed",
    summary: "State inspected" as RunEvent["summary"],
    reasonCode: "state_inspected",
    evidenceIds: [],
    ...overrides,
  } as RunEvent
}

describe("activity projector", () => {
  it("distinguishes safe activity types and specialist lanes", () => {
    const screenshotArtifactId = artifactIdSchema.parse(
      `artifact:v1:${"a".repeat(64)}`
    )
    const projected = projectActivityFeed([
      event(3, {
        agent: "application",
        activity: {
          category: "action",
          detail: "Checkout form advanced to review" as never,
          action: {
            kind: "advance_checkout",
            label: "Advance checkout" as never,
            status: "completed",
          },
          screenshotArtifactId,
        },
      }),
      event(1, { agent: "documentation" }),
      event(2, { agent: "code" }),
      event(4, { agent: "curator" }),
    ])

    expect(projected.lanes.documentation[0]?.sequence).toBe(1)
    expect(projected.lanes.code[0]?.sequence).toBe(2)
    expect(projected.lanes.application[0]).toMatchObject({
      categoryLabel: "Browser action",
      screenshotArtifactId,
    })
    expect(projected.lanes.curator[0]?.sequence).toBe(4)
    expect(projected.storyboard).toHaveLength(1)
  })

  it("maps system status and the latest value of each budget to Curator", () => {
    const projected = projectActivityFeed([
      event(1, {
        kind: "budget_updated",
        status: "completed",
        budget: { consumed: 1, limit: 10, unit: "browser_actions" },
      }),
      event(2, {
        kind: "budget_updated",
        status: "completed",
        budget: { consumed: 4, limit: 10, unit: "browser_actions" },
      }),
    ])
    expect(projected.lanes.curator).toHaveLength(2)
    expect(projected.budgets).toEqual([
      { consumed: 4, limit: 10, unit: "browser_actions" },
    ])
  })

  it("rejects raw hidden-reasoning, selector, DOM, and credential fields", () => {
    const valid = event(1)
    for (const unsafe of [
      { ...valid, prompt: "hidden instructions" },
      { ...valid, selector: "#payment-form" },
      { ...valid, dom: "<main>private</main>" },
      { ...valid, summary: "Authorization: Bearer private-token-value" },
    ]) {
      expect(() => projectActivityEvent(unsafe)).toThrow()
    }
  })
})
