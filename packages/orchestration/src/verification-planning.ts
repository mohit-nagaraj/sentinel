import {
  VERIFICATION_PLAN_POLICY_VERSION,
  createMissionId,
  discoveryMissionSchema,
  hashCanonical,
  verificationPlanSchema,
  verificationPlanningInputSchema,
  verificationSetupSchema,
  type MissionBudget,
  type VerificationControlDefinition,
  type VerificationMissionPlan,
  type VerificationPlan,
  type VerificationPlanningInput,
  type VerificationScenarioDefinition,
  type VerificationSetup,
} from "@sentinel/contracts"

const MAX_AFFECTED_MISSIONS = 10
const MAX_PLAN_EXCLUSIONS = 100
const riskOrder = { high: 0, medium: 1, low: 2 } as const

function emptyBudget(): MissionBudget {
  return {
    toolCalls: 0,
    contentBytes: 0,
    documentBytes: 0,
    documentPages: 0,
    documentSections: 0,
    sourceLines: 0,
    repositoryBytes: 0,
    repositoryFiles: 0,
    browserActions: 0,
    modelCalls: 0,
    modelInputTokens: 0,
    modelOutputTokens: 0,
    reconciliationRounds: 0,
    elapsedMs: 0,
  }
}

function missionBudget(priority: "high" | "medium" | "low"): MissionBudget {
  const scale =
    priority === "high"
      ? { actions: 16, calls: 3, elapsed: 180_000 }
      : priority === "medium"
        ? { actions: 12, calls: 2, elapsed: 120_000 }
        : { actions: 8, calls: 2, elapsed: 90_000 }
  return {
    ...emptyBudget(),
    toolCalls: scale.actions * 2 + 4,
    contentBytes: 256 * 1_024,
    browserActions: scale.actions,
    modelCalls: scale.calls,
    modelInputTokens: 24_000,
    modelOutputTokens: 4_000,
    elapsedMs: scale.elapsed,
  }
}

function addBudgets(values: readonly MissionBudget[]): MissionBudget {
  const total = emptyBudget()
  for (const value of values) {
    for (const key of Object.keys(total) as (keyof MissionBudget)[]) {
      total[key] += value[key]
    }
  }
  total.reconciliationRounds = values.length > 0 ? 1 : 0
  return total
}

function normalizeSetup(
  setup: VerificationSetup,
  impactedIds: ReadonlySet<string>
): VerificationSetup {
  const inside = setup.relatedEntityIds.some((id) => impactedIds.has(id))
  return verificationSetupSchema.parse({
    ...setup,
    classification: inside ? "inside_blast_radius" : "outside_blast_radius",
    method: inside
      ? "user_interface"
      : setup.reference === undefined
        ? "none"
        : "trusted_fixture_api",
  })
}

function boundedExclusions(values: readonly string[]): string[] {
  return [...new Set(values)].slice(0, MAX_PLAN_EXCLUSIONS)
}

function buildMission(input: {
  readonly source: VerificationPlanningInput
  readonly definition:
    VerificationScenarioDefinition | VerificationControlDefinition
  readonly ordinal: number
  readonly kind: "affected" | "control"
  readonly priority: "high" | "medium" | "low"
  readonly findingIds: VerificationMissionPlan["findingIds"]
  readonly scenarioIds: VerificationMissionPlan["scenarioIds"]
  readonly targetIds: VerificationMissionPlan["targetIds"]
  readonly impactedIds: ReadonlySet<string>
}): VerificationMissionPlan {
  const budget = missionBudget(input.priority)
  const setup = normalizeSetup(input.definition.setup, input.impactedIds)
  const publicUrl = input.source.deployment.proof?.publicUrl
  if (publicUrl === undefined) {
    throw new Error("Trusted deployment proof omitted its public URL")
  }
  const mission = discoveryMissionSchema.parse({
    schemaVersion: 1 as const,
    id: createMissionId({
      applicationId: input.source.applicationId,
      runId: input.source.runId,
      agent: "application",
      mode: "pr_change_validation",
      ordinal: input.ordinal,
    }),
    runId: input.source.runId,
    applicationId: input.source.applicationId,
    agent: "application" as const,
    mode: "pr_change_validation" as const,
    goal: input.definition.goal,
    seedEvidenceIds: [],
    questions: input.definition.checkpoints.map(
      ({ description }) => `What observed evidence satisfies: ${description}`
    ),
    scope: {
      repositoryPaths: [],
      sourceUris: [],
      allowedHosts: [new URL(publicUrl).hostname],
      allowedTools: [
        "observe_page",
        "perform_observed_action",
        "navigate_history",
        "finish_application_mission",
      ],
    },
    budget,
    successCriteria: input.definition.checkpoints.map(
      ({ description }) => description
    ),
  })
  return {
    kind: input.kind,
    mission,
    findingIds: [...input.findingIds].sort(),
    scenarioIds: [...input.scenarioIds].sort(),
    targetIds: [...new Set(input.targetIds)].sort(),
    priority: input.priority,
    entryPath: input.definition.entryPath,
    setup,
    checkpoints: input.definition.checkpoints,
    exclusions: input.definition.exclusions,
  }
}

function unavailablePlan(input: {
  readonly source: VerificationPlanningInput
  readonly actionRequired: string
  readonly exclusions: readonly string[]
  readonly now: Date
}): VerificationPlan {
  const draft = {
    schemaVersion: 1 as const,
    policyVersion: VERIFICATION_PLAN_POLICY_VERSION,
    applicationId: input.source.applicationId,
    runId: input.source.runId,
    assessmentId: input.source.blastRadius.assessmentId,
    blastRadiusResultId: input.source.blastRadius.id,
    status: "verification_unavailable" as const,
    deployment: input.source.deployment,
    missions: [],
    budget: emptyBudget(),
    exclusions: boundedExclusions(input.exclusions),
    actionRequired: input.actionRequired,
    createdAt: input.now.toISOString(),
  }
  return verificationPlanSchema.parse({
    ...draft,
    id: hashCanonical({ kind: "verification-plan", version: 1, ...draft }),
  })
}

export function createVerificationPlan(
  inputValue: VerificationPlanningInput,
  options: { readonly now?: () => Date } = {}
): VerificationPlan {
  const input = verificationPlanningInputSchema.parse(inputValue)
  const now = (options.now ?? (() => new Date()))()
  if (
    input.applicationId !== input.blastRadius.applicationId ||
    input.applicationId !== input.deployment.applicationId
  ) {
    throw new Error("Verification planning inputs cross application identity")
  }
  if (
    input.deployment.purpose === "pr_head_verification" &&
    (input.deployment.assessmentId !== input.blastRadius.assessmentId ||
      input.deployment.pullRequestId !== input.blastRadius.pullRequestId)
  ) {
    throw new Error(
      "Deployment validation does not match the blast-radius assessment and pull request"
    )
  }
  if (
    !input.deployment.browserAccessAllowed ||
    input.deployment.purpose !== "pr_head_verification"
  ) {
    return unavailablePlan({
      source: input,
      actionRequired:
        input.deployment.purpose === "baseline_observation"
          ? "Register a trusted deployment of the expected PR head; baseline observations cannot verify a pull request"
          : (input.deployment.actionRequired ??
            "Register a trusted deployment of the expected PR head"),
      exclusions: [
        "Dynamic verification was not run; the static blast-radius assessment remains valid",
        ...input.exclusions,
      ],
      now,
    })
  }

  const impactedIds = new Set<string>()
  const scenarioToFindings = new Map<
    string,
    VerificationMissionPlan["findingIds"]
  >()
  const scenarioPriority = new Map<string, "high" | "medium" | "low">()
  const sourceScenarios = new Map<
    string,
    (typeof input.blastRadius.findings)[number]["scenarios"][number]
  >()
  for (const finding of input.blastRadius.findings) {
    if (finding.risk === "unknown") continue
    if (finding.targetId !== undefined) impactedIds.add(finding.targetId)
    finding.changedSymbolIds.forEach((id) => impactedIds.add(id))
    const findingPathIds = new Set(finding.evidencePathIds)
    input.blastRadius.evidencePaths
      .filter(({ id }) => findingPathIds.has(id))
      .flatMap(({ nodes }) => nodes)
      .forEach(({ id }) => impactedIds.add(id))
    for (const scenario of finding.scenarios) {
      sourceScenarios.set(scenario.id, scenario)
      scenario.checkpointEntityIds.forEach((id) => impactedIds.add(id))
      if (scenario.workflowId !== undefined)
        impactedIds.add(scenario.workflowId)
      scenarioToFindings.set(scenario.id, [
        ...(scenarioToFindings.get(scenario.id) ?? []),
        finding.id,
      ])
      const current = scenarioPriority.get(scenario.id)
      if (
        current === undefined ||
        riskOrder[finding.risk] < riskOrder[current]
      ) {
        scenarioPriority.set(scenario.id, finding.risk)
      }
    }
  }

  const definitions = new Map(
    input.scenarios.map((definition) => [definition.scenario.id, definition])
  )
  const eligible = [...sourceScenarios.values()]
    .filter((scenario) => definitions.has(scenario.id))
    .sort(
      (left, right) =>
        riskOrder[scenarioPriority.get(left.id)!] -
          riskOrder[scenarioPriority.get(right.id)!] ||
        left.id.localeCompare(right.id)
    )
    .slice(0, MAX_AFFECTED_MISSIONS)

  const missingDefinitions = [...sourceScenarios.values()].filter(
    (scenario) => !definitions.has(scenario.id)
  )
  const omissions = missingDefinitions
    .slice(0, MAX_PLAN_EXCLUSIONS - 1)
    .map(
      ({ id }) =>
        `Scenario ${id} was excluded because no deterministic checkpoint definition was supplied`
    )
  if (missingDefinitions.length > omissions.length) {
    omissions.push(
      `${missingDefinitions.length - omissions.length} additional scenarios lacked deterministic checkpoint definitions`
    )
  }
  if (eligible.length === 0) {
    return unavailablePlan({
      source: input,
      actionRequired:
        "Supply deterministic checkpoint definitions for an impacted scenario",
      exclusions: [
        "No dynamic result was fabricated; the static blast-radius assessment remains valid",
        ...omissions,
        ...input.exclusions,
      ],
      now,
    })
  }

  const missions = eligible.map((scenario, ordinal) =>
    buildMission({
      source: input,
      definition: definitions.get(scenario.id)!,
      ordinal,
      kind: "affected",
      priority: scenarioPriority.get(scenario.id)!,
      findingIds: scenarioToFindings.get(scenario.id) ?? [],
      scenarioIds: [scenario.id],
      targetIds: [scenario.targetId, ...scenario.checkpointEntityIds],
      impactedIds,
    })
  )

  const impactedWorkflows = new Set(
    [...sourceScenarios.values()].flatMap(({ workflowId }) =>
      workflowId === undefined ? [] : [workflowId]
    )
  )
  const controlDefinition = [...input.controls]
    .filter(
      ({ workflowId }) =>
        !impactedWorkflows.has(workflowId) && !impactedIds.has(workflowId)
    )
    .sort((left, right) => left.id.localeCompare(right.id))[0]
  const control =
    controlDefinition === undefined
      ? undefined
      : buildMission({
          source: input,
          definition: controlDefinition,
          ordinal: missions.length,
          kind: "control",
          priority: "low",
          findingIds: [],
          scenarioIds: [],
          targetIds: [controlDefinition.workflowId],
          impactedIds,
        })

  const exclusions = [
    ...omissions,
    ...(sourceScenarios.size > MAX_AFFECTED_MISSIONS
      ? [
          `Verification was capped at ${MAX_AFFECTED_MISSIONS} affected missions`,
        ]
      : []),
    ...(control === undefined
      ? [
          "No unaffected control flow with deterministic checkpoints was available",
        ]
      : []),
    ...input.exclusions,
  ]
  const draft = {
    schemaVersion: 1 as const,
    policyVersion: VERIFICATION_PLAN_POLICY_VERSION,
    applicationId: input.applicationId,
    runId: input.runId,
    assessmentId: input.blastRadius.assessmentId,
    blastRadiusResultId: input.blastRadius.id,
    status: "planned" as const,
    deployment: input.deployment,
    missions,
    ...(control === undefined ? {} : { control }),
    budget: addBudgets([
      ...missions.map(({ mission }) => mission.budget),
      ...(control === undefined ? [] : [control.mission.budget]),
    ]),
    exclusions: boundedExclusions(exclusions),
    createdAt: now.toISOString(),
  }
  return verificationPlanSchema.parse({
    ...draft,
    id: hashCanonical({ kind: "verification-plan", version: 1, ...draft }),
  })
}
