import {
  deterministicVerificationAssertionSchema,
  hashCanonical,
  targetedVerificationResultSchema,
  verificationArtifactDecisionSchema,
  verificationCheckpointObservationSchema,
  verificationCheckpointSchema,
  verificationComparisonSchema,
  verificationMissionEvidenceSchema,
  verificationMissionPlanSchema,
  verificationMissionResultSchema,
  verificationSetupReceiptSchema,
  type DeterministicVerificationAssertion,
  type DeploymentValidationResult,
  type MissionBudget,
  type TargetedVerificationResult,
  type VerificationArtifactCandidate,
  type VerificationArtifactDecision,
  type VerificationArtifactPolicy,
  type VerificationCheckpoint,
  type VerificationCheckpointObservation,
  type VerificationComparison,
  type VerificationGapFollowup,
  type VerificationMissionEvidence,
  type VerificationMissionPlan,
  type VerificationMissionResult,
  type VerificationPlan,
  type VerificationSetupReceipt,
} from "@sentinel/contracts"

function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function reportRequests(evidence: VerificationMissionEvidence) {
  const requests = evidence.checkpointObservations.flatMap((observation) =>
    observation.kind === "request_status"
      ? observation.requests.flatMap((request) =>
          request.outcome === "response" && request.status !== undefined
            ? [
                {
                  method: request.method,
                  normalizedPath: request.normalizedPath,
                  status: request.status,
                },
              ]
            : []
        )
      : []
  )
  return [
    ...new Map(
      requests.map((request) => [
        `${request.method}:${request.normalizedPath}:${request.status}`,
        request,
      ])
    ).values(),
  ].sort((left, right) =>
    compareStrings(
      `${left.method}:${left.normalizedPath}:${left.status}`,
      `${right.method}:${right.normalizedPath}:${right.status}`
    )
  )
}

function addSeconds(value: Date, seconds: number): string {
  return new Date(value.getTime() + seconds * 1_000).toISOString()
}

function observationValue(
  observation: VerificationCheckpointObservation
): boolean | string | number | null | undefined {
  switch (observation.kind) {
    case "reachability":
      return observation.reachable
    case "visible":
      return observation.visible
    case "enabled":
      return observation.enabled
    case "transition":
      return observation.changed
    case "value":
      return observation.value
    case "error_absence":
      return observation.errors.length === 0
    case "request_status":
      return undefined
  }
}

function expectedBoolean(checkpoint: VerificationCheckpoint): boolean | null {
  if (checkpoint.operator === "present") return true
  if (checkpoint.operator === "absent") return false
  if (
    checkpoint.operator === "equals" &&
    typeof checkpoint.expected === "boolean"
  ) {
    return checkpoint.expected
  }
  if (checkpoint.operator === "changed") return true
  if (checkpoint.operator === "unchanged") return false
  return null
}

function actualSummary(value: unknown): string {
  if (value === undefined) return "No value was observed"
  if (value === null) return "A null value was observed"
  if (typeof value === "string") return `Observed value ${value.slice(0, 160)}`
  return `Observed value ${String(value)}`
}

function evaluateObserved(
  checkpoint: VerificationCheckpoint,
  observation: VerificationCheckpointObservation
): {
  readonly passed: boolean
  readonly reasonCode: string
  readonly summary: string
} | null {
  if (checkpoint.kind !== observation.kind) return null
  if (checkpoint.kind === "request_status") {
    if (
      observation.kind !== "request_status" ||
      checkpoint.request === undefined ||
      checkpoint.operator !== "status_in"
    ) {
      return null
    }
    const matched = observation.requests.find(
      (request) =>
        request.method === checkpoint.request!.method &&
        request.normalizedPath === checkpoint.request!.normalizedPath &&
        request.status !== undefined &&
        checkpoint.request!.statuses.includes(request.status)
    )
    return matched === undefined
      ? {
          passed: false,
          reasonCode: "request_status_not_observed",
          summary: `Expected ${checkpoint.request.method} ${checkpoint.request.normalizedPath} with an allowed status`,
        }
      : {
          passed: true,
          reasonCode: "request_status_observed",
          summary: `Observed ${matched.method} ${matched.normalizedPath} with status ${matched.status}`,
        }
  }

  if (checkpoint.kind === "error_absence") {
    if (observation.kind !== "error_absence") return null
    const passed =
      checkpoint.operator === "absent"
        ? observation.errors.length === 0
        : checkpoint.operator === "present"
          ? observation.errors.length > 0
          : null
    if (passed === null) return null
    return {
      passed,
      reasonCode: passed
        ? "error_absence_checkpoint_passed"
        : "error_absence_checkpoint_failed",
      summary:
        observation.errors.length === 0
          ? "No runtime errors were observed"
          : `${observation.errors.length} runtime errors were observed`,
    }
  }

  const actual = observationValue(observation)
  if (checkpoint.kind === "value") {
    const passed =
      checkpoint.operator === "present"
        ? actual !== undefined && actual !== null
        : checkpoint.operator === "absent"
          ? actual === undefined || actual === null
          : checkpoint.operator === "equals"
            ? actual === checkpoint.expected
            : checkpoint.operator === "matches" &&
                typeof actual === "string" &&
                typeof checkpoint.expected === "string"
              ? actual
                  .toLocaleLowerCase("en-US")
                  .includes(checkpoint.expected.toLocaleLowerCase("en-US"))
              : null
    if (passed === null) return null
    return {
      passed,
      reasonCode: passed
        ? "value_checkpoint_passed"
        : "value_checkpoint_failed",
      summary: actualSummary(actual),
    }
  }

  const expected = expectedBoolean(checkpoint)
  if (expected === null || typeof actual !== "boolean") return null
  const passed = actual === expected
  return {
    passed,
    reasonCode: passed
      ? `${checkpoint.kind}_checkpoint_passed`
      : `${checkpoint.kind}_checkpoint_failed`,
    summary: actualSummary(actual),
  }
}

export function evaluateVerificationCheckpoint(input: {
  readonly checkpoint: VerificationCheckpoint
  readonly observation?: VerificationCheckpointObservation
  readonly now?: Date
}): DeterministicVerificationAssertion {
  const checkpoint = verificationCheckpointSchema.parse(input.checkpoint)
  const now = input.now ?? new Date()
  if (input.observation === undefined) {
    return deterministicVerificationAssertionSchema.parse({
      schemaVersion: 1,
      checkpoint,
      outcome: "blocked",
      reasonCode: "checkpoint_observation_missing",
      summary: "No deterministic observation was supplied for this checkpoint",
      evidenceIds: [],
      evaluatedAt: now.toISOString(),
    })
  }
  const observation = verificationCheckpointObservationSchema.parse(
    input.observation
  )
  if (observation.checkpointId !== checkpoint.id) {
    return deterministicVerificationAssertionSchema.parse({
      schemaVersion: 1,
      checkpoint,
      outcome: "blocked",
      reasonCode: "checkpoint_identity_mismatch",
      summary: "The supplied observation belongs to another checkpoint",
      evidenceIds: [],
      evaluatedAt: now.toISOString(),
    })
  }
  const evaluated = evaluateObserved(checkpoint, observation)
  if (evaluated === null) {
    return deterministicVerificationAssertionSchema.parse({
      schemaVersion: 1,
      checkpoint,
      outcome: "blocked",
      reasonCode: "checkpoint_operator_invalid",
      summary: "The checkpoint operator is incompatible with its observation",
      evidenceIds: observation.evidenceIds,
      evaluatedAt: now.toISOString(),
    })
  }
  return deterministicVerificationAssertionSchema.parse({
    schemaVersion: 1,
    checkpoint,
    outcome: evaluated.passed ? "passed" : "failed",
    reasonCode: evaluated.reasonCode,
    summary: evaluated.summary,
    evidenceIds: observation.evidenceIds,
    evaluatedAt: now.toISOString(),
  })
}

function semanticObservation(observation: VerificationCheckpointObservation) {
  const {
    evidenceIds: _evidenceIds,
    observedAt: _observedAt,
    ...semantic
  } = observation
  void _evidenceIds
  void _observedAt
  return semantic
}

function compareEvidence(input: {
  readonly plan: VerificationMissionPlan
  readonly head: VerificationMissionEvidence
  readonly baseline?: VerificationMissionEvidence
}): VerificationComparison {
  if (input.baseline === undefined) {
    return verificationComparisonSchema.parse({
      status: "not_available",
      changedCheckpointIds: [],
      headFingerprint: input.head.semanticFingerprint,
    })
  }
  const baselineByCheckpoint = new Map(
    input.baseline.checkpointObservations.map((observation) => [
      observation.checkpointId,
      observation,
    ])
  )
  const headByCheckpoint = new Map(
    input.head.checkpointObservations.map((observation) => [
      observation.checkpointId,
      observation,
    ])
  )
  const changedCheckpointIds = input.plan.checkpoints
    .filter((checkpoint) => {
      const baseline = baselineByCheckpoint.get(checkpoint.id)
      const head = headByCheckpoint.get(checkpoint.id)
      return (
        baseline === undefined ||
        head === undefined ||
        hashCanonical(semanticObservation(baseline)) !==
          hashCanonical(semanticObservation(head))
      )
    })
    .map(({ id }) => id)
    .sort(compareStrings)
  const behaviorChanged =
    changedCheckpointIds.length > 0 ||
    input.baseline.semanticFingerprint !== input.head.semanticFingerprint
  return verificationComparisonSchema.parse({
    status: behaviorChanged ? "changed" : "preserved",
    changedCheckpointIds,
    baselineFingerprint: input.baseline.semanticFingerprint,
    headFingerprint: input.head.semanticFingerprint,
  })
}

export function decideVerificationArtifactRetention(input: {
  readonly artifacts: readonly VerificationArtifactCandidate[]
  readonly status: VerificationMissionResult["status"]
  readonly policy: VerificationArtifactPolicy
  readonly now?: Date
}): VerificationArtifactDecision[] {
  const now = input.now ?? new Date()
  const failure = input.status === "failed" || input.status === "blocked"
  return input.artifacts
    .map((artifact) => {
      const retain =
        failure ||
        artifact.purpose === "report" ||
        input.policy.successfulRetentionSeconds > 0
      const retentionSeconds = failure
        ? input.policy.failureRetentionSeconds
        : artifact.purpose === "report"
          ? input.policy.reportRetentionSeconds
          : input.policy.successfulRetentionSeconds
      return verificationArtifactDecisionSchema.parse({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        disposition: retain ? "retain" : "delete",
        reason: failure
          ? "failure_evidence"
          : retain
            ? "report_evidence"
            : "successful_run",
        private: true,
        ...(retain ? { deleteAfter: addSeconds(now, retentionSeconds) } : {}),
      })
    })
    .sort((left, right) => compareStrings(left.artifactId, right.artifactId))
}

function terminalCategory(
  plan: VerificationMissionPlan,
  evidence: VerificationMissionEvidence
): VerificationMissionResult["failureCategory"] | null {
  if (evidence.explorer.result.status === "complete") return null
  const policyBlocked = evidence.explorer.blockers.some(
    ({ kind }) => kind === "unsafe_action"
  )
  if (plan.kind === "control") return "environment_instability"
  return policyBlocked ? "policy_block" : "agent_block"
}

export function evaluateVerificationMission(input: {
  readonly plan: VerificationMissionPlan
  readonly setup: VerificationSetupReceipt
  readonly head: VerificationMissionEvidence
  readonly baseline?: VerificationMissionEvidence
  readonly artifactPolicy: VerificationArtifactPolicy
  readonly kind?: VerificationMissionResult["kind"]
  readonly now?: Date
}): VerificationMissionResult {
  const plan = verificationMissionPlanSchema.parse(input.plan)
  const setup = verificationSetupReceiptSchema.parse(input.setup)
  const head = verificationMissionEvidenceSchema.parse(input.head)
  const baseline =
    input.baseline === undefined
      ? undefined
      : verificationMissionEvidenceSchema.parse(input.baseline)
  const now = input.now ?? new Date()
  if (
    setup.missionId !== plan.mission.id ||
    head.missionId !== plan.mission.id ||
    (baseline !== undefined && baseline.missionId !== plan.mission.id)
  ) {
    throw new Error(
      "Verification setup and evidence must belong to the plan mission"
    )
  }
  if (
    head.phase !== "head" ||
    (baseline !== undefined && baseline.phase !== "baseline")
  ) {
    throw new Error("Verification evidence phases conflict")
  }

  const headByCheckpoint = new Map(
    head.checkpointObservations.map((observation) => [
      observation.checkpointId,
      observation,
    ])
  )
  const assertions = plan.checkpoints.map((checkpoint) =>
    evaluateVerificationCheckpoint({
      checkpoint,
      ...(headByCheckpoint.get(checkpoint.id) === undefined
        ? {}
        : { observation: headByCheckpoint.get(checkpoint.id)! }),
      now,
    })
  )
  const comparison = compareEvidence({
    plan,
    head,
    ...(baseline === undefined ? {} : { baseline }),
  })
  const terminalFailure = terminalCategory(plan, head)
  const baselineAssertions =
    baseline === undefined
      ? new Map<string, DeterministicVerificationAssertion>()
      : new Map(
          plan.checkpoints.map((checkpoint) => {
            const observations = new Map(
              baseline.checkpointObservations.map((observation) => [
                observation.checkpointId,
                observation,
              ])
            )
            return [
              checkpoint.id,
              evaluateVerificationCheckpoint({
                checkpoint,
                ...(observations.get(checkpoint.id) === undefined
                  ? {}
                  : { observation: observations.get(checkpoint.id)! }),
                now,
              }),
            ]
          })
        )

  let status: VerificationMissionResult["status"]
  let failureCategory: VerificationMissionResult["failureCategory"]
  if (setup.status === "failed") {
    status = "blocked"
    failureCategory = "setup_failure"
  } else if (terminalFailure !== null) {
    status = "blocked"
    failureCategory = terminalFailure
  } else if (assertions.some(({ outcome }) => outcome === "blocked")) {
    status = "blocked"
    failureCategory =
      plan.kind === "control" ? "environment_instability" : "agent_block"
  } else if (assertions.some(({ outcome }) => outcome === "failed")) {
    const failedOnBaseline = assertions
      .filter(({ outcome }) => outcome === "failed")
      .some(
        ({ checkpoint }) =>
          baselineAssertions.get(checkpoint.id)?.outcome === "failed"
      )
    status = failedOnBaseline ? "blocked" : "failed"
    failureCategory = failedOnBaseline
      ? "environment_instability"
      : plan.kind === "control"
        ? "environment_instability"
        : "product_regression"
  } else if (comparison.status === "changed") {
    status = "behavior_changed"
    failureCategory = "none"
  } else {
    status = "passed"
    failureCategory = "none"
  }

  const evidenceIds = [
    ...new Set(assertions.flatMap(({ evidenceIds }) => evidenceIds)),
  ].sort(compareStrings)
  const artifacts = decideVerificationArtifactRetention({
    artifacts: head.artifacts,
    status,
    policy: input.artifactPolicy,
    now,
  })
  const requests = reportRequests(head)
  const deterministicSummary =
    status === "passed"
      ? "Every deterministic checkpoint passed"
      : status === "behavior_changed"
        ? "Every checkpoint passed, but deterministic baseline/head observations changed"
        : status === "failed"
          ? "At least one deterministic head checkpoint failed"
          : setup.status === "failed"
            ? "Verification was blocked by prerequisite setup"
            : "Verification was blocked before a trustworthy product verdict"
  const kind = input.kind ?? plan.kind
  const identity = {
    kind: "verification-mission-result",
    missionId: plan.mission.id,
    resultKind: kind,
    status,
    failureCategory,
    setupId: setup.id,
    assertionOutcomes: assertions.map(
      ({ checkpoint, outcome, reasonCode }) => ({
        checkpointId: checkpoint.id,
        outcome,
        reasonCode,
      })
    ),
    requests,
    comparison,
    version: 1,
  }
  return verificationMissionResultSchema.parse({
    schemaVersion: 1,
    id: hashCanonical(identity),
    kind,
    missionId: plan.mission.id,
    status,
    failureCategory,
    setup,
    assertions,
    requests,
    comparison,
    evidenceIds,
    artifacts,
    deterministicSummary,
    ...(head.modelExplanation === undefined
      ? {}
      : { modelExplanation: head.modelExplanation }),
    completedAt: now.toISOString(),
  })
}

export function buildBlockedSetupVerificationMission(input: {
  readonly plan: VerificationMissionPlan
  readonly setup: VerificationSetupReceipt
  readonly artifactPolicy: VerificationArtifactPolicy
  readonly now?: Date
}): VerificationMissionResult {
  const plan = verificationMissionPlanSchema.parse(input.plan)
  const setup = verificationSetupReceiptSchema.parse(input.setup)
  const now = input.now ?? new Date()
  if (setup.missionId !== plan.mission.id || setup.status !== "failed") {
    throw new Error(
      "Blocked setup result requires a failed matching setup receipt"
    )
  }
  const comparison = verificationComparisonSchema.parse({
    status: "not_available",
    changedCheckpointIds: [],
  })
  const artifacts = decideVerificationArtifactRetention({
    artifacts: setup.artifacts,
    status: "blocked",
    policy: input.artifactPolicy,
    now,
  })
  const identity = {
    kind: "verification-mission-result",
    missionId: plan.mission.id,
    resultKind: plan.kind,
    status: "blocked",
    failureCategory: "setup_failure",
    setupId: setup.id,
    version: 1,
  }
  return verificationMissionResultSchema.parse({
    schemaVersion: 1,
    id: hashCanonical(identity),
    kind: plan.kind,
    missionId: plan.mission.id,
    status: "blocked",
    failureCategory: "setup_failure",
    setup,
    assertions: [],
    requests: [],
    comparison,
    evidenceIds: setup.evidenceIds,
    artifacts,
    deterministicSummary:
      "Verification was blocked by prerequisite setup outside the product assertion",
    completedAt: now.toISOString(),
  })
}

export function buildNotRunVerificationMission(input: {
  readonly plan: VerificationMissionPlan
  readonly setup: VerificationSetupReceipt
  readonly reason: string
  readonly now?: Date
}): VerificationMissionResult {
  const plan = verificationMissionPlanSchema.parse(input.plan)
  const setup = verificationSetupReceiptSchema.parse(input.setup)
  const now = input.now ?? new Date()
  if (setup.missionId !== plan.mission.id || setup.cleanupRequired) {
    throw new Error(
      "Not-run verification requires a matching cleanup-free setup receipt"
    )
  }
  const identity = {
    kind: "verification-mission-result",
    missionId: plan.mission.id,
    resultKind: plan.kind,
    status: "not_run",
    reason: input.reason,
    version: 1,
  }
  return verificationMissionResultSchema.parse({
    schemaVersion: 1,
    id: hashCanonical(identity),
    kind: plan.kind,
    missionId: plan.mission.id,
    status: "not_run",
    failureCategory: "none",
    setup,
    assertions: [],
    requests: [],
    comparison: {
      status: "not_available",
      changedCheckpointIds: [],
    },
    evidenceIds: [],
    artifacts: [],
    deterministicSummary: input.reason,
    completedAt: now.toISOString(),
  })
}

export function effectiveVerificationMissionResults(
  results: readonly VerificationMissionResult[]
): VerificationMissionResult[] {
  const followup = results.find(({ kind }) => kind === "followup")
  const resolvedGapIds = new Set(
    followup !== undefined &&
      (followup.status === "passed" || followup.status === "behavior_changed")
      ? followup.assertions
          .filter(({ outcome }) => outcome === "passed")
          .map(({ checkpoint }) => checkpoint.id)
      : []
  )
  return results.filter((result) => {
    if (
      result.kind === "followup" ||
      result.status !== "blocked" ||
      result.failureCategory !== "agent_block"
    ) {
      return true
    }
    const blockedCheckpointIds = result.assertions
      .filter(({ outcome }) => outcome === "blocked")
      .map(({ checkpoint }) => checkpoint.id)
    return (
      blockedCheckpointIds.length === 0 ||
      blockedCheckpointIds.some((id) => !resolvedGapIds.has(id))
    )
  })
}

function aggregateStatus(input: {
  readonly results: readonly VerificationMissionResult[]
  readonly control?: VerificationMissionResult
}): TargetedVerificationResult["status"] {
  if (
    input.control !== undefined &&
    (input.control.status === "failed" || input.control.status === "blocked")
  ) {
    return "blocked"
  }
  const effectiveResults = effectiveVerificationMissionResults(input.results)
  if (effectiveResults.some(({ status }) => status === "failed"))
    return "failed"
  if (effectiveResults.some(({ status }) => status === "blocked"))
    return "blocked"
  if (effectiveResults.some(({ status }) => status === "not_run")) {
    return effectiveResults.every(({ status }) => status === "not_run")
      ? "not_run"
      : "blocked"
  }
  if (effectiveResults.some(({ status }) => status === "behavior_changed")) {
    return "behavior_changed"
  }
  if (effectiveResults.some(({ status }) => status === "passed"))
    return "passed"
  return "not_run"
}

function resultSummary(status: TargetedVerificationResult["status"]): string {
  const summaries = {
    passed:
      "All executed targeted checkpoints passed; predicted impact remains unchanged",
    failed: "At least one affected head checkpoint failed deterministically",
    behavior_changed:
      "Targeted checkpoints passed with a deterministic baseline/head behavior change",
    blocked: "Verification could not attribute a trustworthy product verdict",
    not_run: "No targeted verification mission was executed",
    verification_unavailable:
      "Verification was unavailable because the expected trusted head was not ready",
  } as const
  return summaries[status]
}

export function buildTargetedVerificationResult(input: {
  readonly plan: VerificationPlan
  readonly headValidation: DeploymentValidationResult
  readonly baselineValidation?: DeploymentValidationResult
  readonly missionResults: readonly VerificationMissionResult[]
  readonly controlResult?: VerificationMissionResult
  readonly followup?: VerificationGapFollowup
  readonly budgetUsed: MissionBudget
  readonly completedAt?: Date
}): TargetedVerificationResult {
  const completedAt = input.completedAt ?? new Date()
  const pullRequestId = input.plan.deployment.pullRequestId
  if (pullRequestId === undefined) {
    throw new Error("Verification plan is missing pull-request identity")
  }
  const predictedFindingIds = [
    ...new Set(input.plan.missions.flatMap(({ findingIds }) => findingIds)),
  ].sort(compareStrings)
  const trustedHead =
    input.headValidation.purpose === "pr_head_verification" &&
    input.headValidation.assessmentId === input.plan.assessmentId &&
    input.headValidation.pullRequestId ===
      input.plan.deployment.pullRequestId &&
    input.headValidation.expectedCommitSha ===
      input.plan.deployment.expectedCommitSha &&
    input.headValidation.browserAccessAllowed
  const executableHead = trustedHead && input.plan.status === "planned"
  const status = executableHead
    ? aggregateStatus({
        results: input.missionResults,
        ...(input.controlResult === undefined
          ? {}
          : { control: input.controlResult }),
      })
    : "verification_unavailable"
  const artifacts = [
    ...new Map(
      [
        ...input.missionResults.flatMap(({ artifacts }) => artifacts),
        ...(input.controlResult?.artifacts ?? []),
      ].map((artifact) => [artifact.artifactId, artifact])
    ).values(),
  ].sort((left, right) => compareStrings(left.artifactId, right.artifactId))
  const draft = {
    schemaVersion: 1 as const,
    policyVersion: "targeted-verification-policy-v1" as const,
    assessmentId: input.plan.assessmentId,
    applicationId: input.plan.applicationId,
    runId: input.plan.runId,
    pullRequestId,
    headSha: input.plan.deployment.expectedCommitSha,
    status,
    headValidation: input.headValidation,
    ...(input.baselineValidation === undefined
      ? {}
      : { baselineValidation: input.baselineValidation }),
    predictedFindingIds,
    missionResults: executableHead ? [...input.missionResults] : [],
    ...(executableHead && input.controlResult !== undefined
      ? { controlResult: input.controlResult }
      : {}),
    ...(executableHead && input.followup !== undefined
      ? { followup: input.followup }
      : {}),
    budgetUsed: input.budgetUsed,
    artifacts: trustedHead ? artifacts : [],
    deterministicSummary: resultSummary(status),
    ...(["blocked", "verification_unavailable"].includes(status)
      ? {
          actionRequired:
            input.plan.actionRequired ??
            input.headValidation.actionRequired ??
            "Inspect setup, control, or environment evidence before retrying verification",
        }
      : {}),
    completedAt: completedAt.toISOString(),
  }
  const identity = {
    kind: "targeted-verification-result",
    policyVersion: draft.policyVersion,
    assessmentId: draft.assessmentId,
    applicationId: draft.applicationId,
    runId: draft.runId,
    pullRequestId: draft.pullRequestId,
    headSha: draft.headSha,
    status: draft.status,
    headValidation: {
      registrationId: draft.headValidation.registrationId,
      identityState: draft.headValidation.identityState,
      trustState: draft.headValidation.trustState,
      readinessState: draft.headValidation.readinessState,
      reason: draft.headValidation.reason,
    },
    baselineValidation:
      draft.baselineValidation === undefined
        ? null
        : {
            registrationId: draft.baselineValidation.registrationId,
            identityState: draft.baselineValidation.identityState,
            trustState: draft.baselineValidation.trustState,
            readinessState: draft.baselineValidation.readinessState,
            reason: draft.baselineValidation.reason,
          },
    predictedFindingIds: draft.predictedFindingIds,
    missionResultIds: draft.missionResults.map(({ id }) => id),
    controlResultId: draft.controlResult?.id ?? null,
    followupId: draft.followup?.id ?? null,
    budgetUsed: draft.budgetUsed,
    artifacts: draft.artifacts,
    version: 1,
  }
  return targetedVerificationResultSchema.parse({
    ...draft,
    id: hashCanonical(identity),
  })
}
