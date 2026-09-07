import type {
  ModelContinuation,
  ModelGateway,
  ModelResult,
  ModelStreamEvent,
  ModelStructuredRequest,
  ModelTextRequest,
  ModelToolDecisionResult,
  ModelToolOutput,
  ModelToolRequest,
} from "./contracts.ts"
import { ModelGatewayError } from "./contracts.ts"

type ScriptedStep =
  | { readonly kind: "text"; readonly result: ModelResult<string> }
  | { readonly kind: "structured"; readonly result: ModelResult<unknown> }
  | { readonly kind: "tools"; readonly result: ModelToolDecisionResult }
  | { readonly kind: "continuation"; readonly result: ModelResult<string> }
  | {
      readonly kind: "stream"
      readonly events: readonly ModelStreamEvent[]
      readonly result: ModelResult<string>
    }
  | {
      readonly kind: "text" | "structured" | "tools" | "continuation" | "stream"
      readonly error: ModelGatewayError
    }

export class ScriptedModelGateway implements ModelGateway {
  private cursor = 0

  constructor(private readonly steps: readonly ScriptedStep[]) {}

  private take(kind: ScriptedStep["kind"]): ScriptedStep {
    const step = this.steps[this.cursor]
    this.cursor += 1
    if (step === undefined || step.kind !== kind) {
      throw new Error(`Unexpected scripted model call: ${kind}`)
    }
    if ("error" in step) throw step.error
    return step
  }

  async generateText(request: ModelTextRequest): Promise<ModelResult<string>> {
    void request
    const step = this.take("text")
    if (step.kind !== "text" || !("result" in step))
      throw new Error("unreachable")
    return step.result
  }

  async generateStructured<Output>(
    request: ModelStructuredRequest<Output>
  ): Promise<ModelResult<Output>> {
    const step = this.take("structured")
    if (step.kind !== "structured" || !("result" in step)) {
      throw new Error("unreachable")
    }
    return {
      ...step.result,
      output: request.schema.parse(step.result.output),
    }
  }

  async decideTools(
    request: ModelToolRequest
  ): Promise<ModelToolDecisionResult> {
    void request
    const step = this.take("tools")
    if (step.kind !== "tools" || !("result" in step))
      throw new Error("unreachable")
    return step.result
  }

  async continueTools(
    continuation: ModelContinuation,
    outputs: readonly ModelToolOutput[]
  ): Promise<ModelResult<string>> {
    void continuation
    void outputs
    const step = this.take("continuation")
    if (step.kind !== "continuation" || !("result" in step)) {
      throw new Error("unreachable")
    }
    return step.result
  }

  async streamText(
    request: ModelTextRequest,
    onEvent: (event: ModelStreamEvent) => void | Promise<void>
  ): Promise<ModelResult<string>> {
    void request
    const step = this.take("stream")
    if (step.kind !== "stream" || !("result" in step))
      throw new Error("unreachable")
    for (const event of step.events) await onEvent(event)
    return step.result
  }

  assertComplete(): void {
    if (this.cursor !== this.steps.length) {
      throw new Error(
        `Scripted model gateway has ${this.steps.length - this.cursor} unused steps`
      )
    }
  }
}

export type { ScriptedStep as ScriptedModelGatewayStep }
