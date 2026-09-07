import {
  createPlaywrightBrowserEvidenceRuntime,
  type BrowserArtifactSink,
} from "@sentinel/adapters"
import {
  applicationExplorerPlannerContextSchema,
  artifactIdSchema,
  discoveryMissionSchema,
  type ApplicationExplorerPlannerContext,
  type ArtifactId,
} from "@sentinel/contracts"
import {
  createApplicationExplorer,
  type ApplicationExplorerPlannerGateway,
} from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"
import type { z } from "zod"

const enabled = process.env["RUN_HIEVENTS_APPLICATION_EXPLORER"] === "1"
const describeHiEvents = enabled ? describe : describe.skip
const applicationId = `application:v1:${"7".repeat(64)}`
const missionId = `mission:v1:${"8".repeat(64)}`
const runId = "run:17171717-1717-4717-8717-171717171717"

class MemoryArtifacts implements BrowserArtifactSink {
  private count = 0

  async persist(): Promise<ArtifactId> {
    this.count += 1
    return artifactIdSchema.parse(
      `artifact:v1:${this.count.toString(16).padStart(64, "0")}`
    )
  }
}

class OneSafeActionPlanner implements ApplicationExplorerPlannerGateway {
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
    const selected =
      this.contexts.length === 1
        ? context.candidates.find(
            ({ candidate }) =>
              candidate.policy.allowed &&
              candidate.policy.replaySafe &&
              candidate.kind !== "back" &&
              candidate.kind !== "reload" &&
              candidate.kind !== "fill" &&
              candidate.kind !== "select"
          )?.candidate
        : undefined
    const output =
      selected === undefined
        ? {
            schemaVersion: 1,
            missionId,
            runId,
            tool: "finish_application_mission",
            reasonCode:
              this.contexts.length === 1
                ? "no_safe_public_action"
                : "public_screen_observed",
            summary:
              this.contexts.length === 1
                ? "No safe public action was available"
                : "Hi.Events public application screen observed",
            terminal: {
              schemaVersion: 1,
              classification:
                this.contexts.length === 1 ? "dead_end" : "goal_completed",
              status: this.contexts.length === 1 ? "partial" : "complete",
              reasonCode:
                this.contexts.length === 1
                  ? "no_safe_public_action"
                  : "public_screen_observed",
              summary:
                this.contexts.length === 1
                  ? "No safe public action was available"
                  : "Hi.Events public application screen observed",
            },
          }
        : {
            schemaVersion: 1,
            missionId,
            runId,
            tool: "perform_observed_action",
            observationEvidenceId: context.observation.evidenceId,
            stateFingerprint: context.observation.stateFingerprint,
            actionId: selected.actionId,
            reasonCode: "safe_public_observation",
            summary: `Observe ${selected.name ?? selected.kind}`,
          }
    return {
      output: request.schema.parse(output),
      model: "deterministic-live-smoke",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }
  }
}

describeHiEvents("Hi.Events Application Explorer smoke", () => {
  it("observes one explicitly configured trusted deployment", async () => {
    const entryUrl = process.env["HIEVENTS_APPLICATION_EXPLORER_URL"]
    if (entryUrl === undefined || entryUrl.trim().length === 0) {
      throw new Error(
        "RUN_HIEVENTS_APPLICATION_EXPLORER=1 requires HIEVENTS_APPLICATION_EXPLORER_URL"
      )
    }
    const parsedEntry = new URL(entryUrl)
    const extraOrigins = (
      process.env["HIEVENTS_APPLICATION_EXPLORER_ALLOWED_ORIGINS"] ?? ""
    )
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
    const allowedOrigins = [...new Set([parsedEntry.origin, ...extraOrigins])]
    const allowInsecureLocalhost = ["127.0.0.1", "localhost", "[::1]"].includes(
      parsedEntry.hostname
    )
    const planner = new OneSafeActionPlanner()
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          throw new Error("The Hi.Events smoke does not enter form values")
        },
      },
    })
    const mission = discoveryMissionSchema.parse({
      schemaVersion: 1,
      id: missionId,
      runId,
      applicationId,
      agent: "application",
      mode: "targeted_requirement_observation",
      goal: "Observe public Hi.Events event discovery",
      seedEvidenceIds: [],
      questions: ["Which public event discovery screen is available?"],
      scope: {
        repositoryPaths: [],
        sourceUris: [],
        allowedHosts: [parsedEntry.hostname],
        allowedTools: [
          "observe_page",
          "perform_observed_action",
          "navigate_history",
          "finish_application_mission",
        ],
      },
      budget: {
        toolCalls: 4,
        contentBytes: 250_000,
        documentBytes: 0,
        documentPages: 0,
        documentSections: 0,
        sourceLines: 0,
        repositoryBytes: 0,
        repositoryFiles: 0,
        browserActions: 1,
        modelCalls: 2,
        modelInputTokens: 5_000,
        modelOutputTokens: 1_000,
        reconciliationRounds: 0,
        elapsedMs: 90_000,
      },
      successCriteria: ["Capture a sanitized public browser observation"],
    })

    const output = await createApplicationExplorer({
      browser: runtime,
      planner,
    }).run({
      mission,
      browserOptions: {
        applicationId,
        runId,
        entryUrl: parsedEntry.toString(),
        policy: {
          allowedOrigins,
          allowInsecureLocalhost,
          budgets: { maxActions: 1, maxDurationMs: 90_000 },
        },
        traceOnFailure: true,
      },
      capabilityHintLabels: ["events", "tickets", "registration"],
      requirementHintLabels: ["public event discovery"],
    })

    expect(output.result.status).not.toBe("failed")
    expect(output.checkpoint.currentScreenshotArtifactId).toMatch(
      /^artifact:v1:/
    )
    expect(planner.contexts[0]?.observation.untrustedPageContent.trust).toBe(
      "untrusted"
    )
  }, 120_000)
})
