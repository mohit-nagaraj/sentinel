import {
  BrowserRuntimeError,
  createPlaywrightBrowserEvidenceRuntime,
  type BrowserArtifactSink,
  type BrowserRunOptions,
} from "@sentinel/adapters"
import {
  applicationExplorerPlannerContextSchema,
  artifactIdSchema,
  discoveryMissionSchema,
  type ApplicationExplorerMissionOutput,
  type ApplicationExplorerPlannerContext,
  type ApplicationExplorerTerminal,
  type ApplicationId,
  type ArtifactId,
  type DiscoveryMission,
  type RunId,
} from "@sentinel/contracts"
import {
  ApplicationExplorerTools,
  createApplicationExplorer,
  type ApplicationExplorerPlannerGateway,
} from "@sentinel/orchestration"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { z } from "zod"

import {
  startApplicationExplorerFixture,
  type ApplicationExplorerFixtureApplication,
} from "../fixtures/application-explorer-application.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const secretReference = `secret-ref:v1:${"d".repeat(64)}`
const fixedNow = new Date("2026-09-08T10:00:00.000Z")

const missionBudget = {
  toolCalls: 30,
  contentBytes: 1_000_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 20,
  modelCalls: 20,
  modelInputTokens: 20_000,
  modelOutputTokens: 20_000,
  reconciliationRounds: 0,
  elapsedMs: 120_000,
}

const identities = {
  unprompted: {
    mission: `mission:v1:${"b".repeat(64)}`,
    run: "run:11111111-1111-4111-8111-111111111111",
  },
  targeted: {
    mission: `mission:v1:${"c".repeat(64)}`,
    run: "run:22222222-2222-4222-8222-222222222222",
  },
  branchOne: {
    mission: `mission:v1:${"d".repeat(64)}`,
    run: "run:33333333-3333-4333-8333-333333333333",
  },
  branchTwo: {
    mission: `mission:v1:${"e".repeat(64)}`,
    run: "run:44444444-4444-4444-8444-444444444444",
  },
  guards: {
    mission: `mission:v1:${"f".repeat(64)}`,
    run: "run:55555555-5555-4555-8555-555555555555",
  },
  stale: {
    mission: `mission:v1:${"1".repeat(64)}`,
    run: "run:66666666-6666-4666-8666-666666666666",
  },
  used: {
    mission: `mission:v1:${"2".repeat(64)}`,
    run: "run:77777777-7777-4777-8777-777777777777",
  },
  recovery: {
    mission: `mission:v1:${"3".repeat(64)}`,
    run: "run:88888888-8888-4888-8888-888888888888",
  },
  uncertain: {
    mission: `mission:v1:${"4".repeat(64)}`,
    run: "run:99999999-9999-4999-8999-999999999999",
  },
  noProgress: {
    mission: `mission:v1:${"5".repeat(64)}`,
    run: "run:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  },
  budget: {
    mission: `mission:v1:${"6".repeat(64)}`,
    run: "run:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  },
} as const

class MemoryArtifacts implements BrowserArtifactSink {
  readonly records: Uint8Array[] = []

  async persist(input: {
    readonly applicationId: ApplicationId
    readonly runId: RunId
    readonly body: Uint8Array
  }): Promise<ArtifactId> {
    this.records.push(input.body)
    return artifactIdSchema.parse(
      `artifact:v1:${this.records.length.toString(16).padStart(64, "0")}`
    )
  }
}

type AgendaItem =
  | { readonly kind: "action"; readonly name: string }
  | { readonly kind: "finish"; readonly classification: "goal_completed" }

class AgendaPlanner implements ApplicationExplorerPlannerGateway {
  readonly contexts: ApplicationExplorerPlannerContext[] = []
  private index = 0

  constructor(private readonly agenda: readonly AgendaItem[]) {}

  async generateStructured<Output>(request: {
    readonly input: string
    readonly schema: z.ZodType<Output>
  }): Promise<{
    readonly output: Output
    readonly model: string
    readonly usage: {
      readonly inputTokens: number
      readonly outputTokens: number
      readonly totalTokens: number
    }
  }> {
    const context = applicationExplorerPlannerContextSchema.parse(
      JSON.parse(request.input)
    )
    this.contexts.push(context)
    const item = this.agenda[this.index++]
    if (item === undefined) throw new Error("Planner agenda was exhausted")

    const decision =
      item.kind === "finish"
        ? {
            schemaVersion: 1,
            missionId: context.mission.id,
            runId: context.mission.runId,
            tool: "finish_application_mission",
            reasonCode: "fixture_goal_observed",
            summary: "Fixture workflow observed",
            terminal: {
              schemaVersion: 1,
              classification: item.classification,
              status: "complete",
              reasonCode: "fixture_goal_observed",
              summary: "Fixture workflow observed",
            },
          }
        : this.actionDecision(context, item.name)

    return {
      output: request.schema.parse(decision),
      model: "deterministic-agenda",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    }
  }

  private actionDecision(
    context: ApplicationExplorerPlannerContext,
    name: string
  ): unknown {
    const match = context.candidates.find(
      ({ candidate }) => candidate.name === name
    )?.candidate
    if (match === undefined) {
      throw new Error(`Observed action was not available: ${name}`)
    }
    return {
      schemaVersion: 1,
      missionId: context.mission.id,
      runId: context.mission.runId,
      tool:
        match.kind === "back" || match.kind === "reload"
          ? "navigate_history"
          : "perform_observed_action",
      observationEvidenceId: context.observation.evidenceId,
      stateFingerprint: context.observation.stateFingerprint,
      actionId: match.actionId,
      reasonCode: "fixture_agenda_action",
      summary: `Explore ${name}`,
    }
  }
}

class EvidenceSeekingPlanner implements ApplicationExplorerPlannerGateway {
  readonly contexts: ApplicationExplorerPlannerContext[] = []

  async generateStructured<Output>(request: {
    readonly input: string
    readonly schema: z.ZodType<Output>
  }): Promise<{
    readonly output: Output
    readonly model: string
    readonly usage: {
      readonly inputTokens: number
      readonly outputTokens: number
      readonly totalTokens: number
    }
  }> {
    const context = applicationExplorerPlannerContextSchema.parse(
      JSON.parse(request.input)
    )
    this.contexts.push(context)
    const hasRegistrationEvidence =
      context.observation.normalizedRoute === "/register" &&
      context.observation.untrustedPageContent.selectedText.some((text) =>
        text.toLowerCase().includes("tickets are available")
      ) &&
      context.progress.visitedStateActionPairs >= 6
    const visitedActionNames = new Set(
      context.progress.recentActions
        .filter((action) =>
          ["executed", "no_progress"].includes(action.outcome)
        )
        .map((action) => action.actionName)
    )
    const allowed = context.candidates.filter(
      ({ candidate }) =>
        candidate.policy.allowed &&
        !candidate.disabled &&
        (candidate.name === undefined ||
          !visitedActionNames.has(candidate.name))
    )
    const priorities = new Map([
      ["fill", 0],
      ["select", 1],
      ["check", 2],
      ["click", 3],
      ["navigate", 4],
      ["back", 5],
      ["reload", 6],
    ])
    const selected =
      context.observation.normalizedRoute === "/register"
        ? [...allowed].sort(
            (left, right) =>
              (priorities.get(left.candidate.kind) ?? 10) -
                (priorities.get(right.candidate.kind) ?? 10) ||
              left.rank - right.rank
          )[0]?.candidate
        : allowed[0]?.candidate
    const decision =
      hasRegistrationEvidence || selected === undefined
        ? {
            schemaVersion: 1,
            missionId: context.mission.id,
            runId: context.mission.runId,
            tool: "finish_application_mission",
            reasonCode: hasRegistrationEvidence
              ? "mission_evidence_satisfied"
              : "frontier_exhausted",
            summary: hasRegistrationEvidence
              ? "Registration form and runtime evidence observed"
              : "No additional safe frontier action is available",
            terminal: {
              schemaVersion: 1,
              classification: hasRegistrationEvidence
                ? "goal_completed"
                : "dead_end",
              status: hasRegistrationEvidence ? "complete" : "partial",
              reasonCode: hasRegistrationEvidence
                ? "mission_evidence_satisfied"
                : "frontier_exhausted",
              summary: hasRegistrationEvidence
                ? "Registration form and runtime evidence observed"
                : "No additional safe frontier action is available",
            },
          }
        : {
            schemaVersion: 1,
            missionId: context.mission.id,
            runId: context.mission.runId,
            tool:
              selected.kind === "back" || selected.kind === "reload"
                ? "navigate_history"
                : "perform_observed_action",
            observationEvidenceId: context.observation.evidenceId,
            stateFingerprint: context.observation.stateFingerprint,
            actionId: selected.actionId,
            reasonCode: "highest_relevance_safe_frontier",
            summary: "Explore the highest-relevance safe frontier action",
          }
    return {
      output: request.schema.parse(decision),
      model: "evidence-seeking-test-agent",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    }
  }
}

function mission(
  identity: { readonly mission: string; readonly run: string },
  origin: string,
  overrides: {
    readonly mode?: DiscoveryMission["mode"]
    readonly goal?: string
    readonly questions?: readonly string[]
    readonly budget?: typeof missionBudget
    readonly successCriteria?: readonly string[]
  } = {}
): DiscoveryMission {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: identity.mission,
    runId: identity.run,
    applicationId,
    agent: "application",
    mode: "workflow_discovery",
    goal: "Discover event registration",
    seedEvidenceIds: [],
    questions: ["How does an attendee explore registration?"],
    scope: {
      repositoryPaths: [],
      sourceUris: [],
      allowedHosts: [new URL(origin).hostname],
      allowedTools: [
        "observe_page",
        "perform_observed_action",
        "navigate_history",
        "finish_application_mission",
      ],
    },
    budget: missionBudget,
    successCriteria: ["Observe registration screens and runtime activity"],
    ...overrides,
  })
}

function browserOptions(
  fixture: ApplicationExplorerFixtureApplication,
  runId: string,
  path = "/"
): BrowserRunOptions {
  return {
    applicationId,
    runId,
    entryUrl: `${fixture.origin}${path}`,
    storageStateReference: secretReference,
    inputSlots: [
      {
        slot: "attendee_email",
        kind: "fill",
        accessibleName: "Attendee email",
      },
      {
        slot: "ticket_tier",
        kind: "select",
        accessibleName: "Ticket tier",
      },
    ],
    policy: {
      allowedOrigins: [fixture.origin],
      allowInsecureLocalhost: true,
      budgets: { maxDurationMs: 30_000 },
    },
  }
}

function createRuntime(artifacts = new MemoryArtifacts()) {
  const storageReferences: string[] = []
  return {
    artifacts,
    storageReferences,
    runtime: createPlaywrightBrowserEvidenceRuntime({
      artifacts,
      inputResolver: {
        async resolve(_runId, slot) {
          return slot === "ticket_tier" ? "vip" : "attendee@example.test"
        },
      },
      storageStateProvider: {
        async resolve(reference) {
          storageReferences.push(reference)
          return { cookies: [], origins: [] }
        },
      },
    }),
  }
}

function productIds(output: ApplicationExplorerMissionOutput): string[] {
  return output.evidenceClaims
    .filter(
      (claim) =>
        claim.claimKind === "screen" ||
        claim.claimKind === "workflow" ||
        claim.claimKind === "flow_step"
    )
    .map((claim) => claim.fact.id)
    .sort()
}

describe("Application Explorer real browser missions", () => {
  let fixture: ApplicationExplorerFixtureApplication

  beforeAll(async () => {
    fixture = await startApplicationExplorerFixture()
  }, 30_000)

  afterAll(async () => {
    await fixture.close()
  }, 30_000)

  it("discovers an unprompted form workflow with dynamic labels and network evidence", async () => {
    const { runtime, artifacts } = createRuntime()
    const planner = new EvidenceSeekingPlanner()
    const currentMission = mission(identities.unprompted, fixture.origin)
    const output = await createApplicationExplorer({
      browser: runtime,
      planner,
      now: () => fixedNow,
    }).run({
      mission: currentMission,
      browserOptions: browserOptions(fixture, currentMission.runId),
      capabilityHintLabels: ["event registration", "attendee", "ticket"],
      requirementHintLabels: [
        "registration details",
        "ticket status",
        "event terms",
      ],
    })

    expect(output.result.status).toBe("complete")
    expect(output.checkpoint.path).toHaveLength(6)
    expect(
      planner.contexts.some((context) =>
        context.candidates.some(
          ({ candidate }) => candidate.name === "VIP attendee contact"
        )
      )
    ).toBe(true)
    expect(
      output.evidenceClaims.find(
        (claim) =>
          claim.claimKind === "runtime_request" &&
          claim.request.normalizedPath === "/api/ticket-status"
      )
    ).toMatchObject({
      request: {
        method: "GET",
        normalizedPath: "/api/ticket-status",
        status: 200,
        outcome: "response",
      },
    })
    expect(
      output.evidenceClaims
        .filter((claim) => claim.claimKind === "flow_step")
        .every(
          (claim) =>
            claim.evidenceIds.includes(claim.before.observationEvidenceId) &&
            claim.evidenceIds.includes(claim.after.observationEvidenceId) &&
            claim.evidenceIds.includes(claim.transitionEvidenceId) &&
            claim.afterScreenshotArtifactId !== undefined
        )
    ).toBe(true)
    expect(artifacts.records.every((body) => body.byteLength > 0)).toBe(true)
    expect(JSON.stringify(output)).not.toContain("attendee@example.test")
    expect(fixture.requests).toContainEqual({
      method: "GET",
      path: "/api/ticket-status",
    })
  }, 60_000)

  it("uses requirement hints for a targeted modal observation", async () => {
    const { runtime } = createRuntime()
    const planner = new AgendaPlanner([
      { kind: "action", name: "Open modal" },
      { kind: "finish", classification: "goal_completed" },
    ])
    const currentMission = mission(identities.targeted, fixture.origin, {
      mode: "targeted_requirement_observation",
      goal: "Observe modal guidance",
      questions: ["What guidance is shown in the event modal?"],
      successCriteria: ["Observe the Event guidance dialog"],
    })
    const output = await createApplicationExplorer({
      browser: runtime,
      planner,
      now: () => fixedNow,
    }).run({
      mission: currentMission,
      browserOptions: browserOptions(fixture, currentMission.runId),
      requirementHintLabels: ["modal guidance"],
      candidateLimit: 4,
    })

    expect(output.result.status).toBe("complete")
    expect(planner.contexts[0]?.candidates[0]).toMatchObject({
      matchedRequirementHints: ["modal guidance"],
      candidate: { name: "Open modal" },
    })
    expect(
      planner.contexts[1]?.observation.untrustedPageContent.dialogs
    ).toEqual([
      expect.objectContaining({
        role: "dialog",
        name: "Event guidance",
        text: expect.stringContaining("Choose an application area"),
      }),
    ])
  }, 30_000)

  it("backtracks across branches and keeps product identities stable across runs", async () => {
    const runBranchMission = async (identity: {
      readonly mission: string
      readonly run: string
    }) => {
      const { runtime } = createRuntime()
      const planner = new AgendaPlanner([
        { kind: "action", name: "View event details" },
        { kind: "action", name: "Go back" },
        { kind: "action", name: "View organizer overview" },
        { kind: "finish", classification: "goal_completed" },
      ])
      const currentMission = mission(identity, fixture.origin)
      return createApplicationExplorer({
        browser: runtime,
        planner,
        now: () => fixedNow,
      }).run({
        mission: currentMission,
        browserOptions: browserOptions(fixture, currentMission.runId),
      })
    }

    const first = await runBranchMission(identities.branchOne)
    const second = await runBranchMission(identities.branchTwo)

    expect(first.checkpoint.path.map((step) => step.replaySafe)).toEqual([
      true,
      false,
      true,
    ])
    expect(
      first.evidenceClaims.filter((claim) => claim.claimKind === "workflow")
    ).toHaveLength(2)
    expect(productIds(second)).toStrictEqual(productIds(first))
  }, 60_000)

  it("fails closed for forged, unsafe, stale, and reused action identities", async () => {
    const guardRuntime = createRuntime().runtime
    const guardMission = mission(identities.guards, fixture.origin)
    const guardOptions = browserOptions(fixture, guardMission.runId)
    const guardObservation = await guardRuntime.startRun(guardOptions)
    const tools = new ApplicationExplorerTools(guardRuntime)
    const baseDecision = {
      schemaVersion: 1,
      missionId: guardMission.id,
      runId: guardMission.runId,
      tool: "perform_observed_action",
      observationEvidenceId: guardObservation.evidenceId,
      stateFingerprint: guardObservation.stateFingerprint,
      reasonCode: "guard_test",
      summary: "Exercise the action guard",
    }
    await expect(
      tools.performObservedAction(
        guardMission,
        { ...baseDecision, actionId: `action:v1:${"0".repeat(64)}` },
        guardObservation
      )
    ).rejects.toMatchObject({ code: "action_not_observed" })
    const unsafe = guardObservation.candidates.find(
      (candidate) => candidate.name === "Place order"
    )
    await expect(
      tools.performObservedAction(
        guardMission,
        { ...baseDecision, actionId: unsafe?.actionId },
        guardObservation
      )
    ).rejects.toMatchObject({ code: "unsafe_action" })
    await guardRuntime.cancelRun(guardMission.runId)

    const staleRuntime = createRuntime().runtime
    const staleMission = mission(identities.stale, fixture.origin)
    const staleObservation = await staleRuntime.startRun(
      browserOptions(fixture, staleMission.runId, "/stale")
    )
    const stale = staleObservation.candidates.find(
      (candidate) => candidate.name === "View stable details"
    )
    await new Promise((resolve) => setTimeout(resolve, 350))
    await expect(
      staleRuntime.performAction(staleMission.runId, stale?.actionId ?? "")
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserRuntimeError &&
        error.failure.code === "action_stale"
    )
    await staleRuntime.cancelRun(staleMission.runId)

    const usedRuntime = createRuntime().runtime
    const usedMission = mission(identities.used, fixture.origin)
    const usedObservation = await usedRuntime.startRun(
      browserOptions(fixture, usedMission.runId)
    )
    const refresh = usedObservation.candidates.find(
      (candidate) => candidate.name === "Refresh state"
    )
    await usedRuntime.performAction(usedMission.runId, refresh?.actionId ?? "")
    await expect(
      usedRuntime.performAction(usedMission.runId, refresh?.actionId ?? "")
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof BrowserRuntimeError &&
        error.failure.code === "action_reused"
    )
    await usedRuntime.cancelRun(usedMission.runId)
  }, 60_000)

  it("replays a safe checkpoint and stops before an uncertain check replay", async () => {
    const safeDependencies = createRuntime()
    const safeMission = mission(identities.recovery, fixture.origin)
    const safeOptions = browserOptions(fixture, safeMission.runId)
    const first = await createApplicationExplorer({
      browser: safeDependencies.runtime,
      planner: new AgendaPlanner([
        { kind: "action", name: "View event details" },
        { kind: "finish", classification: "goal_completed" },
      ]),
      now: () => fixedNow,
    }).run({ mission: safeMission, browserOptions: safeOptions })
    expect(first.checkpoint.replayBoundary).toMatchObject({
      replaySafePathLength: 1,
      checkpointPathLength: 1,
      requiresHumanReview: false,
      authenticationStateReference: secretReference,
    })

    const resumed = await createApplicationExplorer({
      browser: safeDependencies.runtime,
      planner: new AgendaPlanner([
        { kind: "finish", classification: "goal_completed" },
      ]),
      now: () => fixedNow,
    }).run({
      mission: safeMission,
      browserOptions: safeOptions,
      checkpoint: first.checkpoint,
      priorEvidenceClaims: first.evidenceClaims,
    })
    expect(resumed.result.status).toBe("complete")
    expect(safeDependencies.storageReferences).toEqual([
      secretReference,
      secretReference,
    ])

    const uncertainDependencies = createRuntime()
    const uncertainMission = mission(identities.uncertain, fixture.origin, {
      mode: "flow_recovery",
    })
    const uncertainOptions = browserOptions(
      fixture,
      uncertainMission.runId,
      "/register"
    )
    const uncertain = await createApplicationExplorer({
      browser: uncertainDependencies.runtime,
      planner: new AgendaPlanner([
        { kind: "action", name: "Accept event terms" },
        { kind: "finish", classification: "goal_completed" },
      ]),
      now: () => fixedNow,
    }).run({ mission: uncertainMission, browserOptions: uncertainOptions })
    expect(uncertain.checkpoint.replayBoundary.requiresHumanReview).toBe(true)
    const requestCount = fixture.requests.filter(
      ({ path }) => path === "/register"
    ).length

    const interrupted = await createApplicationExplorer({
      browser: uncertainDependencies.runtime,
      planner: new AgendaPlanner([]),
      now: () => fixedNow,
    }).run({
      mission: uncertainMission,
      browserOptions: uncertainOptions,
      checkpoint: uncertain.checkpoint,
      priorEvidenceClaims: uncertain.evidenceClaims,
    })
    expect(interrupted.result.status).toBe("needs_human")
    expect(interrupted.terminal).toMatchObject<
      Partial<ApplicationExplorerTerminal>
    >({
      classification: "recovery_review",
      reasonCode: "non_idempotent_replay",
    })
    expect(
      fixture.requests.filter(({ path }) => path === "/register")
    ).toHaveLength(requestCount)
  }, 60_000)

  it("terminates at no-progress and model-call budgets", async () => {
    const noProgressDependencies = createRuntime()
    const noProgressMission = mission(identities.noProgress, fixture.origin)
    const noProgress = await createApplicationExplorer({
      browser: noProgressDependencies.runtime,
      planner: new AgendaPlanner([{ kind: "action", name: "Refresh state" }]),
      now: () => fixedNow,
    }).run({
      mission: noProgressMission,
      browserOptions: browserOptions(fixture, noProgressMission.runId),
      noProgressLimit: 1,
    })
    expect(noProgress.result.stopReason.code).toBe("no_progress_limit")
    expect(noProgress.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "no_progress", recoverable: false }),
      ])
    )

    const budgetDependencies = createRuntime()
    const budgetMission = mission(identities.budget, fixture.origin, {
      budget: { ...missionBudget, modelCalls: 1 },
    })
    const budgetOutput = await createApplicationExplorer({
      browser: budgetDependencies.runtime,
      planner: new AgendaPlanner([
        { kind: "action", name: "View event details" },
      ]),
      now: () => fixedNow,
    }).run({
      mission: budgetMission,
      browserOptions: browserOptions(fixture, budgetMission.runId),
    })
    expect(budgetOutput.result.status).toBe("budget_exhausted")
    expect(budgetOutput.result.stopReason.code).toBe(
      "model_call_budget_exhausted"
    )
  }, 60_000)
})
