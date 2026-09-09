import { describe, expect, it } from "vitest"

import {
  deterministicVerificationAssertionSchema,
  verificationArtifactDecisionSchema,
  verificationCheckpointObservationSchema,
} from "./targeted-verification.ts"
import { verificationCheckpointSchema } from "./deployment-verification.ts"

const checkpointId = `sha256:${"a".repeat(64)}`
const workflowId = `workflow:v1:${"b".repeat(64)}`
const evidenceId = `evidence:v1:${"c".repeat(64)}`
const timestamp = "2026-09-09T10:00:00.000Z"

describe("targeted verification contracts", () => {
  it("requires method, normalized path, and statuses only for request checkpoints", () => {
    const request = verificationCheckpointSchema.safeParse({
      id: checkpointId,
      kind: "request_status",
      sourceEntityId: workflowId,
      operator: "status_in",
      description: "Order creation returns success",
    })
    const transition = verificationCheckpointSchema.safeParse({
      id: checkpointId,
      kind: "transition",
      sourceEntityId: workflowId,
      operator: "changed",
      request: {
        method: "POST",
        normalizedPath: "/api/orders",
        statuses: [201],
      },
      description: "Checkout advances",
    })
    expect(request.success).toBe(false)
    expect(transition.success).toBe(false)
  })

  it("requires observed evidence for deterministic pass/fail assertions", () => {
    const assertion = deterministicVerificationAssertionSchema.safeParse({
      schemaVersion: 1,
      checkpoint: {
        id: checkpointId,
        kind: "transition",
        sourceEntityId: workflowId,
        operator: "changed",
        description: "Checkout advances",
      },
      outcome: "passed",
      reasonCode: "transition_checkpoint_passed",
      summary: "The state changed",
      evidenceIds: [],
      evaluatedAt: timestamp,
    })
    expect(assertion.success).toBe(false)
  })

  it("keeps retained artifacts private and expiry-bound", () => {
    expect(
      verificationArtifactDecisionSchema.safeParse({
        artifactId: `artifact:v1:${"d".repeat(64)}`,
        kind: "trace",
        disposition: "retain",
        reason: "failure_evidence",
        private: true,
      }).success
    ).toBe(false)
  })

  it("bounds and validates checkpoint observation evidence", () => {
    const observation = verificationCheckpointObservationSchema.parse({
      schemaVersion: 1,
      checkpointId,
      kind: "error_absence",
      errors: [],
      evidenceIds: [evidenceId],
      observedAt: timestamp,
    })
    expect(observation.kind).toBe("error_absence")
  })
})
