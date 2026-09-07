import { canonicalSerialize } from "@sentinel/contracts"
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
import {
  assertModelSafeValue,
  defaultModelCallLimits,
  ModelGatewayError,
  parseModelOperation,
  parseModelSafeText,
} from "./contracts.ts"
import { createStrictModelJsonSchema } from "./schema.ts"

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
  const outputTokens =
    request.maxOutputTokens ?? defaultModelCallLimits.maxOutputTokens
  if (
    input.length + instructions.length >
      defaultModelCallLimits.maxInputCharacters ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 1 ||
    outputTokens > defaultModelCallLimits.maxOutputTokens
  ) {
    throw new ModelGatewayError("limit_exceeded", false)
  }
}

function validateContinuation(continuation: ModelContinuation): void {
  if (
    continuation.items.length > defaultModelCallLimits.maxToolCalls * 3 + 2 ||
    continuation.calls.length > defaultModelCallLimits.maxToolCalls ||
    continuation.tools.length > defaultModelCallLimits.maxTools
  ) {
    throw new ModelGatewayError("limit_exceeded", false)
  }
  let textCharacters = 0
  if (continuation.instructions !== undefined) {
    textCharacters += parseModelSafeText(
      continuation.instructions,
      defaultModelCallLimits.maxInputCharacters
    ).length
  }
  const calls = new Map<string, (typeof continuation.calls)[number]>()
  for (const call of continuation.calls) {
    parseModelOperation(call.name)
    assertModelSafeValue(call.arguments)
    if (
      call.callId.length < 1 ||
      call.callId.length > 256 ||
      calls.has(call.callId)
    ) {
      throw new ModelGatewayError("tool_protocol_invalid", false)
    }
    calls.set(call.callId, call)
  }
  const toolNames = new Set<string>()
  for (const tool of continuation.tools) {
    parseModelOperation(tool.name)
    parseModelSafeText(tool.description, 1_024)
    assertModelSafeValue(tool.parameters)
    if (toolNames.has(tool.name)) {
      throw new ModelGatewayError("tool_protocol_invalid", false)
    }
    toolNames.add(tool.name)
  }
  const itemCallIds = new Set<string>()
  for (const item of continuation.items) {
    if (item.type === "user_text" || item.type === "assistant_text") {
      textCharacters += parseModelSafeText(
        item.text,
        defaultModelCallLimits.maxInputCharacters
      ).length
    } else if (item.type === "function_call") {
      let parsed: unknown
      try {
        parsed = JSON.parse(item.argumentsJson)
      } catch {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
      const call = calls.get(item.callId)
      if (
        call === undefined ||
        call.name !== item.name ||
        canonicalSerialize(call.arguments) !== canonicalSerialize(parsed) ||
        itemCallIds.has(item.callId)
      ) {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
      assertModelSafeValue(parsed)
      itemCallIds.add(item.callId)
    } else if (
      item.id.length < 1 ||
      item.id.length > 256 ||
      item.encryptedContent === undefined ||
      item.encryptedContent.length > 65_536
    ) {
      throw new ModelGatewayError("tool_protocol_invalid", false)
    }
  }
  if (
    textCharacters > defaultModelCallLimits.maxInputCharacters ||
    calls.size !== itemCallIds.size ||
    [...calls.values()].some(
      (call) => !itemCallIds.has(call.callId) || !toolNames.has(call.name)
    )
  ) {
    throw new ModelGatewayError("tool_protocol_invalid", false)
  }
}

function assertCorrelatedOutputs(
  continuation: ModelContinuation,
  outputs: readonly ModelToolOutput[]
): void {
  validateContinuation(continuation)
  const expected = continuation.calls.map((call) => call.callId).sort()
  const supplied = outputs.map((output) => output.callId).sort()
  if (
    expected.length !== supplied.length ||
    expected.some((callId, index) => supplied[index] !== callId) ||
    new Set(supplied).size !== supplied.length
  ) {
    throw new ModelGatewayError("tool_protocol_invalid", false)
  }
  let outputCharacters = 0
  outputs.forEach((output) => {
    assertModelSafeValue(output.output)
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(output.output)
    } catch {
      throw new ModelGatewayError("invalid_request", false)
    }
    outputCharacters += serialized?.length ?? 0
  })
  if (outputCharacters > defaultModelCallLimits.maxToolOutputCharacters) {
    throw new ModelGatewayError("limit_exceeded", false)
  }
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
    createStrictModelJsonSchema(request.schema, request.schemaName)
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
      createStrictModelJsonSchema(tool.parameters, tool.name)
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
      validateContinuation(step.result.continuation)
    } else if (step.result.output.length === 0) {
      throw new ModelGatewayError("malformed_output", false)
    }
    return step.result
  }

  async continueTools(
    continuation: ModelContinuation,
    outputs: readonly ModelToolOutput[],
    request: Omit<ModelTextRequest, "input"> = {}
  ): Promise<ModelResult<string>> {
    const outputTokens =
      request.maxOutputTokens ?? defaultModelCallLimits.maxOutputTokens
    if (
      !Number.isInteger(outputTokens) ||
      outputTokens < 1 ||
      outputTokens > defaultModelCallLimits.maxOutputTokens
    ) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    if (request.instructions !== undefined) {
      parseModelSafeText(
        request.instructions,
        defaultModelCallLimits.maxInputCharacters
      )
    }
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
