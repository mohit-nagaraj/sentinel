import {
  browserObservationSchema,
  browserRecoveryRecipeSchema,
  browserTransitionEvidenceSchema,
  runIdSchema,
  type BrowserObservation,
  type BrowserRecoveryRecipe,
  type BrowserTransitionEvidence,
} from "@sentinel/contracts"

import {
  type BrowserEvidenceRuntime,
  type BrowserReplayResult,
  type BrowserRunOptions,
} from "./runtime.ts"

export interface ScriptedBrowserRun {
  readonly initial: BrowserObservation
  readonly transitions: readonly BrowserTransitionEvidence[]
  readonly recovery?: BrowserRecoveryRecipe | undefined
}

interface ActiveScript {
  observation: BrowserObservation
  readonly remaining: BrowserTransitionEvidence[]
  readonly recovery: BrowserRecoveryRecipe
}

export class FakeBrowserEvidenceRuntime implements BrowserEvidenceRuntime {
  private readonly scripts = new Map<string, ScriptedBrowserRun>()
  private readonly active = new Map<string, ActiveScript>()
  readonly completedRuns: string[] = []
  readonly cancelledRuns: string[] = []

  enqueue(runId: string, scriptInput: ScriptedBrowserRun): void {
    const parsedRunId = runIdSchema.parse(runId)
    const script = {
      initial: browserObservationSchema.parse(scriptInput.initial),
      transitions: scriptInput.transitions.map((transition) =>
        browserTransitionEvidenceSchema.parse(transition)
      ),
      recovery:
        scriptInput.recovery === undefined
          ? undefined
          : browserRecoveryRecipeSchema.parse(scriptInput.recovery),
    }
    this.scripts.set(parsedRunId, script)
  }

  isActive(runId: string): boolean {
    const parsed = runIdSchema.safeParse(runId)
    return parsed.success && this.active.has(parsed.data)
  }

  async startRun(options: BrowserRunOptions): Promise<BrowserObservation> {
    const runId = runIdSchema.parse(options.runId)
    const script = this.scripts.get(runId)
    if (script === undefined) throw new Error(`No fake browser script for ${runId}`)
    if (this.active.has(runId)) throw new Error(`Fake browser run already active`)
    const recovery =
      script.recovery ??
      browserRecoveryRecipeSchema.parse({
        schemaVersion: 1,
        applicationId: script.initial.applicationId,
        sourceRunId: script.initial.runId,
        entryUrl: script.initial.url,
        steps: [],
        createdAt: script.initial.observedAt,
      })
    this.active.set(runId, {
      observation: script.initial,
      remaining: [...script.transitions],
      recovery,
    })
    return script.initial
  }

  async observe(runIdInput: string): Promise<BrowserObservation> {
    return this.requireActive(runIdInput).observation
  }

  async performAction(
    runIdInput: string,
    actionId: string
  ): Promise<BrowserTransitionEvidence> {
    const active = this.requireActive(runIdInput)
    const index = active.remaining.findIndex(
      (transition) => transition.action.actionId === actionId
    )
    if (index < 0) throw new Error("Fake action was not scripted")
    const [transition] = active.remaining.splice(index, 1)
    if (transition === undefined) throw new Error("Fake transition disappeared")
    active.observation = transition.after
    return transition
  }

  createRecoveryRecipe(runIdInput: string): BrowserRecoveryRecipe {
    return this.requireActive(runIdInput).recovery
  }

  async replay(
    options: BrowserRunOptions,
    _recipe: BrowserRecoveryRecipe
  ): Promise<BrowserReplayResult> {
    void _recipe
    const finalObservation = await this.startRun(options)
    return { finalObservation, transitions: [] }
  }

  async completeRun(runIdInput: string): Promise<void> {
    const runId = runIdSchema.parse(runIdInput)
    this.requireActive(runId)
    this.active.delete(runId)
    this.completedRuns.push(runId)
  }

  async cancelRun(runIdInput: string): Promise<void> {
    const runId = runIdSchema.parse(runIdInput)
    if (!this.active.delete(runId)) return
    this.cancelledRuns.push(runId)
  }

  private requireActive(runIdInput: string): ActiveScript {
    const runId = runIdSchema.parse(runIdInput)
    const active = this.active.get(runId)
    if (active === undefined) throw new Error(`Fake browser run is not active`)
    return active
  }
}
