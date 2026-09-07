import { hashCanonical } from "@sentinel/contracts"
import {
  createAzureOpenAIModelGateway,
  loadAzureCompatibilityEnvironment,
  loadAzureOpenAIEnvironment,
} from "@sentinel/adapters"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const enabled = process.env["RUN_AZURE_OPENAI_COMPATIBILITY"] === "1"
const describeCompatibility = enabled ? describe : describe.skip

describeCompatibility("Azure OpenAI deployment compatibility", () => {
  it("passes Sentinel's bounded Responses API capability probe", async () => {
    const environment = loadAzureOpenAIEnvironment(process.env)
    const compatibility = loadAzureCompatibilityEnvironment(process.env)
    const maxOutputTokens = compatibility.AZURE_OPENAI_COMPATIBILITY_MAX_TOKENS
    const gateway = createAzureOpenAIModelGateway(environment, {
      maxInputCharacters: 2_000,
      maxOutputTokens,
      maxTools: 2,
      maxToolCalls: 2,
      maxToolOutputCharacters: 1_000,
      timeoutMs: 30_000,
      maxRetries: 1,
    })

    const ordinary = await gateway.generateText({
      input: "Reply with exactly OK.",
      maxOutputTokens,
    })
    expect(ordinary.output.toUpperCase()).toContain("OK")
    expect(ordinary.usage.totalTokens).toBeGreaterThan(0)

    const structured = await gateway.generateStructured({
      input: "Return status compatible and value 42.",
      schemaName: "compatibility_result",
      schema: z.strictObject({
        status: z.literal("compatible"),
        value: z.literal(42),
      }),
      maxOutputTokens,
    })
    expect(structured.output).toEqual({ status: "compatible", value: 42 })

    const decision = await gateway.decideTools({
      input:
        "Call lookup_fact with key answer. Do not answer until its output is provided.",
      toolChoice: "required",
      tools: [
        {
          name: "lookup_fact",
          description: "Look up one deterministic compatibility fact.",
          parameters: z.strictObject({ key: z.literal("answer") }),
        },
      ],
      maxOutputTokens,
    })
    expect(decision.kind).toBe("tool_calls")
    if (decision.kind !== "tool_calls") throw new Error("expected tool calls")
    expect(decision.output).toHaveLength(1)
    expect(decision.output[0]).toMatchObject({
      name: "lookup_fact",
      arguments: { key: "answer" },
    })
    const continued = await gateway.continueTools(
      decision.continuation,
      [{ callId: decision.output[0]!.callId, output: { value: 42 } }],
      {
        instructions: "Reply with only the numeric value returned by the tool.",
        maxOutputTokens,
      }
    )
    expect(continued.output).toContain("42")

    const streamEvents: string[] = []
    const streamed = await gateway.streamText(
      { input: "Reply with exactly STREAM_OK.", maxOutputTokens },
      (event) => {
        streamEvents.push(event.type)
      }
    )
    expect(streamed.output.toUpperCase()).toContain("STREAM_OK")
    expect(streamEvents).toContain("text_delta")
    expect(streamEvents.at(-1)).toBe("completed")

    const timeoutGateway = createAzureOpenAIModelGateway(environment, {
      maxInputCharacters: 1_000,
      maxOutputTokens: 32,
      maxTools: 1,
      maxToolCalls: 1,
      maxToolOutputCharacters: 1_000,
      timeoutMs: 1,
      maxRetries: 0,
    })
    await expect(
      timeoutGateway.generateText({ input: "Reply with OK." })
    ).rejects.toMatchObject({ code: "timeout", retryable: true })

    const safeResult = {
      deploymentFingerprint: hashCanonical({
        deployment: environment.AZURE_OPENAI_DEPLOYMENT,
      }),
      model: ordinary.model,
      ordinary: true,
      structured: true,
      strictToolCall: true,
      twoStepToolLoop: true,
      streaming: true,
      usage: true,
      timeoutNormalization: true,
      store: false,
      maxOutputTokens,
    }
    console.info(`[azure-compatibility] ${JSON.stringify(safeResult)}`)
  }, 120_000)
})
