import {
  githubCheckLifecycleSchema,
  hashCanonical,
  reportVerificationSchema,
  targetedVerificationEnrichmentSchema,
  targetedVerificationResultSchema,
  verificationPlanSchema,
  verificationResultSchema,
  type GithubCheckLifecycle,
  type ReportVerification,
  type TargetedVerificationEnrichment,
  type TargetedVerificationResult,
  type VerificationMissionPlan,
  type VerificationMissionResult,
  type VerificationPlan,
  type VerificationResult,
} from "@sentinel/contracts"

import type { TargetedVerificationPublisherPort } from "./targeted-verification.ts"
import { effectiveVerificationMissionResults } from "./verification-evaluator.ts"

export interface VerificationEnrichmentRepositoryPort {
  /** Must compare-and-set current assessment/head and deduplicate idempotencyKey. */
  appendCurrent(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly resultId: string
    readonly verification: Omit<ReportVerification, "version">
    readonly appendedAt: string
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
  }): Promise<"published" | "sync_pending" | "superseded">
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

function missionPlanMap(
  plan: VerificationPlan,
  result: TargetedVerificationResult
): ReadonlyMap<string, VerificationMissionPlan> {
  return new Map(
    [
      ...plan.missions,
      ...(plan.control === undefined ? [] : [plan.control]),
      ...(result.followup === undefined ? [] : [result.followup.mission]),
    ].map((mission) => [mission.mission.id, mission])
  )
}

function projectMissionResult(input: {
  readonly mission: VerificationMissionResult
  readonly plan: VerificationMissionPlan
  readonly result: TargetedVerificationResult
  readonly controlUnstable: boolean
}): VerificationResult {
  const workflowId = input.plan.targetIds.find((id) =>
    String(id).startsWith("workflow:v1:")
  )
  if (workflowId === undefined) {
    throw new Error("Verification report mission is not linked to a workflow")
  }
  const requirementIds = [
    ...new Set(
      [
        ...input.plan.targetIds,
        ...input.plan.checkpoints.map(({ sourceEntityId }) => sourceEntityId),
      ].filter((id) => String(id).startsWith("requirement:v1:"))
    ),
  ].sort()
  const status =
    input.mission.status === "not_run" ||
    (input.controlUnstable && input.mission.status === "failed") ||
    (input.mission.kind === "control" &&
      ["failed", "blocked"].includes(input.mission.status))
      ? "blocked"
      : input.mission.status
  const deploymentUrl = input.result.headValidation.proof?.publicUrl
  if (deploymentUrl === undefined) {
    throw new Error("Executed verification report omitted its deployment URL")
  }
  return verificationResultSchema.parse({
    schemaVersion: 1,
    runId: input.result.runId,
    pullRequestId: input.result.pullRequestId,
    headSha: input.result.headSha,
    workflowId,
    requirementIds,
    completedAt: input.mission.completedAt,
    status,
    deploymentUrl,
    assertions: input.mission.assertions
      .filter(({ evidenceIds }) => evidenceIds.length > 0)
      .map((assertion) => ({
        name: assertion.checkpoint.description,
        passed: assertion.outcome === "passed",
        evidenceIds: assertion.evidenceIds,
      })),
    requests: input.mission.requests,
  })
}

export function buildReportVerification(input: {
  readonly plan: VerificationPlan
  readonly result: TargetedVerificationResult
}): ReportVerification {
  const plan = verificationPlanSchema.parse(input.plan)
  const result = targetedVerificationResultSchema.parse(input.result)
  if (
    plan.assessmentId !== result.assessmentId ||
    plan.applicationId !== result.applicationId ||
    plan.runId !== result.runId ||
    plan.deployment.pullRequestId !== result.pullRequestId ||
    plan.deployment.expectedCommitSha !== result.headSha
  ) {
    throw new Error("Verification report projection conflicts with its plan")
  }
  if (
    result.status === "not_run" ||
    result.status === "verification_unavailable"
  ) {
    return reportVerificationSchema.parse({
      status: result.status,
      results: [],
      reason: result.deterministicSummary,
      version: 0,
    })
  }
  const plans = missionPlanMap(plan, result)
  const controlUnstable =
    result.controlResult !== undefined &&
    ["failed", "blocked"].includes(result.controlResult.status)
  const missions = [
    ...effectiveVerificationMissionResults(result.missionResults),
    ...(controlUnstable ? [result.controlResult!] : []),
  ]
  const results = missions.map((mission) => {
    const missionPlan = plans.get(mission.missionId)
    if (missionPlan === undefined) {
      throw new Error("Verification report result omitted its mission plan")
    }
    return projectMissionResult({
      mission,
      plan: missionPlan,
      result,
      controlUnstable,
    })
  })
  return reportVerificationSchema.parse({
    status: result.status,
    results,
    reason: result.deterministicSummary,
    version: 0,
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
    readonly plan: VerificationPlan
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
    const reportVerification = buildReportVerification({
      plan: input.plan,
      result,
    })
    const { version: _version, ...verification } = reportVerification
    void _version
    const appended = await this.repository.appendCurrent({
      assessmentId: input.assessmentId,
      headSha: input.headSha,
      resultId: result.id,
      verification,
      appendedAt: enrichment.appendedAt,
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
    if (published === "sync_pending") {
      throw new Error("Verification GitHub check synchronization is pending")
    }
    return published === "published" ? appended.disposition : "superseded"
  }
}
