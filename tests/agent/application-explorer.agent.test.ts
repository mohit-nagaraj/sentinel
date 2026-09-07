import { FakeBrowserEvidenceRuntime } from "@sentinel/adapters"
import {
  applicationExplorerPlannerContextSchema,
  browserActionCandidateSchema,
  browserObservationSchema,
  browserTransitionEvidenceSchema,
  discoveryMissionSchema,
  type ApplicationExplorerPlannerContext,
  type BrowserActionCandidate,
  type BrowserObservation,
  type DiscoveryMission,
} from "@sentinel/contracts"
import {
  createApplicationExplorer,
  type ApplicationExplorerPlannerGateway,
} from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"
import type { z } from "zod"

const applicationId = `application:v1:${"a".repeat(64)}`
const timestamp = "2026-09-08T10:00:00.000Z"

const budget = {
  toolCalls: 10,
  contentBytes: 200_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 5,
  modelCalls: 5,
  modelInputTokens: 5_000,
  modelOutputTokens: 5_000,
  reconciliationRounds: 0,
  elapsedMs: 60_000,
}

function mission(input: {
  readonly missionCharacter: string
  readonly runId: string
  readonly mode?: DiscoveryMission["mode"]
  readonly budgetOverride?: Partial<typeof budget>
}): DiscoveryMission {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: `mission:v1:${input.missionCharacter.repeat(64)}`,
    runId: input.runId,
    applicationId,
    agent: "application",
    mode: input.mode ?? "workflow_discovery",
    goal: "Discover registration guidance",
    seedEvidenceIds: [],
    questions: ["Where can an attendee view registration guidance?"],
    scope: {
      repositoryPaths: [],
      sourceUris: [],
      allowedHosts: ["fixture.test"],
      allowedTools: [
        "observe_page",
        "perform_observed_action",
        "navigate_history",
        "finish_application_mission",
      ],
    },
    budget: { ...budget, ...input.budgetOverride },
    successCriteria: ["Observe the registration guidance screen"],
  })
}

function candidate(input: {
  readonly id: string
  readonly signature: string
  readonly name: string
  readonly kind?: BrowserActionCandidate["kind"]
}): BrowserActionCandidate {
  const kind = input.kind ?? "navigate"
  return browserActionCandidateSchema.parse({
    actionId: `action:v1:${input.id.repeat(64)}`,
    signature: `sha256:${input.signature.repeat(64)}`,
    kind,
    role: kind === "reload" ? "navigation" : "link",
    name: input.name,
    disabled: false,
    policy: {
      category: kind === "reload" ? "safe_read" : "safe_navigation",
      allowed: true,
      reason: kind === "reload" ? "safe_read" : "safe_navigation",
      replaySafe: true,
    },
    expiresAt: "2026-09-08T10:10:00.000Z",
  })
}

function observation(input: {
  readonly evidenceCharacter: string
  readonly fingerprintCharacter: string
  readonly runId: string
  readonly route: string
  readonly title: string
  readonly candidates: readonly BrowserActionCandidate[]
}): BrowserObservation {
  return browserObservationSchema.parse({
    schemaVersion: 1,
    evidenceId: `evidence:v1:${input.evidenceCharacter.repeat(64)}`,
    applicationId,
    runId: input.runId,
    url: `https://fixture.test${input.route}`,
    normalizedRoute: input.route,
    title: input.title,
    headings: [input.title],
    controls: input.candidates.map((item) => ({
      role: item.role ?? "link",
      name: item.name ?? "Unnamed",
      disabled: item.disabled,
    })),
    dialogs: [],
    selectedText: [`${input.title} evidence`],
    candidates: input.candidates,
    stateFingerprint: `sha256:${input.fingerprintCharacter.repeat(64)}`,
    screenshotArtifactId: `artifact:v1:${input.evidenceCharacter.repeat(64)}`,
    errors: [],
    observedAt: timestamp,
  })
}

function transition(
  evidenceCharacter: string,
  before: BrowserObservation,
  action: BrowserActionCandidate,
  after: BrowserObservation
) {
  return browserTransitionEvidenceSchema.parse({
    schemaVersion: 1,
    evidenceId: `evidence:v1:${evidenceCharacter.repeat(64)}`,
    runId: before.runId,
    action,
    before,
    after,
    network: [],
    errors: [],
    observedAt: timestamp,
  })
}

class GoalAwarePlanner implements ApplicationExplorerPlannerGateway {
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
    const selected = context.candidates.find(
      ({ candidate }) => candidate.policy.allowed
    )?.candidate
    const output =
      selected === undefined
        ? {
            schemaVersion: 1,
            missionId: context.mission.id,
            runId: context.mission.runId,
            tool: "finish_application_mission",
            reasonCode: "goal_observed",
            summary: "Registration guidance observed",
            terminal: {
              schemaVersion: 1,
              classification: "goal_completed",
              status: "complete",
              reasonCode: "goal_observed",
              summary: "Registration guidance observed",
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
            reasonCode: "highest_ranked_evidence",
            summary: `Explore ${selected.name ?? selected.kind}`,
          }
    return {
      output: request.schema.parse(output),
      model: "goal-aware-test-agent",
      usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
    }
  }
}

function options(runId: string) {
  return {
    applicationId,
    runId,
    entryUrl: "https://fixture.test/",
    policy: { allowedOrigins: ["https://fixture.test"] },
  }
}

describe("Application Explorer agent boundary", () => {
  it.each([
    ["workflow_discovery", "1", "run:11111111-1111-4111-8111-111111111111"],
    [
      "targeted_requirement_observation",
      "2",
      "run:22222222-2222-4222-8222-222222222222",
    ],
  ] as const)(
    "completes a %s mission from ranked observed candidates",
    async (mode, missionCharacter, runId) => {
      const open = candidate({
        id: missionCharacter,
        signature: missionCharacter,
        name: "View registration guidance",
      })
      const start = observation({
        evidenceCharacter: missionCharacter,
        fingerprintCharacter: missionCharacter,
        runId,
        route: "/",
        title: "Event dashboard",
        candidates: [open],
      })
      const endCharacter = mode === "workflow_discovery" ? "3" : "4"
      const end = observation({
        evidenceCharacter: endCharacter,
        fingerprintCharacter: endCharacter,
        runId,
        route: "/registration",
        title: "Registration guidance",
        candidates: [],
      })
      const browser = new FakeBrowserEvidenceRuntime()
      browser.enqueue(runId, {
        initial: start,
        transitions: [transition("5", start, open, end)],
      })
      const planner = new GoalAwarePlanner()
      const currentMission = mission({ missionCharacter, runId, mode })
      const output = await createApplicationExplorer({
        browser,
        planner,
        now: () => new Date(timestamp),
      }).run({
        mission: currentMission,
        browserOptions: options(runId),
        requirementHintLabels: ["registration guidance"],
      })

      expect(output.result.status).toBe("complete")
      expect(output.checkpoint.visits).toEqual([
        expect.objectContaining({
          actionId: open.actionId,
          outcome: "executed",
        }),
      ])
      expect(planner.contexts[0]?.candidates[0]).toMatchObject({
        matchedRequirementHints: ["registration guidance"],
        candidate: { actionId: open.actionId },
      })
    }
  )

  it("rejects a planner-forged action before the browser executes it", async () => {
    const runId = "run:33333333-3333-4333-8333-333333333333"
    const observed = candidate({ id: "6", signature: "6", name: "View help" })
    const start = observation({
      evidenceCharacter: "6",
      fingerprintCharacter: "6",
      runId,
      route: "/",
      title: "Dashboard",
      candidates: [observed],
    })
    const browser = new FakeBrowserEvidenceRuntime()
    browser.enqueue(runId, { initial: start, transitions: [] })
    const currentMission = mission({ missionCharacter: "3", runId })
    const planner: ApplicationExplorerPlannerGateway = {
      async generateStructured(request) {
        return {
          output: request.schema.parse({
            schemaVersion: 1,
            missionId: currentMission.id,
            runId,
            tool: "perform_observed_action",
            observationEvidenceId: start.evidenceId,
            stateFingerprint: start.stateFingerprint,
            actionId: `action:v1:${"f".repeat(64)}`,
            reasonCode: "forged_choice",
            summary: "Attempt an unobserved action",
          }),
          model: "hostile-test-agent",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }
      },
    }

    const output = await createApplicationExplorer({
      browser,
      planner,
      now: () => new Date(timestamp),
    }).run({ mission: currentMission, browserOptions: options(runId) })

    expect(output.result.status).toBe("failed")
    expect(output.result.stopReason.code).toBe("action_outside_context")
    expect(output.checkpoint.path).toEqual([])
  })

  it("stops a repeated state without asking the planner for another action", async () => {
    const runId = "run:44444444-4444-4444-8444-444444444444"
    const refresh = candidate({
      id: "7",
      signature: "7",
      name: "Refresh state",
      kind: "reload",
    })
    const start = observation({
      evidenceCharacter: "7",
      fingerprintCharacter: "7",
      runId,
      route: "/",
      title: "Dashboard",
      candidates: [refresh],
    })
    const after = observation({
      evidenceCharacter: "8",
      fingerprintCharacter: "7",
      runId,
      route: "/",
      title: "Dashboard",
      candidates: [
        candidate({
          id: "8",
          signature: "7",
          name: "Refresh state",
          kind: "reload",
        }),
      ],
    })
    const browser = new FakeBrowserEvidenceRuntime()
    browser.enqueue(runId, {
      initial: start,
      transitions: [transition("9", start, refresh, after)],
    })
    const planner = new GoalAwarePlanner()
    const currentMission = mission({ missionCharacter: "4", runId })
    const output = await createApplicationExplorer({
      browser,
      planner,
      now: () => new Date(timestamp),
    }).run({
      mission: currentMission,
      browserOptions: options(runId),
      noProgressLimit: 1,
    })

    expect(output.result.stopReason.code).toBe("no_progress_limit")
    expect(output.checkpoint.visits[0]?.outcome).toBe("no_progress")
    expect(planner.contexts).toHaveLength(1)
  })
})
