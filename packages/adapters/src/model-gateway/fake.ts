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
import { z } from "zod"
import {
  assertModelSafeValue,
  defaultModelCallLimits,
  ModelGatewayError,
  parseModelOperation,
  parseModelSafeText,
} from "./contracts.ts"

function validateRequest(request: ModelTextRequest): void {
  const input = parseModelSafeText(
    request.input,
    defaultModelCallLimits.maxInputCharacters
  )
  const instructions =
    request.instructions === undefined
      ? ""
      : parseModelSafeText(
          request.instructions,
          defaultModelCallLimits.maxInputCharacters
        )
  if (
    input.length + instructions.length >
      defaultModelCallLimits.maxInputCharacters ||
    (request.maxOutputTokens ?? defaultModelCallLimits.maxOutputTokens) >
      defaultModelCallLimits.maxOutputTokens
  ) {
    throw new ModelGatewayError("limit_exceeded", false)
  }
}

function assertCorrelatedOutputs(
  continuation: ModelContinuation,
  outputs: readonly ModelToolOutput[]
): void {
  if (continuation.instructions !== undefined) {
    parseModelSafeText(
      continuation.instructions,
      defaultModelCallLimits.maxInputCharacters
    )
  }
  for (const item of continuation.items) {
    if (item.type === "user_text" || item.type === "assistant_text") {
      parseModelSafeText(item.text, defaultModelCallLimits.maxInputCharacters)
    } else if (item.type === "function_call") {
      let parsed: unknown
      try {
        parsed = JSON.parse(item.argumentsJson)
      } catch {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
      assertModelSafeValue(parsed)
    }
  }
  const expected = continuation.calls.map((call) => call.callId).sort()
  const supplied = outputs.map((output) => output.callId).sort()
  if (
    expected.length !== supplied.length ||
    expected.some((callId, index) => supplied[index] !== callId) ||
    new Set(supplied).size !== supplied.length
  ) {
    throw new ModelGatewayError("tool_protocol_invalid", false)
  }
  outputs.forEach((output) => assertModelSafeValue(output.output))
}

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
    validateRequest(request)
    const step = this.take("text")
    if (step.kind !== "text" || !("result" in step))
      throw new Error("unreachable")
    if (step.result.output.length === 0) {
      throw new ModelGatewayError("malformed_output", false)
    }
    return step.result
  }

  async generateStructured<Output>(
    request: ModelStructuredRequest<Output>
  ): Promise<ModelResult<Output>> {
    validateRequest(request)
    const step = this.take("structured")
    if (step.kind !== "structured" || !("result" in step)) {
      throw new Error("unreachable")
    }
    try {
      return {
        ...step.result,
        output: request.schema.parse(step.result.output),
      }
    } catch {
      throw new ModelGatewayError("malformed_output", false)
    }
  }

  async decideTools(
    request: ModelToolRequest
  ): Promise<ModelToolDecisionResult> {
    validateRequest(request)
    if (
      request.tools.length < 1 ||
      request.tools.length > defaultModelCallLimits.maxTools
    ) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    for (const tool of request.tools) {
      parseModelOperation(tool.name)
      parseModelSafeText(tool.description, 1_024)
      try {
        assertModelSafeValue(z.toJSONSchema(tool.parameters))
      } catch (error) {
        if (error instanceof ModelGatewayError) throw error
        throw new ModelGatewayError("invalid_request", false)
      }
    }
    const step = this.take("tools")
    if (step.kind !== "tools" || !("result" in step))
      throw new Error("unreachable")
    if (
      request.toolChoice === "required" &&
      step.result.kind !== "tool_calls"
    ) {
      throw new ModelGatewayError("tool_protocol_invalid", false)
    }
    if (step.result.kind === "tool_calls") {
      const definitions = new Map(
        request.tools.map((tool) => [tool.name, tool])
      )
      const ids = new Set<string>()
      for (const call of step.result.output) {
        const tool = definitions.get(call.name)
        if (
          tool === undefined ||
          ids.has(call.callId) ||
          !tool.parameters.safeParse(call.arguments).success
        ) {
          throw new ModelGatewayError("tool_protocol_invalid", false)
        }
        ids.add(call.callId)
      }
      const continuationIds = step.result.continuation.calls
        .map((call) => call.callId)
        .sort()
      if (
        ids.size !== continuationIds.length ||
        [...ids]
          .sort()
          .some((callId, index) => continuationIds[index] !== callId)
      ) {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
    } else if (step.result.output.length === 0) {
      throw new ModelGatewayError("malformed_output", false)
    }
    return step.result
  }

  async continueTools(
    continuation: ModelContinuation,
    outputs: readonly ModelToolOutput[]
  ): Promise<ModelResult<string>> {
    assertCorrelatedOutputs(continuation, outputs)
    const step = this.take("continuation")
    if (step.kind !== "continuation" || !("result" in step)) {
      throw new Error("unreachable")
    }
    if (step.result.output.length === 0) {
      throw new ModelGatewayError("malformed_output", false)
    }
    return step.result
  }

  async streamText(
    request: ModelTextRequest,
    onEvent: (event: ModelStreamEvent) => void | Promise<void>
  ): Promise<ModelResult<string>> {
    validateRequest(request)
    const step = this.take("stream")
    if (step.kind !== "stream" || !("result" in step))
      throw new Error("unreachable")
    if (
      step.events.length === 0 ||
      step.events.at(-1)?.type !== "completed" ||
      step.events.filter((event) => event.type === "completed").length !== 1
    ) {
      throw new ModelGatewayError("tool_protocol_invalid", false)
    }
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
