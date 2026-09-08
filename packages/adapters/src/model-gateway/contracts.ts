import { reasonCodeSchema, redactPersistedText } from "@sentinel/contracts"
import { z } from "zod"

export const modelCallLimitsSchema = z.strictObject({
  maxInputCharacters: z.number().int().positive().max(100_000),
  maxOutputTokens: z.number().int().positive().max(4_096),
  maxTools: z.number().int().positive().max(32),
  maxToolCalls: z.number().int().positive().max(32),
  maxToolOutputCharacters: z.number().int().positive().max(65_536),
  timeoutMs: z.number().int().positive().max(120_000),
  maxRetries: z.number().int().nonnegative().max(5),
})

export type ModelCallLimits = z.infer<typeof modelCallLimitsSchema>

export const defaultModelCallLimits: ModelCallLimits = {
  maxInputCharacters: 16_000,
  maxOutputTokens: 512,
  maxTools: 16,
  maxToolCalls: 8,
  maxToolOutputCharacters: 8_192,
  timeoutMs: 30_000,
  maxRetries: 2,
}

export interface ModelUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

export interface ModelTextRequest {
  readonly input: string
  readonly instructions?: string
  readonly maxOutputTokens?: number
  readonly signal?: AbortSignal
}

export interface ModelStructuredRequest<Output> extends ModelTextRequest {
  readonly schemaName: string
  readonly schema: z.ZodType<Output>
}

export interface ModelToolDefinition<Arguments = unknown> {
  readonly name: string
  readonly description: string
  readonly parameters: z.ZodType<Arguments>
}

export interface ModelToolRequest extends ModelTextRequest {
  readonly tools: readonly ModelToolDefinition[]
  readonly toolChoice?: "auto" | "required"
}

export interface ModelToolCall<Arguments = unknown> {
  readonly callId: string
  readonly name: string
  readonly arguments: Arguments
  readonly argumentsHash: string
  readonly rawArgumentsHash: string
}

export type ModelContinuationItem =
  | { readonly type: "user_text"; readonly text: string }
  | { readonly type: "assistant_text"; readonly text: string }
  | {
      readonly type: "function_call"
      readonly callId: string
      readonly name: string
      readonly argumentsJson: string
    }
  | {
      readonly type: "reasoning"
      readonly id: string
      readonly encryptedContent?: string
    }

export interface ModelContinuation {
  readonly instructions?: string
  readonly items: readonly ModelContinuationItem[]
  readonly calls: readonly ModelToolCall[]
  readonly tools: readonly {
    readonly name: string
    readonly description: string
    readonly parameters: Readonly<Record<string, unknown>>
  }[]
}

export interface ModelToolOutput {
  readonly callId: string
  readonly output: unknown
}

export interface ModelResult<Output> {
  readonly output: Output
  readonly model: string
  readonly usage: ModelUsage
}

export interface ModelToolCallsResult extends ModelResult<
  readonly ModelToolCall[]
> {
  readonly kind: "tool_calls"
  readonly continuation: ModelContinuation
}

export interface ModelToolFinalResult extends ModelResult<string> {
  readonly kind: "final_text"
}

export type ModelToolDecisionResult =
  ModelToolCallsResult | ModelToolFinalResult

export type ModelStreamEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "completed"; readonly usage: ModelUsage }

export interface ModelGateway {
  generateText(request: ModelTextRequest): Promise<ModelResult<string>>
  generateStructured<Output>(
    request: ModelStructuredRequest<Output>
  ): Promise<ModelResult<Output>>
  decideTools(request: ModelToolRequest): Promise<ModelToolDecisionResult>
  continueTools(
    continuation: ModelContinuation,
    outputs: readonly ModelToolOutput[],
    request?: Omit<ModelTextRequest, "input">
  ): Promise<ModelResult<string>>
  streamText(
    request: ModelTextRequest,
    onEvent: (event: ModelStreamEvent) => void | Promise<void>
  ): Promise<ModelResult<string>>
}

export type ModelGatewayErrorCode =
  | "authentication_failed"
  | "content_filtered"
  | "invalid_request"
  | "limit_exceeded"
  | "malformed_output"
  | "provider_unavailable"
  | "rate_limited"
  | "refused"
  | "timeout"
  | "tool_arguments_invalid"
  | "tool_protocol_invalid"

export class ModelGatewayError extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    readonly retryable: boolean
  ) {
    super(`Model gateway request failed: ${code}`)
    this.name = "ModelGatewayError"
  }
}

export function parseModelSafeText(
  value: string,
  maxCharacters: number
): string {
  const result = z.string().trim().min(1).max(maxCharacters).safeParse(value)
  if (!result.success || redactPersistedText(result.data) !== result.data) {
    throw new ModelGatewayError("invalid_request", false)
  }
  return result.data
}

export function parseModelOperation(value: string): string {
  const result = reasonCodeSchema.safeParse(value)
  if (!result.success) throw new ModelGatewayError("invalid_request", false)
  return result.data
}

const sensitiveKeySegments = new Set([
  "auth",
  "authorization",
  "cookie",
  "credential",
  "password",
  "secret",
  "session",
  "sid",
  "signature",
  "token",
])
const sensitiveKeys = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "connectsid",
  "cookie",
  "credential",
  "idtoken",
  "oauthtoken",
  "password",
  "phpsessid",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessionid",
  "token",
  "xamzsignature",
  "xgoogsignature",
])

export function assertModelSafeValue(
  value: unknown,
  path = "$",
  depth = 0
): void {
  if (depth > 12) throw new ModelGatewayError("limit_exceeded", false)
  if (typeof value === "string") {
    if (value.length > 8_192 || redactPersistedText(value) !== value) {
      throw new ModelGatewayError("invalid_request", false)
    }
    return
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new ModelGatewayError("limit_exceeded", false)
    value.forEach((item, index) =>
      assertModelSafeValue(item, `${path}[${index}]`, depth + 1)
    )
    return
  }
  if (typeof value !== "object") {
    throw new ModelGatewayError("invalid_request", false)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ModelGatewayError("invalid_request", false)
  }
  const entries = Object.entries(value)
  if (entries.length > 128) throw new ModelGatewayError("limit_exceeded", false)
  for (const [key, child] of entries) {
    const segments = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
    const normalized = segments.join("")
    const keyPair = segments.some(
      (segment, index) =>
        ["access", "api", "private"].includes(segment) &&
        segments[index + 1] === "key"
    )
    if (
      segments.some((segment) => sensitiveKeySegments.has(segment)) ||
      sensitiveKeys.has(normalized) ||
      keyPair
    ) {
      throw new ModelGatewayError("invalid_request", false)
    }
    assertModelSafeValue(child, `${path}.${key}`, depth + 1)
  }
}
