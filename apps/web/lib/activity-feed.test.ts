// @vitest-environment node

import { createEventId, runIdSchema, type RunEvent } from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

import {
  ActivityCatchUpController,
  ActivityFeedIntegrityError,
  createActivityFeedState,
  mergeActivityPage,
  type ActivityFeedState,
} from "./activity-feed"

const databaseRunId = "33333333-3333-4333-8333-333333333333"
const contractRunId = runIdSchema.parse(`run:${databaseRunId}`)

function event(sequence: number, summary = `Event ${sequence}`): RunEvent {
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
    summary: summary as RunEvent["summary"],
    reasonCode: "state_inspected",
    evidenceIds: [],
  }
}

function page(events: readonly RunEvent[], nextCursor?: number) {
  return {
    schemaVersion: 1,
    items: events.map((item) => ({ sequence: item.sequence, event: item })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  }
}

describe("durable activity feed", () => {
  it("sorts pages and ignores identical replayed events", () => {
    let state = createActivityFeedState(databaseRunId)
    state = mergeActivityPage(state, page([event(2), event(1)]))
    state = mergeActivityPage(state, page([event(1), event(2)]))
    expect(state.items.map((item) => item.sequence)).toEqual([1, 2])
    expect(state.cursor).toBe(2)
  })

  it("fails closed on gaps, conflicts, run mismatches, and invalid cursors", () => {
    const state = createActivityFeedState(databaseRunId)
    for (const candidate of [
      page([event(2)]),
      page([event(1, "Changed")], 2),
      page([
        {
          ...event(1),
          runId: runIdSchema.parse(`run:${crypto.randomUUID()}`),
        },
      ]),
      page([event(1)], 9),
    ]) {
      expect(() => mergeActivityPage(state, candidate)).toThrow(
        ActivityFeedIntegrityError
      )
    }
    const existing = mergeActivityPage(state, page([event(1)]))
    expect(() =>
      mergeActivityPage(existing, page([event(1, "Changed")]))
    ).toThrow(ActivityFeedIntegrityError)
  })

  it("serializes concurrent wakes and drains every cursor page", async () => {
    let state: ActivityFeedState = createActivityFeedState(databaseRunId)
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const fetchPage = vi.fn(async (after: number) => {
      if (after === 0) {
        await firstGate
        return page([event(1)], 1)
      }
      if (after === 1) return page([event(2)])
      return page([])
    })
    const controller = new ActivityCatchUpController({
      read: () => state,
      write: (next) => {
        state = next
      },
      fetchPage,
    })

    const first = controller.wake()
    const second = controller.wake()
    expect(first).toBe(second)
    releaseFirst?.()
    await first
    expect(state.items.map((item) => item.sequence)).toEqual([1, 2])
    expect(state.caughtUp).toBe(true)
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })
})
