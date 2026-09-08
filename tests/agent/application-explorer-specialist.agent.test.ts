import {
  actionIdSchema,
  applicationIdSchema,
  applicationExplorerPlannerContextSchema,
  browserObservationSchema,
  browserTransitionEvidenceSchema,
  contentHashSchema,
  discoveryMissionSchema,
  persistedTextSchema,
  type ApplicationExplorerPlannerContext,
  type BrowserActionCandidate,
  type BrowserObservation,
  type BrowserRecoveryRecipe,
  type BrowserTransitionEvidence,
  type DiscoveryMission,
  type MissionBudget,
} from "@sentinel/contracts"
import {
  APPLICATION_EXPLORER_MODES,
  APPLICATION_EXPLORER_PROMPT_TEMPLATE_ID,
  InMemoryApplicationExplorerSpecialistStoreForTesting,
  InMemoryResumeCoordinator,
  InMemorySpecialistToolExecutionCoordinator,
  createApplicationExplorerSpecialist,
  createInMemorySpecialistCheckpointer,
  createSpecialistInitialState,
  type ApplicationBrowserRunOptions,
  type ApplicationBrowserRuntime,
  type ApplicationExplorerPlannerGateway,
  type ApplicationExplorerSpecialistMissionContext,
  type OrchestrationEvent,
} from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const fixedTime = "2026-09-08T00:00:00.000Z"
const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)

const fullBudget: MissionBudget = {
  toolCalls: 20,
  contentBytes: 250_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 0,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 20,
  modelCalls: 20,
  modelInputTokens: 20_000,
  modelOutputTokens: 10_000,
  reconciliationRounds: 0,
  elapsedMs: 60_000,
}

function hex(index: number): string {
  return index.toString(16).padStart(64, "0")
}

function runId(index: number): string {
  return `run:00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
}

function mission(
  index: number,
  mode: (typeof APPLICATION_EXPLORER_MODES)[number] = "workflow_discovery",
  overrides: Partial<DiscoveryMission> = {}
): DiscoveryMission {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: `mission:v1:${hex(index)}`,
    runId: runId(index),
    applicationId,
    agent: "application",
    mode,
    goal: "Reach the order confirmation screen",
    seedEvidenceIds: [],
    questions: ["Was the order confirmation screen observed?"],
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
    budget: fullBudget,
    successCriteria: ["Order confirmation screen"],
    ...overrides,
  })
}

function candidate(
  id: number,
  name: string,
  kind: BrowserActionCandidate["kind"] = "click"
): BrowserActionCandidate {
  return {
    actionId: actionIdSchema.parse(`action:v1:${hex(id)}`),
    signature: contentHashSchema.parse(`sha256:${hex(id + 100)}`),
    kind,
    role: kind === "back" ? "button" : "link",
    name,
    disabled: false,
    policy: {
      category: kind === "back" ? "safe_navigation" : "safe_navigation",
      allowed: true,
      reason: "safe_navigation",
      replaySafe: kind !== "back",
    },
    expiresAt: "2026-09-08T00:10:00.000Z",
  }
}

function observation(input: {
  readonly index: number
  readonly runId: string
  readonly route: string
  readonly title: string
  readonly candidates: readonly BrowserActionCandidate[]
}): BrowserObservation {
  return browserObservationSchema.parse({
    schemaVersion: 1,
    evidenceId: `evidence:v1:${hex(input.index + 200)}`,
    applicationId,
    runId: input.runId,
    url: `https://fixture.test${input.route}`,
    normalizedRoute: input.route,
    title: input.title,
    headings: [input.title],
    controls: [],
    dialogs: [],
    selectedText: [input.title],
    candidates: input.candidates,
    stateFingerprint: `sha256:${hex(input.index + 300)}`,
    screenshotArtifactId: `artifact:v1:${hex(input.index + 400)}`,
    errors: [],
    observedAt: fixedTime,
  })
}

function transition(
  index: number,
  before: BrowserObservation,
  action: BrowserActionCandidate,
  after: BrowserObservation
): BrowserTransitionEvidence {
  return browserTransitionEvidenceSchema.parse({
    schemaVersion: 1,
    evidenceId: `evidence:v1:${hex(index + 500)}`,
    runId: before.runId,
    action,
    before,
    after,
    network: [
      {
        requestId: `sha256:${hex(index + 600)}`,
        method: "GET",
        normalizedPath: after.normalizedRoute,
        resourceType: "fetch",
        status: 200,
        outcome: "response",
        startedAt: fixedTime,
        completedAt: fixedTime,
        durationMs: 1,
      },
    ],
    errors: [],
    observedAt: fixedTime,
  })
}

type TestBrowserOptions = ApplicationBrowserRunOptions

class ScenarioBrowser implements ApplicationBrowserRuntime<TestBrowserOptions> {
  readonly #initial: BrowserObservation
  readonly #transitions: readonly BrowserTransitionEvidence[]
  readonly #executed: BrowserTransitionEvidence[] = []
  #active = false
  #current: BrowserObservation
  starts = 0
  actions = 0
  replayedActions = 0
  completions = 0
  cancellations = 0

  constructor(
    initial: BrowserObservation,
    transitions: readonly BrowserTransitionEvidence[]
  ) {
    this.#initial = initial
    this.#current = initial
    this.#transitions = transitions
  }

  async startRun(options: TestBrowserOptions): Promise<BrowserObservation> {
    if (options.runId !== this.#initial.runId) throw new Error("Wrong run")
    this.starts += 1
    this.#active = true
    this.#current = this.#initial
    this.#executed.splice(0)
    return this.#current
  }

  async observe(): Promise<BrowserObservation> {
    if (!this.#active) throw new Error("Browser inactive")
    return this.#current
  }

  async performAction(
    _runId: string,
    actionId: string
  ): Promise<BrowserTransitionEvidence> {
    if (!this.#active) throw new Error("Browser inactive")
    const next = this.#transitions.find(
      (item) =>
        item.before.stateFingerprint === this.#current.stateFingerprint &&
        item.action.actionId === actionId
    )
    if (next === undefined) throw new Error("Action not available")
    this.actions += 1
    this.#executed.push(next)
    this.#current = next.after
    return next
  }

  createRecoveryRecipe(runIdInput: string): BrowserRecoveryRecipe {
    const steps: BrowserRecoveryRecipe["steps"] = []
    for (const item of this.#executed) {
      if (!item.action.policy.replaySafe) break
      steps.push({
        ordinal: steps.length,
        signature: item.action.signature,
        kind: item.action.kind,
        ...(item.action.name === undefined ? {} : { name: item.action.name }),
        ...(item.action.inputSlot === undefined
          ? {}
          : { inputSlot: item.action.inputSlot }),
        expectedBeforeFingerprint: item.before.stateFingerprint,
        expectedAfterFingerprint: item.after.stateFingerprint,
        replaySafe: true,
      })
    }
    return {
      schemaVersion: 1,
      applicationId,
      sourceRunId: runIdInput as BrowserRecoveryRecipe["sourceRunId"],
      entryUrl: "https://fixture.test/",
      steps,
      createdAt: fixedTime,
    }
  }

  async replay(
    options: TestBrowserOptions,
    recipe: BrowserRecoveryRecipe
  ): Promise<{
    readonly finalObservation: BrowserObservation
    readonly transitions: readonly BrowserTransitionEvidence[]
  }> {
    await this.startRun(options)
    const replayed: BrowserTransitionEvidence[] = []
    for (const step of recipe.steps) {
      const next = this.#transitions.find(
        (item) =>
          item.before.stateFingerprint === step.expectedBeforeFingerprint &&
          item.action.signature === step.signature
      )
      if (next === undefined) throw new Error("Replay mismatch")
      this.replayedActions += 1
      this.actions += 1
      this.#executed.push(next)
      this.#current = next.after
      replayed.push(next)
    }
    return { finalObservation: this.#current, transitions: replayed }
  }

  async completeRun(): Promise<void> {
    this.completions += 1
    this.#active = false
  }

  async cancelRun(): Promise<void> {
    this.cancellations += 1
    this.#active = false
  }

  isActive(): boolean {
    return this.#active
  }
}

type PlannerStep =
  | { readonly kind: "action"; readonly name: string }
  | {
      readonly kind: "finish"
      readonly classification?: "goal_completed" | "unsafe_boundary"
    }

class AgendaPlanner implements ApplicationExplorerPlannerGateway {
  readonly contexts: ApplicationExplorerPlannerContext[] = []
  #cursor = 0

  constructor(private readonly steps: readonly PlannerStep[]) {}

  async generateStructured<Output>(request: {
    readonly input: string
    readonly schema: z.ZodType<Output>
    readonly signal?: AbortSignal
  }): Promise<{
    readonly output: Output
    readonly model: string
    readonly usage: {
      readonly inputTokens: number
      readonly outputTokens: number
      readonly totalTokens: number
    }
  }> {
    if (request.signal?.aborted === true) throw new Error("Aborted")
    const context = applicationExplorerPlannerContextSchema.parse(
      JSON.parse(request.input)
    )
    this.contexts.push(context)
    const step = this.steps[this.#cursor++]
    if (step === undefined) throw new Error("Planner agenda exhausted")
    const output =
      step.kind === "finish"
        ? {
            schemaVersion: 1,
            missionId: context.mission.id,
            runId: context.mission.runId,
            tool: "finish_application_mission",
            reasonCode: "agenda_finished",
            summary: "Observed the requested terminal state",
            terminal: {
              schemaVersion: 1,
              classification: step.classification ?? "goal_completed",
              status:
                step.classification === "unsafe_boundary"
                  ? "needs_human"
                  : "complete",
              reasonCode:
                step.classification === "unsafe_boundary"
                  ? "unsafe_boundary"
                  : "criteria_observed",
              summary:
                step.classification === "unsafe_boundary"
                  ? "Human review is required"
                  : "Order confirmation screen observed",
            },
          }
        : (() => {
            const selected = context.candidates.find(
              ({ candidate: item }) => item.name === step.name
            )?.candidate
            if (selected === undefined) throw new Error("Agenda action missing")
            return {
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
              reasonCode: "agenda_action",
              summary: "Execute the observed fixture action",
            }
          })()
    return {
      output: request.schema.parse(output),
      model: "agenda_planner_v1",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }
  }
}

function scenario(selectedMission: DiscoveryMission) {
  const open = candidate(1, "Open checkout")
  const confirm = candidate(2, "Confirm order")
  const start = observation({
    index: 1,
    runId: selectedMission.runId,
    route: "/",
    title: "Events",
    candidates: [open],
  })
  const checkout = observation({
    index: 2,
    runId: selectedMission.runId,
    route: "/checkout",
    title: "Order checkout",
    candidates: [confirm],
  })
  const completed = observation({
    index: 3,
    runId: selectedMission.runId,
    route: "/confirmation",
    title: "Order confirmation screen",
    candidates: [],
  })
  return {
    browser: new ScenarioBrowser(start, [
      transition(1, start, open, checkout),
      transition(2, checkout, confirm, completed),
    ]),
  }
}

function harness(
  selectedMission: DiscoveryMission,
  browser: ScenarioBrowser,
  planner: ApplicationExplorerPlannerGateway,
  options: {
    readonly checkpointer?: ReturnType<
      typeof createInMemorySpecialistCheckpointer
    >
    readonly store?: InMemoryApplicationExplorerSpecialistStoreForTesting
    readonly coordinator?: InMemorySpecialistToolExecutionCoordinator
    readonly resolveStorageStateReference?: () => string | undefined
  } = {}
) {
  const events: OrchestrationEvent[] = []
  const checkpointer =
    options.checkpointer ?? createInMemorySpecialistCheckpointer()
  const store =
    options.store ?? new InMemoryApplicationExplorerSpecialistStoreForTesting()
  const coordinator =
    options.coordinator ?? new InMemorySpecialistToolExecutionCoordinator()
  const missionContext = (
    missionInput: DiscoveryMission
  ): ApplicationExplorerSpecialistMissionContext<TestBrowserOptions> => {
    const storageStateReference = options.resolveStorageStateReference?.()
    return {
      browserOptions: {
        applicationId: missionInput.applicationId,
        runId: missionInput.runId,
        entryUrl: "https://fixture.test/",
        policy: { allowedOrigins: ["https://fixture.test"] },
        ...(storageStateReference === undefined
          ? {}
          : { storageStateReference }),
      },
      requirementHintLabels: ["order confirmation"],
    }
  }
  const specialist = createApplicationExplorerSpecialist({
    browser,
    planner,
    store,
    resolveMissionContext: missionContext,
    modelEstimate: {
      contentBytes: 50_000,
      modelInputTokens: 1_000,
      modelOutputTokens: 512,
    },
    executionCoordinator: coordinator,
    runtime: {
      owner: "application-agent-test",
      control: { assertActive: async () => undefined },
      events: { append: async (event) => void events.push(event) },
      effects: { execute: async () => undefined },
      resumeAuthorization: { authorize: async () => true },
      resumeCoordinator: new InMemoryResumeCoordinator(),
      now: () => new Date(fixedTime),
    },
    checkpointer,
    now: () => new Date(fixedTime),
  })
  return {
    specialist,
    events,
    store,
    checkpointer,
    coordinator,
    selectedMission,
  }
}

describe("Application Explorer shared specialist kernel", () => {
  it("runs a complete multi-step trajectory with proposed evidence-backed claims", async () => {
    const selectedMission = mission(1)
    const { browser } = scenario(selectedMission)
    const planner = new AgendaPlanner([
      { kind: "action", name: "Open checkout" },
      { kind: "action", name: "Confirm order" },
      { kind: "finish" },
    ])
    const test = harness(selectedMission, browser, planner)

    const result = await test.specialist.start(selectedMission)
    const stored = await test.store.load(selectedMission.id)

    expect(result.status).toBe("complete")
    expect(result.mission.claims.length).toBeGreaterThan(0)
    expect(
      result.mission.claims.every((claim) => claim.status === "proposed")
    ).toBe(true)
    expect(result.mission.unresolved).toEqual([])
    expect(result.state.kernel.promptTemplateId).toBe(
      APPLICATION_EXPLORER_PROMPT_TEMPLATE_ID
    )
    expect(result.state.completedCalls.map((call) => call.toolName)).toEqual([
      "finish_application_mission",
      "observe_page",
      "perform_observed_action",
      "perform_observed_action",
    ])
    expect(stored?.transitions).toHaveLength(2)
    expect(stored?.result).toEqual(result.mission)
    expect(
      test.events.some(
        (event) =>
          event.kind === "mission_completed" && event.agent === "application"
      )
    ).toBe(true)
    const knownEvidence = new Set(
      result.state.observations.flatMap((item) => item.evidenceIds)
    )
    expect(
      result.mission.claims
        .flatMap((claim) => claim.evidenceIds)
        .every((evidenceId) => knownEvidence.has(evidenceId))
    ).toBe(true)
  })

  it.each(APPLICATION_EXPLORER_MODES)(
    "supports the %s mode through the same fixed kernel",
    async (mode) => {
      const selectedMission = mission(
        APPLICATION_EXPLORER_MODES.indexOf(mode) + 10,
        mode
      )
      const { browser } = scenario(selectedMission)
      const result = await harness(
        selectedMission,
        browser,
        new AgendaPlanner([
          { kind: "action", name: "Open checkout" },
          { kind: "action", name: "Confirm order" },
          { kind: "finish" },
        ])
      ).specialist.start(selectedMission)
      expect(result.status).toBe("complete")
      expect(result.state.mission.mode).toBe(mode)
    }
  )

  it("denies cross-agent use and zero tool budgets before browser execution", async () => {
    const selectedMission = mission(20)
    const firstScenario = scenario(selectedMission)
    const first = harness(
      selectedMission,
      firstScenario.browser,
      new AgendaPlanner([])
    )
    const codeMission = discoveryMissionSchema.parse({
      ...selectedMission,
      id: `mission:v1:${hex(21)}`,
      runId: runId(21),
      agent: "code",
      mode: "implementation_trace",
    })
    await expect(first.specialist.start(codeMission)).rejects.toThrow()
    expect(firstScenario.browser.starts).toBe(0)

    const budgetMission = mission(22, "workflow_discovery", {
      budget: { ...fullBudget, toolCalls: 0 },
    })
    const budgetScenario = scenario(budgetMission)
    const exhausted = await harness(
      budgetMission,
      budgetScenario.browser,
      new AgendaPlanner([])
    ).specialist.start(budgetMission)
    expect(exhausted.status).toBe("budget_exhausted")
    expect(budgetScenario.browser.starts).toBe(0)
  })

  it("recovers a committed safe path with charged replay and no duplicate resume", async () => {
    const selectedMission = mission(30)
    const { browser } = scenario(selectedMission)
    const test = harness(
      selectedMission,
      browser,
      new AgendaPlanner([
        { kind: "action", name: "Open checkout" },
        { kind: "action", name: "Confirm order" },
        { kind: "finish" },
      ])
    )
    const config = test.specialist.kernel.config
    const graphConfig = {
      configurable: { thread_id: selectedMission.id },
      recursionLimit: config.recursionLimit,
      interruptAfter: ["specialist_tool_committed" as const],
    }
    const initial = createSpecialistInitialState(selectedMission, {
      graphName: config.graphName,
      promptTemplateId: config.promptTemplateId,
      configurationFingerprint: config.configurationFingerprint,
      startedAtMs: new Date(fixedTime).getTime(),
    })

    await test.specialist.kernel.graph.invoke(initial, graphConfig)
    await test.specialist.kernel.graph.invoke(null, graphConfig)
    expect(browser.actions).toBe(1)
    await browser.cancelRun()

    const resumed = await test.specialist.start(selectedMission)
    expect(resumed.status).toBe("complete")
    expect(browser.replayedActions).toBe(1)
    expect(resumed.mission.budgetUsed.browserActions).toBe(3)
    const actionCount = browser.actions

    const duplicate = await test.specialist.start(selectedMission)
    expect(duplicate.idempotent).toBe(true)
    expect(browser.actions).toBe(actionCount)
  })

  it("rejects recovery before replay when the authentication reference changed", async () => {
    const selectedMission = mission(31)
    const { browser } = scenario(selectedMission)
    let authenticationReference = `secret-ref:v1:${"a".repeat(64)}`
    const test = harness(
      selectedMission,
      browser,
      new AgendaPlanner([
        { kind: "action", name: "Open checkout" },
        { kind: "action", name: "Confirm order" },
      ]),
      { resolveStorageStateReference: () => authenticationReference }
    )
    const config = test.specialist.kernel.config
    const graphConfig = {
      configurable: { thread_id: selectedMission.id },
      recursionLimit: config.recursionLimit,
      interruptAfter: ["specialist_tool_committed" as const],
    }
    const initial = createSpecialistInitialState(selectedMission, {
      graphName: config.graphName,
      promptTemplateId: config.promptTemplateId,
      configurationFingerprint: config.configurationFingerprint,
      startedAtMs: new Date(fixedTime).getTime(),
    })
    await test.specialist.kernel.graph.invoke(initial, graphConfig)
    await test.specialist.kernel.graph.invoke(null, graphConfig)
    await browser.cancelRun()
    authenticationReference = `secret-ref:v1:${"b".repeat(64)}`

    const rejected = await test.specialist.start(selectedMission)
    expect(rejected.status).not.toBe("complete")
    expect(browser.replayedActions).toBe(0)
    expect(
      (await test.store.load(selectedMission.id))?.checkpoint.replayBoundary
        .authenticationStateReference
    ).toBe(`secret-ref:v1:${"a".repeat(64)}`)
  })

  it("advances an approved review once and never repeats an uncertain action", async () => {
    const selectedMission = mission(40)
    const { browser } = scenario(selectedMission)
    const planner = new AgendaPlanner([
      { kind: "action", name: "Open checkout" },
      { kind: "finish", classification: "unsafe_boundary" },
      { kind: "action", name: "Confirm order" },
      { kind: "finish" },
    ])
    const test = harness(selectedMission, browser, planner)

    const interrupted = await test.specialist.start(selectedMission)
    expect(interrupted.status).toBe("interrupted")
    expect(interrupted.interrupts).toHaveLength(1)
    const resumed = await test.specialist.resume({
      missionId: selectedMission.id,
      decisionId: interrupted.interrupts[0]?.decisionId ?? "missing",
      actorId: "reviewer:application_test",
      approved: true,
    })
    expect(resumed.status).toBe("complete")
    expect(browser.actions).toBe(2)
    expect(browser.replayedActions).toBe(0)
    expect((await test.store.load(selectedMission.id))?.review).toMatchObject({
      status: "approved",
      decisionId: interrupted.interrupts[0]?.decisionId,
    })
  })

  it("persists an authorized rejection without calling the planner again", async () => {
    const selectedMission = mission(41)
    const { browser } = scenario(selectedMission)
    const planner = new AgendaPlanner([
      { kind: "action", name: "Open checkout" },
      { kind: "finish", classification: "unsafe_boundary" },
    ])
    const test = harness(selectedMission, browser, planner)

    const interrupted = await test.specialist.start(selectedMission)
    const plannerCalls = planner.contexts.length
    const resumed = await test.specialist.resume({
      missionId: selectedMission.id,
      decisionId: interrupted.interrupts[0]?.decisionId ?? "missing",
      actorId: "reviewer:application_test",
      approved: false,
    })
    expect(resumed.status).toBe("blocked")
    expect(resumed.state.humanInterrupt).toMatchObject({
      status: "resolved",
      approved: false,
    })
    expect(
      test.events.some((event) => event.kind === "interrupt_resumed")
    ).toBe(true)
    expect(planner.contexts).toHaveLength(plannerCalls)
    expect((await test.store.load(selectedMission.id))?.review).toMatchObject({
      status: "rejected",
      actorId: "reviewer:application_test",
    })
  })

  it("cannot complete when mission questions are unrelated to observed evidence", async () => {
    const selectedMission = mission(42, "workflow_discovery", {
      questions: [
        persistedTextSchema.parse("Was the refund approval audit recorded?"),
      ],
    })
    const { browser } = scenario(selectedMission)
    const result = await harness(
      selectedMission,
      browser,
      new AgendaPlanner([
        { kind: "action", name: "Open checkout" },
        { kind: "action", name: "Confirm order" },
        { kind: "finish" },
      ])
    ).specialist.start(selectedMission)

    expect(result.status).toBe("partial")
    expect(result.mission.stopReason.code).toBe("completion_criteria_unmet")
    expect(result.mission.unresolved).toEqual([
      expect.objectContaining({
        question: "Was the refund approval audit recorded?",
      }),
    ])
  })

  it("rejects off-host initial and transition observations", async () => {
    const initialMission = mission(43)
    const safeInitial = observation({
      index: 43,
      runId: initialMission.runId,
      route: "/",
      title: "Events",
      candidates: [],
    })
    const offHostInitial = browserObservationSchema.parse({
      ...safeInitial,
      url: "https://outside.test/",
    })
    const initialBrowser = new ScenarioBrowser(offHostInitial, [])
    const initialTest = harness(
      initialMission,
      initialBrowser,
      new AgendaPlanner([])
    )
    const initial = await initialTest.specialist.start(initialMission)
    expect(initial.status).toBe("partial")
    expect(await initialTest.store.load(initialMission.id)).toBeNull()
    expect(initialBrowser.isActive()).toBe(false)

    const transitionMission = mission(44)
    const open = candidate(44, "Open checkout")
    const before = observation({
      index: 44,
      runId: transitionMission.runId,
      route: "/",
      title: "Events",
      candidates: [open],
    })
    const outside = browserObservationSchema.parse({
      ...observation({
        index: 45,
        runId: transitionMission.runId,
        route: "/outside",
        title: "Outside",
        candidates: [],
      }),
      url: "https://outside.test/outside",
    })
    const transitionBrowser = new ScenarioBrowser(before, [
      transition(44, before, open, outside),
    ])
    const transitioned = await harness(
      transitionMission,
      transitionBrowser,
      new AgendaPlanner([{ kind: "action", name: "Open checkout" }])
    ).specialist.start(transitionMission)
    expect(transitioned.status).toBe("failed")
  })

  it("coalesces identical result persistence without advancing revision", async () => {
    const selectedMission = mission(45)
    const { browser } = scenario(selectedMission)
    const test = harness(
      selectedMission,
      browser,
      new AgendaPlanner([
        { kind: "action", name: "Open checkout" },
        { kind: "action", name: "Confirm order" },
        { kind: "finish" },
      ])
    )
    const [first, second] = await Promise.all([
      test.specialist.start(selectedMission),
      test.specialist.start(selectedMission),
    ])
    expect(first.mission).toEqual(second.mission)
    const committed = await test.store.load(selectedMission.id)
    expect(committed?.revision).toBe(4)

    await test.specialist.start(selectedMission)
    await test.specialist.continue(selectedMission.id)
    expect((await test.store.load(selectedMission.id))?.revision).toBe(4)
  })

  it("cleans up a browser after post-observation budget exhaustion", async () => {
    const selectedMission = mission(46, "workflow_discovery", {
      budget: { ...fullBudget, modelCalls: 1 },
    })
    const { browser } = scenario(selectedMission)
    const result = await harness(
      selectedMission,
      browser,
      new AgendaPlanner([])
    ).specialist.start(selectedMission)

    expect(result.status).toBe("budget_exhausted")
    expect(browser.isActive()).toBe(false)
    expect(browser.completions + browser.cancellations).toBeGreaterThan(0)
  })
})
