import {
  contentHashSchema,
  verificationArtifactDecisionSchema,
  type VerificationArtifactDecision,
} from "@sentinel/contracts"

export interface VerificationArtifactServicePort {
  delete(applicationId: string, id: string): Promise<boolean>
  retainUntil(
    applicationId: string,
    id: string,
    retainUntil: Date
  ): Promise<boolean>
}

export class VerificationArtifactRetentionService {
  constructor(
    private readonly applicationDatabaseId: string,
    private readonly artifacts: VerificationArtifactServicePort
  ) {}

  async apply(input: {
    readonly decisions: readonly VerificationArtifactDecision[]
    readonly idempotencyKey: string
  }): Promise<void> {
    contentHashSchema.parse(input.idempotencyKey)
    const decisions = input.decisions.map((decision) =>
      verificationArtifactDecisionSchema.parse(decision)
    )
    if (
      new Set(decisions.map(({ artifactId }) => artifactId)).size !==
      decisions.length
    ) {
      throw new Error("Verification artifact decisions must be unique")
    }
    for (const decision of decisions) {
      if (decision.disposition === "delete") {
        await this.artifacts.delete(
          this.applicationDatabaseId,
          decision.artifactId
        )
      } else {
        const retained = await this.artifacts.retainUntil(
          this.applicationDatabaseId,
          decision.artifactId,
          new Date(decision.deleteAfter!)
        )
        if (!retained) {
          throw new Error("Retained verification artifact was not found")
        }
      }
    }
  }
}
