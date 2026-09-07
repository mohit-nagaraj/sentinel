import { describe, expect, it } from "vitest"
import { z } from "zod"

import { ModelGatewayError, type ModelUsage } from "./contracts.ts"
import { ScriptedModelGateway } from "./fake.ts"

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
      calls: [{ callId: "call-1", name: "lookup_count", arguments: {} }],
      tools: [],
    }
    const gateway = new ScriptedModelGateway([
      {
        kind: "tools",
        result: {
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

    const decision = await gateway.decideTools({
      input: "Find the count",
      tools: [],
    })
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
})
