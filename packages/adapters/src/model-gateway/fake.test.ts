import { hashCanonical } from "@sentinel/contracts"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { ModelGatewayError, type ModelUsage } from "./contracts.ts"
import { ScriptedModelGateway } from "./fake.ts"
import { createStrictModelJsonSchema } from "./schema.ts"

const usage: ModelUsage = { inputTokens: 4, outputTokens: 2, totalTokens: 6 }

describe("scripted model gateway", () => {
  it("replays a deterministic multi-turn trajectory", async () => {
    const continuation = {
      items: [
        { type: "user_text" as const, text: "Find the count" },
        {
          type: "function_call" as const,
          callId: "call-1",
          name: "lookup_count",
          argumentsJson: "{}",
        },
      ],
      calls: [
        {
          callId: "call-1",
          name: "lookup_count",
          arguments: {},
          argumentsHash: hashCanonical({}),
          rawArgumentsHash: hashCanonical({}),
        },
      ],
      tools: [
        {
          name: "lookup_count",
          description: "Look up a count.",
          parameters: createStrictModelJsonSchema(
            z.strictObject({}),
            "lookup_count"
          ),
        },
      ],
    }
    const gateway = new ScriptedModelGateway([
      {
        kind: "tools",
        result: {
          kind: "tool_calls",
          output: continuation.calls,
          continuation,
          model: "fake",
          usage,
        },
      },
      {
        kind: "continuation",
        result: { output: "The count is 42.", model: "fake", usage },
      },
      {
        kind: "structured",
        result: { output: { count: 42 }, model: "fake", usage },
      },
    ])
    await expect(
      gateway.continueTools(
        {
          ...continuation,
          instructions: "password=must-not-hide-behind-override",
        },
        [{ callId: "call-1", output: {} }],
        { instructions: "Use the supplied result." }
      )
    ).rejects.toMatchObject({ code: "invalid_request" })

    const decision = await gateway.decideTools({
      input: "Find the count",
      tools: [
        {
          name: "lookup_count",
          description: "Look up a count.",
          parameters: z.strictObject({}),
        },
      ],
    })
    expect(decision.kind).toBe("tool_calls")
    if (decision.kind !== "tool_calls") throw new Error("expected tool calls")
    await expect(
      gateway.continueTools(decision.continuation, [
        { callId: "call-1", output: { count: 42 } },
      ])
    ).resolves.toMatchObject({ output: "The count is 42." })
    await expect(
      gateway.generateStructured({
        input: "Return the count",
        schemaName: "count_result",
        schema: z.strictObject({ count: z.number() }),
      })
    ).resolves.toMatchObject({ output: { count: 42 } })
    gateway.assertComplete()
  })

  it("rejects scripted calls that disagree with continuation state", async () => {
    const emptyHash = hashCanonical({})
    const continuation = {
      items: [
        { type: "user_text" as const, text: "look up" },
        {
          type: "function_call" as const,
          callId: "call-1",
          name: "tool_b",
          argumentsJson: "{}",
        },
      ],
      calls: [
        {
          callId: "call-1",
          name: "tool_b",
          arguments: {},
          argumentsHash: emptyHash,
          rawArgumentsHash: emptyHash,
        },
      ],
      tools: [
        {
          name: "tool_b",
          description: "Use tool B.",
          parameters: createStrictModelJsonSchema(z.strictObject({}), "tool_b"),
        },
      ],
    }
    const gateway = new ScriptedModelGateway([
      {
        kind: "tools",
        result: {
          kind: "tool_calls",
          output: [
            {
              callId: "call-1",
              name: "tool_a",
              arguments: {},
              argumentsHash: emptyHash,
              rawArgumentsHash: emptyHash,
            },
          ],
          continuation,
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ])
    const tool = (name: string) => ({
      name,
      description: name === "tool_a" ? "Use tool A." : "Use tool B.",
      parameters: z.strictObject({}),
    })
    await expect(
      gateway.decideTools({
        input: "look up",
        tools: [tool("tool_a"), tool("tool_b")],
      })
    ).rejects.toMatchObject({ code: "tool_protocol_invalid" })
    gateway.assertComplete()
  })

  it("replays typed failures", async () => {
    const gateway = new ScriptedModelGateway([
      {
        kind: "text",
        error: new ModelGatewayError("rate_limited", true),
      },
    ])
    await expect(
      gateway.generateText({ input: "hello" })
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    })
    gateway.assertComplete()
  })

  it("rejects invalid schema names before consuming a structured step", async () => {
    const gateway = new ScriptedModelGateway([
      {
        kind: "structured",
        result: {
          output: { ok: true },
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ])
    const schema = z.strictObject({ ok: z.boolean() })
    await expect(
      gateway.generateStructured({
        input: "return ok",
        schemaName: "not valid!",
        schema,
      })
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      gateway.generateStructured({
        input: "return ok",
        schemaName: "valid_result",
        schema,
      })
    ).resolves.toMatchObject({ output: { ok: true } })
    gateway.assertComplete()
  })

  it("rejects duplicate tool definitions before consuming a step", async () => {
    const gateway = new ScriptedModelGateway([
      {
        kind: "tools",
        result: {
          kind: "final_text",
          output: "done",
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ])
    const tool = {
      name: "lookup",
      description: "Look up a value.",
      parameters: z.strictObject({}),
    }
    await expect(
      gateway.decideTools({ input: "answer", tools: [tool, tool] })
    ).rejects.toMatchObject({ code: "invalid_request" })
    await expect(
      gateway.decideTools({ input: "answer", tools: [tool] })
    ).resolves.toMatchObject({ kind: "final_text", output: "done" })
    gateway.assertComplete()
  })

  it("rejects mismatched tool results before consuming a scripted step", async () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    const continuation = {
      items: [
        { type: "user_text" as const, text: "look up" },
        {
          type: "function_call" as const,
          callId: "call-1",
          name: "lookup",
          argumentsJson: "{}",
        },
      ],
      calls: [
        {
          callId: "call-1",
          name: "lookup",
          arguments: {},
          argumentsHash: hashCanonical({}),
          rawArgumentsHash: hashCanonical({}),
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Look up a value.",
          parameters: createStrictModelJsonSchema(z.strictObject({}), "lookup"),
        },
      ],
    }
    const gateway = new ScriptedModelGateway([
      {
        kind: "continuation",
        result: { output: "done", model: "fake", usage },
      },
    ])
    await expect(
      gateway.continueTools(
        {
          ...continuation,
          items: continuation.items.map((item) =>
            item.type === "user_text"
              ? { ...item, text: "x".repeat(15_990) }
              : item
          ),
        },
        [{ callId: "call-1", output: {} }],
        { instructions: "y".repeat(20) }
      )
    ).rejects.toMatchObject({ code: "limit_exceeded" })
    await expect(
      gateway.continueTools(
        {
          ...continuation,
          items: continuation.items.map((item) =>
            item.type === "function_call"
              ? { ...item, argumentsJson: '{"changed":true}' }
              : item
          ),
        },
        [{ callId: "call-1", output: {} }]
      )
    ).rejects.toMatchObject({ code: "tool_protocol_invalid" })
    await expect(
      gateway.continueTools(continuation, [{ callId: "wrong", output: {} }])
    ).rejects.toMatchObject({ code: "tool_protocol_invalid" })
    await expect(
      gateway.continueTools(continuation, [{ callId: "call-1", output: {} }])
    ).resolves.toMatchObject({ output: "done" })
    gateway.assertComplete()
  })

  it("enforces production request limits before consuming a step", async () => {
    const gateway = new ScriptedModelGateway([
      {
        kind: "text",
        result: {
          output: "ok",
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ])
    await expect(
      gateway.generateText({ input: "hello", maxOutputTokens: -1 })
    ).rejects.toMatchObject({ code: "limit_exceeded" })
    await expect(
      gateway.generateText({ input: "hello" })
    ).resolves.toMatchObject({
      output: "ok",
    })
    gateway.assertComplete()
  })

  it("normalizes malformed scripted structured output", async () => {
    const gateway = new ScriptedModelGateway([
      {
        kind: "structured",
        result: {
          output: { count: "wrong" },
          model: "fake",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      },
    ])
    await expect(
      gateway.generateStructured({
        input: "count",
        schemaName: "count_result",
        schema: z.strictObject({ count: z.number() }),
      })
    ).rejects.toMatchObject({ code: "malformed_output" })
    gateway.assertComplete()
  })
})
