import { describe, expect, it } from "vitest"

import { VerificationArtifactRetentionService } from "./verification-artifact-retention.ts"

const applicationId = "123e4567-e89b-42d3-a456-426614174010"

describe("VerificationArtifactRetentionService", () => {
  it("retains private failure evidence and deletes successful diagnostics idempotently", async () => {
    const calls: string[] = []
    const service = new VerificationArtifactRetentionService(applicationId, {
      delete: async (_applicationId, id) => {
        calls.push(`delete:${id}`)
        return true
      },
      retainUntil: async (_applicationId, id, retainUntil) => {
        calls.push(`retain:${id}:${retainUntil.toISOString()}`)
        return true
      },
    })
    await service.apply({
      idempotencyKey: `sha256:${"1".repeat(64)}`,
      decisions: [
        {
          artifactId: `artifact:v1:${"2".repeat(64)}` as never,
          kind: "trace",
          disposition: "retain",
          reason: "failure_evidence",
          private: true,
          deleteAfter: "2026-09-10T10:00:00.000Z",
        },
        {
          artifactId: `artifact:v1:${"3".repeat(64)}` as never,
          kind: "console",
          disposition: "delete",
          reason: "successful_run",
          private: true,
        },
      ],
    })
    expect(calls).toEqual([
      `retain:artifact:v1:${"2".repeat(64)}:2026-09-10T10:00:00.000Z`,
      `delete:artifact:v1:${"3".repeat(64)}`,
    ])
  })

  it("fails when retained evidence is missing instead of claiming preservation", async () => {
    const service = new VerificationArtifactRetentionService(applicationId, {
      delete: async () => false,
      retainUntil: async () => false,
    })
    await expect(
      service.apply({
        idempotencyKey: `sha256:${"1".repeat(64)}`,
        decisions: [
          {
            artifactId: `artifact:v1:${"2".repeat(64)}` as never,
            kind: "screenshot",
            disposition: "retain",
            reason: "failure_evidence",
            private: true,
            deleteAfter: "2026-09-10T10:00:00.000Z",
          },
        ],
      })
    ).rejects.toThrow("not found")
  })
})
