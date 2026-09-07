import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  AzureOpenAIModelGateway,
  normalizeModelGatewayError,
  type AzureResponsesTransport,
} from "./azure.ts"
import {
  defaultModelCallLimits,
  ModelGatewayError,
  type ModelUsage,
} from "./contracts.ts"

const providerUsage = {
  input_tokens: 10,
  output_tokens: 4,
  total_tokens: 14,
}
const usage: ModelUsage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 }

function completed(
  outputText: string,
  output: readonly unknown[] = [
    {
      type: "message",
      content: [{ type: "output_text", text: outputText }],
    },
  ]
) {
  return {
    status: "completed",
    model: "azure-deployment-version",
    output,
    output_text: outputText,
    usage: providerUsage,
  }
}

class QueueTransport implements AzureResponsesTransport {
  readonly requests: Readonly<Record<string, unknown>>[] = []
  streamReturned = false

  constructor(
    private readonly responses: unknown[] = [],
    private readonly events: unknown[] = []
  ) {}

  async create(request: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.requests.push(request)
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response
  }

  async stream(
    request: Readonly<Record<string, unknown>>
  ): Promise<AsyncIterable<unknown>> {
    this.requests.push(request)
    const events = this.events
    const markReturned = () => {
      this.streamReturned = true
    }
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (const event of events) yield event
        } finally {
          markReturned()
        }
      },
    }
  }
}

describe("Azure OpenAI model gateway", () => {
  it("generates stateless bounded text and captures usage", async () => {
    const transport = new QueueTransport([completed("hello")])
    const gateway = new AzureOpenAIModelGateway(transport, "deployment")
    await expect(gateway.generateText({ input: "Say hello" })).resolves.toEqual(
      {
        output: "hello",
        model: "azure-deployment-version",
        usage,
      }
    )
    expect(transport.requests[0]).toMatchObject({
      model: "deployment",
      input: "Say hello",
      max_output_tokens: 512,
      reasoning: { effort: "low" },
      store: false,
    })
    expect(transport.requests[0]).not.toHaveProperty("previous_response_id")
  })

  it("sends strict JSON schema and revalidates output", async () => {
    const schema = z.strictObject({ answer: z.number().int() })
    const transport = new QueueTransport([completed('{"answer":42}')])
    const gateway = new AzureOpenAIModelGateway(transport, "deployment")
    await expect(
      gateway.generateStructured({
        input: "Return the answer",
        schemaName: "answer_result",
        schema,
      })
    ).resolves.toMatchObject({ output: { answer: 42 } })
    expect(transport.requests[0]).toMatchObject({
      text: {
        format: {
          type: "json_schema",
          name: "answer_result",
          strict: true,
          schema: { type: "object", additionalProperties: false },
        },
      },
    })

    const malformed = new AzureOpenAIModelGateway(
      new QueueTransport([completed('{"answer":"wrong"}')]),
      "deployment"
    )
    await expect(
      malformed.generateStructured({
        input: "Return the answer",
        schemaName: "answer_result",
        schema,
      })
    ).rejects.toMatchObject({ code: "malformed_output" })

    const unsupportedTransport = new QueueTransport([completed("unused")])
    await expect(
      new AzureOpenAIModelGateway(
        unsupportedTransport,
        "deployment"
      ).generateStructured({
        input: "Return a date",
        schemaName: "date_result",
        schema: z.date(),
      })
    ).rejects.toMatchObject({ code: "invalid_request", retryable: false })
    expect(unsupportedTransport.requests).toHaveLength(0)
  })

  it("validates strict tool calls and correlates continuation outputs", async () => {
    const call = {
      type: "function_call",
      call_id: "call-1",
      name: "lookup_count",
      arguments: '{"scope":"orders"}',
    }
    const transport = new QueueTransport([
      completed("", [call]),
      completed("There are 42 orders."),
    ])
    const gateway = new AzureOpenAIModelGateway(transport, "deployment")
    const decision = await gateway.decideTools({
      input: "Count orders",
      instructions: "Use tools before answering.",
      toolChoice: "required",
      tools: [
        {
          name: "lookup_count",
          description: "Return a deterministic count.",
          parameters: z.strictObject({ scope: z.literal("orders") }),
        },
      ],
    })
    expect(decision.kind).toBe("tool_calls")
    if (decision.kind !== "tool_calls") throw new Error("expected tool calls")
    expect(decision.output).toEqual([
      {
        callId: "call-1",
        name: "lookup_count",
        arguments: { scope: "orders" },
      },
    ])
    await expect(
      gateway.continueTools(decision.continuation, [
        { callId: "call-1", output: { count: 42 } },
      ])
    ).resolves.toMatchObject({ output: "There are 42 orders." })
    expect(transport.requests[1]).toMatchObject({
      instructions: "Use tools before answering.",
      store: false,
    })
    expect(transport.requests[1]?.["input"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "call-1" }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call-1",
        }),
      ])
    )
    await expect(
      gateway.continueTools(decision.continuation, [
        { callId: "other", output: 42 },
      ])
    ).rejects.toMatchObject({ code: "tool_protocol_invalid" })
    await expect(
      gateway.continueTools(
        {
          ...decision.continuation,
          items: [
            ...decision.continuation.items,
            { type: "user_text", text: "password=must-not-replay" },
          ],
        },
        [{ callId: "call-1", output: 42 }]
      )
    ).rejects.toMatchObject({ code: "invalid_request" })
  })

  it("returns a direct terminal answer when auto tool choice uses no tool", async () => {
    const gateway = new AzureOpenAIModelGateway(
      new QueueTransport([
        completed("First.Second.", [
          {
            type: "message",
            content: [{ type: "output_text", text: "First." }],
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "Second." }],
          },
        ]),
      ]),
      "deployment"
    )
    await expect(
      gateway.decideTools({
        input: "Answer without a lookup when possible.",
        toolChoice: "auto",
        tools: [
          {
            name: "lookup_count",
            description: "Return a count.",
            parameters: z.strictObject({}),
          },
        ],
      })
    ).resolves.toMatchObject({
      kind: "final_text",
      output: "First.Second.",
    })
  })

  it("returns only compact, replayable continuation state", async () => {
    const call = {
      type: "function_call",
      call_id: "call-1",
      name: "lookup",
      arguments: "{}",
    }
    const limits = { ...defaultModelCallLimits, maxInputCharacters: 5 }
    const oversized = new AzureOpenAIModelGateway(
      new QueueTransport([
        completed("x", [
          { type: "message", content: [{ type: "output_text", text: "x" }] },
          call,
        ]),
      ]),
      "deployment",
      limits
    )
    await expect(
      oversized.decideTools({
        input: "12345",
        tools: [
          {
            name: "lookup",
            description: "Look up a value.",
            parameters: z.strictObject({}),
          },
        ],
      })
    ).rejects.toMatchObject({ code: "limit_exceeded" })

    const missingReasoning = new AzureOpenAIModelGateway(
      new QueueTransport([
        completed("", [{ type: "reasoning", id: "reason-1" }, call]),
      ]),
      "deployment"
    )
    await expect(
      missingReasoning.decideTools({
        input: "look up",
        tools: [
          {
            name: "lookup",
            description: "Look up a value.",
            parameters: z.strictObject({}),
          },
        ],
      })
    ).rejects.toMatchObject({ code: "tool_protocol_invalid" })
  })

  it("rejects malformed tool arguments before returning a decision", async () => {
    const gateway = new AzureOpenAIModelGateway(
      new QueueTransport([
        completed("", [
          {
            type: "function_call",
            call_id: "call-1",
            name: "lookup_count",
            arguments: '{"scope":42}',
          },
        ]),
      ]),
      "deployment"
    )
    await expect(
      gateway.decideTools({
        input: "Count orders",
        tools: [
          {
            name: "lookup_count",
            description: "Return a count.",
            parameters: z.strictObject({ scope: z.string() }),
          },
        ],
      })
    ).rejects.toMatchObject({ code: "tool_arguments_invalid" })
  })

  it("adapts text deltas without exposing reasoning events", async () => {
    const transport = new QueueTransport(
      [],
      [
        { type: "response.reasoning_summary_text.delta", delta: "hidden" },
        { type: "response.output_text.delta", delta: "hel" },
        { type: "response.output_text.delta", delta: "lo" },
        { type: "response.completed", response: completed("hello") },
      ]
    )
    const gateway = new AzureOpenAIModelGateway(transport, "deployment")
    const events: unknown[] = []
    await expect(
      gateway.streamText({ input: "Say hello" }, (event) => {
        events.push(event)
      })
    ).resolves.toEqual({
      output: "hello",
      model: "azure-deployment-version",
      usage,
    })
    expect(events).toEqual([
      { type: "text_delta", delta: "hel" },
      { type: "text_delta", delta: "lo" },
      { type: "completed", usage },
    ])
  })

  it("classifies incomplete/error streams and preserves callback failures", async () => {
    const incomplete = new AzureOpenAIModelGateway(
      new QueueTransport(
        [],
        [
          { type: "response.output_text.delta", delta: "partial" },
          {
            type: "response.incomplete",
            response: {
              ...completed("partial"),
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            },
          },
        ]
      ),
      "deployment"
    )
    await expect(
      incomplete.streamText({ input: "hello" }, () => undefined)
    ).rejects.toMatchObject({ code: "limit_exceeded" })

    const filtered = new AzureOpenAIModelGateway(
      new QueueTransport([], [{ type: "error", code: "content_filter" }]),
      "deployment"
    )
    await expect(
      filtered.streamText({ input: "hello" }, () => undefined)
    ).rejects.toMatchObject({ code: "content_filtered" })

    const callbackError = new Error("event persistence failed")
    const callbackTransport = new QueueTransport(
      [],
      [
        { type: "response.output_text.delta", delta: "hello" },
        { type: "response.completed", response: completed("hello") },
      ]
    )
    const callbackGateway = new AzureOpenAIModelGateway(
      callbackTransport,
      "deployment"
    )
    await expect(
      callbackGateway.streamText({ input: "hello" }, () => {
        throw callbackError
      })
    ).rejects.toBe(callbackError)
    expect(callbackTransport.streamReturned).toBe(true)

    const rateLimited = new AzureOpenAIModelGateway(
      new QueueTransport([], [{ type: "error", code: "rate_limit_exceeded" }]),
      "deployment"
    )
    await expect(
      rateLimited.streamText({ input: "hello" }, () => undefined)
    ).rejects.toMatchObject({ code: "rate_limited", retryable: true })

    const invalidPrompt = new AzureOpenAIModelGateway(
      new QueueTransport([], [{ type: "error", code: "invalid_prompt" }]),
      "deployment"
    )
    await expect(
      invalidPrompt.streamText({ input: "hello" }, () => undefined)
    ).rejects.toMatchObject({ code: "invalid_request", retryable: false })
  })

  it("normalizes refusals, filters, limits, timeouts, and rate limits", async () => {
    const refusal = new AzureOpenAIModelGateway(
      new QueueTransport([
        completed("", [
          { type: "message", content: [{ type: "refusal", refusal: "no" }] },
        ]),
      ]),
      "deployment"
    )
    await expect(
      refusal.generateText({ input: "benign" })
    ).rejects.toMatchObject({
      code: "refused",
      retryable: false,
    })

    const filtered = new AzureOpenAIModelGateway(
      new QueueTransport([
        {
          status: "failed",
          model: "deployment",
          output: [],
          error: { code: "content_filter", message: "raw provider detail" },
        },
      ]),
      "deployment"
    )
    await expect(filtered.generateText({ input: "benign" })).rejects.toEqual(
      new ModelGatewayError("content_filtered", false)
    )
    expect(normalizeModelGatewayError({ status: 429 })).toMatchObject({
      code: "rate_limited",
      retryable: true,
    })
    expect(normalizeModelGatewayError({ name: "TimeoutError" })).toMatchObject({
      code: "timeout",
      retryable: true,
    })
    await expect(
      new AzureOpenAIModelGateway(
        new QueueTransport(),
        "deployment"
      ).generateText({
        input: "hello",
        maxOutputTokens: 513,
      })
    ).rejects.toMatchObject({ code: "limit_exceeded" })
  })
})
