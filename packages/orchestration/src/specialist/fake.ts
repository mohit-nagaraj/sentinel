import {
  executionBudgetSchema,
  type DiscoveryMission,
  type MissionBudget,
} from "@sentinel/contracts"
import { MemorySaver } from "@langchain/langgraph"
import { z } from "zod"

import {
  specialistModelDecisionSchema,
  type SpecialistDecisionModel,
  type SpecialistModelDecision,
  type SpecialistModelRequest,
} from "./kernel.ts"
import {
  EMPTY_BUDGET_USAGE,
  type SpecialistAgent,
  type SpecialistStateValue,
} from "./state.ts"
import {
  defineSpecialistTool,
  specialistToolOutputSchema,
  type SpecialistToolArguments,
  type SpecialistToolContext,
  type SpecialistToolDefinition,
  type SpecialistToolOutput,
} from "./tools.ts"

export type ScriptedSpecialistModelStep =
  | {
      readonly kind: "decision"
      readonly decision: SpecialistModelDecision
    }
  | { readonly kind: "malformed"; readonly value: unknown }
  | { readonly kind: "error"; readonly error?: Error }
  | { readonly kind: "wait_for_abort" }

export interface ScriptedSpecialistModelCall {
  readonly sequence: number
  readonly missionId: string
  readonly agent: SpecialistAgent
  readonly promptTemplateId: string
  readonly stateFingerprint: string
  readonly completedCallIds: readonly string[]
  readonly executionKind: SpecialistModelRequest["executionKind"]
  readonly humanResolution: SpecialistModelRequest["humanResolution"]
  readonly remainingBudget: MissionBudget
}

export interface ScriptedSpecialistModelOptions {
  readonly estimate?:
    | Partial<MissionBudget>
    | ((state: SpecialistStateValue) => Partial<MissionBudget>)
}

export class ScriptedSpecialistDecisionModel implements SpecialistDecisionModel {
  readonly #steps: readonly ScriptedSpecialistModelStep[]
  readonly #estimate: NonNullable<ScriptedSpecialistModelOptions["estimate"]>
  readonly #calls: ScriptedSpecialistModelCall[] = []
  #cursor = 0

  constructor(
    steps: readonly ScriptedSpecialistModelStep[],
    options: ScriptedSpecialistModelOptions = {}
  ) {
    this.#steps = Object.freeze(
      steps.map((step) =>
        step.kind === "decision"
          ? Object.freeze({
              kind: step.kind,
              decision: specialistModelDecisionSchema.parse(step.decision),
            })
          : Object.freeze({ ...step })
      )
    )
    this.#estimate = options.estimate ?? { modelCalls: 1 }
  }

  estimate(state: SpecialistStateValue): Partial<MissionBudget> {
    const estimate =
      typeof this.#estimate === "function"
        ? this.#estimate(state)
        : this.#estimate
    executionBudgetSchema.partial().parse(estimate)
    return estimate
  }

  async decide(request: SpecialistModelRequest): Promise<unknown> {
    const step = this.#steps[this.#cursor]
    if (step === undefined) {
      throw new Error("Scripted specialist model has no remaining step")
    }
    this.#cursor += 1
    this.#calls.push(
      Object.freeze({
        sequence: this.#cursor,
        missionId: request.mission.id,
        agent: request.mission.agent,
        promptTemplateId: request.promptTemplateId,
        stateFingerprint: request.stateFingerprint,
        completedCallIds: Object.freeze([...request.completedCallIds]),
        executionKind: request.executionKind,
        humanResolution:
          request.humanResolution === null
            ? null
            : Object.freeze({ ...request.humanResolution }),
        remainingBudget: executionBudgetSchema.parse(request.remainingBudget),
      })
    )
    assertNotAborted(request.signal)
    switch (step.kind) {
      case "decision":
        return step.decision
      case "malformed":
        return step.value
      case "error":
        throw step.error ?? new Error("Scripted specialist model failure")
      case "wait_for_abort":
        return await rejectOnAbort(request.signal)
    }
  }

  get callCount(): number {
    return this.#calls.length
  }

  get calls(): readonly ScriptedSpecialistModelCall[] {
    return Object.freeze([...this.#calls])
  }

  assertComplete(): void {
    const remaining = this.#steps.length - this.#cursor
    if (remaining !== 0) {
      throw new Error(
        `Scripted specialist model has ${remaining} unused ${pluralizeStep(remaining)}`
      )
    }
  }
}

export function scriptedSpecialistDecision(
  decisionId: string,
  action: unknown,
  usage: Partial<MissionBudget> = { modelCalls: 1 }
): SpecialistModelDecision {
  return specialistModelDecisionSchema.parse({
    decisionId,
    usage: { ...EMPTY_BUDGET_USAGE, ...usage },
    action,
  })
}

export type ScriptedSpecialistToolStep =
  | { readonly kind: "result"; readonly result: SpecialistToolOutput }
  | { readonly kind: "malformed"; readonly value: unknown }
  | { readonly kind: "error"; readonly error?: Error }
  | { readonly kind: "wait_for_abort" }

export interface ScriptedSpecialistToolCall {
  readonly sequence: number
  readonly missionId: string
  readonly agent: SpecialistAgent
  readonly decisionId: string
  readonly callId: string
  readonly requestHash: string
  readonly arguments: SpecialistToolArguments
}

export interface ScriptedSpecialistToolConfig<
  TArguments extends SpecialistToolArguments,
> {
  readonly name: string
  readonly description: string
  readonly agents: readonly SpecialistAgent[]
  readonly modes: readonly DiscoveryMission["mode"][]
  readonly argumentsSchema: z.ZodType<TArguments>
  readonly validateScope: (
    arguments_: TArguments,
    context: SpecialistToolContext
  ) => boolean | string | void
  readonly estimate: (
    arguments_: TArguments,
    context: SpecialistToolContext
  ) => Partial<MissionBudget>
  readonly steps: readonly ScriptedSpecialistToolStep[]
}

export class ScriptedSpecialistTool<
  TArguments extends SpecialistToolArguments,
> {
  readonly definition: SpecialistToolDefinition
  readonly #steps: readonly ScriptedSpecialistToolStep[]
  readonly #calls: ScriptedSpecialistToolCall[] = []
  #cursor = 0

  constructor(config: ScriptedSpecialistToolConfig<TArguments>) {
    this.#steps = Object.freeze(
      config.steps.map((step) =>
        step.kind === "result"
          ? Object.freeze({
              kind: step.kind,
              result: specialistToolOutputSchema.parse(step.result),
            })
          : Object.freeze({ ...step })
      )
    )
    this.definition = defineSpecialistTool({
      name: config.name,
      description: config.description,
      agents: config.agents,
      modes: config.modes,
      argumentsSchema: config.argumentsSchema,
      outputSchema: z.unknown(),
      validateScope: config.validateScope,
      estimate: config.estimate,
      execute: async (arguments_, context) => {
        const step = this.#steps[this.#cursor]
        if (step === undefined) {
          throw new Error("Scripted specialist tool has no remaining step")
        }
        this.#cursor += 1
        this.#calls.push(
          Object.freeze({
            sequence: this.#cursor,
            missionId: context.mission.id,
            agent: context.mission.agent,
            decisionId: context.decisionId,
            callId: context.callId,
            requestHash: context.requestHash,
            arguments: config.argumentsSchema.parse(arguments_),
          })
        )
        assertNotAborted(context.signal)
        switch (step.kind) {
          case "result":
            return step.result
          case "malformed":
            return step.value
          case "error":
            throw step.error ?? new Error("Scripted specialist tool failure")
          case "wait_for_abort":
            return await rejectOnAbort(context.signal)
        }
      },
    })
  }

  get callCount(): number {
    return this.#calls.length
  }

  get calls(): readonly ScriptedSpecialistToolCall[] {
    return Object.freeze([...this.#calls])
  }

  assertComplete(): void {
    const remaining = this.#steps.length - this.#cursor
    if (remaining !== 0) {
      throw new Error(
        `Scripted specialist tool has ${remaining} unused ${pluralizeStep(remaining)}`
      )
    }
  }
}

export function scriptedSpecialistToolOutput(
  input: Omit<z.input<typeof specialistToolOutputSchema>, "usage"> & {
    readonly usage?: Partial<MissionBudget>
  }
): SpecialistToolOutput {
  return specialistToolOutputSchema.parse({
    ...input,
    usage: { ...EMPTY_BUDGET_USAGE, toolCalls: 1, ...input.usage },
  })
}

export function createInMemorySpecialistCheckpointer(): MemorySaver {
  return new MemorySaver()
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  assertNotAborted(signal)
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), {
      once: true,
    })
  })
}

function abortError(): Error {
  const error = new Error("Scripted specialist operation aborted")
  error.name = "AbortError"
  return error
}

function pluralizeStep(count: number): string {
  return count === 1 ? "step" : "steps"
}
