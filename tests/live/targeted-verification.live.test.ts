import {
  BoundedUrlReadinessProbe,
  DeploymentValidationService,
  PublicDeploymentReadinessProbe,
  RenderApiDeploymentAttestor,
  createPlaywrightBrowserEvidenceRuntime,
  type BrowserArtifactSink,
} from "@sentinel/adapters"
import {
  applicationExplorerPlannerContextSchema,
  artifactIdSchema,
  deploymentRegistrationSchema,
  deploymentValidationRequestSchema,
  hashCanonical,
  verificationMissionPlanSchema,
  verificationSetupReceiptSchema,
  type ApplicationExplorerPlannerContext,
  type ArtifactId,
} from "@sentinel/contracts"
import {
  ApplicationExplorerVerificationExecutor,
  createApplicationExplorer,
  evaluateVerificationMission,
  type ApplicationExplorerPlannerGateway,
  type ApplicationExplorerVerificationSession,
  type VerificationExecutionCache,
} from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"
import type { z } from "zod"

const enabled = process.env["RUN_HIEVENTS_TARGETED_VERIFICATION"] === "1"
const describeHiEvents = enabled ? describe : describe.skip
const applicationId = `application:v1:${"7".repeat(64)}`
const missionId = `mission:v1:${"8".repeat(64)}`
const runId = "run:17171717-1717-4717-8717-171717171717"
const assessmentId = "17171717-1717-4717-8717-171717171718"
const pullRequestId = `pull-request:v1:${"9".repeat(64)}`
const timestamp = "2026-09-09T10:00:00.000Z"

class MemoryArtifacts implements BrowserArtifactSink {
  private count = 0

  async persist(): Promise<ArtifactId> {
    this.count += 1
    return artifactIdSchema.parse(
      `artifact:v1:${this.count.toString(16).padStart(64, "0")}`
    )
  }
}

class ReachabilityPlanner implements ApplicationExplorerPlannerGateway {
  readonly contexts: ApplicationExplorerPlannerContext[] = []

  async generateStructured<Output>(request: {
    readonly input: string
    readonly schema: z.ZodType<Output>
  }) {
    const context = applicationExplorerPlannerContextSchema.parse(
      JSON.parse(request.input)
    )
    this.contexts.push(context)
    return {
      output: request.schema.parse({
        schemaVersion: 1,
        missionId,
        runId,
        tool: "finish_application_mission",
        reasonCode: "trusted_head_reachable",
        summary: "The trusted Hi.Events head exposed a browser document",
        terminal: {
          schemaVersion: 1,
          classification: "goal_completed",
          status: "complete",
          reasonCode: "trusted_head_reachable",
          summary: "The trusted Hi.Events head exposed a browser document",
        },
      }),
      model: "deterministic-live-smoke",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }
  }
}

describeHiEvents("trusted Hi.Events head verification", () => {
  it("attests, explores, evaluates, and closes one exact Render head", async () => {
    const required = [
      "RENDER_API_KEY",
      "RENDER_SERVICE_ID",
      "RENDER_DEPLOY_ID",
      "HIEVENTS_EXPECTED_HEAD_SHA",
      "HIEVENTS_VERIFICATION_URL",
    ] as const
    for (const key of required) {
      if (process.env[key] === undefined) {
        throw new Error(`RUN_HIEVENTS_TARGETED_VERIFICATION=1 requires ${key}`)
      }
    }
    const publicUrl = process.env["HIEVENTS_VERIFICATION_URL"]!
    const parsedUrl = new URL(publicUrl)
    const headSha = process.env["HIEVENTS_EXPECTED_HEAD_SHA"]!
    const compatibilityFingerprint = `sha256:${"a".repeat(64)}`
    const registration = deploymentRegistrationSchema.parse({
      schemaVersion: 1,
      id: `sha256:${"b".repeat(64)}`,
      policyVersion: "deployment-identity-policy-v1",
      applicationId,
      repository: {
        host: "github.com",
        owner: process.env["HIEVENTS_REPOSITORY_OWNER"] ?? "mohit-nagaraj",
        name: process.env["HIEVENTS_REPOSITORY_NAME"] ?? "Hi.Events",
      },
      role: "pr_head",
      commitSha: headSha,
      publicUrl,
      healthPath: process.env["HIEVENTS_HEALTH_PATH"] ?? "/",
      provider: {
        kind: "render",
        serviceId: process.env["RENDER_SERVICE_ID"],
        deployId: process.env["RENDER_DEPLOY_ID"],
      },
      compatibility: {
        fingerprint: compatibilityFingerprint,
        authenticationRevision: 0,
        authenticationReferences: [],
        allowedOrigins: [parsedUrl.origin],
        policyFingerprint: `sha256:${"c".repeat(64)}`,
      },
      registeredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      cleanupBy: "2030-01-02T00:00:00.000Z",
    })
    const validationRequest = deploymentValidationRequestSchema.parse({
      schemaVersion: 1,
      applicationId,
      purpose: "pr_head_verification",
      assessmentId,
      pullRequestId,
      expectedRepository: registration.repository,
      expectedCommitSha: headSha,
      expectedCompatibilityFingerprint: compatibilityFingerprint,
      registration,
    })
    const validation = await new DeploymentValidationService({
      attestor: new RenderApiDeploymentAttestor({
        apiKey: process.env["RENDER_API_KEY"]!,
      }),
      readiness: new PublicDeploymentReadinessProbe(
        new BoundedUrlReadinessProbe()
      ),
    }).validate(validationRequest)
    expect(validation.browserAccessAllowed).toBe(true)

    const checkpoint = {
      id: `sha256:${"d".repeat(64)}`,
      kind: "reachability" as const,
      sourceEntityId: `workflow:v1:${"e".repeat(64)}`,
      operator: "present" as const,
      description: "The trusted Hi.Events head is browser reachable",
    }
    const budget = {
      toolCalls: 2,
      contentBytes: 128_000,
      documentBytes: 0,
      documentPages: 0,
      documentSections: 0,
      sourceLines: 0,
      repositoryBytes: 0,
      repositoryFiles: 0,
      browserActions: 0,
      modelCalls: 1,
      modelInputTokens: 4_000,
      modelOutputTokens: 500,
      reconciliationRounds: 0,
      elapsedMs: 60_000,
    }
    const plan = verificationMissionPlanSchema.parse({
      kind: "affected",
      mission: {
        schemaVersion: 1,
        id: missionId,
        runId,
        applicationId,
        agent: "application",
        mode: "pr_change_validation",
        goal: "Observe the exact trusted Hi.Events PR head",
        seedEvidenceIds: [],
        questions: ["Is the selected head browser reachable?"],
        scope: {
          repositoryPaths: [],
          sourceUris: [],
          allowedHosts: [parsedUrl.hostname],
          allowedTools: [
            "observe_page",
            "perform_observed_action",
            "navigate_history",
            "finish_application_mission",
          ],
        },
        budget,
        successCriteria: [checkpoint.description],
      },
      findingIds: [`sha256:${"f".repeat(64)}`],
      scenarioIds: [`sha256:${"1".repeat(64)}`],
      targetIds: [checkpoint.sourceEntityId],
      priority: "high",
      entryPath: parsedUrl.pathname,
      setup: {
        method: "none",
        classification: "outside_blast_radius",
        relatedEntityIds: [],
      },
      checkpoints: [checkpoint],
      exclusions: ["No state-changing action is allowed in the live smoke"],
    })
    const planner = new ReachabilityPlanner()
    const runtime = createPlaywrightBrowserEvidenceRuntime({
      artifacts: new MemoryArtifacts(),
      inputResolver: {
        async resolve() {
          throw new Error("The reachability smoke does not enter form values")
        },
      },
    })
    const explorer = createApplicationExplorer({ browser: runtime, planner })
    const session: ApplicationExplorerVerificationSession = {
      run: async ({ allowedOrigins, entryUrl, phase, plan }, signal) => {
        void signal
        const output = await explorer.run({
          mission: plan.mission,
          browserOptions: {
            applicationId,
            runId,
            entryUrl,
            policy: {
              allowedOrigins,
              budgets: { maxActions: 1, maxDurationMs: 60_000 },
            },
            traceOnFailure: true,
          },
        })
        return {
          explorer: output,
          checkpointObservations: [
            {
              schemaVersion: 1,
              checkpointId: checkpoint.id,
              kind: "reachability",
              reachable: true,
              normalizedRoute: parsedUrl.pathname,
              evidenceIds: [output.checkpoint.currentObservationEvidenceId],
              observedAt: timestamp,
            },
          ],
          artifacts:
            output.checkpoint.currentScreenshotArtifactId === undefined
              ? []
              : [
                  {
                    artifactId: output.checkpoint.currentScreenshotArtifactId,
                    kind: "screenshot" as const,
                    purpose: "report" as const,
                    capturedAt: timestamp,
                  },
                ],
          semanticFingerprint: output.checkpoint.currentStateFingerprint,
          modelExplanation: `${phase} reachability observation completed`,
          completedAt: timestamp,
        }
      },
      close: async () => {
        if (runtime.isActive(runId)) await runtime.cancelRun(runId)
      },
    }
    const cacheValues = new Map()
    const cache: VerificationExecutionCache = {
      get: async (key) => cacheValues.get(key) ?? null,
      put: async (key, evidence) => {
        cacheValues.set(key, evidence)
        return evidence
      },
    }
    const evidence = await new ApplicationExplorerVerificationExecutor(
      session,
      cache
    ).execute({
      plan,
      deployment: validation,
      phase: "head",
      idempotencyKey: hashCanonical({ kind: "live-head", headSha }),
    })
    const setupDraft = {
      schemaVersion: 1 as const,
      missionId: plan.mission.id,
      classification: "outside_blast_radius" as const,
      method: "none" as const,
      status: "not_required" as const,
      idempotencyKey: hashCanonical({ kind: "live-setup", headSha }),
      evidenceIds: [],
      artifacts: [],
      cleanupRequired: false,
      reasonCode: "setup_not_required",
      summary: "The public reachability smoke requires no fixture setup",
      preparedAt: timestamp,
    }
    const setup = verificationSetupReceiptSchema.parse({
      ...setupDraft,
      id: hashCanonical(setupDraft),
    })
    const result = evaluateVerificationMission({
      plan,
      setup,
      head: evidence,
      artifactPolicy: {
        successfulRetentionSeconds: 0,
        failureRetentionSeconds: 86_400,
        reportRetentionSeconds: 604_800,
      },
    })
    expect(result.status).toBe("passed")
    expect(runtime.isActive(runId)).toBe(false)
    expect(planner.contexts).toHaveLength(1)
  }, 120_000)
})
