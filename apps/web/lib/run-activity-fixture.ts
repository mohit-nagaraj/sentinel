import "server-only"

import {
  createEventId,
  databaseRunIdSchema,
  pageLimitSchema,
  publicRunInterruptSchema,
  publicRunSchema,
  runCommandSchema,
  runEventSchema,
  runIdSchema,
  type PublicRun,
  type PublicRunInterrupt,
  type RunEvent,
} from "@sentinel/contracts"
import { RunControlRepositoryError } from "@sentinel/storage"
import { z } from "zod"

import { RunActivityConfigurationError } from "./run-control"

export const ACTIVITY_FIXTURE_RUN_ID = "00000000-0000-4000-8000-000000000024"
export const ACTIVITY_FIXTURE_APPLICATION_ID =
  "00000000-0000-4000-8000-000000000124"
export const ACTIVITY_FIXTURE_ASSESSMENT_ID =
  "00000000-0000-4000-8000-000000000029"
export const ACTIVITY_FIXTURE_SCREENSHOT_ID = `artifact:v1:${"a".repeat(64)}`

const contractRunId = runIdSchema.parse(`run:${ACTIVITY_FIXTURE_RUN_ID}`)
const missionIds = {
  documentation: `mission:v1:${"1".repeat(64)}`,
  code: `mission:v1:${"2".repeat(64)}`,
  application: `mission:v1:${"3".repeat(64)}`,
} as const

function common(sequence: number) {
  return {
    schemaVersion: 1 as const,
    id: createEventId(contractRunId, sequence),
    runId: contractRunId,
    sequence,
    occurredAt: `2026-09-09T04:00:${String(sequence).padStart(2, "0")}.000Z`,
    graphName: "synthetic_parallel_assessment",
    evidenceIds: [],
  }
}

function initialEvents(): readonly RunEvent[] {
  return [
    runEventSchema.parse({
      ...common(1),
      kind: "mission_started",
      agent: "documentation",
      missionId: missionIds.documentation,
      status: "started",
      summary: "Mapping the checkout contract",
      reasonCode: "documentation_mapping_started",
      activity: {
        category: "decision",
        detail:
          "Compare the stated checkout flow with source and observed behavior.",
      },
    }),
    runEventSchema.parse({
      ...common(2),
      kind: "mission_started",
      agent: "code",
      missionId: missionIds.code,
      status: "started",
      summary: "Tracing checkout implementation",
      reasonCode: "code_trace_started",
      activity: {
        category: "tool",
        detail:
          "Index route handlers and client transitions for the checkout path.",
      },
    }),
    runEventSchema.parse({
      ...common(3),
      kind: "mission_started",
      agent: "application",
      missionId: missionIds.application,
      status: "started",
      summary: "Observing checkout behavior",
      reasonCode: "application_observation_started",
      activity: {
        category: "action",
        detail: "Advance only through the configured non-payment fixture flow.",
      },
    }),
  ]
}

function completedEvents(startSequence = 4): readonly RunEvent[] {
  const sequence = (original: number) => startSequence + original - 4
  return [
    runEventSchema.parse({
      ...common(sequence(4)),
      kind: "mission_completed",
      agent: "documentation",
      missionId: missionIds.documentation,
      status: "completed",
      summary: "Checkout review step is documented",
      reasonCode: "documentation_checkout_review_found",
      evidenceIds: [`evidence:v1:${"4".repeat(64)}`],
      activity: { category: "coverage", coverageDelta: 1 },
    }),
    runEventSchema.parse({
      ...common(sequence(5)),
      kind: "tool_completed",
      agent: "application",
      missionId: missionIds.application,
      toolName: "browser_observe_transition",
      status: "completed",
      summary: "Checkout advanced to review",
      reasonCode: "application_checkout_review_observed",
      evidenceIds: [`evidence:v1:${"5".repeat(64)}`],
      activity: {
        category: "action",
        detail:
          "The review state appeared without a payment or external message.",
        action: {
          kind: "advance_checkout",
          label: "Advance checkout to review",
          status: "completed",
        },
        request: { method: "POST", route: "/api/checkout/review", status: 200 },
        screenshotArtifactId: ACTIVITY_FIXTURE_SCREENSHOT_ID,
      },
    }),
    runEventSchema.parse({
      ...common(sequence(6)),
      kind: "mission_completed",
      agent: "code",
      missionId: missionIds.code,
      status: "completed",
      summary: "Review transition matches the route handler",
      reasonCode: "code_checkout_transition_matched",
      evidenceIds: [`evidence:v1:${"6".repeat(64)}`],
      activity: {
        category: "request",
        request: { method: "POST", route: "/api/checkout/review", status: 200 },
        coverageDelta: 1,
      },
    }),
    runEventSchema.parse({
      ...common(sequence(7)),
      kind: "node_completed",
      agent: "curator",
      nodeName: "reconcile_checkout_evidence",
      status: "completed",
      summary: "Checkout review behavior reconciled",
      reasonCode: "checkout_review_reconciled",
      evidenceIds: [
        `evidence:v1:${"4".repeat(64)}`,
        `evidence:v1:${"5".repeat(64)}`,
        `evidence:v1:${"6".repeat(64)}`,
      ],
      activity: {
        category: "policy",
        detail: "Documentation, implementation, and runtime evidence agree.",
        action: {
          kind: "accept_checkout_behavior",
          label: "Accept reconciled checkout behavior",
          status: "allowed",
        },
        coverageDelta: 3,
      },
    }),
    runEventSchema.parse({
      ...common(sequence(8)),
      kind: "budget_updated",
      status: "completed",
      summary: "Browser action budget updated",
      reasonCode: "browser_action_budget_updated",
      budget: { consumed: 6, limit: 20, unit: "browser_actions" },
    }),
    runEventSchema.parse({
      ...common(sequence(9)),
      kind: "run_status",
      status: "succeeded",
      summary: "Parallel assessment completed",
      reasonCode: "parallel_assessment_completed",
    }),
  ]
}

interface ActivityFixtureState {
  run: PublicRun
  events: RunEvent[]
  interrupt: PublicRunInterrupt | null
  screenshot?: ArrayBuffer
}

const globalState = globalThis as typeof globalThis & {
  __sentinelActivityFixture?: ActivityFixtureState
}

function newRun(): PublicRun {
  return publicRunSchema.parse({
    schemaVersion: 1,
    id: ACTIVITY_FIXTURE_RUN_ID,
    applicationId: ACTIVITY_FIXTURE_APPLICATION_ID,
    type: "assess_pr",
    status: "running",
    attemptCount: 0,
    createdAt: "2026-09-09T04:00:00.000Z",
    startedAt: "2026-09-09T04:00:00.000Z",
  })
}

function state(): ActivityFixtureState {
  return (globalState.__sentinelActivityFixture ??= {
    run: newRun(),
    events: [...initialEvents()],
    interrupt: null,
  })
}

function updateRun(
  input: Record<string, unknown>,
  remove: readonly string[] = []
) {
  const next = { ...state().run, ...input } as Record<string, unknown>
  for (const key of remove) delete next[key]
  state().run = publicRunSchema.parse(next)
}

function appendStatus(status: "cancelled" | "running", reasonCode: string) {
  const sequence = state().events.length + 1
  state().events.push(
    runEventSchema.parse({
      ...common(sequence),
      kind: "run_status",
      status,
      summary:
        status === "cancelled" ? "Run stopped by operator" : "Run resumed",
      reasonCode,
    })
  )
}

export function resetActivityFixture(): void {
  globalState.__sentinelActivityFixture = {
    run: newRun(),
    events: [...initialEvents()],
    interrupt: null,
  }
}

export function advanceActivityFixture(): void {
  const current = state()
  if (current.run.status === "succeeded") return
  if (current.run.pauseRequestedAt !== undefined) {
    updateRun({ status: "interrupted" }, ["pauseRequestedAt", "finishedAt"])
    const sequence = current.events.length + 1
    current.events.push(
      runEventSchema.parse({
        ...common(sequence),
        kind: "interrupt_requested",
        status: "blocked",
        summary: "Run paused at a safe boundary",
        reasonCode: "pause_boundary_reached",
        activity: { category: "policy" },
      })
    )
    current.interrupt = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000224",
      runId: ACTIVITY_FIXTURE_RUN_ID,
      decisionId: "resume_run",
      prompt: "Resume the run from its durable checkpoint" as never,
      status: "pending",
      createdAt: "2026-09-09T04:00:10.000Z",
    }
    return
  }
  if (current.run.status !== "running") return
  current.events.push(...completedEvents(current.events.length + 1))
  updateRun({
    status: "succeeded",
    finishedAt: "2026-09-09T04:00:09.000Z",
    assessmentId: ACTIVITY_FIXTURE_ASSESSMENT_ID,
  })
}

export function storeActivityFixtureScreenshot(body: ArrayBuffer): void {
  const bytes = new Uint8Array(body)
  if (
    bytes.byteLength < 8 ||
    bytes.byteLength > 2_000_000 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value
    )
  ) {
    throw new Error("Fixture screenshot must be a bounded PNG")
  }
  state().screenshot = body.slice(0)
}

export function getActivityFixtureScreenshot(): ArrayBuffer | undefined {
  return state().screenshot?.slice(0)
}

export function getActivityFixtureSnapshot() {
  const current = state()
  return {
    run: current.run,
    eventPage: {
      schemaVersion: 1 as const,
      items: current.events.map((event) => ({
        sequence: event.sequence,
        event,
      })),
    },
    interrupt: current.interrupt,
  }
}

class ActivityFixtureRunControl {
  async command(input: unknown) {
    runCommandSchema.parse(input)
    return { run: state().run, created: false }
  }

  async get(runId: string) {
    return databaseRunIdSchema.parse(runId) === ACTIVITY_FIXTURE_RUN_ID
      ? state().run
      : null
  }

  async list() {
    return { items: [state().run] }
  }

  async events(input: { runId: string; after?: unknown; limit?: unknown }) {
    if (databaseRunIdSchema.parse(input.runId) !== ACTIVITY_FIXTURE_RUN_ID) {
      return null
    }
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse(input.after ?? 0)
    const limit = pageLimitSchema.parse(input.limit)
    const remaining = state().events.filter((event) => event.sequence > after)
    const items = remaining.slice(0, limit).map((event) => ({
      sequence: event.sequence,
      event,
    }))
    return {
      items,
      ...(remaining.length > limit && items.at(-1) !== undefined
        ? { nextCursor: items.at(-1)!.sequence }
        : {}),
    }
  }

  async cancel(runId: string) {
    if ((await this.get(runId)) === null) return null
    if (
      !new Set(["queued", "running", "interrupted"]).has(state().run.status)
    ) {
      throw new RunControlRepositoryError("cancellation_not_allowed")
    }
    updateRun({ status: "cancelled", finishedAt: new Date().toISOString() }, [
      "pauseRequestedAt",
    ])
    appendStatus("cancelled", "operator_cancelled_run")
    return state().run
  }

  async pause(runId: string) {
    if ((await this.get(runId)) === null) {
      throw new RunControlRepositoryError("run_not_found")
    }
    if (!new Set(["queued", "running"]).has(state().run.status)) {
      throw new RunControlRepositoryError("pause_not_allowed")
    }
    updateRun({ pauseRequestedAt: new Date().toISOString() })
    return state().run
  }

  async retry() {
    throw new RunControlRepositoryError("retry_not_allowed")
  }

  async respond(runId: string, decisionId: string, input: unknown) {
    const current = state()
    const pending = current.interrupt
    if ((await this.get(runId)) === null || pending === null) {
      throw new RunControlRepositoryError("interrupt_not_found")
    }
    const response = z
      .strictObject({
        schemaVersion: z.literal(1),
        response: z.strictObject({
          approved: z.boolean(),
          note: z.string().optional(),
        }),
      })
      .parse(input)
    if (decisionId !== pending.decisionId) {
      throw new RunControlRepositoryError("interrupt_not_found")
    }
    const responded = publicRunInterruptSchema.parse({
      ...pending,
      status: "responded" as const,
      respondedAt: new Date().toISOString(),
    })
    if (decisionId === "resume_run" && response.response.approved) {
      current.interrupt = null
      updateRun({ status: "running" }, ["finishedAt", "pauseRequestedAt"])
      appendStatus("running", "operator_resumed_run")
    } else {
      current.interrupt = responded
    }
    return { interrupt: responded, idempotent: false }
  }

  async pendingInterrupt(runId: string) {
    return (await this.get(runId)) === null ? null : state().interrupt
  }

  async readiness() {
    return {
      schemaVersion: 1 as const,
      service: "control-plane" as const,
      status: "ready" as const,
      dependencies: [{ name: "storage" as const, status: "ready" as const }],
    }
  }

  async realtime(): Promise<never> {
    throw new RunActivityConfigurationError()
  }

  async artifact() {
    return null
  }
}

const fixtureService = new ActivityFixtureRunControl()

export function getActivityFixtureRunControlService() {
  return fixtureService
}
