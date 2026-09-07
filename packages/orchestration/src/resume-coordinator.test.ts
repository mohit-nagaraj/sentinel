import { describe, expect, it } from "vitest"

import {
  InMemoryResumeCoordinator,
  PostgresResumeCoordinator,
} from "./resume-coordinator.ts"

const input = {
  runId: "run:11111111-1111-4111-8111-111111111111",
  decisionId: "synthetic_review",
}

describe("resume coordinators", () => {
  it("serializes concurrent work for one run decision", async () => {
    const coordinator = new InMemoryResumeCoordinator()
    let active = 0
    let maximumActive = 0
    const work = () =>
      coordinator.runExclusive(input, async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
      })
    await Promise.all([work(), work(), work()])
    expect(maximumActive).toBe(1)
  })

  it("rejects unsafe Postgres configuration without echoing it", () => {
    const value = "https://user:secret@example.com"
    let captured: unknown
    try {
      new PostgresResumeCoordinator(value)
    } catch (error) {
      captured = error
    }
    expect(String(captured)).not.toContain(value)
    expect(String(captured)).not.toContain("secret")
  })
})
