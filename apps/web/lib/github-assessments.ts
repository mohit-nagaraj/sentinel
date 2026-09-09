import "server-only"

import {
  GithubAppClient,
  GithubAppError,
  loadGithubAppConfiguration,
  parseGithubWebhook,
  toManualAssessmentTrigger,
  verifyGithubWebhookSignature,
  type ResolvedGithubPullRequest,
} from "@sentinel/adapters/github-app"
import {
  githubAssessmentResponseSchema,
  githubAssessmentTriggerSchema,
  githubCheckLifecycleSchema,
  manualGithubAssessmentRequestSchema,
  type GithubAssessmentEnqueueResult,
  type GithubAssessmentResponse,
  type GithubAssessmentTrigger,
  type GithubCheckLifecycle,
  type GithubCheckTarget,
} from "@sentinel/contracts"
import {
  createPostgresDatabase,
  GithubAssessmentRepository,
  type ManualGithubAssessmentTarget,
} from "@sentinel/storage"
import { z } from "zod"

export const DEFAULT_GITHUB_ASSESSMENT_BUDGET = Object.freeze({
  toolCalls: 100,
  contentBytes: 1_000_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 250_000,
  repositoryBytes: 1_000_000_000,
  repositoryFiles: 100_000,
  browserActions: 50,
  modelCalls: 50,
  modelInputTokens: 500_000,
  modelOutputTokens: 100_000,
  reconciliationRounds: 5,
  elapsedMs: 3_600_000,
})

export interface GithubAssessmentStore {
  getManualTarget(
    operatorId: string,
    applicationId: string
  ): Promise<ManualGithubAssessmentTarget | null>
  enqueue(
    trigger: GithubAssessmentTrigger | unknown,
    budget: unknown
  ): Promise<GithubAssessmentEnqueueResult>
  claimCheck(
    assessmentId: string,
    headSha: string,
    leaseSeconds?: number
  ): Promise<GithubCheckTarget | null>
  bindCheck(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly syncLeaseToken: string
    readonly checkRunId: string
  }): Promise<boolean>
  releaseCheck(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly syncLeaseToken: string
  }): Promise<boolean>
  getCurrentCheck(
    assessmentId: string,
    headSha: string
  ): Promise<GithubCheckTarget | null>
}

export interface GithubAssessmentProvider {
  resolvePullRequest(input: {
    readonly installationId: string
    readonly pullRequestUrl: string
    readonly expectedRepository?: {
      readonly host: string
      readonly owner: string
      readonly name: string
    }
  }): Promise<ResolvedGithubPullRequest>
  ensureQueuedCheck(target: GithubCheckTarget | unknown): Promise<string>
  assessmentDetailsUrl(assessmentId: string): string
  updateCheck(
    target: GithubCheckTarget | unknown,
    request: unknown
  ): Promise<void>
}

export type GithubAssessmentServiceErrorCode =
  "application_not_found" | "check_sync_failed" | "pull_request_closed"

export class GithubAssessmentServiceError extends Error {
  constructor(readonly code: GithubAssessmentServiceErrorCode) {
    super(code)
    this.name = "GithubAssessmentServiceError"
  }
}

function ignored(
  reason:
    | "unsupported_event"
    | "unsupported_action"
    | "draft_pull_request"
    | "stale_delivery"
): GithubAssessmentResponse {
  return githubAssessmentResponseSchema.parse({
    schemaVersion: 1,
    status: "ignored",
    reason,
  })
}

export class GithubAssessmentService {
  constructor(
    private readonly store: GithubAssessmentStore,
    private readonly provider: GithubAssessmentProvider,
    private readonly webhookSecret: string,
    private readonly budget: unknown = DEFAULT_GITHUB_ASSESSMENT_BUDGET
  ) {
    if (webhookSecret.length < 32 || webhookSecret.length > 4_096) {
      throw new GithubAppError(
        "configuration_invalid",
        "GitHub webhook configuration is invalid"
      )
    }
  }

  async receiveWebhook(input: {
    readonly body: Uint8Array
    readonly signature: string | null
    readonly deliveryId: string | null
    readonly event: string | null
  }): Promise<GithubAssessmentResponse> {
    if (
      !verifyGithubWebhookSignature(
        input.body,
        input.signature,
        this.webhookSecret
      )
    ) {
      throw new GithubAppError(
        "signature_invalid",
        "GitHub webhook signature is invalid"
      )
    }
    const decision = parseGithubWebhook(input.body, {
      deliveryId: input.deliveryId,
      event: input.event,
    })
    if (decision.kind === "ignored") return ignored(decision.reason)
    const resolved = await this.provider.resolvePullRequest({
      installationId: decision.trigger.installationId,
      pullRequestUrl: decision.trigger.pullRequestUrl,
      expectedRepository: decision.trigger.repository,
    })
    if (
      resolved.state !== "open" ||
      resolved.headSha !== decision.trigger.headSha
    ) {
      return ignored("stale_delivery")
    }
    if (resolved.draft) return ignored("draft_pull_request")
    if (
      resolved.repositoryId !== decision.trigger.repositoryId ||
      resolved.pullRequestId !== decision.trigger.pullRequestId ||
      resolved.pullRequestNumber !== decision.trigger.pullRequestNumber
    ) {
      throw new GithubAppError(
        "payload_invalid",
        "GitHub webhook and current pull request identities differ"
      )
    }
    return this.enqueue({
      ...decision.trigger,
      pullRequestUrl: resolved.pullRequestUrl,
      baseSha: resolved.baseSha,
      headSha: resolved.headSha,
      providerUpdatedAt: resolved.providerUpdatedAt,
    })
  }

  async submitManual(
    operatorIdInput: string,
    requestInput: unknown
  ): Promise<GithubAssessmentResponse> {
    const operatorId = z.uuid().parse(operatorIdInput)
    const request = manualGithubAssessmentRequestSchema.parse(requestInput)
    const target = await this.store.getManualTarget(
      operatorId,
      request.applicationId
    )
    if (target === null) {
      throw new GithubAssessmentServiceError("application_not_found")
    }
    const resolved = await this.provider.resolvePullRequest({
      installationId: target.installationId,
      pullRequestUrl: request.pullRequestUrl,
      expectedRepository: target.repository,
    })
    if (resolved.state !== "open") {
      throw new GithubAssessmentServiceError("pull_request_closed")
    }
    if (resolved.draft) return ignored("draft_pull_request")
    return this.enqueue(
      toManualAssessmentTrigger({
        resolved,
        applicationId: target.applicationId,
        operatorId,
      })
    )
  }

  async publishCheck(input: {
    readonly assessmentId: string
    readonly headSha: string
    readonly lifecycle: GithubCheckLifecycle | unknown
  }): Promise<boolean> {
    const assessmentId = z.uuid().parse(input.assessmentId)
    const lifecycle = githubCheckLifecycleSchema.parse(input.lifecycle)
    let target = await this.store.getCurrentCheck(assessmentId, input.headSha)
    if (target === null) return false
    if (target.checkRunId === null) {
      const synchronized = await this.synchronizeQueuedCheck({
        assessmentId,
        headSha: target.headSha,
        checkRunId: null,
      })
      if (synchronized === "sync_pending") return false
      target = await this.store.getCurrentCheck(assessmentId, input.headSha)
      if (target === null || target.checkRunId === null) return false
    }
    await this.provider.updateCheck(target, {
      schemaVersion: 1,
      assessmentId,
      headSha: target.headSha,
      detailsUrl: this.provider.assessmentDetailsUrl(assessmentId),
      lifecycle,
    })
    return true
  }

  private async enqueue(
    triggerInput: GithubAssessmentTrigger | unknown
  ): Promise<GithubAssessmentResponse> {
    const trigger = githubAssessmentTriggerSchema.parse(triggerInput)
    const result = await this.store.enqueue(trigger, this.budget)
    if (result.disposition === "stale" || result.runId === null) {
      return ignored("stale_delivery")
    }

    const check = await this.synchronizeQueuedCheck(result)
    return githubAssessmentResponseSchema.parse({
      schemaVersion: 1,
      status: "accepted",
      assessmentId: result.assessmentId,
      runId: result.runId,
      headSha: result.headSha,
      duplicate: result.disposition === "duplicate",
      check,
    })
  }

  private async synchronizeQueuedCheck(
    result: Pick<
      GithubAssessmentEnqueueResult,
      "assessmentId" | "headSha" | "checkRunId"
    >
  ): Promise<"queued" | "sync_pending"> {
    if (result.checkRunId !== null) return "queued"
    const target = await this.store.claimCheck(
      result.assessmentId,
      result.headSha
    )
    if (target === null || target.syncLeaseToken === null) {
      return "sync_pending"
    }
    try {
      const checkRunId = await this.provider.ensureQueuedCheck(target)
      const bound = await this.store.bindCheck({
        assessmentId: target.assessmentId,
        headSha: target.headSha,
        syncLeaseToken: target.syncLeaseToken,
        checkRunId,
      })
      if (bound) return "queued"
      await this.store.releaseCheck({
        assessmentId: target.assessmentId,
        headSha: target.headSha,
        syncLeaseToken: target.syncLeaseToken,
      })
      return "sync_pending"
    } catch (error) {
      await this.store.releaseCheck({
        assessmentId: target.assessmentId,
        headSha: target.headSha,
        syncLeaseToken: target.syncLeaseToken,
      })
      if (error instanceof GithubAppError) throw error
      throw new GithubAssessmentServiceError("check_sync_failed")
    }
  }
}

interface GithubAssessmentGlobalState {
  service?: Promise<GithubAssessmentService>
}

const globalState = globalThis as typeof globalThis & {
  __sentinelGithubAssessments?: GithubAssessmentGlobalState
}

export function getGithubAssessmentService(): Promise<GithubAssessmentService> {
  const state = (globalState.__sentinelGithubAssessments ??= {})
  state.service ??= loadGithubAppConfiguration(process.env).then(
    (configuration) => {
      const databaseUrl = z
        .url({ protocol: /^postgres(?:ql)?$/ })
        .safeParse(process.env["SUPABASE_DB_URL"])
      if (!databaseUrl.success) {
        throw new GithubAppError(
          "configuration_invalid",
          "GitHub assessment database configuration is invalid"
        )
      }
      const database = createPostgresDatabase(databaseUrl.data)
      return new GithubAssessmentService(
        new GithubAssessmentRepository(database),
        new GithubAppClient(configuration),
        configuration.webhookSecret
      )
    }
  )
  return state.service
}
