import { randomBytes } from "node:crypto"

import {
  actionIdSchema,
  applicationIdSchema,
  artifactIdSchema,
  browserObservationSchema,
  browserRecoveryRecipeSchema,
  browserRuntimeFailureSchema,
  browserRuntimeErrorEvidenceSchema,
  browserTransitionEvidenceSchema,
  createActionId,
  createRunScopedEvidenceId,
  createStableKey,
  contentHashSchema,
  hashCanonical,
  httpMethodSchema,
  runIdSchema,
  secretReferenceSchema,
  type ActionId,
  type ApplicationId,
  type ArtifactId,
  type BrowserActionCandidate,
  type BrowserActionKind,
  type BrowserNetworkEvidence,
  type BrowserObservation,
  type BrowserPolicyDecision,
  type BrowserRecoveryRecipe,
  type BrowserReplayStep,
  type BrowserRuntimeErrorEvidence,
  type BrowserRuntimeFailure,
  type BrowserRuntimeFailureCode,
  type BrowserTransitionEvidence,
  type ContentHash,
  type RunId,
} from "@sentinel/contracts"
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType,
  type Frame,
  type Locator,
  type Page,
  type Request,
} from "playwright"
import { ZodError } from "zod"

import {
  classifyBrowserAction,
  createBrowserPolicy,
  isAllowedBrowserUrl,
  isAllowedBrowserWebSocketUrl,
  normalizeRoute,
  toPublicBrowserUrl,
  type BrowserPolicy,
  type BrowserPolicyInput,
} from "./policy.ts"
import {
  BrowserEvidenceRedactor,
  SCREENSHOT_MASK_SELECTOR,
  SCREENSHOT_PII_PATTERNS,
} from "./redaction.ts"

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='textbox']",
  "[role='combobox']",
].join(",")

const SELECTED_TEXT_SELECTOR = [
  "main p",
  "main [role='status']",
  "[role='alert']",
  "[data-sentinel-evidence]",
].join(",")

const DIALOG_SELECTOR = [
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='alert']",
  "dialog[open]",
].join(",")

export interface BrowserArtifactSink {
  persist(input: {
    readonly applicationId: ApplicationId
    readonly runId: RunId
    readonly artifactType: "screenshot" | "trace"
    readonly mimeType: "image/png" | "application/json"
    readonly body: Uint8Array
    readonly retention: "report" | "failure"
  }): Promise<ArtifactId>
}

export interface BrowserStorageStateProvider {
  resolve(
    reference: string
  ): Promise<Exclude<BrowserContextOptions["storageState"], string | undefined>>
}

export interface BrowserInputSlotResolver {
  resolve(runId: RunId, slot: string): Promise<string>
}

export interface BrowserClock {
  now(): Date
}

export interface BrowserLauncher {
  launch(): Promise<Browser>
}

export interface BrowserInputSlotBinding {
  readonly slot: string
  readonly kind: "fill" | "select"
  readonly accessibleName: string
}

export interface BrowserRunOptions {
  readonly applicationId: string
  readonly runId: string
  readonly entryUrl: string
  readonly storageStateReference?: string
  readonly inputSlots?: readonly BrowserInputSlotBinding[]
  readonly policy: BrowserPolicyInput
  readonly traceOnFailure?: boolean
}

export interface BrowserReplayResult {
  readonly finalObservation: BrowserObservation
  readonly transitions: readonly BrowserTransitionEvidence[]
}

export interface BrowserEvidenceRuntime {
  startRun(options: BrowserRunOptions): Promise<BrowserObservation>
  observe(runId: string): Promise<BrowserObservation>
  performAction(
    runId: string,
    actionId: string
  ): Promise<BrowserTransitionEvidence>
  createRecoveryRecipe(runId: string): BrowserRecoveryRecipe
  replay(
    options: BrowserRunOptions,
    recipe: BrowserRecoveryRecipe
  ): Promise<BrowserReplayResult>
  completeRun(runId: string): Promise<void>
  cancelRun(runId: string): Promise<void>
  isActive(runId: string): boolean
}

interface ElementDescriptor {
  readonly tag: string
  readonly role: string
  readonly name: string
  readonly nameFingerprint: ContentHash
  readonly disabled: boolean
  readonly checked?: boolean | undefined
  readonly inputType?: string | undefined
  readonly href?: string | undefined
  readonly submit: boolean
  readonly download: boolean
  readonly opensNewTab: boolean
}

interface PreparedCandidate {
  readonly kind: BrowserActionKind
  readonly role?: string | undefined
  readonly name?: string | undefined
  readonly contextLabel?: string | undefined
  readonly inputSlot?: string | undefined
  readonly disabled: boolean
  readonly signature: ContentHash
  readonly behaviorFingerprint: ContentHash
  readonly policy: BrowserPolicyDecision
  readonly locator?: Locator | undefined
  readonly descriptor?: ElementDescriptor | undefined
}

interface ActionRecord {
  readonly candidate: BrowserActionCandidate
  readonly locator?: Locator | undefined
  readonly descriptor?: ElementDescriptor | undefined
  readonly observation: BrowserObservation
  readonly behaviorFingerprint: ContentHash
  used: boolean
}

interface NetworkRecord {
  readonly requestId: ContentHash
  readonly request: Request
  readonly ordinal: number
  readonly method: string
  readonly normalizedPath: string
  readonly resourceType: string
  readonly startedAt: Date
  completedAt?: Date
  status?: number
  outcome: "response" | "failed" | "pending"
}

interface PageSnapshot {
  readonly url: string
  readonly normalizedRoute: string
  readonly title: string
  readonly headings: readonly string[]
  readonly controls: readonly {
    role: string
    name: string
    disabled: boolean
    checked?: boolean | undefined
  }[]
  readonly dialogs: readonly {
    role: "alert" | "alertdialog" | "dialog"
    name: string
    text: string
  }[]
  readonly selectedText: readonly string[]
  readonly preparedCandidates: readonly PreparedCandidate[]
  readonly stateFingerprint: ContentHash
}

interface RunSession {
  readonly applicationId: ApplicationId
  readonly runId: RunId
  readonly entryUrl: string
  readonly options: BrowserRunOptions
  readonly policy: BrowserPolicy
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  readonly startedAt: Date
  readonly sessionNonce: ContentHash
  readonly inputSlots: readonly BrowserInputSlotBinding[]
  readonly actions: Map<ActionId, ActionRecord>
  readonly network: NetworkRecord[]
  readonly requestRecords: Map<Request, NetworkRecord>
  readonly errors: BrowserRuntimeErrorEvidence[]
  readonly violations: BrowserRuntimeFailureCode[]
  readonly history: BrowserReplayStep[]
  readonly secretValues: Set<string>
  readonly expiration: Promise<never>
  readonly rejectExpiration: (error: BrowserRuntimeError) => void
  actionCount: number
  screenCount: number
  redirectCount: number
  downloadCount: number
  observationOrdinal: number
  actionOrdinal: number
  requestOrdinal: number
  transitionOrdinal: number
  deadline: ReturnType<typeof setTimeout> | undefined
  busy: boolean
  cancelled: boolean
  closed: boolean
}

interface StartControl {
  readonly controller: AbortController
  timedOut: boolean
}

class SystemClock implements BrowserClock {
  now(): Date {
    return new Date()
  }
}

class ChromiumLauncher implements BrowserLauncher {
  constructor(private readonly browserType: BrowserType = chromium) {}

  launch(): Promise<Browser> {
    return this.browserType.launch({
      headless: true,
      args: ["--disable-webrtc", "--disable-background-networking"],
    })
  }
}

export class BrowserRuntimeError extends Error {
  constructor(readonly failure: BrowserRuntimeFailure) {
    super(failure.message)
    this.name = "BrowserRuntimeError"
  }
}

function normalizeReasonCode(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96)
  return normalized.length > 0 && /^[a-z]/.test(normalized)
    ? normalized
    : "unknown"
}

function iso(date: Date): string {
  return date.toISOString()
}

function normalizeVolatileText(input: string): string {
  return input
    .replace(
      /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
      "{timestamp}"
    )
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\b/gi, "{time}")
    .replace(/\b\d{10,13}\b/g, "{timestamp}")
}

function roleForElement(
  tag: string,
  explicitRole: string,
  inputType: string
): string {
  if (explicitRole.length > 0) return normalizeReasonCode(explicitRole)
  if (tag === "a") return "link"
  if (tag === "button") return "button"
  if (tag === "select") return "combobox"
  if (tag === "textarea") return "textbox"
  if (inputType === "checkbox") return "checkbox"
  if (inputType === "radio") return "radio"
  if (["button", "submit", "reset"].includes(inputType)) return "button"
  return "textbox"
}

function kindForElement(descriptor: ElementDescriptor): BrowserActionKind {
  if (descriptor.tag === "a" || descriptor.role === "link") return "navigate"
  if (descriptor.role === "checkbox") return "check"
  if (descriptor.tag === "select" || descriptor.role === "combobox") {
    return "select"
  }
  if (
    descriptor.tag === "input" ||
    descriptor.tag === "textarea" ||
    descriptor.role === "textbox"
  ) {
    return "fill"
  }
  return "click"
}

export class PlaywrightBrowserEvidenceRuntime implements BrowserEvidenceRuntime {
  private readonly sessions = new Map<RunId, RunSession>()
  private readonly startControls = new Map<RunId, StartControl>()
  private readonly terminalFailures = new Map<RunId, "run_expired">()
  private readonly actionOwners = new Map<ActionId, RunId>()

  constructor(
    private readonly artifacts: BrowserArtifactSink,
    private readonly inputResolver: BrowserInputSlotResolver,
    private readonly storageStateProvider?: BrowserStorageStateProvider,
    private readonly launcher: BrowserLauncher = new ChromiumLauncher(),
    private readonly clock: BrowserClock = new SystemClock()
  ) {}

  isActive(runIdInput: string): boolean {
    const parsed = runIdSchema.safeParse(runIdInput)
    return parsed.success && this.sessions.has(parsed.data)
  }

  async startRun(options: BrowserRunOptions): Promise<BrowserObservation> {
    const applicationId = applicationIdSchema.parse(options.applicationId)
    const runId = runIdSchema.parse(options.runId)
    if (this.sessions.has(runId) || this.startControls.has(runId)) {
      throw this.publicError(runId, "run_already_exists", "Run already exists")
    }
    this.terminalFailures.delete(runId)
    const startedAt = this.clock.now()
    const startControl: StartControl = {
      controller: new AbortController(),
      timedOut: false,
    }
    this.startControls.set(runId, startControl)
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    let startDeadline: ReturnType<typeof setTimeout> | undefined
    let setupStage = "policy_validation"
    try {
      const policy = createBrowserPolicy(options.policy)
      startDeadline = setTimeout(() => {
        startControl.timedOut = true
        startControl.controller.abort()
      }, policy.budgets.maxDurationMs)
      if (!isAllowedBrowserUrl(options.entryUrl, policy)) {
        throw this.publicError(
          runId,
          "host_denied",
          "Entry URL is not allowlisted"
        )
      }
      setupStage = "storage_state_resolution"
      const storageState =
        options.storageStateReference === undefined
          ? undefined
          : await this.awaitStart(
              runId,
              this.resolveStorageState(options.storageStateReference)
            )
      setupStage = "browser_launch"
      browser = await this.awaitStart(
        runId,
        this.launcher.launch(),
        async (lateBrowser) => lateBrowser.close().catch(() => undefined)
      )
      setupStage = "context_creation"
      context = await this.awaitStart(
        runId,
        browser.newContext({
          acceptDownloads: false,
          serviceWorkers: "block",
          ...(storageState === undefined ? {} : { storageState }),
        }),
        async (lateContext) => lateContext.close().catch(() => undefined)
      )
      setupStage = "context_hardening"
      await this.awaitStart(
        runId,
        context.addInitScript(() => {
          Object.defineProperty(globalThis, "RTCPeerConnection", {
            configurable: false,
            value: undefined,
            writable: false,
          })
        })
      )
      setupStage = "page_creation"
      const page = await this.awaitStart(
        runId,
        context.newPage(),
        async (latePage) => latePage.close().catch(() => undefined)
      )
      page.setDefaultTimeout(policy.budgets.actionTimeoutMs)
      page.setDefaultNavigationTimeout(policy.budgets.navigationTimeoutMs)
      let rejectExpiration: ((error: BrowserRuntimeError) => void) | undefined
      const expiration = new Promise<never>((_resolve, reject) => {
        rejectExpiration = reject
      })
      void expiration.catch(() => undefined)
      const session: RunSession = {
        applicationId,
        runId,
        entryUrl: new BrowserEvidenceRedactor().redactUrl(options.entryUrl),
        options,
        policy,
        browser,
        context,
        page,
        startedAt,
        sessionNonce: contentHashSchema.parse(
          `sha256:${randomBytes(32).toString("hex")}`
        ),
        inputSlots: options.inputSlots ?? [],
        actions: new Map(),
        network: [],
        requestRecords: new Map(),
        errors: [],
        violations: [],
        history: [],
        secretValues: new Set(
          storageState === undefined
            ? []
            : [
                ...storageState.cookies.map((cookie) => cookie.value),
                ...storageState.origins.flatMap((origin) =>
                  origin.localStorage.map((entry) => entry.value)
                ),
              ]
        ),
        expiration,
        rejectExpiration: (error) => rejectExpiration?.(error),
        actionCount: 0,
        screenCount: 0,
        redirectCount: 0,
        downloadCount: 0,
        observationOrdinal: 0,
        actionOrdinal: 0,
        requestOrdinal: 0,
        transitionOrdinal: 0,
        deadline: undefined,
        busy: false,
        cancelled: false,
        closed: false,
      }
      this.sessions.set(runId, session)
      session.deadline = setTimeout(() => {
        void this.expireSession(session)
      }, this.remainingRunDurationMs(session))
      setupStage = "policy_guards"
      await this.awaitSessionOperation(session, this.attachGuards(session))
      setupStage = "entry_navigation"
      await this.awaitSessionOperation(
        session,
        page.goto(options.entryUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.boundedTimeout(
            session,
            policy.budgets.navigationTimeoutMs
          ),
        })
      )
      await this.throwPendingViolation(session)
      this.assertRunDuration(session)
      setupStage = "initial_observation"
      if (policy.budgets.observationSettleMs > 0) {
        await this.awaitSessionOperation(
          session,
          page.waitForTimeout(policy.budgets.observationSettleMs)
        )
      }
      const observation = await this.awaitSessionOperation(
        session,
        this.captureObservation(session)
      )
      await this.throwPendingViolation(session)
      this.assertRunDuration(session)
      return observation
    } catch (error) {
      const session = this.sessions.get(runId)
      if (session !== undefined) {
        await this.cleanup(session)
        this.sessions.delete(runId)
      } else {
        await context?.close().catch(() => undefined)
        await browser?.close().catch(() => undefined)
      }
      if (error instanceof BrowserRuntimeError) throw error
      if (startControl.timedOut) {
        throw this.publicError(
          runId,
          "run_expired",
          "Run time limit was reached"
        )
      }
      throw this.publicError(
        runId,
        "browser_error",
        `Browser setup failed during ${setupStage}: ${this.safeSetupDiagnostic(error)}`
      )
    } finally {
      if (startDeadline !== undefined) clearTimeout(startDeadline)
      this.startControls.delete(runId)
    }
  }

  async observe(runIdInput: string): Promise<BrowserObservation> {
    const session = this.requireSession(runIdInput)
    if (session.busy) {
      throw this.publicError(session.runId, "run_busy", "Run is busy")
    }
    session.busy = true
    try {
      this.assertRunDuration(session)
      await this.throwPendingViolation(session)
      if (session.policy.budgets.observationSettleMs > 0) {
        await this.awaitSessionOperation(
          session,
          session.page.waitForTimeout(
            session.policy.budgets.observationSettleMs
          )
        )
      }
      const observation = await this.awaitSessionOperation(
        session,
        this.captureObservation(session)
      )
      await this.throwPendingViolation(session)
      this.assertRunDuration(session)
      return observation
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error
      throw await this.failureWithArtifacts(
        session,
        "browser_error",
        "Browser observation failed"
      )
    } finally {
      session.busy = false
    }
  }

  async performAction(
    runIdInput: string,
    actionIdInput: string
  ): Promise<BrowserTransitionEvidence> {
    const session = this.requireSession(runIdInput)
    const actionId = actionIdSchema.parse(actionIdInput)
    if (session.busy) {
      throw this.publicError(session.runId, "run_busy", "Run is busy", actionId)
    }
    session.busy = true
    try {
      await this.throwPendingViolation(session, actionId)
      this.assertRunBudgets(session, actionId)
      const owner = this.actionOwners.get(actionId)
      if (owner !== undefined && owner !== session.runId) {
        throw this.publicError(
          session.runId,
          "action_cross_run",
          "Action belongs to a different run",
          actionId
        )
      }
      const record = session.actions.get(actionId)
      if (record === undefined) {
        throw this.publicError(
          session.runId,
          "action_not_found",
          "Action was not observed for this run",
          actionId
        )
      }
      if (record.used) {
        throw this.publicError(
          session.runId,
          "action_reused",
          "Action has already been used",
          actionId
        )
      }
      if (this.clock.now().getTime() > Date.parse(record.candidate.expiresAt)) {
        throw this.publicError(
          session.runId,
          "action_expired",
          "Action has expired",
          actionId
        )
      }
      if (record.candidate.disabled) {
        throw this.publicError(
          session.runId,
          "action_disabled",
          "Action target is disabled",
          actionId
        )
      }

      const current = await this.inspectPage(session)
      const currentCandidate = current.preparedCandidates.find(
        (candidate) => candidate.signature === record.candidate.signature
      )
      if (
        currentCandidate === undefined ||
        currentCandidate.behaviorFingerprint !== record.behaviorFingerprint
      ) {
        throw this.publicError(
          session.runId,
          "action_stale",
          "Page state changed after the action was observed",
          actionId
        )
      }
      const currentRecord: ActionRecord = {
        ...record,
        locator: currentCandidate.locator,
        descriptor: currentCandidate.descriptor,
      }
      const decision = this.reclassify(currentRecord, session.policy)
      if (!decision.allowed) {
        throw this.publicError(
          session.runId,
          "policy_denied",
          `Action denied by ${decision.reason}`,
          actionId
        )
      }
      this.assertActionSideEffectBudgets(session, currentRecord, actionId)

      record.used = true
      session.actionCount += 1
      const networkStart = session.requestOrdinal
      const errorStart = session.errors.length
      try {
        await this.awaitSessionOperation(
          session,
          this.executeCandidate(session, currentRecord)
        )
        if (session.policy.budgets.observationSettleMs > 0) {
          await this.awaitSessionOperation(
            session,
            session.page.waitForTimeout(
              Math.min(
                session.policy.budgets.observationSettleMs,
                this.remainingRunDurationMs(session)
              )
            )
          )
        }
        this.assertRunDuration(session, actionId)
        const violation = session.violations[0]
        if (violation !== undefined) {
          throw await this.failureWithArtifacts(
            session,
            violation,
            "Browser action triggered a denied side effect",
            actionId
          )
        }
        const after = await this.awaitSessionOperation(
          session,
          this.captureObservation(session, actionId)
        )
        await this.throwPendingViolation(session, actionId)
        const afterScreenId = createStableKey({
          kind: "screen",
          applicationId: session.applicationId,
          normalizedRoute: after.normalizedRoute,
          stateFingerprint: after.stateFingerprint,
        })
        const transition = browserTransitionEvidenceSchema.parse({
          schemaVersion: 1,
          evidenceId: createRunScopedEvidenceId({
            applicationId: session.applicationId,
            runId: session.runId,
            sourceId: afterScreenId,
            kind: "browser_transition",
            ordinal: session.transitionOrdinal++,
          }),
          runId: session.runId,
          action: record.candidate,
          before: record.observation,
          after,
          network: this.networkWindow(session, networkStart),
          errors: session.errors.slice(errorStart),
          observedAt: iso(this.clock.now()),
        })
        if (decision.replaySafe) {
          session.history.push({
            ordinal: session.history.length,
            signature: record.candidate.signature,
            kind: record.candidate.kind,
            ...(record.candidate.name === undefined
              ? {}
              : { name: record.candidate.name }),
            ...(record.candidate.inputSlot === undefined
              ? {}
              : { inputSlot: record.candidate.inputSlot }),
            expectedBeforeFingerprint: transition.before.stateFingerprint,
            expectedAfterFingerprint: transition.after.stateFingerprint,
            replaySafe: true,
          })
        }
        return transition
      } catch (error) {
        if (error instanceof BrowserRuntimeError) {
          if (
            error.failure.screenshotArtifactId !== undefined ||
            error.failure.traceArtifactId !== undefined
          ) {
            throw error
          }
          throw await this.failureWithArtifacts(
            session,
            error.failure.code,
            error.failure.message,
            actionId
          )
        }
        const violation = session.violations[0]
        const expired =
          this.terminalFailures.get(session.runId) === "run_expired" ||
          this.remainingRunDurationMs(session) <= 0
        throw await this.failureWithArtifacts(
          session,
          violation ?? (expired ? "run_expired" : "browser_error"),
          violation !== undefined
            ? "Browser action triggered a denied side effect"
            : expired
              ? "Run time limit was reached"
              : `Browser action failed: ${this.safeSetupDiagnostic(error)}`,
          actionId
        )
      }
    } finally {
      session.busy = false
    }
  }

  createRecoveryRecipe(runIdInput: string): BrowserRecoveryRecipe {
    const session = this.requireSession(runIdInput)
    return browserRecoveryRecipeSchema.parse({
      schemaVersion: 1,
      applicationId: session.applicationId,
      sourceRunId: session.runId,
      entryUrl: session.entryUrl,
      steps: session.history,
      createdAt: iso(this.clock.now()),
    })
  }

  async replay(
    options: BrowserRunOptions,
    recipeInput: BrowserRecoveryRecipe
  ): Promise<BrowserReplayResult> {
    const recipe = browserRecoveryRecipeSchema.parse(recipeInput)
    if (options.applicationId !== recipe.applicationId) {
      throw this.publicError(
        runIdSchema.parse(options.runId),
        "recovery_mismatch",
        "Recovery recipe belongs to a different application"
      )
    }
    let observation = await this.startRun({
      ...options,
      entryUrl: recipe.entryUrl,
    })
    const transitions: BrowserTransitionEvidence[] = []
    try {
      for (const step of recipe.steps) {
        if (observation.stateFingerprint !== step.expectedBeforeFingerprint) {
          throw this.publicError(
            observation.runId,
            "recovery_mismatch",
            "Recovery state did not match the expected fingerprint"
          )
        }
        const candidate = observation.candidates.find(
          (value) =>
            value.signature === step.signature && value.policy.replaySafe
        )
        if (candidate === undefined) {
          throw this.publicError(
            observation.runId,
            "recovery_mismatch",
            "Recovery action was not available in the observed state"
          )
        }
        const transition = await this.performAction(
          observation.runId,
          candidate.actionId
        )
        if (
          transition.after.stateFingerprint !== step.expectedAfterFingerprint
        ) {
          throw this.publicError(
            observation.runId,
            "recovery_mismatch",
            "Recovery action reached an unexpected state"
          )
        }
        transitions.push(transition)
        observation = transition.after
      }
      return { finalObservation: observation, transitions }
    } catch (error) {
      await this.cancelRun(options.runId)
      throw error
    }
  }

  async completeRun(runIdInput: string): Promise<void> {
    const session = this.requireSession(runIdInput)
    if (session.busy) {
      throw this.publicError(session.runId, "run_busy", "Run is busy")
    }
    session.busy = true
    try {
      if (session.policy.budgets.observationSettleMs > 0) {
        await this.awaitSessionOperation(
          session,
          session.page.waitForTimeout(
            Math.min(
              session.policy.budgets.observationSettleMs,
              this.remainingRunDurationMs(session)
            )
          )
        )
      }
      await this.throwPendingViolation(session)
    } finally {
      await this.cleanup(session)
      this.sessions.delete(session.runId)
    }
  }

  async cancelRun(runIdInput: string): Promise<void> {
    const parsed = runIdSchema.parse(runIdInput)
    this.startControls.get(parsed)?.controller.abort()
    const session = this.sessions.get(parsed)
    if (session === undefined) return
    session.cancelled = true
    await this.cleanup(session)
    this.sessions.delete(parsed)
  }

  async executeRun<T>(
    options: BrowserRunOptions,
    callback: (
      runtime: BrowserEvidenceRuntime,
      observation: BrowserObservation
    ) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const runId = runIdSchema.parse(options.runId)
    let rejectCancellation: ((error: BrowserRuntimeError) => void) | undefined
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject
    })
    const abortHandler = () => {
      void this.cancelRun(runId).finally(() => {
        rejectCancellation?.(
          this.publicError(runId, "run_cancelled", "Run was cancelled")
        )
      })
    }
    signal?.addEventListener("abort", abortHandler, { once: true })
    try {
      if (signal?.aborted === true) {
        abortHandler()
      }
      const observation = await Promise.race([
        this.startRun(options),
        cancellation,
      ])
      const session = this.requireSession(runId)
      return await Promise.race([
        callback(this, observation),
        cancellation,
        session.expiration,
      ])
    } finally {
      signal?.removeEventListener("abort", abortHandler)
      await this.cancelRun(runId)
    }
  }

  private async resolveStorageState(
    referenceInput: string
  ): Promise<
    Exclude<BrowserContextOptions["storageState"], string | undefined>
  > {
    const reference = secretReferenceSchema.parse(referenceInput)
    if (this.storageStateProvider === undefined) {
      throw new Error("Storage state provider is not configured")
    }
    return this.storageStateProvider.resolve(reference)
  }

  private requireSession(runIdInput: string): RunSession {
    const runId = runIdSchema.parse(runIdInput)
    const session = this.sessions.get(runId)
    if (session === undefined || session.closed) {
      if (this.terminalFailures.get(runId) === "run_expired") {
        throw this.publicError(
          runId,
          "run_expired",
          "Run time limit was reached"
        )
      }
      throw this.publicError(runId, "run_not_found", "Run was not found")
    }
    if (session.cancelled) {
      throw this.publicError(runId, "run_cancelled", "Run was cancelled")
    }
    return session
  }

  private safeSetupDiagnostic(error: unknown): string {
    if (error instanceof ZodError) {
      return error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}:${issue.code}`)
        .join(",")
    }
    if (
      error instanceof Error &&
      ["ZodError", "TypeError", "RangeError"].includes(error.name)
    ) {
      return error.name
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      return "action_timeout"
    }
    if (error instanceof Error) {
      if (/not visible/i.test(error.message)) return "target_not_visible"
      if (/detached/i.test(error.message)) return "target_detached"
      if (/intercepts pointer events/i.test(error.message)) {
        return "target_intercepted"
      }
    }
    return "browser_error"
  }

  private publicError(
    runId: RunId,
    code: BrowserRuntimeFailureCode,
    message: string,
    actionId?: ActionId
  ): BrowserRuntimeError {
    return new BrowserRuntimeError(
      browserRuntimeFailureSchema.parse({
        schemaVersion: 1,
        code,
        runId,
        actionId,
        message: new BrowserEvidenceRedactor().redactText(message, 1_024),
        observedAt: iso(this.clock.now()),
      })
    )
  }

  private async failureWithArtifacts(
    session: RunSession,
    code: BrowserRuntimeFailureCode,
    message: string,
    actionId?: ActionId
  ): Promise<BrowserRuntimeError> {
    const screenshotArtifactId = await this.captureScreenshot(
      session,
      "failure"
    ).catch(() => undefined)
    const traceArtifactId = await this.captureFailureTrace(session).catch(
      () => undefined
    )
    return new BrowserRuntimeError(
      browserRuntimeFailureSchema.parse({
        schemaVersion: 1,
        code,
        runId: session.runId,
        actionId,
        message: this.redactor(session).redactText(message, 1_024),
        screenshotArtifactId,
        traceArtifactId,
        observedAt: iso(this.clock.now()),
      })
    )
  }

  private async awaitStart<T>(
    runId: RunId,
    operation: Promise<T>,
    disposeLateValue?: (value: T) => void | Promise<void>
  ): Promise<T> {
    const control = this.startControls.get(runId)
    if (control === undefined) return operation
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const dispose = (value: T): void => {
        if (disposeLateValue !== undefined) {
          void Promise.resolve(disposeLateValue(value)).catch(() => undefined)
        }
      }
      const abort = (): void => {
        if (settled) return
        settled = true
        void operation.then(dispose, () => undefined)
        reject(
          this.publicError(
            runId,
            control.timedOut ? "run_expired" : "run_cancelled",
            control.timedOut
              ? "Run time limit was reached"
              : "Run was cancelled"
          )
        )
      }
      control.controller.signal.addEventListener("abort", abort, { once: true })
      if (control.controller.signal.aborted) abort()
      void operation.then(
        (value) => {
          control.controller.signal.removeEventListener("abort", abort)
          if (settled) return
          settled = true
          resolve(value)
        },
        (error: unknown) => {
          control.controller.signal.removeEventListener("abort", abort)
          if (settled) return
          settled = true
          reject(error)
        }
      )
    })
  }

  private async expireSession(session: RunSession): Promise<void> {
    if (session.closed) return
    this.terminalFailures.set(session.runId, "run_expired")
    await this.cleanup(session)
    this.sessions.delete(session.runId)
    session.rejectExpiration(
      this.publicError(
        session.runId,
        "run_expired",
        "Run time limit was reached"
      )
    )
    while (this.terminalFailures.size > 1_000) {
      const oldest = this.terminalFailures.keys().next().value as
        RunId | undefined
      if (oldest === undefined) break
      this.terminalFailures.delete(oldest)
    }
  }

  private async throwPendingViolation(
    session: RunSession,
    actionId?: ActionId
  ): Promise<void> {
    const violation = session.violations[0]
    if (violation === undefined) return
    throw await this.failureWithArtifacts(
      session,
      violation,
      "Browser activity triggered a denied side effect",
      actionId
    )
  }

  private async awaitSessionOperation<T>(
    session: RunSession,
    operation: Promise<T>
  ): Promise<T> {
    return Promise.race([operation, session.expiration])
  }

  private assertRunBudgets(session: RunSession, actionId: ActionId): void {
    if (session.cancelled) {
      throw this.publicError(
        session.runId,
        "run_cancelled",
        "Run was cancelled",
        actionId
      )
    }
    this.assertRunDuration(session, actionId)
    if (session.actionCount >= session.policy.budgets.maxActions) {
      throw this.publicError(
        session.runId,
        "action_limit_reached",
        "Action limit was reached",
        actionId
      )
    }
    if (session.screenCount >= session.policy.budgets.maxScreens) {
      throw this.publicError(
        session.runId,
        "screen_limit_reached",
        "Screen observation limit was reached",
        actionId
      )
    }
  }

  private assertRunDuration(session: RunSession, actionId?: ActionId): void {
    if (this.remainingRunDurationMs(session) <= 0) {
      throw this.publicError(
        session.runId,
        "run_expired",
        "Run time limit was reached",
        actionId
      )
    }
  }

  private remainingRunDurationMs(session: RunSession): number {
    return Math.max(
      0,
      session.policy.budgets.maxDurationMs -
        (this.clock.now().getTime() - session.startedAt.getTime())
    )
  }

  private boundedTimeout(session: RunSession, configured: number): number {
    return Math.max(
      1,
      Math.min(configured, this.remainingRunDurationMs(session))
    )
  }

  private assertActionSideEffectBudgets(
    session: RunSession,
    record: ActionRecord,
    actionId: ActionId
  ): void {
    if (
      record.descriptor?.download === true &&
      session.downloadCount >= session.policy.budgets.maxDownloads
    ) {
      throw this.publicError(
        session.runId,
        "download_denied",
        "Download limit was reached",
        actionId
      )
    }
    if (
      record.descriptor?.opensNewTab === true &&
      session.context.pages().length >= session.policy.budgets.maxTabs
    ) {
      throw this.publicError(
        session.runId,
        "tab_limit_reached",
        "Tab limit was reached",
        actionId
      )
    }
  }

  private async attachGuards(session: RunSession): Promise<void> {
    await session.context.route("**/*", async (route) => {
      const request = route.request()
      if (!isAllowedBrowserUrl(request.url(), session.policy)) {
        session.violations.push("host_denied")
        await route.abort("blockedbyclient")
        return
      }
      if (session.redirectCount > session.policy.budgets.maxRedirects) {
        session.violations.push("redirect_limit_reached")
        await route.abort("blockedbyclient")
        return
      }
      await route.continue()
    })
    await session.context.routeWebSocket("**/*", (webSocket) => {
      if (!isAllowedBrowserWebSocketUrl(webSocket.url(), session.policy)) {
        session.violations.push("host_denied")
        webSocket.close({ code: 1008, reason: "Blocked by browser policy" })
        return
      }
      webSocket.connectToServer()
    })

    session.context.on("request", (request) => {
      let url: URL
      try {
        url = new URL(this.redactor(session).redactUrl(request.url()))
      } catch {
        return
      }
      const startedAt = this.clock.now()
      const ordinal = session.requestOrdinal++
      const record: NetworkRecord = {
        requestId: hashCanonical({
          runId: session.runId,
          ordinal,
          method: request.method(),
          path: normalizeRoute(url.pathname),
        }),
        request,
        ordinal,
        method: request.method(),
        normalizedPath: normalizeRoute(url.pathname),
        resourceType: normalizeReasonCode(request.resourceType()),
        startedAt,
        outcome: "pending",
      }
      session.network.push(record)
      session.requestRecords.set(request, record)
    })
    session.context.on("response", (response) => {
      const record = session.requestRecords.get(response.request())
      if (record === undefined) return
      record.status = response.status()
      record.completedAt = this.clock.now()
      record.outcome = "response"
      if (response.status() >= 300 && response.status() < 400) {
        session.redirectCount += 1
        if (session.redirectCount > session.policy.budgets.maxRedirects) {
          session.violations.push("redirect_limit_reached")
        }
      }
    })
    session.context.on("requestfailed", (request) => {
      const record = session.requestRecords.get(request)
      if (record === undefined) return
      record.completedAt = this.clock.now()
      record.outcome = "failed"
    })
    session.context.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return
      session.errors.push(
        browserRuntimeErrorEvidenceSchema.parse({
          kind: "console",
          message: this.redactor(session).redactText(message.text(), 1_024),
          observedAt: iso(this.clock.now()),
        })
      )
    })
    session.page.on("pageerror", (error) => {
      session.errors.push(
        browserRuntimeErrorEvidenceSchema.parse({
          kind: "page",
          message: this.redactor(session).errorMessage(error),
          observedAt: iso(this.clock.now()),
        })
      )
    })
    session.page.on("download", (download) => {
      session.downloadCount += 1
      if (
        session.downloadCount > session.policy.budgets.maxDownloads ||
        !session.policy.allowedCategories.has("download")
      ) {
        session.violations.push("download_denied")
      }
      void download.cancel()
    })
    session.context.on("page", (page) => {
      if (page === session.page) return
      if (session.context.pages().length > session.policy.budgets.maxTabs) {
        session.violations.push("tab_limit_reached")
      } else if (!session.policy.allowedCategories.has("popup")) {
        session.violations.push("policy_denied")
      }
      void page.close()
    })
    session.context.on("dialog", (dialog) => {
      session.violations.push("policy_denied")
      void dialog.dismiss()
    })
  }

  private async inspectPage(session: RunSession): Promise<PageSnapshot> {
    const redactor = this.redactor(session)
    const url = redactor.redactUrl(toPublicBrowserUrl(session.page.url()))
    if (!isAllowedBrowserUrl(url, session.policy)) {
      throw this.publicError(
        session.runId,
        "host_denied",
        "Page left allowlist"
      )
    }
    const title = redactor.redactText(await session.page.title(), 512)
    const headings = await this.visibleTexts(
      session.page.getByRole("heading"),
      50,
      redactor,
      512
    )
    const selectedText = await this.visibleTexts(
      session.page.locator(SELECTED_TEXT_SELECTOR),
      50,
      redactor,
      4_096
    )
    const dialogs = await this.readDialogs(session, redactor)
    const preparedCandidates = await this.readCandidates(session, redactor)
    const controls = preparedCandidates
      .filter((candidate) => candidate.descriptor !== undefined)
      .map((candidate) => {
        const checked = candidate.descriptor?.checked
        return {
          role: candidate.role ?? "unknown",
          name: candidate.name ?? "Unnamed control",
          disabled: candidate.disabled,
          ...(checked === undefined ? {} : { checked }),
        }
      })
    const normalizedRoute = normalizeRoute(url)
    const stateFingerprint = hashCanonical({
      normalizedRoute,
      title: normalizeVolatileText(title),
      headings: headings.map(normalizeVolatileText),
      controls: controls.map((control) => ({
        ...control,
        name: normalizeVolatileText(control.name),
      })),
      dialogs: dialogs.map((dialog) => ({
        ...dialog,
        name: normalizeVolatileText(dialog.name),
        text: normalizeVolatileText(dialog.text),
      })),
      actions: preparedCandidates
        .filter((candidate) => candidate.descriptor !== undefined)
        .map((candidate) => ({
          signature: candidate.signature,
          disabled: candidate.disabled,
          policy: candidate.policy,
        })),
    })
    return {
      url,
      normalizedRoute,
      title,
      headings,
      controls,
      dialogs,
      selectedText,
      preparedCandidates,
      stateFingerprint,
    }
  }

  private async captureObservation(
    session: RunSession,
    priorActionId?: ActionId
  ): Promise<BrowserObservation> {
    if (session.screenCount >= session.policy.budgets.maxScreens) {
      throw this.publicError(
        session.runId,
        "screen_limit_reached",
        "Screen observation limit was reached",
        priorActionId
      )
    }
    const snapshot = await this.inspectPage(session)
    const screenId = createStableKey({
      kind: "screen",
      applicationId: session.applicationId,
      normalizedRoute: snapshot.normalizedRoute,
      stateFingerprint: snapshot.stateFingerprint,
    })
    const observationOrdinal = session.observationOrdinal++
    const observedAt = this.clock.now()
    const expiresAt = new Date(
      observedAt.getTime() + session.policy.budgets.actionExpiryMs
    )
    const candidates = snapshot.preparedCandidates.map((prepared) => {
      const actionId = createActionId({
        applicationId: session.applicationId,
        runId: session.runId,
        sessionNonce: session.sessionNonce,
        stateFingerprint: snapshot.stateFingerprint,
        actionType: prepared.kind,
        ordinal: session.actionOrdinal++,
      })
      const candidate: BrowserActionCandidate = {
        actionId,
        signature: prepared.signature,
        kind: prepared.kind,
        ...(prepared.role === undefined ? {} : { role: prepared.role }),
        ...(prepared.name === undefined ? {} : { name: prepared.name }),
        ...(prepared.contextLabel === undefined
          ? {}
          : { contextLabel: prepared.contextLabel }),
        ...(prepared.inputSlot === undefined
          ? {}
          : { inputSlot: prepared.inputSlot }),
        disabled: prepared.disabled,
        policy: prepared.policy,
        expiresAt: iso(expiresAt),
      }
      return { candidate, prepared }
    })
    const screenshotArtifactId = await this.captureScreenshot(session, "report")
    const observation = browserObservationSchema.parse({
      schemaVersion: 1,
      evidenceId: createRunScopedEvidenceId({
        applicationId: session.applicationId,
        runId: session.runId,
        sourceId: screenId,
        kind: "browser_observation",
        ordinal: observationOrdinal,
      }),
      applicationId: session.applicationId,
      runId: session.runId,
      url: snapshot.url,
      normalizedRoute: snapshot.normalizedRoute,
      title: snapshot.title,
      headings: snapshot.headings,
      controls: snapshot.controls,
      dialogs: snapshot.dialogs,
      selectedText: snapshot.selectedText,
      candidates: candidates.map(({ candidate }) => candidate),
      stateFingerprint: snapshot.stateFingerprint,
      ...(screenshotArtifactId === undefined ? {} : { screenshotArtifactId }),
      errors: session.errors.slice(-100),
      ...(priorActionId === undefined ? {} : { priorActionId }),
      observedAt: iso(observedAt),
    })
    for (const { candidate, prepared } of candidates) {
      session.actions.set(candidate.actionId, {
        candidate,
        locator: prepared.locator,
        descriptor: prepared.descriptor,
        observation,
        behaviorFingerprint: prepared.behaviorFingerprint,
        used: false,
      })
      this.actionOwners.set(candidate.actionId, session.runId)
    }
    session.screenCount += 1
    return observation
  }

  private async readCandidates(
    session: RunSession,
    redactor: BrowserEvidenceRedactor
  ): Promise<PreparedCandidate[]> {
    const result: PreparedCandidate[] = []
    const occurrences = new Map<string, number>()
    const locators = session.page.locator(INTERACTIVE_SELECTOR)
    const count = Math.min(await locators.count(), 500)
    for (let index = 0; index < count && result.length < 248; index += 1) {
      const locator = locators.nth(index)
      if (!(await locator.isVisible().catch(() => false))) continue
      const raw = await locator.evaluate((element) => {
        const html = element as HTMLElement
        const input = element instanceof HTMLInputElement ? element : undefined
        const labelledControl =
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement
            ? element
            : undefined
        const labels = labelledControl?.labels
          ? [...labelledControl.labels]
              .map((label) =>
                [...label.childNodes]
                  .filter((node) => node.nodeType === Node.TEXT_NODE)
                  .map((node) => node.textContent ?? "")
                  .join(" ")
              )
              .join(" ")
          : ""
        const tag = html.tagName.toLowerCase()
        const inputType = input?.type.toLowerCase() ?? ""
        const inputButtonName = ["button", "submit", "reset"].includes(
          inputType
        )
          ? (input?.value ?? "")
          : ""
        const valueBearingControl =
          labelledControl !== undefined ||
          html.isContentEditable ||
          ["textbox", "combobox"].includes(
            html.getAttribute("role")?.toLowerCase() ?? ""
          )
        const name =
          html.getAttribute("aria-label") ||
          labels ||
          (valueBearingControl ? "" : html.innerText) ||
          html.getAttribute("placeholder") ||
          html.getAttribute("title") ||
          inputButtonName ||
          ""
        let contextLabel = ""
        let context = html.parentElement
        for (let depth = 0; depth < 6 && context !== null; depth += 1) {
          const heading = context.querySelector(
            "h1, h2, h3, h4, [role='heading']"
          ) as HTMLElement | null
          const text = heading?.innerText.trim() ?? ""
          if (text.length > 0 && text !== name.trim()) {
            contextLabel = text
            break
          }
          context = context.parentElement
        }
        const button =
          element instanceof HTMLButtonElement ? element : undefined
        const anchor =
          element instanceof HTMLAnchorElement ? element : undefined
        return {
          tag,
          explicitRole: html.getAttribute("role") ?? "",
          name,
          contextLabel,
          disabled:
            html.getAttribute("aria-disabled") === "true" ||
            ("disabled" in html && Boolean(html.disabled)),
          checked:
            inputType === "checkbox" || inputType === "radio"
              ? input?.checked
              : undefined,
          inputType,
          href: anchor?.href,
          submit:
            inputType === "submit" ||
            button?.type === "submit" ||
            html.getAttribute("type") === "submit",
          download: anchor?.hasAttribute("download") ?? false,
          opensNewTab: anchor?.target === "_blank",
        }
      })
      const role = roleForElement(raw.tag, raw.explicitRole, raw.inputType)
      const contextLabel = redactor.redactText(raw.contextLabel, 512)
      const descriptor: ElementDescriptor = {
        tag: raw.tag,
        role,
        name: redactor.redactText(raw.name, 512),
        nameFingerprint: hashCanonical({ accessibleName: raw.name }),
        disabled: raw.disabled,
        checked: raw.checked,
        inputType: raw.inputType,
        href: raw.href,
        submit: raw.submit,
        download: raw.download,
        opensNewTab: raw.opensNewTab,
      }
      const kind = kindForElement(descriptor)
      const inputSlot = this.matchInputSlot(session, kind, descriptor.name)
      const semanticName = normalizeVolatileText(descriptor.name)
      const semanticKey = JSON.stringify({
        kind,
        role,
        name: semanticName,
        contextLabel,
        inputSlot,
      })
      const occurrence = occurrences.get(semanticKey) ?? 0
      occurrences.set(semanticKey, occurrence + 1)
      const signature = hashCanonical({
        kind,
        role,
        name: semanticName,
        ...(contextLabel.length === 0 ? {} : { contextLabel }),
        ...(inputSlot === undefined ? {} : { inputSlot }),
        tag: descriptor.tag,
        ...(descriptor.inputType === undefined
          ? {}
          : { inputType: descriptor.inputType }),
        ...(descriptor.href === undefined
          ? {}
          : { targetUrl: redactor.redactUrl(descriptor.href) }),
        submit: descriptor.submit,
        download: descriptor.download,
        opensNewTab: descriptor.opensNewTab,
        occurrence,
      })
      const behaviorFingerprint = hashCanonical({
        tag: descriptor.tag,
        role: descriptor.role,
        nameFingerprint: descriptor.nameFingerprint,
        ...(descriptor.inputType === undefined
          ? {}
          : { inputType: descriptor.inputType }),
        ...(descriptor.href === undefined ? {} : { href: descriptor.href }),
        submit: descriptor.submit,
        download: descriptor.download,
        opensNewTab: descriptor.opensNewTab,
      })
      result.push({
        kind,
        role,
        name: descriptor.name,
        ...(contextLabel.length === 0 ? {} : { contextLabel }),
        inputSlot,
        disabled: descriptor.disabled,
        signature,
        behaviorFingerprint,
        policy: classifyBrowserAction(
          {
            kind,
            role,
            name: descriptor.name,
            inputSlot,
            targetUrl: descriptor.href,
            submit: descriptor.submit,
            download: descriptor.download,
            opensNewTab: descriptor.opensNewTab,
          },
          session.policy
        ),
        locator,
        descriptor,
      })
    }

    for (const kind of ["back", "reload"] as const) {
      const name = kind === "back" ? "Go back" : "Reload page"
      result.push({
        kind,
        role: "navigation",
        name,
        disabled: kind === "back" && session.actionCount === 0,
        signature: hashCanonical({ kind, role: "navigation", name }),
        behaviorFingerprint: hashCanonical({ kind, role: "navigation" }),
        policy: classifyBrowserAction(
          { kind, role: "navigation", name },
          session.policy
        ),
      })
    }
    return result
  }

  private matchInputSlot(
    session: RunSession,
    kind: BrowserActionKind,
    name: string
  ): string | undefined {
    const binding = session.inputSlots.find(
      (value) =>
        value.kind === kind &&
        value.accessibleName.localeCompare(name, undefined, {
          sensitivity: "accent",
        }) === 0
    )
    return binding === undefined ? undefined : normalizeReasonCode(binding.slot)
  }

  private async readDialogs(
    session: RunSession,
    redactor: BrowserEvidenceRedactor
  ): Promise<PageSnapshot["dialogs"]> {
    const result: Array<{
      role: "alert" | "alertdialog" | "dialog"
      name: string
      text: string
    }> = []
    const dialogs = session.page.locator(DIALOG_SELECTOR)
    const count = Math.min(await dialogs.count(), 20)
    for (let index = 0; index < count; index += 1) {
      const locator = dialogs.nth(index)
      if (!(await locator.isVisible().catch(() => false))) continue
      const value = await locator.evaluate((element) => ({
        role: element.getAttribute("role") ?? "dialog",
        name:
          element.getAttribute("aria-label") ??
          element.getAttribute("aria-labelledby") ??
          "Dialog",
        text: element.textContent ?? "",
      }))
      const role = ["alert", "alertdialog", "dialog"].includes(value.role)
        ? (value.role as "alert" | "alertdialog" | "dialog")
        : "dialog"
      result.push({
        role,
        name: redactor.redactText(value.name, 512),
        text: redactor.redactText(value.text, 4_096),
      })
    }
    return result
  }

  private async visibleTexts(
    locator: Locator,
    maximum: number,
    redactor: BrowserEvidenceRedactor,
    maxLength: number
  ): Promise<string[]> {
    const result: string[] = []
    const count = Math.min(await locator.count(), maximum * 4)
    for (let index = 0; index < count && result.length < maximum; index += 1) {
      const item = locator.nth(index)
      if (!(await item.isVisible().catch(() => false))) continue
      const text = redactor.redactText(await item.innerText(), maxLength)
      if (!result.includes(text)) result.push(text)
    }
    return result
  }

  private reclassify(
    record: ActionRecord,
    policy: BrowserPolicy
  ): BrowserPolicyDecision {
    return classifyBrowserAction(
      {
        kind: record.candidate.kind,
        role: record.candidate.role,
        name: record.candidate.name,
        inputSlot: record.candidate.inputSlot,
        targetUrl: record.descriptor?.href,
        submit: record.descriptor?.submit,
        download: record.descriptor?.download,
        opensNewTab: record.descriptor?.opensNewTab,
      },
      policy
    )
  }

  private async executeCandidate(
    session: RunSession,
    record: ActionRecord
  ): Promise<void> {
    const { candidate, locator } = record
    switch (candidate.kind) {
      case "click":
      case "navigate":
        if (locator === undefined)
          throw new Error("Action target is unavailable")
        await locator.click({
          timeout: this.boundedTimeout(
            session,
            session.policy.budgets.actionTimeoutMs
          ),
        })
        return
      case "fill":
      case "select": {
        if (locator === undefined)
          throw new Error("Action target is unavailable")
        if (candidate.inputSlot === undefined) {
          throw this.publicError(
            session.runId,
            "input_slot_missing",
            "Action requires a named input slot",
            candidate.actionId
          )
        }
        const value = await this.awaitSessionOperation(
          session,
          this.inputResolver.resolve(session.runId, candidate.inputSlot)
        )
        if (value.length > session.policy.budgets.maxInputLength) {
          throw this.publicError(
            session.runId,
            "input_too_long",
            "Input slot value exceeded the configured limit",
            candidate.actionId
          )
        }
        session.secretValues.add(value)
        this.assertRunDuration(session, candidate.actionId)
        const timeout = this.boundedTimeout(
          session,
          session.policy.budgets.actionTimeoutMs
        )
        if (candidate.kind === "fill") await locator.fill(value, { timeout })
        else await locator.selectOption(value, { timeout })
        return
      }
      case "check":
        if (locator === undefined)
          throw new Error("Action target is unavailable")
        await locator.check({
          timeout: this.boundedTimeout(
            session,
            session.policy.budgets.actionTimeoutMs
          ),
        })
        return
      case "back":
        await session.page.goBack({
          waitUntil: "domcontentloaded",
          timeout: this.boundedTimeout(
            session,
            session.policy.budgets.navigationTimeoutMs
          ),
        })
        return
      case "reload":
        await session.page.reload({
          waitUntil: "domcontentloaded",
          timeout: this.boundedTimeout(
            session,
            session.policy.budgets.navigationTimeoutMs
          ),
        })
    }
  }

  private networkWindow(
    session: RunSession,
    startOrdinal: number
  ): BrowserNetworkEvidence[] {
    return session.network
      .filter((record) => record.ordinal >= startOrdinal)
      .slice(0, 200)
      .map((record) => {
        const completedAt = record.completedAt
        return {
          requestId: record.requestId,
          method: httpMethodSchema.parse(record.method.toUpperCase()),
          normalizedPath: record.normalizedPath,
          resourceType: record.resourceType,
          status: record.status,
          outcome: record.outcome,
          startedAt: iso(record.startedAt),
          completedAt: completedAt === undefined ? undefined : iso(completedAt),
          durationMs:
            completedAt === undefined
              ? undefined
              : Math.max(0, completedAt.getTime() - record.startedAt.getTime()),
        }
      })
  }

  private redactor(session: RunSession): BrowserEvidenceRedactor {
    return new BrowserEvidenceRedactor(session.secretValues)
  }

  private async captureScreenshot(
    session: RunSession,
    retention: "report" | "failure"
  ): Promise<ArtifactId> {
    const body = await this.awaitSessionOperation(
      session,
      session.page.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        mask: session.page
          .frames()
          .flatMap((frame) =>
            this.screenshotMasks(frame, session.secretValues)
          ),
        maskColor: "#000000",
      })
    )
    return artifactIdSchema.parse(
      await this.awaitSessionOperation(
        session,
        this.artifacts.persist({
          applicationId: session.applicationId,
          runId: session.runId,
          artifactType: "screenshot",
          mimeType: "image/png",
          body,
          retention,
        })
      )
    )
  }

  private screenshotMasks(
    frame: Frame,
    secrets: ReadonlySet<string>
  ): Locator[] {
    return [
      frame.locator(SCREENSHOT_MASK_SELECTOR),
      ...SCREENSHOT_PII_PATTERNS.map((pattern) => frame.getByText(pattern)),
      ...[...secrets]
        .filter((secret) => secret.length > 0)
        .map((secret) => frame.getByText(secret, { exact: false })),
    ]
  }

  private async captureFailureTrace(
    session: RunSession
  ): Promise<ArtifactId | undefined> {
    if (session.options.traceOnFailure !== true) return undefined
    const body = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        kind: "sanitized_browser_failure_trace",
        runId: session.runId,
        entryUrl: session.entryUrl,
        network: this.networkWindow(session, 0),
        errors: session.errors.slice(-100),
        replayHistory: session.history,
        capturedAt: iso(this.clock.now()),
      })
    )
    return artifactIdSchema.parse(
      await this.awaitSessionOperation(
        session,
        this.artifacts.persist({
          applicationId: session.applicationId,
          runId: session.runId,
          artifactType: "trace",
          mimeType: "application/json",
          body,
          retention: "failure",
        })
      )
    )
  }

  private async cleanup(session: RunSession): Promise<void> {
    if (session.closed) return
    session.closed = true
    if (session.deadline !== undefined) {
      clearTimeout(session.deadline)
      session.deadline = undefined
    }
    await session.context.close().catch(() => undefined)
    await session.browser.close().catch(() => undefined)
    for (const [actionId, owner] of this.actionOwners) {
      if (owner === session.runId) this.actionOwners.delete(actionId)
    }
    session.actions.clear()
    session.requestRecords.clear()
    session.network.length = 0
    session.errors.length = 0
    session.violations.length = 0
    session.history.length = 0
    session.secretValues.clear()
  }
}

export function createPlaywrightBrowserEvidenceRuntime(dependencies: {
  readonly artifacts: BrowserArtifactSink
  readonly inputResolver: BrowserInputSlotResolver
  readonly storageStateProvider?: BrowserStorageStateProvider
  readonly launcher?: BrowserLauncher
  readonly clock?: BrowserClock
}): PlaywrightBrowserEvidenceRuntime {
  return new PlaywrightBrowserEvidenceRuntime(
    dependencies.artifacts,
    dependencies.inputResolver,
    dependencies.storageStateProvider,
    dependencies.launcher,
    dependencies.clock
  )
}
