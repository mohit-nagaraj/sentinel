import {
  githubCheckLifecycleSchema,
  hashCanonical,
  targetedVerificationEnrichmentSchema,
  targetedVerificationResultSchema,
  type GithubCheckLifecycle,
  type TargetedVerificationEnrichment,
  type TargetedVerificationResult,
} from "@sentinel/contracts"

import type { TargetedVerificationPublisherPort } from "./targeted-verification.ts"

export interface VerificationEnrichmentRepositoryPort {
  /** Must compare-and-set current assessment/head and deduplicate idempotencyKey. */
  appendCurrent(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly result: TargetedVerificationResult
    readonly enrichment: Omit<TargetedVerificationEnrichment, "version">
    readonly idempotencyKey: string
  }): Promise<{
    readonly disposition: "published" | "existing" | "superseded"
    readonly version?: number
  }>
}

export interface VerificationGithubCheckPort {
  publishCheck(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly lifecycle: GithubCheckLifecycle
  }): Promise<boolean>
}

function checkLifecycle(
  result: TargetedVerificationResult,
  completedAt: string
): GithubCheckLifecycle {
  const outcome =
    result.status === "failed"
      ? "verification_failed"
      : result.status === "blocked"
        ? "action_required"
        : result.status === "verification_unavailable" ||
            result.status === "not_run"
          ? "verification_unavailable"
          : result.status === "behavior_changed"
            ? "predicted_risk"
            : "analysis_succeeded"
  const title =
    result.status === "passed"
      ? "Sentinel targeted verification passed"
      : result.status === "failed"
        ? "Sentinel targeted verification failed"
        : result.status === "behavior_changed"
          ? "Sentinel observed changed behavior"
          : result.status === "blocked"
            ? "Sentinel verification needs action"
            : "Sentinel verification unavailable"
  return githubCheckLifecycleSchema.parse({
    state: "completed",
    outcome,
    title,
    summary: result.deterministicSummary,
    completedAt,
  })
}

export function buildTargetedVerificationEnrichment(input: {
  readonly result: TargetedVerificationResult
  readonly appendedAt?: Date
}): Omit<TargetedVerificationEnrichment, "version"> {
  const result = targetedVerificationResultSchema.parse(input.result)
  const draft = {
    schemaVersion: 1 as const,
    assessmentId: result.assessmentId,
    pullRequestId: result.pullRequestId,
    headSha: result.headSha,
    resultId: result.id,
    status: result.status,
    predictedFindingIds: result.predictedFindingIds,
    missionResultIds: [
      ...result.missionResults.map(({ id }) => id),
      ...(result.controlResult === undefined ? [] : [result.controlResult.id]),
    ],
    evidenceIds: [
      ...new Set(
        [
          ...result.missionResults,
          ...(result.controlResult === undefined ? [] : [result.controlResult]),
        ].flatMap(({ evidenceIds }) => evidenceIds)
      ),
    ].sort(),
    artifactIds: result.artifacts.map(({ artifactId }) => artifactId).sort(),
    summary: result.deterministicSummary,
    appendedAt: (
      input.appendedAt ?? new Date(result.completedAt)
    ).toISOString(),
  }
  const { appendedAt: _appendedAt, ...identity } = draft
  void _appendedAt
  const id = hashCanonical({
    kind: "targeted-verification-enrichment",
    ...identity,
    version: 1,
  })
  return targetedVerificationEnrichmentSchema.omit({ version: true }).parse({
    ...draft,
    id,
  })
}

export class TargetedVerificationPublicationService implements TargetedVerificationPublisherPort {
  constructor(
    private readonly repository: VerificationEnrichmentRepositoryPort,
    private readonly checks: VerificationGithubCheckPort
  ) {}

  async publishCurrent(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly result: TargetedVerificationResult
    readonly idempotencyKey: string
  }): Promise<"published" | "existing" | "superseded"> {
    const result = targetedVerificationResultSchema.parse(input.result)
    if (
      result.assessmentId !== input.assessmentId ||
      result.headSha !== input.headSha
    ) {
      throw new Error("Verification publication identity conflicts")
    }
    const enrichment = buildTargetedVerificationEnrichment({ result })
    const appended = await this.repository.appendCurrent({
      assessmentId: input.assessmentId,
      headSha: input.headSha,
      result,
      enrichment,
      idempotencyKey: input.idempotencyKey,
    })
    if (appended.disposition === "superseded") return "superseded"
    if (appended.version === undefined || appended.version < 1) {
      throw new Error("Verification enrichment append omitted its version")
    }
    const published = await this.checks.publishCheck({
      assessmentId: input.assessmentId,
      headSha: input.headSha,
      lifecycle: checkLifecycle(result, enrichment.appendedAt),
    })
    if (!published) {
      throw new Error("Verification GitHub check update was not published")
    }
    return appended.disposition
  }
}
