import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  type Locator,
  type Page,
  type Request,
} from "playwright"

import {
  classifyBrowserAction,
  createBrowserPolicy,
  isAllowedBrowserUrl,
  normalizeRoute,
  toPublicBrowserUrl,
  type BrowserPolicy,
  type BrowserPolicyInput,
} from "./policy.ts"
import {
  BrowserEvidenceRedactor,
  SCREENSHOT_MASK_SELECTOR,
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
    readonly mimeType: "image/png" | "application/zip"
    readonly body: Uint8Array
    readonly retention: "report" | "failure"
  }): Promise<ArtifactId>
}

export interface BrowserStorageStateProvider {
  resolve(
    reference: string
  ): Promise<BrowserContextOptions["storageState"]>
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
  performAction(runId: string, actionId: string): Promise<BrowserTransitionEvidence>
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
  readonly inputSlot?: string | undefined
  readonly disabled: boolean
  readonly signature: ContentHash
  readonly policy: BrowserPolicyDecision
  readonly locator?: Locator | undefined
  readonly descriptor?: ElementDescriptor | undefined
}

interface ActionRecord {
  readonly candidate: BrowserActionCandidate
  readonly locator?: Locator | undefined
  readonly descriptor?: ElementDescriptor | undefined
  readonly observation: BrowserObservation
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
  readonly inputSlots: readonly BrowserInputSlotBinding[]
  readonly actions: Map<ActionId, ActionRecord>
  readonly network: NetworkRecord[]
  readonly requestRecords: Map<Request, NetworkRecord>
  readonly errors: BrowserRuntimeErrorEvidence[]
  readonly violations: BrowserRuntimeFailureCode[]
  readonly history: BrowserReplayStep[]
  readonly secretValues: Set<string>
  actionCount: number
  screenCount: number
  redirectCount: number
  downloadCount: number
  observationOrdinal: number
  actionOrdinal: number
  requestOrdinal: number
  transitionOrdinal: number
  busy: boolean
  cancelled: boolean
  closed: boolean
  traceActive: boolean
}

class SystemClock implements BrowserClock {
  now(): Date {
    return new Date()
  }
}

class ChromiumLauncher implements BrowserLauncher {
  constructor(private readonly browserType: BrowserType = chromium) {}

  launch(): Promise<Browser> {
    return this.browserType.launch({ headless: true })
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

function roleForElement(tag: string, explicitRole: string, inputType: string): string {
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
    if (this.sessions.has(runId)) {
      throw this.publicError(runId, "run_already_exists", "Run already exists")
    }
    const policy = createBrowserPolicy(options.policy)
    if (!isAllowedBrowserUrl(options.entryUrl, policy)) {
      throw this.publicError(runId, "host_denied", "Entry URL is not allowlisted")
    }

    const storageState =
      options.storageStateReference === undefined
        ? undefined
        : await this.resolveStorageState(options.storageStateReference)
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    try {
      browser = await this.launcher.launch()
      context = await browser.newContext({
        acceptDownloads: false,
        ...(storageState === undefined ? {} : { storageState }),
      })
      const page = await context.newPage()
      page.setDefaultTimeout(policy.budgets.actionTimeoutMs)
      page.setDefaultNavigationTimeout(policy.budgets.navigationTimeoutMs)
      const session: RunSession = {
        applicationId,
        runId,
        entryUrl: new BrowserEvidenceRedactor().redactUrl(options.entryUrl),
        options,
        policy,
        browser,
        context,
        page,
        startedAt: this.clock.now(),
        inputSlots: options.inputSlots ?? [],
        actions: new Map(),
        network: [],
        requestRecords: new Map(),
        errors: [],
        violations: [],
        history: [],
        secretValues: new Set(),
        actionCount: 0,
        screenCount: 0,
        redirectCount: 0,
        downloadCount: 0,
        observationOrdinal: 0,
        actionOrdinal: 0,
        requestOrdinal: 0,
        transitionOrdinal: 0,
        busy: false,
        cancelled: false,
        closed: false,
        traceActive: false,
      }
      this.sessions.set(runId, session)
      await this.attachGuards(session)
      if (options.traceOnFailure === true) {
        await context.tracing.start({
          screenshots: false,
          snapshots: false,
          sources: false,
        })
        session.traceActive = true
      }
      await page.goto(options.entryUrl, { waitUntil: "domcontentloaded" })
      return await this.captureObservation(session)
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
      throw this.publicError(
        runId,
        "browser_error",
        new BrowserEvidenceRedactor().errorMessage(error)
      )
    }
  }

  async observe(runIdInput: string): Promise<BrowserObservation> {
    return this.captureObservation(this.requireSession(runIdInput))
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
      if (current.stateFingerprint !== record.observation.stateFingerprint) {
        throw this.publicError(
          session.runId,
          "action_stale",
          "Page state changed after the action was observed",
          actionId
        )
      }
      const decision = this.reclassify(record, session.policy)
      if (!decision.allowed) {
        throw this.publicError(
          session.runId,
          "policy_denied",
          `Action denied by ${decision.reason}`,
          actionId
        )
      }

      record.used = true
      session.actionCount += 1
      const networkStart = session.requestOrdinal
      const errorStart = session.errors.length
      const violationStart = session.violations.length
      try {
        await this.executeCandidate(session, record)
        if (session.policy.budgets.observationSettleMs > 0) {
          await session.page.waitForTimeout(
            session.policy.budgets.observationSettleMs
          )
        }
        const violation = session.violations[violationStart]
        if (violation !== undefined) {
          throw await this.failureWithArtifacts(
            session,
            violation,
            "Browser action triggered a denied side effect",
            actionId
          )
        }
        const after = await this.captureObservation(session, actionId)
        const transition = browserTransitionEvidenceSchema.parse({
          schemaVersion: 1,
          evidenceId: createRunScopedEvidenceId({
            applicationId: session.applicationId,
            runId: session.runId,
            sourceId: after.evidenceId,
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
            name: record.candidate.name,
            inputSlot: record.candidate.inputSlot,
            expectedBeforeFingerprint: transition.before.stateFingerprint,
            expectedAfterFingerprint: transition.after.stateFingerprint,
            replaySafe: true,
          })
        }
        return transition
      } catch (error) {
        if (error instanceof BrowserRuntimeError) throw error
        throw await this.failureWithArtifacts(
          session,
          "browser_error",
          this.redactor(session).errorMessage(error),
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
    let observation = await this.startRun({ ...options, entryUrl: recipe.entryUrl })
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
          (value) => value.signature === step.signature && value.policy.replaySafe
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
        if (transition.after.stateFingerprint !== step.expectedAfterFingerprint) {
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
    await this.cleanup(session)
    this.sessions.delete(session.runId)
  }

  async cancelRun(runIdInput: string): Promise<void> {
    const parsed = runIdSchema.parse(runIdInput)
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
    let abortHandler: (() => void) | undefined
    try {
      const observation = await this.startRun(options)
      if (signal?.aborted === true) {
        await this.cancelRun(options.runId)
        throw this.publicError(
          observation.runId,
          "run_cancelled",
          "Run was cancelled"
        )
      }
      if (signal !== undefined) {
        abortHandler = () => {
          void this.cancelRun(options.runId)
        }
        signal.addEventListener("abort", abortHandler, { once: true })
      }
      return await callback(this, observation)
    } finally {
      if (abortHandler !== undefined) {
        signal?.removeEventListener("abort", abortHandler)
      }
      await this.cancelRun(options.runId)
    }
  }

  private async resolveStorageState(
    referenceInput: string
  ): Promise<BrowserContextOptions["storageState"]> {
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
      throw this.publicError(runId, "run_not_found", "Run was not found")
    }
    if (session.cancelled) {
      throw this.publicError(runId, "run_cancelled", "Run was cancelled")
    }
    return session
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

  private assertRunBudgets(session: RunSession, actionId: ActionId): void {
    if (session.cancelled) {
      throw this.publicError(
        session.runId,
        "run_cancelled",
        "Run was cancelled",
        actionId
      )
    }
    if (
      this.clock.now().getTime() - session.startedAt.getTime() >
      session.policy.budgets.maxDurationMs
    ) {
      throw this.publicError(
        session.runId,
        "run_expired",
        "Run time limit was reached",
        actionId
      )
    }
    if (session.actionCount >= session.policy.budgets.maxActions) {
      throw this.publicError(
        session.runId,
        "action_limit_reached",
        "Action limit was reached",
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
      let redirects = 0
      let previous = request.redirectedFrom()
      while (previous !== null) {
        redirects += 1
        previous = previous.redirectedFrom()
      }
      session.redirectCount = Math.max(session.redirectCount, redirects)
      if (redirects > session.policy.budgets.maxRedirects) {
        session.violations.push("redirect_limit_reached")
        await route.abort("blockedbyclient")
        return
      }
      await route.continue()
    })

    session.context.on("request", (request) => {
      let url: URL
      try {
        url = new URL(request.url())
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
    })
    session.context.on("requestfailed", (request) => {
      const record = session.requestRecords.get(request)
      if (record === undefined) return
      record.completedAt = this.clock.now()
      record.outcome = "failed"
    })
    session.context.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return
      session.errors.push(browserRuntimeErrorEvidenceSchema.parse({
        kind: "console",
        message: this.redactor(session).redactText(message.text(), 1_024),
        observedAt: iso(this.clock.now()),
      }))
    })
    session.page.on("pageerror", (error) => {
      session.errors.push(browserRuntimeErrorEvidenceSchema.parse({
        kind: "page",
        message: this.redactor(session).errorMessage(error),
        observedAt: iso(this.clock.now()),
      }))
    })
    session.page.on("download", (download) => {
      session.downloadCount += 1
      session.violations.push("download_denied")
      void download.cancel()
    })
    session.context.on("page", (page) => {
      if (page === session.page) return
      session.violations.push("tab_limit_reached")
      void page.close()
    })
    session.context.on("dialog", (dialog) => {
      session.violations.push("policy_denied")
      void dialog.dismiss()
    })
  }

  private async inspectPage(session: RunSession): Promise<PageSnapshot> {
    const redactor = this.redactor(session)
    const url = redactor.redactUrl(
      toPublicBrowserUrl(session.page.url())
    )
    if (!isAllowedBrowserUrl(url, session.policy)) {
      throw this.publicError(session.runId, "host_denied", "Page left allowlist")
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
      title,
      headings,
      controls,
      dialogs,
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
        stateFingerprint: snapshot.stateFingerprint,
        actionType: prepared.kind,
        ordinal: session.actionOrdinal++,
      })
      const candidate: BrowserActionCandidate = {
        actionId,
        signature: prepared.signature,
        kind: prepared.kind,
        role: prepared.role,
        name: prepared.name,
        inputSlot: prepared.inputSlot,
        disabled: prepared.disabled,
        policy: prepared.policy,
        expiresAt: iso(expiresAt),
      }
      this.actionOwners.set(actionId, session.runId)
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
      screenshotArtifactId,
      errors: session.errors.slice(-100),
      priorActionId,
      observedAt: iso(observedAt),
    })
    for (const { candidate, prepared } of candidates) {
      session.actions.set(candidate.actionId, {
        candidate,
        locator: prepared.locator,
        descriptor: prepared.descriptor,
        observation,
        used: false,
      })
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
        const labels = input?.labels
          ? [...input.labels]
              .map((label) => label.textContent ?? "")
              .join(" ")
          : ""
        const tag = html.tagName.toLowerCase()
        const inputType = input?.type.toLowerCase() ?? ""
        const inputButtonName = ["button", "submit", "reset"].includes(
          inputType
        )
          ? (input?.value ?? "")
          : ""
        const name =
          html.getAttribute("aria-label") ||
          labels ||
          html.innerText ||
          html.getAttribute("placeholder") ||
          html.getAttribute("title") ||
          inputButtonName ||
          ""
        const button = element instanceof HTMLButtonElement ? element : undefined
        const anchor = element instanceof HTMLAnchorElement ? element : undefined
        return {
          tag,
          explicitRole: html.getAttribute("role") ?? "",
          name,
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
      const descriptor: ElementDescriptor = {
        tag: raw.tag,
        role,
        name: redactor.redactText(raw.name, 512),
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
      const semanticKey = JSON.stringify({
        kind,
        role,
        name: descriptor.name,
        inputSlot,
      })
      const occurrence = occurrences.get(semanticKey) ?? 0
      occurrences.set(semanticKey, occurrence + 1)
      const signature = hashCanonical({
        kind,
        role,
        name: descriptor.name,
        inputSlot,
        occurrence,
      })
      result.push({
        kind,
        role,
        name: descriptor.name,
        inputSlot,
        disabled: descriptor.disabled,
        signature,
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
        policy: classifyBrowserAction({ kind, role: "navigation", name }, session.policy),
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
        if (locator === undefined) throw new Error("Action target is unavailable")
        await locator.click({ timeout: session.policy.budgets.actionTimeoutMs })
        return
      case "fill":
      case "select": {
        if (locator === undefined) throw new Error("Action target is unavailable")
        if (candidate.inputSlot === undefined) {
          throw this.publicError(
            session.runId,
            "input_slot_missing",
            "Action requires a named input slot",
            candidate.actionId
          )
        }
        const value = await this.inputResolver.resolve(
          session.runId,
          candidate.inputSlot
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
        if (candidate.kind === "fill") await locator.fill(value)
        else await locator.selectOption(value)
        return
      }
      case "check":
        if (locator === undefined) throw new Error("Action target is unavailable")
        await locator.check()
        return
      case "back":
        await session.page.goBack({ waitUntil: "domcontentloaded" })
        return
      case "reload":
        await session.page.reload({ waitUntil: "domcontentloaded" })
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
    const body = await session.page.screenshot({
      type: "png",
      animations: "disabled",
      caret: "hide",
      mask: [session.page.locator(SCREENSHOT_MASK_SELECTOR)],
      maskColor: "#000000",
    })
    return artifactIdSchema.parse(
      await this.artifacts.persist({
        applicationId: session.applicationId,
        runId: session.runId,
        artifactType: "screenshot",
        mimeType: "image/png",
        body,
        retention,
      })
    )
  }

  private async captureFailureTrace(
    session: RunSession
  ): Promise<ArtifactId | undefined> {
    if (!session.traceActive) return undefined
    const directory = join(
      tmpdir(),
      `sentinel-browser-${session.runId.replace(/[^a-z0-9]/gi, "-")}`
    )
    const path = join(directory, "trace.zip")
    await mkdir(directory, { recursive: true })
    try {
      await session.context.tracing.stop({ path })
      session.traceActive = false
      const body = await readFile(path)
      return artifactIdSchema.parse(
        await this.artifacts.persist({
          applicationId: session.applicationId,
          runId: session.runId,
          artifactType: "trace",
          mimeType: "application/zip",
          body,
          retention: "failure",
        })
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async cleanup(session: RunSession): Promise<void> {
    if (session.closed) return
    session.closed = true
    if (session.traceActive) {
      await session.context.tracing.stop().catch(() => undefined)
      session.traceActive = false
    }
    await session.context.close().catch(() => undefined)
    await session.browser.close().catch(() => undefined)
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
