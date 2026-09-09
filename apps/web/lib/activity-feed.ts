import {
  databaseRunIdSchema,
  hashCanonical,
  runEventPageSchema,
  runEventSchema,
  type RunEvent,
} from "@sentinel/contracts"

export type ActivityConnectionState =
  "connecting" | "live" | "reconnecting" | "offline" | "error"

export interface ActivityFeedState {
  readonly runId: string
  readonly items: readonly RunEvent[]
  readonly cursor: number
  readonly connection: ActivityConnectionState
  readonly caughtUp: boolean
  readonly errorMessage?: string
}

export type ActivityFeedAction =
  | { readonly type: "merge"; readonly page: unknown }
  | {
      readonly type: "connection"
      readonly connection: ActivityConnectionState
      readonly errorMessage?: string
    }
  | { readonly type: "caught_up" }

export class ActivityFeedIntegrityError extends Error {
  constructor(readonly code: "conflict" | "gap" | "invalid_page") {
    super("The durable activity feed could not be reconstructed.")
    this.name = "ActivityFeedIntegrityError"
  }
}

export function createActivityFeedState(runIdInput: string): ActivityFeedState {
  return {
    runId: databaseRunIdSchema.parse(runIdInput),
    items: [],
    cursor: 0,
    connection: "connecting",
    caughtUp: false,
  }
}

export function mergeActivityPage(
  state: ActivityFeedState,
  pageInput: unknown
): ActivityFeedState {
  const parsed = runEventPageSchema.safeParse(pageInput)
  if (!parsed.success) throw new ActivityFeedIntegrityError("invalid_page")
  const canonicalRunId = `run:${state.runId}`
  const existing = new Map(
    state.items.map((event) => [event.sequence, event] as const)
  )
  let cursor = state.cursor
  const incoming = [...parsed.data.items].sort(
    (left, right) => left.sequence - right.sequence
  )

  for (const item of incoming) {
    const result = runEventSchema.safeParse(item.event)
    if (
      !result.success ||
      result.data.runId !== canonicalRunId ||
      result.data.sequence !== item.sequence
    ) {
      throw new ActivityFeedIntegrityError("invalid_page")
    }
    const prior = existing.get(item.sequence)
    if (prior !== undefined) {
      if (hashCanonical(prior) !== hashCanonical(result.data)) {
        throw new ActivityFeedIntegrityError("conflict")
      }
      continue
    }
    if (item.sequence !== cursor + 1) {
      throw new ActivityFeedIntegrityError("gap")
    }
    existing.set(item.sequence, result.data)
    cursor = item.sequence
  }

  if (parsed.data.nextCursor !== undefined) {
    if (
      incoming.length === 0 ||
      parsed.data.nextCursor !== incoming.at(-1)?.sequence ||
      parsed.data.nextCursor !== cursor
    ) {
      throw new ActivityFeedIntegrityError("invalid_page")
    }
  }

  return {
    ...state,
    items: [...existing.values()].sort(
      (left, right) => left.sequence - right.sequence
    ),
    cursor,
  }
}

export function activityFeedReducer(
  state: ActivityFeedState,
  action: ActivityFeedAction
): ActivityFeedState {
  switch (action.type) {
    case "merge":
      return mergeActivityPage(state, action.page)
    case "caught_up":
      return { ...state, caughtUp: true }
    case "connection":
      if (action.errorMessage === undefined) {
        return {
          runId: state.runId,
          items: state.items,
          cursor: state.cursor,
          caughtUp: state.caughtUp,
          connection: action.connection,
        }
      }
      return {
        ...state,
        connection: action.connection,
        errorMessage: action.errorMessage,
      }
  }
}

export interface ActivityCatchUpDependencies {
  readonly read: () => ActivityFeedState
  readonly write: (state: ActivityFeedState) => void
  readonly fetchPage: (after: number) => Promise<unknown>
  readonly onError?: (error: unknown) => void
}

export class ActivityCatchUpController {
  private pending = false
  private stopped = false
  private inFlight: Promise<void> | undefined

  constructor(private readonly dependencies: ActivityCatchUpDependencies) {}

  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.pending = true
    if (this.inFlight !== undefined) return this.inFlight
    const operation = this.drain()
    this.inFlight = operation
    void operation
      .catch((error: unknown) => this.dependencies.onError?.(error))
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = undefined
        if (this.pending && !this.stopped) void this.wake()
      })
    return operation
  }

  stop(): void {
    this.stopped = true
    this.pending = false
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.stopped) {
      this.pending = false
      let more = true
      while (more && !this.stopped) {
        const current = this.dependencies.read()
        const page = runEventPageSchema.parse(
          await this.dependencies.fetchPage(current.cursor)
        )
        const next = mergeActivityPage(current, page)
        this.dependencies.write(next)
        more = page.nextCursor !== undefined
      }
      if (!this.stopped) {
        this.dependencies.write({
          ...this.dependencies.read(),
          caughtUp: true,
        })
      }
    }
  }
}
