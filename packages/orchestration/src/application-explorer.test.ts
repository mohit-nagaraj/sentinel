import {
  applicationExplorerCheckpointStateSchema,
  applicationExplorerPlannerContextSchema,
  applicationExplorerPlannerDecisionSchema,
  browserActionCandidateSchema,
  browserObservationSchema,
  browserRecoveryRecipeSchema,
  browserTransitionEvidenceSchema,
  discoveryMissionSchema,
  type ApplicationExplorerPlannerDecision,
  type BrowserActionCandidate,
  type BrowserObservation,
  type BrowserRecoveryRecipe,
  type BrowserTransitionEvidence,
  type DiscoveryMission,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"
import type { z } from "zod"

import {
  ApplicationExplorerTools,
  ApplicationExplorerToolError,
  buildApplicationExplorerPlannerContext,
  createApplicationExplorer,
  type ApplicationBrowserRunOptions,
  type ApplicationBrowserRuntime,
  type ApplicationExplorerEvent,
  type ApplicationExplorerPlannerGateway,
} from "./application-explorer.ts"

const hash = (character: string) => `sha256:${character.repeat(64)}`
const evidenceId = (character: string) => `evidence:v1:${character.repeat(64)}`
const actionId = (character: string) => `action:v1:${character.repeat(64)}`
const timestamp = "2026-09-08T10:00:00.000Z"
const applicationId = `application:v1:${"a".repeat(64)}`
const missionId = `mission:v1:${"b".repeat(64)}`
const runId = "run:11111111-1111-4111-8111-111111111111"

const budget = {
  toolCalls: 20,
  contentBytes: 500_000,
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
  elapsedMs: 120_000,
}

function mission(overrides: Partial<DiscoveryMission> = {}): DiscoveryMission {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: missionId,
    runId,
    applicationId,
    agent: "application",
    mode: "workflow_discovery",
    goal: "Discover checkout and confirmation",
    seedEvidenceIds: [],
    questions: ["How does a buyer complete checkout?"],
    scope: {
      repositoryPaths: [],
      sourceUris: [],
      allowedHosts: ["example.test"],
      allowedTools: [
        "observe_page",
        "perform_observed_action",
        "navigate_history",
        "finish_application_mission",
      ],
    },
    budget,
    successCriteria: ["Observe order confirmation"],
    ...overrides,
  })
}

function candidate(input: {
  id: string
  signature: string
  name: string
  kind?: BrowserActionCandidate["kind"]
  allowed?: boolean
  replaySafe?: boolean
  category?: BrowserActionCandidate["policy"]["category"]
}): BrowserActionCandidate {
  const category = input.category ?? "safe_form_progress"
  const allowed = input.allowed ?? true
  return browserActionCandidateSchema.parse({
    actionId: actionId(input.id),
    signature: hash(input.signature),
    kind: input.kind ?? "click",
    role:
      input.kind === "back" || input.kind === "reload"
        ? "navigation"
        : "button",
    name: input.name,
    disabled: false,
    policy: {
      category,
      allowed,
      reason: allowed ? category : `${category}_denied`,
      replaySafe: input.replaySafe ?? allowed,
    },
    expiresAt: "2026-09-08T10:10:00.000Z",
  })
}

function observation(
  id: string,
  fingerprint: string,
  route: string,
  title: string,
  candidates: readonly BrowserActionCandidate[]
): BrowserObservation {
  return browserObservationSchema.parse({
    schemaVersion: 1,
    evidenceId: evidenceId(id),
    applicationId,
    runId,
    url: `https://example.test${route}`,
    normalizedRoute: route,
    title,
    headings: [title],
    controls: candidates
      .filter((value) => value.role !== undefined && value.name !== undefined)
      .map((value) => ({
        role: value.role,
        name: value.name,
        disabled: value.disabled,
      })),
    dialogs: title.includes("Modal")
      ? [{ role: "dialog", name: "Review", text: "Review order" }]
      : [],
    selectedText: [`${title} state`],
    candidates,
    stateFingerprint: hash(fingerprint),
    screenshotArtifactId: `artifact:v1:${id.repeat(64)}`,
    errors: [],
    observedAt: timestamp,
  })
}

function transition(
  id: string,
  before: BrowserObservation,
  action: BrowserActionCandidate,
  after: BrowserObservation,
  network = false
): BrowserTransitionEvidence {
  return browserTransitionEvidenceSchema.parse({
    schemaVersion: 1,
    evidenceId: evidenceId(id),
    runId,
    action,
    before,
    after,
    network: network
      ? [
          {
            requestId: hash("9"),
            method: "POST",
            normalizedPath: "/api/orders",
            resourceType: "fetch",
            status: 201,
            outcome: "response",
            startedAt: timestamp,
            completedAt: timestamp,
            durationMs: 0,
          },
        ]
      : [],
    errors: [],
    observedAt: timestamp,
  })
}

interface TestBrowserOptions extends ApplicationBrowserRunOptions {
  readonly marker?: string
}

class ScriptedBrowser implements ApplicationBrowserRuntime<TestBrowserOptions> {
  private current: BrowserObservation | undefined
  private active = false
  private readonly used = new Set<string>()
  private history: BrowserRecoveryRecipe["steps"] = []
  readonly performed: string[] = []
  readonly replayedOptions: TestBrowserOptions[] = []
  failNextActionWith: string | undefined

  constructor(
    private readonly initial: BrowserObservation,
    private readonly transitions: readonly BrowserTransitionEvidence[]
  ) {}

  async startRun(): Promise<BrowserObservation> {
    this.current = this.initial
    this.active = true
    this.used.clear()
    this.history = []
    return this.initial
  }

  async observe(): Promise<BrowserObservation> {
    if (!this.active || this.current === undefined) throw new Error("inactive")
    return this.current
  }

  async performAction(
    _runId: string,
    selectedActionId: string
  ): Promise<BrowserTransitionEvidence> {
    if (!this.active || this.current === undefined) throw new Error("inactive")
    if (this.failNextActionWith !== undefined) {
      const code = this.failNextActionWith
      this.failNextActionWith = undefined
      throw { failure: { code } }
    }
    if (this.used.has(selectedActionId)) {
      throw { failure: { code: "action_reused" } }
    }
    const next = this.transitions.find(
      (item) =>
        item.before.stateFingerprint === this.current?.stateFingerprint &&
        item.action.actionId === selectedActionId
    )
    if (next === undefined) throw { failure: { code: "action_not_found" } }
    this.used.add(selectedActionId)
    this.performed.push(selectedActionId)
    if (next.action.policy.replaySafe) {
      this.history = [
        ...this.history,
        {
          ordinal: this.history.length,
          signature: next.action.signature,
          kind: next.action.kind,
          ...(next.action.name === undefined ? {} : { name: next.action.name }),
          ...(next.action.inputSlot === undefined
            ? {}
            : { inputSlot: next.action.inputSlot }),
          expectedBeforeFingerprint: next.before.stateFingerprint,
          expectedAfterFingerprint: next.after.stateFingerprint,
          replaySafe: true,
        },
      ]
    }
    this.current = next.after
    return next
  }

  createRecoveryRecipe(): BrowserRecoveryRecipe {
    return browserRecoveryRecipeSchema.parse({
      schemaVersion: 1,
      applicationId,
      sourceRunId: runId,
      entryUrl: this.initial.url,
      steps: this.history,
      createdAt: timestamp,
    })
  }

  async replay(options: TestBrowserOptions, recipe: BrowserRecoveryRecipe) {
    this.replayedOptions.push(options)
    await this.startRun()
    const replayed: BrowserTransitionEvidence[] = []
    for (const step of recipe.steps) {
      const next = this.transitions.find(
        (item) =>
          item.before.stateFingerprint === this.current?.stateFingerprint &&
          item.action.signature === step.signature
      )
      if (next === undefined) throw new Error("recovery mismatch")
      replayed.push(await this.performAction(runId, next.action.actionId))
    }
    return {
      finalObservation: await this.observe(),
      transitions: replayed,
    }
  }

  async completeRun(): Promise<void> {
    this.active = false
  }

  async cancelRun(): Promise<void> {
    this.active = false
  }

  isActive(): boolean {
    return this.active
  }
}

class ScriptedPlanner implements ApplicationExplorerPlannerGateway {
  readonly contexts: unknown[] = []

  constructor(private readonly decisions: readonly unknown[]) {}

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
    this.contexts.push(JSON.parse(request.input))
    const next = this.decisions[this.contexts.length - 1]
    if (next === undefined) throw new Error("No scripted planner decision")
    return {
      output: request.schema.parse(next),
      model: "scripted",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }
  }
}

function actionDecision(
  tool: "perform_observed_action" | "navigate_history",
  current: BrowserObservation,
  action: BrowserActionCandidate
): ApplicationExplorerPlannerDecision {
  return applicationExplorerPlannerDecisionSchema.parse({
    schemaVersion: 1,
    missionId,
    runId,
    tool,
    observationEvidenceId: current.evidenceId,
    stateFingerprint: current.stateFingerprint,
    actionId: action.actionId,
    reasonCode: "gain_workflow_evidence",
    summary: `Explore ${action.name ?? action.kind}`,
  })
}

function finishDecision(
  classification:
    | "goal_completed"
    | "unsafe_boundary"
    | "dead_end"
    | "recoverable_branch"
    | "login_block",
  reasonCode: string = classification,
  summary: string = "Checkout confirmation observed"
): ApplicationExplorerPlannerDecision {
  const status =
    classification === "goal_completed"
      ? "complete"
      : classification === "unsafe_boundary"
        ? "needs_human"
        : classification === "login_block"
          ? "blocked"
          : "partial"
  return applicationExplorerPlannerDecisionSchema.parse({
    schemaVersion: 1,
    missionId,
    runId,
    tool: "finish_application_mission",
    reasonCode,
    summary,
    terminal: {
      schemaVersion: 1,
      classification,
      status,
      reasonCode,
      summary,
    },
  })
}

function browserOptions(): TestBrowserOptions {
  return {
    applicationId,
    runId,
    entryUrl: "https://example.test/checkout",
    storageStateReference: `secret-ref:v1:${"c".repeat(64)}`,
    policy: { allowedOrigins: ["https://example.test"] },
    marker: "test",
  }
}

describe("Application Explorer context and tool boundary", () => {
  it("ranks mission hints while exposing only the bounded candidate set", () => {
    const checkout = candidate({
      id: "1",
      signature: "2",
      name: "Continue checkout",
    })
    const settings = candidate({
      id: "3",
      signature: "4",
      name: "Open settings",
    })
    const current = observation("1", "2", "/checkout", "Tickets", [
      settings,
      checkout,
    ])
    const context = buildApplicationExplorerPlannerContext({
      mission: mission(),
      observation: current,
      capabilityHintLabels: ["checkout"],
      requirementHintLabels: ["continue checkout confirmation"],
      candidateLimit: 1,
    })

    expect(context.candidates).toHaveLength(1)
    expect(context.candidates[0]?.candidate.actionId).toBe(checkout.actionId)
    expect(context.candidates[0]?.matchedCapabilityHints).toEqual(["checkout"])
    expect(JSON.stringify(context)).not.toMatch(/selector|cookie|storageState/)
  })

  it("rejects forged, unsafe, and wrong-tool action IDs before execution", async () => {
    const safe = candidate({ id: "1", signature: "2", name: "Continue" })
    const back = candidate({
      id: "3",
      signature: "4",
      name: "Go back",
      kind: "back",
    })
    const unsafe = candidate({
      id: "5",
      signature: "6",
      name: "Place order",
      allowed: false,
      replaySafe: false,
      category: "payment",
    })
    const current = observation("1", "2", "/checkout", "Tickets", [
      safe,
      back,
      unsafe,
    ])
    const browser = new ScriptedBrowser(current, [])
    await browser.startRun()
    const tools = new ApplicationExplorerTools(browser)
    const base = {
      schemaVersion: 1,
      missionId,
      runId,
      observationEvidenceId: current.evidenceId,
      stateFingerprint: current.stateFingerprint,
      reasonCode: "test_guard",
      summary: "Exercise deterministic guard",
    }

    await expect(
      tools.performObservedAction(
        mission(),
        {
          ...base,
          tool: "perform_observed_action",
          actionId: actionId("f"),
        },
        current
      )
    ).rejects.toMatchObject({ code: "action_not_observed" })
    await expect(
      tools.performObservedAction(
        mission(),
        { ...base, tool: "perform_observed_action", actionId: back.actionId },
        current
      )
    ).rejects.toMatchObject({ code: "wrong_action_tool" })
    await expect(
      tools.navigateHistory(
        mission(),
        { ...base, tool: "navigate_history", actionId: safe.actionId },
        current
      )
    ).rejects.toMatchObject({ code: "wrong_action_tool" })
    await expect(
      tools.performObservedAction(
        mission(),
        {
          ...base,
          tool: "perform_observed_action",
          actionId: unsafe.actionId,
        },
        current
      )
    ).rejects.toBeInstanceOf(ApplicationExplorerToolError)
    expect(browser.performed).toEqual([])
  })
})

describe("Application Explorer mission runtime", () => {
  it("rejects a browser entry host outside mission scope", async () => {
    const first = observation("1", "2", "/", "Home", [])
    await expect(
      createApplicationExplorer({
        browser: new ScriptedBrowser(first, []),
        planner: new ScriptedPlanner([]),
      }).run({
        mission: mission(),
        browserOptions: {
          ...browserOptions(),
          entryUrl: "https://outside.example/",
        },
      })
    ).rejects.toThrow(/outside the application mission scope/)
    await expect(
      createApplicationExplorer({
        browser: new ScriptedBrowser(first, []),
        planner: new ScriptedPlanner([]),
      }).run({
        mission: mission(),
        browserOptions: {
          ...browserOptions(),
          policy: {
            allowedOrigins: ["https://example.test", "https://outside.example"],
          },
        },
      })
    ).rejects.toThrow(/outside the application mission scope/)
  })

  it("discovers a multi-screen workflow and constructs linked evidence claims", async () => {
    const choose = candidate({
      id: "1",
      signature: "2",
      name: "Choose ticket",
    })
    const continueAction = candidate({
      id: "3",
      signature: "4",
      name: "Continue checkout",
    })
    const first = observation("1", "2", "/events/1", "Tickets", [choose])
    const second = observation("3", "4", "/checkout", "Attendee", [
      continueAction,
    ])
    const third = observation("5", "6", "/orders/1", "Confirmation", [])
    const transitions = [
      transition("7", first, choose, second),
      transition("8", second, continueAction, third, true),
    ]
    const browser = new ScriptedBrowser(first, transitions)
    const planner = new ScriptedPlanner([
      actionDecision("perform_observed_action", first, choose),
      actionDecision("perform_observed_action", second, continueAction),
      finishDecision("goal_completed"),
    ])
    const events: ApplicationExplorerEvent[] = []
    const explorer = createApplicationExplorer({
      browser,
      planner,
      events: {
        async append(event) {
          events.push(event)
        },
      },
      now: () => new Date(timestamp),
    })

    const output = await explorer.run({
      mission: mission(),
      browserOptions: browserOptions(),
      capabilityHintLabels: ["checkout"],
      requirementHintLabels: ["order confirmation"],
    })

    expect(output.result.status).toBe("complete")
    expect(output.checkpoint.path).toHaveLength(2)
    expect(
      output.evidenceClaims.filter((claim) => claim.claimKind === "flow_step")
    ).toHaveLength(2)
    expect(
      output.evidenceClaims.find(
        (claim) => claim.claimKind === "runtime_request"
      )
    ).toMatchObject({ request: { normalizedPath: "/api/orders", status: 201 } })
    const workflow = output.evidenceClaims.find(
      (claim) => claim.claimKind === "workflow"
    )
    expect(workflow).toMatchObject({ stepIds: expect.any(Array) })
    expect(events.some((event) => event.kind === "evidence_gained")).toBe(true)
    for (const toolName of [
      "observe_page",
      "perform_observed_action",
      "finish_application_mission",
    ]) {
      expect(
        events.filter(
          (event) =>
            event.toolName === toolName && event.kind === "tool_started"
        )
      ).toHaveLength(
        events.filter(
          (event) =>
            event.toolName === toolName && event.kind === "tool_completed"
        ).length
      )
    }
  })

  it("adapts to a changed head label through the current opaque action", async () => {
    const renamedAction = candidate({
      id: "a",
      signature: "b",
      name: "Next step",
    })
    const head = observation("c", "d", "/checkout", "Attendee", [renamedAction])
    const confirmation = observation("e", "f", "/orders/1", "Confirmation", [])
    const output = await createApplicationExplorer({
      browser: new ScriptedBrowser(head, [
        transition("1", head, renamedAction, confirmation),
      ]),
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", head, renamedAction),
        finishDecision("goal_completed"),
      ]),
    }).run({
      mission: mission({
        mode: "pr_change_validation",
        goal: "Reach order confirmation despite changed presentation" as never,
        questions: ["Does the checkout transition still complete?" as never],
        successCriteria: ["Observe order confirmation" as never],
      }),
      browserOptions: browserOptions(),
      requirementHintLabels: ["order confirmation"],
    })

    expect(output.result.status).toBe("complete")
    expect(output.checkpoint.path).toEqual([
      expect.objectContaining({ actionSignature: renamedAction.signature }),
    ])
    expect(output.checkpoint.currentStateFingerprint).toBe(
      confirmation.stateFingerprint
    )
  })

  it("keeps backtracked alternatives as separate evidence workflows", async () => {
    const branchA = candidate({ id: "1", signature: "2", name: "Branch A" })
    const back = candidate({
      id: "3",
      signature: "4",
      name: "Go back",
      kind: "back",
    })
    const branchB = candidate({ id: "5", signature: "6", name: "Branch B" })
    const root = observation("1", "2", "/", "Home", [branchA])
    const childA = observation("3", "4", "/a", "Branch A", [back])
    const rootAgain = observation("5", "2", "/", "Home", [branchB])
    const childB = observation("6", "7", "/b", "Branch B", [])
    const browser = new ScriptedBrowser(root, [
      transition("7", root, branchA, childA),
      transition("8", childA, back, rootAgain),
      transition("9", rootAgain, branchB, childB),
    ])
    const planner = new ScriptedPlanner([
      actionDecision("perform_observed_action", root, branchA),
      actionDecision("navigate_history", childA, back),
      actionDecision("perform_observed_action", rootAgain, branchB),
      finishDecision("goal_completed"),
    ])
    const output = await createApplicationExplorer({
      browser,
      planner,
    }).run({ mission: mission(), browserOptions: browserOptions() })

    expect(output.checkpoint.path).toHaveLength(3)
    expect(
      output.evidenceClaims.filter((claim) => claim.claimKind === "workflow")
    ).toHaveLength(2)
    expect(
      output.evidenceClaims
        .filter((claim) => claim.claimKind === "workflow")
        .map((claim) => claim.fact.name)
    ).toEqual([
      "Discover checkout and confirmation: Home to Branch A",
      "Discover checkout and confirmation: Home to Branch B",
    ])
    expect(
      applicationExplorerPlannerContextSchema.parse(planner.contexts[2])
        .progress
    ).toMatchObject({ exploredBranchCount: 2, currentBranchDepth: 0 })

    const alternateSummary = await createApplicationExplorer({
      browser: new ScriptedBrowser(root, [
        transition("7", root, branchA, childA),
        transition("8", childA, back, rootAgain),
        transition("9", rootAgain, branchB, childB),
      ]),
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", root, branchA),
        actionDecision("navigate_history", childA, back),
        actionDecision("perform_observed_action", rootAgain, branchB),
        finishDecision(
          "goal_completed",
          "goal_completed",
          "A differently worded completion summary"
        ),
      ]),
    }).run({ mission: mission(), browserOptions: browserOptions() })
    const productIds = (result: typeof output) =>
      result.evidenceClaims
        .filter(
          (claim) =>
            claim.claimKind === "workflow" || claim.claimKind === "flow_step"
        )
        .map((claim) => claim.fact.id)
        .sort()
    expect(productIds(alternateSummary)).toEqual(productIds(output))
    expect(new Set(output.result.claims.map((claim) => claim.id)).size).toBe(
      output.result.claims.length
    )
  })

  it("fails closed when the planner selects outside its bounded context", async () => {
    const shown = candidate({ id: "1", signature: "2", name: "Checkout" })
    const hidden = candidate({ id: "3", signature: "4", name: "Settings" })
    const first = observation("1", "2", "/", "Home", [shown, hidden])
    const browser = new ScriptedBrowser(first, [])
    const planner = new ScriptedPlanner([
      actionDecision("perform_observed_action", first, hidden),
    ])
    const output = await createApplicationExplorer({ browser, planner }).run({
      mission: mission(),
      browserOptions: browserOptions(),
      candidateLimit: 1,
      requirementHintLabels: ["checkout"],
    })

    expect(output.result.status).toBe("failed")
    expect(output.result.stopReason.code).toBe("action_outside_context")
    expect(browser.performed).toEqual([])
  })

  it("records unsafe denial and lets the planner terminate at the boundary", async () => {
    const unsafe = candidate({
      id: "1",
      signature: "2",
      name: "Place order",
      allowed: false,
      replaySafe: false,
      category: "payment",
    })
    const first = observation("1", "2", "/checkout", "Review", [unsafe])
    const planner = new ScriptedPlanner([
      actionDecision("perform_observed_action", first, unsafe),
      finishDecision("unsafe_boundary"),
    ])
    const output = await createApplicationExplorer({
      browser: new ScriptedBrowser(first, []),
      planner,
    }).run({ mission: mission(), browserOptions: browserOptions() })

    expect(output.result.status).toBe("needs_human")
    expect(output.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "unsafe_action", recoverable: true }),
      ])
    )
  })

  it("terminates repeated no-progress and exact model-call budgets predictably", async () => {
    const refresh = candidate({
      id: "1",
      signature: "2",
      name: "Refresh state",
      kind: "reload",
    })
    const first = observation("1", "2", "/", "Home", [refresh])
    const unchanged = observation("3", "2", "/", "Home", [
      candidate({
        id: "3",
        signature: "2",
        name: "Refresh state",
        kind: "reload",
      }),
    ])
    const noProgress = await createApplicationExplorer({
      browser: new ScriptedBrowser(first, [
        transition("4", first, refresh, unchanged),
      ]),
      planner: new ScriptedPlanner([
        actionDecision("navigate_history", first, refresh),
      ]),
    }).run({
      mission: mission(),
      browserOptions: browserOptions(),
      noProgressLimit: 1,
    })
    expect(noProgress.result.stopReason.code).toBe("no_progress_limit")

    const go = candidate({ id: "5", signature: "6", name: "Open checkout" })
    const start = observation("5", "6", "/", "Home", [go])
    const end = observation("6", "7", "/checkout", "Checkout", [])
    const limitedBrowser = new ScriptedBrowser(start, [
      transition("7", start, go, end),
    ])
    const limited = await createApplicationExplorer({
      browser: limitedBrowser,
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", start, go),
      ]),
    }).run({
      mission: mission({ budget: { ...budget, modelCalls: 1 } }),
      browserOptions: browserOptions(),
    })
    expect(limitedBrowser.performed).toEqual([go.actionId])
    expect(limited.result.status).toBe("budget_exhausted")
    expect(limited.result.stopReason.code).toBe("model_call_budget_exhausted")
  })

  it("replays safe checkpoints with auth reference and interrupts unsafe replay", async () => {
    const safe = candidate({ id: "1", signature: "2", name: "Continue" })
    const first = observation("1", "2", "/", "Start", [safe])
    const second = observation("3", "4", "/next", "Next", [])
    const safeBrowser = new ScriptedBrowser(first, [
      transition("5", first, safe, second),
    ])
    const firstOutput = await createApplicationExplorer({
      browser: safeBrowser,
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", first, safe),
        finishDecision("goal_completed"),
      ]),
    }).run({ mission: mission(), browserOptions: browserOptions() })

    const resumed = await createApplicationExplorer({
      browser: safeBrowser,
      planner: new ScriptedPlanner([finishDecision("goal_completed")]),
    }).run({
      mission: mission(),
      browserOptions: browserOptions(),
      checkpoint: firstOutput.checkpoint,
      priorEvidenceClaims: firstOutput.evidenceClaims,
    })
    expect(resumed.result.status).toBe("complete")
    expect(resumed.checkpoint.budgetUsed.browserActions).toBe(
      firstOutput.checkpoint.budgetUsed.browserActions + 1
    )
    expect(safeBrowser.replayedOptions[0]?.storageStateReference).toBe(
      browserOptions().storageStateReference
    )
    const mismatchedAuth = await createApplicationExplorer({
      browser: safeBrowser,
      planner: new ScriptedPlanner([]),
    }).run({
      mission: mission(),
      browserOptions: {
        ...browserOptions(),
        storageStateReference: `secret-ref:v1:${"d".repeat(64)}`,
      },
      checkpoint: firstOutput.checkpoint,
      priorEvidenceClaims: firstOutput.evidenceClaims,
    })
    expect(mismatchedAuth.result.status).toBe("needs_human")
    expect(mismatchedAuth.result.stopReason.code).toBe(
      "authentication_state_mismatch"
    )
    expect(safeBrowser.replayedOptions).toHaveLength(1)
    expect(mismatchedAuth.checkpoint.budgetUsed.browserActions).toBe(
      firstOutput.checkpoint.budgetUsed.browserActions
    )

    const replayDenied = await createApplicationExplorer({
      browser: safeBrowser,
      planner: new ScriptedPlanner([]),
    }).run({
      mission: mission({
        budget: {
          ...budget,
          browserActions: firstOutput.checkpoint.budgetUsed.browserActions,
        },
      }),
      browserOptions: browserOptions(),
      checkpoint: firstOutput.checkpoint,
      priorEvidenceClaims: firstOutput.evidenceClaims,
    })
    expect(replayDenied.result.status).toBe("budget_exhausted")
    expect(replayDenied.checkpoint.budgetUsed.browserActions).toBe(
      firstOutput.checkpoint.budgetUsed.browserActions
    )
    expect(safeBrowser.replayedOptions).toHaveLength(1)

    const mutable = candidate({
      id: "6",
      signature: "7",
      name: "Submit mutable form",
      category: "unknown_submission",
      replaySafe: false,
    })
    const mutableStart = observation("6", "7", "/form", "Form", [mutable])
    const mutableEnd = observation("7", "8", "/done", "Done", [])
    const mutableBrowser = new ScriptedBrowser(mutableStart, [
      transition("8", mutableStart, mutable, mutableEnd),
    ])
    const mutableOutput = await createApplicationExplorer({
      browser: mutableBrowser,
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", mutableStart, mutable),
        finishDecision("goal_completed"),
      ]),
    }).run({ mission: mission(), browserOptions: browserOptions() })
    expect(mutableOutput.checkpoint.replayBoundary.requiresHumanReview).toBe(
      true
    )

    const interrupted = await createApplicationExplorer({
      browser: mutableBrowser,
      planner: new ScriptedPlanner([]),
    }).run({
      mission: mission(),
      browserOptions: browserOptions(),
      checkpoint: applicationExplorerCheckpointStateSchema.parse(
        mutableOutput.checkpoint
      ),
      priorEvidenceClaims: mutableOutput.evidenceClaims,
    })
    expect(interrupted.result.status).toBe("needs_human")
    expect(interrupted.result.stopReason.code).toBe("non_idempotent_replay")
    expect(mutableBrowser.replayedOptions).toHaveLength(0)
  })

  it("recovers an in-action crash only for replay-safe work", async () => {
    const safe = candidate({ id: "1", signature: "2", name: "Continue" })
    const first = observation("1", "2", "/", "Start", [safe])
    const second = observation("3", "4", "/next", "Next", [])
    const safeBrowser = new ScriptedBrowser(first, [
      transition("5", first, safe, second),
    ])
    safeBrowser.failNextActionWith = "browser_error"
    const recovered = await createApplicationExplorer({
      browser: safeBrowser,
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", first, safe),
        actionDecision("perform_observed_action", first, safe),
        finishDecision("goal_completed"),
      ]),
    }).run({ mission: mission(), browserOptions: browserOptions() })
    expect(recovered.result.status).toBe("complete")
    expect(safeBrowser.replayedOptions).toHaveLength(1)
    expect(safeBrowser.performed).toEqual([safe.actionId])

    const uncertain = candidate({
      id: "6",
      signature: "7",
      name: "Submit mutable form",
      category: "unknown_submission",
      replaySafe: false,
    })
    const uncertainStart = observation("6", "7", "/form", "Form", [uncertain])
    const uncertainBrowser = new ScriptedBrowser(uncertainStart, [])
    uncertainBrowser.failNextActionWith = "browser_error"
    const interrupted = await createApplicationExplorer({
      browser: uncertainBrowser,
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", uncertainStart, uncertain),
      ]),
    }).run({ mission: mission(), browserOptions: browserOptions() })
    expect(interrupted.result.status).toBe("needs_human")
    expect(interrupted.result.stopReason.code).toBe("non_idempotent_replay")
    expect(uncertainBrowser.replayedOptions).toHaveLength(0)
  })

  it("continues a recovered mission without colliding with prior workflow claims", async () => {
    const firstAction = candidate({ id: "1", signature: "2", name: "First" })
    const secondAction = candidate({ id: "3", signature: "4", name: "Second" })
    const first = observation("1", "2", "/", "Start", [firstAction])
    const second = observation("3", "4", "/middle", "Middle", [secondAction])
    const third = observation("5", "6", "/done", "Done", [])
    const browser = new ScriptedBrowser(first, [
      transition("7", first, firstAction, second),
      transition("8", second, secondAction, third),
    ])
    const initial = await createApplicationExplorer({
      browser,
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", first, firstAction),
        finishDecision("goal_completed"),
      ]),
    }).run({ mission: mission(), browserOptions: browserOptions() })
    const continued = await createApplicationExplorer({
      browser,
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", second, secondAction),
        finishDecision("goal_completed"),
      ]),
    }).run({
      mission: mission(),
      browserOptions: browserOptions(),
      checkpoint: initial.checkpoint,
      priorEvidenceClaims: initial.evidenceClaims,
    })

    expect(continued.result.status).toBe("complete")
    expect(
      continued.evidenceClaims.filter(
        (claim) => claim.claimKind === "flow_step"
      )
    ).toHaveLength(2)
    expect(new Set(continued.result.claims.map((claim) => claim.id)).size).toBe(
      continued.result.claims.length
    )
  })

  it("enforces planner deadlines and cleans up after event persistence failure", async () => {
    const first = observation("1", "2", "/", "Start", [])
    const deadlineBrowser = new ScriptedBrowser(first, [])
    const hangingPlanner: ApplicationExplorerPlannerGateway = {
      async generateStructured<Output>(): Promise<{
        readonly output: Output
        readonly model: string
        readonly usage: {
          readonly inputTokens: number
          readonly outputTokens: number
          readonly totalTokens: number
        }
      }> {
        return new Promise(() => undefined)
      },
    }
    const timed = await createApplicationExplorer({
      browser: deadlineBrowser,
      planner: hangingPlanner,
    }).run({
      mission: mission({ budget: { ...budget, elapsedMs: 25 } }),
      browserOptions: browserOptions(),
    })
    expect(timed.result.status).toBe("budget_exhausted")
    expect(timed.result.stopReason.code).toBe("elapsed_budget_exhausted")
    expect(deadlineBrowser.isActive()).toBe(false)

    const eventBrowser = new ScriptedBrowser(first, [])
    await expect(
      createApplicationExplorer({
        browser: eventBrowser,
        planner: new ScriptedPlanner([]),
        events: {
          async append(event) {
            if (
              event.kind === "tool_completed" &&
              event.toolName === "observe_page"
            ) {
              throw new Error("event persistence unavailable")
            }
          },
        },
      }).run({ mission: mission(), browserOptions: browserOptions() })
    ).rejects.toThrow(/event persistence unavailable/)
    expect(eventBrowser.isActive()).toBe(false)
  })

  it("rejects ungrounded completion and returns a typed login blocker", async () => {
    const first = observation("1", "2", "/login", "Sign in", [])
    const ungrounded = await createApplicationExplorer({
      browser: new ScriptedBrowser(first, []),
      planner: new ScriptedPlanner([finishDecision("goal_completed")]),
    }).run({ mission: mission(), browserOptions: browserOptions() })
    expect(ungrounded.result.status).toBe("partial")
    expect(ungrounded.result.stopReason.code).toBe(
      "completion_without_evidence"
    )

    const login = await createApplicationExplorer({
      browser: new ScriptedBrowser(first, []),
      planner: new ScriptedPlanner([
        finishDecision("login_block", "login_required", "Sign in is required"),
      ]),
    }).run({ mission: mission(), browserOptions: browserOptions() })
    expect(login.result.status).toBe("blocked")
    expect(login.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "login_required", recoverable: true }),
      ])
    )
  })

  it("truncates recovery at the first non-replay-safe path boundary", async () => {
    const firstSafe = candidate({ id: "1", signature: "2", name: "Continue" })
    const unsafe = candidate({
      id: "3",
      signature: "4",
      name: "Submit mutable form",
      category: "unknown_submission",
      replaySafe: false,
    })
    const laterSafe = candidate({
      id: "5",
      signature: "6",
      name: "View result",
    })
    const first = observation("1", "2", "/", "Start", [firstSafe])
    const second = observation("3", "4", "/form", "Form", [unsafe])
    const third = observation("5", "6", "/submitted", "Submitted", [laterSafe])
    const fourth = observation("6", "7", "/result", "Result", [])
    const browser = new ScriptedBrowser(first, [
      transition("7", first, firstSafe, second),
      transition("8", second, unsafe, third),
      transition("9", third, laterSafe, fourth),
    ])
    const output = await createApplicationExplorer({
      browser,
      planner: new ScriptedPlanner([
        actionDecision("perform_observed_action", first, firstSafe),
        actionDecision("perform_observed_action", second, unsafe),
        actionDecision("perform_observed_action", third, laterSafe),
        finishDecision("goal_completed"),
      ]),
    }).run({ mission: mission(), browserOptions: browserOptions() })

    expect(output.checkpoint.path).toHaveLength(3)
    expect(output.checkpoint.replayBoundary.recipe.steps).toHaveLength(1)
    expect(output.checkpoint.replayBoundary.requiresHumanReview).toBe(true)
  })
})
