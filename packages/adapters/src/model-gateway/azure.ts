import { canonicalSerialize } from "@sentinel/contracts"
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  RateLimitError,
} from "openai"
import type {
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses"
import { z } from "zod"

import {
  loadAzureOpenAIEnvironment,
  type AzureOpenAIEnvironment,
} from "./environment.ts"
import {
  assertModelSafeValue,
  defaultModelCallLimits,
  ModelGatewayError,
  modelCallLimitsSchema,
  parseModelOperation,
  parseModelSafeText,
  type ModelCallLimits,
  type ModelContinuation,
  type ModelContinuationItem,
  type ModelGateway,
  type ModelResult,
  type ModelStreamEvent,
  type ModelStructuredRequest,
  type ModelTextRequest,
  type ModelToolCall,
  type ModelToolDecisionResult,
  type ModelToolOutput,
  type ModelToolRequest,
  type ModelUsage,
} from "./contracts.ts"
import { createStrictModelJsonSchema } from "./schema.ts"

export interface AzureResponsesTransport {
  create(request: Readonly<Record<string, unknown>>): Promise<unknown>
  stream(
    request: Readonly<Record<string, unknown>>
  ): Promise<AsyncIterable<unknown>>
}

class OpenAIResponsesTransport implements AzureResponsesTransport {
  constructor(private readonly client: OpenAI) {}

  create(request: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.client.responses.create(
      request as unknown as ResponseCreateParamsNonStreaming
    )
  }

  async stream(
    request: Readonly<Record<string, unknown>>
  ): Promise<AsyncIterable<unknown>> {
    return this.client.responses.create(
      request as unknown as ResponseCreateParamsStreaming
    )
  }
}

const usageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
})
const responseSchema = z.looseObject({
  status: z.string(),
  model: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._:-]+$/),
  output: z.array(z.unknown()),
  output_text: z.string().optional(),
  usage: usageSchema.nullable().optional(),
  error: z
    .looseObject({ code: z.string().nullable().optional() })
    .nullable()
    .optional(),
  incomplete_details: z
    .looseObject({ reason: z.string().nullable().optional() })
    .nullable()
    .optional(),
})
const outputItemSchema = z.looseObject({ type: z.string() })
const messageItemSchema = z.looseObject({
  type: z.literal("message"),
  content: z.array(z.unknown()),
})
const contentItemSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  refusal: z.string().optional(),
})
const functionCallSchema = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string().min(1).max(256),
  name: z.string().min(1).max(96),
  arguments: z.string().max(16_384),
})
const reasoningItemSchema = z.looseObject({
  type: z.literal("reasoning"),
  id: z.string().min(1).max(256),
  encrypted_content: z.string().max(65_536).nullable().optional(),
})
const streamEventSchema = z.looseObject({ type: z.string() })

function usageFromProvider(input: unknown): ModelUsage {
  const parsed = usageSchema.safeParse(input)
  if (!parsed.success) {
    throw new ModelGatewayError("malformed_output", false)
  }
  return {
    inputTokens: parsed.data.input_tokens,
    outputTokens: parsed.data.output_tokens,
    totalTokens: parsed.data.total_tokens,
  }
}

function errorFromProviderCode(
  codeInput: string | null | undefined
): ModelGatewayError {
  const code = codeInput?.toLowerCase() ?? ""
  if (code.includes("content_filter")) {
    return new ModelGatewayError("content_filtered", false)
  }
  if (code.includes("rate_limit")) {
    return new ModelGatewayError("rate_limited", true)
  }
  if (code.includes("timeout")) {
    return new ModelGatewayError("timeout", true)
  }
  if (code.includes("auth") || code.includes("unauthorized")) {
    return new ModelGatewayError("authentication_failed", false)
  }
  if (
    code.includes("invalid_prompt") ||
    code.includes("invalid_request") ||
    code.includes("bad_request")
  ) {
    return new ModelGatewayError("invalid_request", false)
  }
  return new ModelGatewayError("provider_unavailable", true)
}

function parseResponse(input: unknown) {
  const parsed = responseSchema.safeParse(input)
  if (!parsed.success) throw new ModelGatewayError("malformed_output", false)
  const response = parsed.data
  if (response.error?.code !== undefined && response.error.code !== null) {
    throw errorFromProviderCode(response.error.code)
  }
  if (response.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens") {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    throw errorFromProviderCode(response.incomplete_details?.reason)
  }
  if (response.status !== "completed") {
    throw new ModelGatewayError("provider_unavailable", true)
  }
  return response
}

function extractMessageText(input: unknown): string {
  const message = messageItemSchema.safeParse(input)
  if (!message.success) throw new ModelGatewayError("malformed_output", false)
  const textParts: string[] = []
  for (const rawContent of message.data.content) {
    const content = contentItemSchema.safeParse(rawContent)
    if (!content.success) {
      throw new ModelGatewayError("malformed_output", false)
    }
    if (content.data.type === "refusal") {
      throw new ModelGatewayError("refused", false)
    }
    if (
      content.data.type === "output_text" &&
      content.data.text !== undefined
    ) {
      textParts.push(content.data.text)
    }
  }
  return textParts.join("")
}

function extractText(responseInput: unknown): {
  readonly text: string
  readonly model: string
  readonly usage: ModelUsage
} {
  const response = parseResponse(responseInput)
  const textParts: string[] = []
  for (const rawItem of response.output) {
    const item = outputItemSchema.safeParse(rawItem)
    if (!item.success) throw new ModelGatewayError("malformed_output", false)
    if (item.data.type === "message") {
      textParts.push(extractMessageText(item.data))
    }
  }
  const text = response.output_text ?? textParts.join("")
  return {
    text,
    model: response.model,
    usage: usageFromProvider(response.usage),
  }
}

function requestTokenLimit(
  request: Pick<ModelTextRequest, "maxOutputTokens">,
  limits: ModelCallLimits
): number {
  const requested = request.maxOutputTokens ?? limits.maxOutputTokens
  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > limits.maxOutputTokens
  ) {
    throw new ModelGatewayError("limit_exceeded", false)
  }
  return requested
}

export function normalizeModelGatewayError(error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) return error
  if (error instanceof APIConnectionTimeoutError) {
    return new ModelGatewayError("timeout", true)
  }
  if (error instanceof RateLimitError) {
    return new ModelGatewayError("rate_limited", true)
  }
  if (error instanceof APIConnectionError) {
    return new ModelGatewayError("provider_unavailable", true)
  }
  if (error instanceof APIError) {
    if (error.code === "content_filter") {
      return new ModelGatewayError("content_filtered", false)
    }
    if (error.status === 401 || error.status === 403) {
      return new ModelGatewayError("authentication_failed", false)
    }
    if (error.status === 408) return new ModelGatewayError("timeout", true)
    if (error.status === 429) {
      return new ModelGatewayError("rate_limited", true)
    }
    if (error.status !== undefined && error.status >= 500) {
      return new ModelGatewayError("provider_unavailable", true)
    }
    return new ModelGatewayError("invalid_request", false)
  }
  const candidate = z
    .looseObject({
      status: z.number().int().optional(),
      code: z.string().optional(),
      name: z.string().optional(),
    })
    .safeParse(error)
  if (candidate.success) {
    if (candidate.data.code === "content_filter") {
      return new ModelGatewayError("content_filtered", false)
    }
    if (candidate.data.status === 429) {
      return new ModelGatewayError("rate_limited", true)
    }
    if (
      candidate.data.status === 408 ||
      candidate.data.name === "TimeoutError"
    ) {
      return new ModelGatewayError("timeout", true)
    }
    if ((candidate.data.status ?? 0) >= 500) {
      return new ModelGatewayError("provider_unavailable", true)
    }
  }
  return new ModelGatewayError("provider_unavailable", false)
}

export class AzureOpenAIModelGateway implements ModelGateway {
  private readonly limits: ModelCallLimits

  constructor(
    private readonly transport: AzureResponsesTransport,
    private readonly deployment: string,
    limits: ModelCallLimits = defaultModelCallLimits
  ) {
    this.limits = modelCallLimitsSchema.parse(limits)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deployment)) {
      throw new ModelGatewayError("invalid_request", false)
    }
  }

  private baseRequest(request: ModelTextRequest): Record<string, unknown> {
    const input = parseModelSafeText(
      request.input,
      this.limits.maxInputCharacters
    )
    const instructions =
      request.instructions === undefined
        ? undefined
        : parseModelSafeText(
            request.instructions,
            this.limits.maxInputCharacters
          )
    if (
      input.length + (instructions?.length ?? 0) >
      this.limits.maxInputCharacters
    ) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    return {
      model: this.deployment,
      input,
      ...(instructions === undefined ? {} : { instructions }),
      max_output_tokens: requestTokenLimit(request, this.limits),
      reasoning: { effort: "low" },
      store: false,
    }
  }

  private async create(request: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.transport.create(request)
    } catch (error) {
      throw normalizeModelGatewayError(error)
    }
  }

  async generateText(request: ModelTextRequest): Promise<ModelResult<string>> {
    const result = extractText(await this.create(this.baseRequest(request)))
    if (result.text.length === 0) {
      throw new ModelGatewayError("malformed_output", false)
    }
    return { output: result.text, model: result.model, usage: result.usage }
  }

  async generateStructured<Output>(
    request: ModelStructuredRequest<Output>
  ): Promise<ModelResult<Output>> {
    const schemaName = parseModelOperation(request.schemaName)
    const response = await this.create({
      ...this.baseRequest(request),
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          schema: createStrictModelJsonSchema(request.schema, schemaName),
          strict: true,
        },
      },
    })
    const result = extractText(response)
    try {
      return {
        output: request.schema.parse(JSON.parse(result.text)),
        model: result.model,
        usage: result.usage,
      }
    } catch {
      throw new ModelGatewayError("malformed_output", false)
    }
  }

  async decideTools(
    request: ModelToolRequest
  ): Promise<ModelToolDecisionResult> {
    if (
      request.tools.length < 1 ||
      request.tools.length > this.limits.maxTools
    ) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    const toolsByName = new Map(
      request.tools.map((tool) => [parseModelOperation(tool.name), tool])
    )
    if (toolsByName.size !== request.tools.length) {
      throw new ModelGatewayError("invalid_request", false)
    }
    const input = parseModelSafeText(
      request.input,
      this.limits.maxInputCharacters
    )
    const instructions =
      request.instructions === undefined
        ? undefined
        : parseModelSafeText(
            request.instructions,
            this.limits.maxInputCharacters
          )
    const tools = request.tools.map((tool) => ({
      name: tool.name,
      description: parseModelSafeText(tool.description, 1_024),
      parameters: createStrictModelJsonSchema(tool.parameters, tool.name),
    }))
    const response = parseResponse(
      await this.create({
        ...this.baseRequest(request),
        include: ["reasoning.encrypted_content"],
        parallel_tool_calls: false,
        tool_choice: request.toolChoice ?? "auto",
        tools: tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        })),
      })
    )
    const calls: ModelToolCall[] = []
    const callIds = new Set<string>()
    const items: ModelContinuationItem[] = [{ type: "user_text", text: input }]
    const assistantText: string[] = []
    for (const rawItem of response.output) {
      const item = outputItemSchema.safeParse(rawItem)
      if (!item.success) throw new ModelGatewayError("malformed_output", false)
      if (item.data.type === "function_call") {
        const call = functionCallSchema.safeParse(item.data)
        if (!call.success) {
          throw new ModelGatewayError("malformed_output", false)
        }
        const tool = toolsByName.get(call.data.name)
        if (tool === undefined) {
          throw new ModelGatewayError("tool_protocol_invalid", false)
        }
        let rawArguments: unknown
        try {
          rawArguments = JSON.parse(call.data.arguments)
        } catch {
          throw new ModelGatewayError("tool_arguments_invalid", false)
        }
        const argumentsResult = tool.parameters.safeParse(rawArguments)
        if (!argumentsResult.success) {
          throw new ModelGatewayError("tool_arguments_invalid", false)
        }
        assertModelSafeValue(argumentsResult.data)
        if (callIds.has(call.data.call_id)) {
          throw new ModelGatewayError("tool_protocol_invalid", false)
        }
        callIds.add(call.data.call_id)
        calls.push({
          callId: call.data.call_id,
          name: call.data.name,
          arguments: argumentsResult.data,
        })
        items.push({
          type: "function_call",
          callId: call.data.call_id,
          name: call.data.name,
          argumentsJson: call.data.arguments,
        })
      } else if (item.data.type === "reasoning") {
        const reasoning = reasoningItemSchema.safeParse(item.data)
        if (!reasoning.success) {
          throw new ModelGatewayError("malformed_output", false)
        }
        if (
          reasoning.data.encrypted_content === undefined ||
          reasoning.data.encrypted_content === null
        ) {
          throw new ModelGatewayError("tool_protocol_invalid", false)
        }
        items.push({
          type: "reasoning",
          id: reasoning.data.id,
          encryptedContent: reasoning.data.encrypted_content,
        })
      } else if (item.data.type === "message") {
        const extracted = extractMessageText(item.data)
        if (extracted.length > 0) {
          const text = parseModelSafeText(
            extracted,
            this.limits.maxInputCharacters
          )
          assistantText.push(text)
          items.push({ type: "assistant_text", text })
        }
      }
    }
    if (
      calls.length > this.limits.maxToolCalls ||
      items.length > this.limits.maxToolCalls * 3 + 2 ||
      input.length +
        (instructions?.length ?? 0) +
        assistantText.join("").length >
        this.limits.maxInputCharacters
    ) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    if ((request.toolChoice ?? "auto") === "required" && calls.length === 0) {
      throw new ModelGatewayError("tool_protocol_invalid", false)
    }
    const usage = usageFromProvider(response.usage)
    if (calls.length === 0) {
      const output = assistantText.join("")
      if (output.length === 0) {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
      return {
        kind: "final_text",
        output,
        model: response.model,
        usage,
      }
    }
    return {
      kind: "tool_calls",
      output: calls,
      continuation: {
        ...(instructions === undefined ? {} : { instructions }),
        items,
        calls,
        tools,
      },
      model: response.model,
      usage,
    }
  }

  async continueTools(
    continuation: ModelContinuation,
    outputs: readonly ModelToolOutput[],
    request: Omit<ModelTextRequest, "input"> = {}
  ): Promise<ModelResult<string>> {
    if (
      continuation.items.length > this.limits.maxToolCalls * 3 + 2 ||
      continuation.calls.length > this.limits.maxToolCalls ||
      continuation.tools.length > this.limits.maxTools
    ) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    if (continuation.instructions !== undefined) {
      parseModelSafeText(
        continuation.instructions,
        this.limits.maxInputCharacters
      )
    }
    const continuationCalls = new Map<string, ModelToolCall>()
    for (const call of continuation.calls) {
      const callId = z.string().min(1).max(256).safeParse(call.callId)
      const name = z.string().safeParse(call.name)
      if (!callId.success || !name.success) {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
      parseModelOperation(name.data)
      assertModelSafeValue(call.arguments)
      if (continuationCalls.has(callId.data)) {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
      continuationCalls.set(callId.data, call)
    }
    const itemCallIds = new Set<string>()
    let continuationTextCharacters = 0
    for (const item of continuation.items) {
      if (item.type === "user_text" || item.type === "assistant_text") {
        parseModelSafeText(item.text, this.limits.maxInputCharacters)
        continuationTextCharacters += item.text.length
      } else if (item.type === "function_call") {
        if (
          item.callId.length < 1 ||
          item.callId.length > 256 ||
          item.argumentsJson.length > 16_384 ||
          continuationCalls.get(item.callId)?.name !== item.name
        ) {
          throw new ModelGatewayError("tool_protocol_invalid", false)
        }
        parseModelOperation(item.name)
        let parsedArguments: unknown
        try {
          parsedArguments = JSON.parse(item.argumentsJson)
        } catch {
          throw new ModelGatewayError("tool_protocol_invalid", false)
        }
        assertModelSafeValue(parsedArguments)
        if (
          canonicalSerialize(parsedArguments) !==
          canonicalSerialize(continuationCalls.get(item.callId)?.arguments)
        ) {
          throw new ModelGatewayError("tool_protocol_invalid", false)
        }
        itemCallIds.add(item.callId)
      } else if (
        item.id.length < 1 ||
        item.id.length > 256 ||
        (item.encryptedContent?.length ?? 0) > 65_536
      ) {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
    }
    if (
      continuationTextCharacters > this.limits.maxInputCharacters ||
      itemCallIds.size !== continuationCalls.size ||
      [...continuationCalls.keys()].some((callId) => !itemCallIds.has(callId))
    ) {
      throw new ModelGatewayError("tool_protocol_invalid", false)
    }
    const continuationToolNames = new Set<string>()
    for (const tool of continuation.tools) {
      parseModelOperation(tool.name)
      parseModelSafeText(tool.description, 1_024)
      assertModelSafeValue(tool.parameters)
      if (
        continuationToolNames.has(tool.name) ||
        JSON.stringify(tool.parameters).length > 32_768
      ) {
        throw new ModelGatewayError("tool_protocol_invalid", false)
      }
      continuationToolNames.add(tool.name)
    }
    if (
      continuation.calls.some((call) => !continuationToolNames.has(call.name))
    ) {
      throw new ModelGatewayError("tool_protocol_invalid", false)
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
    let toolOutputCharacters = 0
    const toolOutputs = outputs.map((output) => {
      assertModelSafeValue(output.output)
      let serialized: string
      try {
        serialized = JSON.stringify(output.output)
      } catch {
        throw new ModelGatewayError("invalid_request", false)
      }
      if (
        serialized === undefined ||
        (toolOutputCharacters += serialized.length) >
          this.limits.maxToolOutputCharacters
      ) {
        throw new ModelGatewayError("limit_exceeded", false)
      }
      return {
        type: "function_call_output",
        call_id: output.callId,
        output: serialized,
      }
    })
    const input = continuation.items.map((item) => {
      switch (item.type) {
        case "user_text":
          return { role: "user", content: item.text }
        case "assistant_text":
          return { role: "assistant", content: item.text }
        case "function_call":
          return {
            type: "function_call",
            call_id: item.callId,
            name: item.name,
            arguments: item.argumentsJson,
          }
        case "reasoning":
          return {
            type: "reasoning",
            id: item.id,
            summary: [],
            ...(item.encryptedContent === undefined
              ? {}
              : { encrypted_content: item.encryptedContent }),
          }
      }
    })
    const continuationInstructions =
      request.instructions ?? continuation.instructions
    const instructions =
      continuationInstructions === undefined
        ? undefined
        : parseModelSafeText(
            continuationInstructions,
            this.limits.maxInputCharacters
          )
    if (
      continuationTextCharacters + (instructions?.length ?? 0) >
      this.limits.maxInputCharacters
    ) {
      throw new ModelGatewayError("limit_exceeded", false)
    }
    const response = await this.create({
      model: this.deployment,
      input: [...input, ...toolOutputs],
      ...(instructions === undefined ? {} : { instructions }),
      max_output_tokens: requestTokenLimit(request, this.limits),
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      store: false,
      tool_choice: "none",
      tools: continuation.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true,
      })),
    })
    const result = extractText(response)
    if (result.text.length === 0) {
      throw new ModelGatewayError("malformed_output", false)
    }
    return { output: result.text, model: result.model, usage: result.usage }
  }

  async streamText(
    request: ModelTextRequest,
    onEvent: (event: ModelStreamEvent) => void | Promise<void>
  ): Promise<ModelResult<string>> {
    let stream: AsyncIterable<unknown>
    try {
      stream = await this.transport.stream({
        ...this.baseRequest(request),
        stream: true,
      })
    } catch (error) {
      throw normalizeModelGatewayError(error)
    }
    const parts: string[] = []
    let completed: ReturnType<typeof parseResponse> | undefined
    const iterator = stream[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        let iteration: IteratorResult<unknown>
        try {
          iteration = await iterator.next()
        } catch (error) {
          throw normalizeModelGatewayError(error)
        }
        if (iteration.done) {
          exhausted = true
          break
        }
        const event = streamEventSchema.safeParse(iteration.value)
        if (!event.success) {
          throw new ModelGatewayError("malformed_output", false)
        }
        if (event.data.type === "response.output_text.delta") {
          const delta = z.string().safeParse(event.data["delta"])
          if (!delta.success) {
            throw new ModelGatewayError("malformed_output", false)
          }
          parts.push(delta.data)
          await onEvent({ type: "text_delta", delta: delta.data })
        } else if (event.data.type === "response.refusal.delta") {
          throw new ModelGatewayError("refused", false)
        } else if (event.data.type === "response.completed") {
          completed = parseResponse(event.data["response"])
        } else if (
          event.data.type === "response.failed" ||
          event.data.type === "response.incomplete"
        ) {
          parseResponse(event.data["response"])
        } else if (event.data.type === "error") {
          const code = z.string().nullable().safeParse(event.data["code"])
          throw errorFromProviderCode(code.success ? code.data : undefined)
        }
      }
    } finally {
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // Preserve the original callback or protocol failure.
        }
      }
    }
    if (completed === undefined || parts.length === 0) {
      throw new ModelGatewayError("malformed_output", false)
    }
    const usage = usageFromProvider(completed.usage)
    await onEvent({ type: "completed", usage })
    return { output: parts.join(""), model: completed.model, usage }
  }
}

export function createAzureOpenAIModelGateway(
  environment: AzureOpenAIEnvironment,
  limits: ModelCallLimits = defaultModelCallLimits
): AzureOpenAIModelGateway {
  const parsedEnvironment = loadAzureOpenAIEnvironment(environment)
  const parsedLimits = modelCallLimitsSchema.parse(limits)
  const client = new OpenAI({
    apiKey: parsedEnvironment.AZURE_OPENAI_API_KEY,
    baseURL: parsedEnvironment.AZURE_OPENAI_ENDPOINT,
    maxRetries: parsedLimits.maxRetries,
    timeout: parsedLimits.timeoutMs,
  })
  return new AzureOpenAIModelGateway(
    new OpenAIResponsesTransport(client),
    parsedEnvironment.AZURE_OPENAI_DEPLOYMENT,
    parsedLimits
  )
}
