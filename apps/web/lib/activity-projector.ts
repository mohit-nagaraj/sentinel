import { runEventSchema, type RunEvent } from "@sentinel/contracts"

export type ActivityLane = "documentation" | "code" | "application" | "curator"
export type ActivityCategory =
  | "decision"
  | "policy"
  | "tool"
  | "action"
  | "transition"
  | "request"
  | "coverage"
  | "status"

export interface ActivityViewModel {
  readonly sequence: number
  readonly lane: ActivityLane
  readonly category: ActivityCategory
  readonly categoryLabel: string
  readonly summary: string
  readonly detail?: string
  readonly reasonCode: string
  readonly occurredAt: string
  readonly status: string
  readonly toolName?: string
  readonly action?: NonNullable<RunEvent["activity"]>["action"]
  readonly request?: NonNullable<RunEvent["activity"]>["request"]
  readonly evidenceGain: number
  readonly coverageDelta?: number
  readonly screenshotArtifactId?: string
  readonly budget?: NonNullable<RunEvent["budget"]>
}

export interface ActivityProjection {
  readonly lanes: Readonly<Record<ActivityLane, readonly ActivityViewModel[]>>
  readonly budgets: readonly NonNullable<RunEvent["budget"]>[]
  readonly storyboard: readonly ActivityViewModel[]
}

const categoryLabels: Readonly<Record<ActivityCategory, string>> = {
  decision: "Decision",
  policy: "Policy result",
  tool: "Tool execution",
  action: "Browser action",
  transition: "Workflow transition",
  request: "Network request",
  coverage: "Evidence result",
  status: "Run status",
}

function defaultCategory(event: RunEvent): ActivityCategory {
  switch (event.kind) {
    case "tool_started":
    case "tool_completed":
      return "tool"
    case "evidence_gained":
      return "coverage"
    case "interrupt_requested":
    case "interrupt_resumed":
      return "policy"
    case "node_started":
    case "node_completed":
    case "mission_started":
    case "mission_completed":
      return "transition"
    case "run_status":
    case "budget_updated":
    case "warning":
    case "error":
      return "status"
  }
}

function laneFor(event: RunEvent): ActivityLane {
  if (
    event.agent === "documentation" ||
    event.agent === "code" ||
    event.agent === "application"
  ) {
    return event.agent
  }
  return "curator"
}

function eventStatus(event: RunEvent): string {
  if (event.activity?.action?.status === "failed") return "failed"
  return event.status
}

export function projectActivityEvent(input: unknown): ActivityViewModel {
  const event = runEventSchema.parse(input)
  const category = event.activity?.category ?? defaultCategory(event)
  const actionFailed = event.activity?.action?.status === "failed"
  return {
    sequence: event.sequence,
    lane: laneFor(event),
    category,
    categoryLabel: categoryLabels[category],
    summary:
      actionFailed && event.toolName === "submit_requirement_claim"
        ? "Requirement claim rejected"
        : event.summary,
    ...(event.activity?.detail === undefined
      ? {}
      : { detail: event.activity.detail }),
    reasonCode: event.reasonCode,
    occurredAt: event.occurredAt,
    status: eventStatus(event),
    ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
    ...(event.activity?.action === undefined
      ? {}
      : { action: event.activity.action }),
    ...(event.activity?.request === undefined
      ? {}
      : { request: event.activity.request }),
    evidenceGain: actionFailed ? 0 : event.evidenceIds.length,
    ...(event.activity?.coverageDelta === undefined || actionFailed
      ? {}
      : { coverageDelta: event.activity.coverageDelta }),
    ...(event.activity?.screenshotArtifactId === undefined
      ? {}
      : { screenshotArtifactId: event.activity.screenshotArtifactId }),
    ...(event.budget === undefined ? {} : { budget: event.budget }),
  }
}

export function projectActivityFeed(
  events: readonly RunEvent[]
): ActivityProjection {
  const sortedEvents = [...events].sort(
    (left, right) => left.sequence - right.sequence
  )
  const projected = sortedEvents.map(projectActivityEvent)
  const lanes: Record<ActivityLane, ActivityViewModel[]> = {
    documentation: [],
    code: [],
    application: [],
    curator: [],
  }
  const runBudgets = new Map<string, NonNullable<RunEvent["budget"]>>()
  const missionBudgets = new Map<string, NonNullable<RunEvent["budget"]>>()
  for (const [index, item] of projected.entries()) {
    lanes[item.lane].push(item)
    const source = sortedEvents[index]
    const eventBudget = source?.budget
    if (eventBudget !== undefined) {
      if (source.missionId === undefined) {
        runBudgets.set(eventBudget.unit, eventBudget)
      } else {
        missionBudgets.set(
          `${source.missionId}:${eventBudget.unit}`,
          eventBudget
        )
      }
    }
    projected[index] = item
  }
  const missionTotals = new Map<string, NonNullable<RunEvent["budget"]>>()
  for (const budget of missionBudgets.values()) {
    const current = missionTotals.get(budget.unit)
    missionTotals.set(budget.unit, {
      unit: budget.unit,
      consumed: (current?.consumed ?? 0) + budget.consumed,
      limit: (current?.limit ?? 0) + budget.limit,
    })
  }
  const budgetUnits = [
    ...new Set([...missionTotals.keys(), ...runBudgets.keys()]),
  ].sort()
  return {
    lanes,
    budgets: budgetUnits.map((unit) => {
      const budget = runBudgets.get(unit) ?? missionTotals.get(unit)
      if (budget === undefined) {
        throw new Error("Projected budget unit is missing")
      }
      return budget
    }),
    storyboard: projected.filter(
      (item) => item.screenshotArtifactId !== undefined
    ),
  }
}
