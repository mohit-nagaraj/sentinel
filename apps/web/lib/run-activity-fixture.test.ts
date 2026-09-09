// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  ACTIVITY_FIXTURE_RUN_ID,
  advanceActivityFixture,
  getActivityFixtureRunControlService,
  getActivityFixtureScreenshot,
  getActivityFixtureSnapshot,
  resetActivityFixture,
  storeActivityFixtureScreenshot,
} from "./run-activity-fixture"

beforeEach(() => resetActivityFixture())

describe("activity browser fixture", () => {
  it("streams continuous specialist activity through pause and resume", async () => {
    const service = getActivityFixtureRunControlService()
    const initial = getActivityFixtureSnapshot()
    expect(initial.run.status).toBe("running")
    expect(initial.eventPage.items.map((item) => item.event.agent)).toEqual([
      "documentation",
      "code",
      "application",
    ])
    await expect(
      service.events({ runId: ACTIVITY_FIXTURE_RUN_ID, after: 0, limit: 1 })
    ).resolves.toMatchObject({ nextCursor: 1 })

    await service.pause(ACTIVITY_FIXTURE_RUN_ID)
    advanceActivityFixture()
    expect(getActivityFixtureSnapshot().run.status).toBe("interrupted")
    expect(
      await service.pendingInterrupt(ACTIVITY_FIXTURE_RUN_ID)
    ).toMatchObject({
      decisionId: "resume_run",
    })
    await service.respond(ACTIVITY_FIXTURE_RUN_ID, "resume_run", {
      schemaVersion: 1,
      response: { approved: true },
    })
    advanceActivityFixture()

    const completed = getActivityFixtureSnapshot()
    expect(completed.run.status).toBe("succeeded")
    expect(completed.eventPage.items.map((item) => item.sequence)).toEqual(
      Array.from(
        { length: completed.eventPage.items.length },
        (_value, index) => index + 1
      )
    )
    expect(
      completed.eventPage.items.some((item) => item.event.agent === "curator")
    ).toBe(true)
  })

  it("accepts only bounded PNG screenshot bytes and returns defensive copies", () => {
    expect(() => storeActivityFixtureScreenshot(new ArrayBuffer(12))).toThrow()
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]).buffer
    storeActivityFixtureScreenshot(png)
    const first = getActivityFixtureScreenshot()
    expect(first?.byteLength).toBe(9)
    new Uint8Array(first!)[8] = 99
    expect(new Uint8Array(getActivityFixtureScreenshot()!)[8]).toBe(1)
  })

  it("does not expose the fixture under another run identity", async () => {
    await expect(
      getActivityFixtureRunControlService().get(
        "11111111-1111-4111-8111-111111111111"
      )
    ).resolves.toBeNull()
  })
})
