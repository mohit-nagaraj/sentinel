import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  AzureOpenAIModelGateway,
  normalizeModelGatewayError,
  type AzureResponsesTransport,
} from "./azure.ts"
import { ModelGatewayError, type ModelUsage } from "./contracts.ts"

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
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event
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
