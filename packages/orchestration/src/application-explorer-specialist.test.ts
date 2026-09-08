import {
  browserObservationSchema,
  browserRecoveryRecipeSchema,
  discoveryMissionSchema,
  type BrowserObservation,
  type BrowserRecoveryRecipe,
  type BrowserTransitionEvidence,
  type DiscoveryMission,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  APPLICATION_EXPLORER_MODES,
  InMemoryApplicationExplorerSpecialistStoreForTesting,
  createApplicationExplorerSpecialistToolDefinitions,
} from "./application-explorer-specialist.ts"
import {
  ApplicationExplorerTools,
  createApplicationExplorer,
  type ApplicationBrowserRuntime,
  type ApplicationExplorerPlannerGateway,
} from "./application-explorer.ts"

const applicationId = `application:v1:${"a".repeat(64)}`
const applicationRunId = "run:17171717-1717-4717-8717-171717171717"

function mission(overrides: Partial<DiscoveryMission> = {}): DiscoveryMission {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: `mission:v1:${"b".repeat(64)}`,
    runId: applicationRunId,
    applicationId,
    agent: "application",
    mode: "workflow_discovery",
    goal: "Observe confirmation",
    seedEvidenceIds: [],
    questions: ["Is confirmation shown?"],
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
    budget: {
      toolCalls: 10,
      contentBytes: 100_000,
      documentBytes: 0,
      documentPages: 0,
      documentSections: 0,
      sourceLines: 0,
      repositoryBytes: 0,
      repositoryFiles: 0,
      browserActions: 10,
      modelCalls: 10,
      modelInputTokens: 10_000,
      modelOutputTokens: 10_000,
      reconciliationRounds: 0,
      elapsedMs: 30_000,
    },
    successCriteria: ["Confirmation shown"],
    ...overrides,
  })
}

function observation(runId = applicationRunId): BrowserObservation {
  return browserObservationSchema.parse({
    schemaVersion: 1,
    evidenceId: `evidence:v1:${"c".repeat(64)}`,
    applicationId,
    runId,
    url: "https://fixture.test/",
    normalizedRoute: "/",
    title: "Home",
    headings: ["Home"],
    controls: [],
    dialogs: [],
    selectedText: [],
    candidates: [],
    stateFingerprint: `sha256:${"d".repeat(64)}`,
    errors: [],
    observedAt: "2026-09-08T00:00:00.000Z",
  })
}

class CountingBrowser implements ApplicationBrowserRuntime<{
  readonly applicationId: string
  readonly runId: string
  readonly entryUrl: string
  readonly policy: { readonly allowedOrigins: readonly string[] }
}> {
  starts = 0
  actions = 0

  async startRun(): Promise<BrowserObservation> {
    this.starts += 1
    return observation()
  }

  async observe(): Promise<BrowserObservation> {
    return observation()
  }

  async performAction(): Promise<BrowserTransitionEvidence> {
    this.actions += 1
    throw new Error("No action was configured")
  }

  createRecoveryRecipe(): BrowserRecoveryRecipe {
    return browserRecoveryRecipeSchema.parse({
      schemaVersion: 1,
      applicationId,
      sourceRunId: applicationRunId,
      entryUrl: "https://fixture.test/",
      steps: [],
      createdAt: "2026-09-08T00:00:00.000Z",
    })
  }

  async replay(): Promise<{
    readonly finalObservation: BrowserObservation
    readonly transitions: readonly BrowserTransitionEvidence[]
  }> {
    return { finalObservation: observation(), transitions: [] }
  }

  async completeRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
  isActive(): boolean {
    return false
  }
}

const unusedPlanner: ApplicationExplorerPlannerGateway = {
  async generateStructured() {
    throw new Error("Planner must not be called")
  },
}

describe("Application Explorer specialist composition contracts", () => {
  it("defines four strict, described application-only tools for every mode", () => {
    const browser = new CountingBrowser()
    const definitions = createApplicationExplorerSpecialistToolDefinitions({
      browser,
      store: new InMemoryApplicationExplorerSpecialistStoreForTesting(),
      resolveMissionContext: (selectedMission) => ({
        browserOptions: {
          applicationId: selectedMission.applicationId,
          runId: selectedMission.runId,
          entryUrl: "https://fixture.test/",
          policy: { allowedOrigins: ["https://fixture.test"] },
        },
      }),
      now: () => new Date("2026-09-08T00:00:00.000Z"),
    })

    expect(definitions.map((definition) => definition.name)).toEqual([
      "observe_page",
      "perform_observed_action",
      "navigate_history",
      "finish_application_mission",
    ])
    for (const definition of definitions) {
      expect(definition.description.length).toBeGreaterThan(20)
      expect(definition.agents).toEqual(["application"])
      expect(definition.modes).toEqual(APPLICATION_EXPLORER_MODES)
    }
    expect(() =>
      definitions[1]?.parseArguments({
        observationEvidenceId: `evidence:v1:${"c".repeat(64)}`,
        stateFingerprint: `sha256:${"d".repeat(64)}`,
        actionId: `action:v1:${"e".repeat(64)}`,
        selector: "#forbidden",
      })
    ).toThrow()
  })

  it("keeps legacy tools application-only", async () => {
    const browser = new CountingBrowser()
    const codeMission = discoveryMissionSchema.parse({
      ...mission(),
      agent: "code",
      mode: "implementation_trace",
    })
    await expect(
      new ApplicationExplorerTools(browser).observePage(codeMission, {
        schemaVersion: 1,
        missionId: codeMission.id,
        runId: codeMission.runId,
        tool: "observe_page",
        reasonCode: "test",
        summary: "Observe",
      })
    ).rejects.toMatchObject({ code: "mission_mismatch" })
  })

  it("does not start the legacy browser without observe permission or budget", async () => {
    const options = {
      applicationId,
      runId: applicationRunId,
      entryUrl: "https://fixture.test/",
      policy: { allowedOrigins: ["https://fixture.test"] },
    }

    const deniedBrowser = new CountingBrowser()
    await expect(
      createApplicationExplorer({
        browser: deniedBrowser,
        planner: unusedPlanner,
      }).run({
        mission: mission({
          scope: {
            ...mission().scope,
            allowedTools: ["finish_application_mission"],
          },
        }),
        browserOptions: options,
      })
    ).rejects.toMatchObject({ code: "tool_not_allowed" })
    expect(deniedBrowser.starts).toBe(0)

    const budgetBrowser = new CountingBrowser()
    await expect(
      createApplicationExplorer({
        browser: budgetBrowser,
        planner: unusedPlanner,
      }).run({
        mission: mission({
          budget: { ...mission().budget, toolCalls: 0 },
        }),
        browserOptions: options,
      })
    ).rejects.toMatchObject({ code: "budget_exhausted" })
    expect(budgetBrowser.starts).toBe(0)
  })
})
