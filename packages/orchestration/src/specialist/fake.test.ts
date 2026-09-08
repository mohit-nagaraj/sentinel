import {
  discoveryMissionSchema,
  type DiscoveryMission,
  type MissionBudget,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  ScriptedSpecialistDecisionModel,
  ScriptedSpecialistTool,
  scriptedSpecialistDecision,
  scriptedSpecialistToolOutput,
} from "./fake.ts"
import { EMPTY_BUDGET_USAGE, createSpecialistInitialState } from "./state.ts"

const missionBudget = (
  overrides: Partial<MissionBudget> = {}
): MissionBudget => ({
  ...EMPTY_BUDGET_USAGE,
  toolCalls: 2,
  contentBytes: 2_000,
  sourceLines: 200,
  modelCalls: 4,
  modelInputTokens: 2_000,
  modelOutputTokens: 500,
  elapsedMs: 10_000,
  ...overrides,
})

function mission(): DiscoveryMission {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: `mission:v1:${"a".repeat(64)}`,
    runId: "run:00000000-0000-4000-8000-000000000014",
    applicationId: `application:v1:${"b".repeat(64)}`,
    agent: "code",
    mode: "implementation_trace",
    goal: "Exercise deterministic specialist fakes.",
    seedEvidenceIds: [],
    questions: ["Which symbol owns the behavior?"],
    scope: {
      repositoryPaths: ["packages"],
      sourceUris: [],
      allowedHosts: [],
      allowedTools: ["read_symbol"],
    },
    budget: missionBudget(),
    successCriteria: ["Return one compact observation."],
  })
}

function request(signal = new AbortController().signal) {
  const selectedMission = mission()
  return {
    mission: selectedMission,
    promptTemplateId: "code_specialist_prompt",
    stateFingerprint: `sha256:${"c".repeat(64)}`,
    observations: [],
    completedCallIds: [],
    executionKind: "provider" as const,
    humanResolution: null,
    remainingBudget: selectedMission.budget,
    signal,
  }
}

function state() {
  return createSpecialistInitialState(mission(), {
    graphName: "code_specialist",
    promptTemplateId: "code_specialist_prompt",
    configurationFingerprint: `sha256:${"d".repeat(64)}`,
    startedAtMs: 0,
  })
}

describe("scripted specialist fakes", () => {
  it("validates decisions and records deterministic model calls", async () => {
    const first = scriptedSpecialistDecision("decision_01", {
      kind: "continue",
    })
    const second = scriptedSpecialistDecision("decision_02", {
      kind: "finish",
      result: {
        status: "complete",
        claims: [],
        unresolved: [],
        exclusions: [],
        suggestedFollowups: [],
        stopReason: { code: "criteria_met", summary: "Done." },
      },
    })
    const model = new ScriptedSpecialistDecisionModel(
      [
        { kind: "decision", decision: first },
        { kind: "decision", decision: second },
      ],
      { estimate: { modelCalls: 1, modelInputTokens: 20 } }
    )

    expect(model.estimate(state())).toEqual({
      modelCalls: 1,
      modelInputTokens: 20,
    })
    await expect(model.decide(request())).resolves.toEqual(first)
    expect(() => model.assertComplete()).toThrow("1 unused step")
    await expect(model.decide(request())).resolves.toEqual(second)

    expect(model.callCount).toBe(2)
    expect(model.calls).toEqual([
      expect.objectContaining({
        sequence: 1,
        agent: "code",
        promptTemplateId: "code_specialist_prompt",
      }),
      expect.objectContaining({ sequence: 2, agent: "code" }),
    ])
    expect(Object.isFrozen(model.calls[0])).toBe(true)
    expect(() => model.assertComplete()).not.toThrow()
    await expect(model.decide(request())).rejects.toThrow("no remaining step")
  })

  it("supports explicit malformed, error, and aborting model steps", async () => {
    const failure = new Error("planned model failure")
    const model = new ScriptedSpecialistDecisionModel([
      { kind: "malformed", value: { decisionId: "invalid" } },
      { kind: "error", error: failure },
      { kind: "wait_for_abort" },
    ])

    await expect(model.decide(request())).resolves.toEqual({
      decisionId: "invalid",
    })
    await expect(model.decide(request())).rejects.toBe(failure)
    const controller = new AbortController()
    const pending = model.decide(request(controller.signal))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(model.callCount).toBe(3)
    model.assertComplete()

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    const neverReturned = new ScriptedSpecialistDecisionModel([
      {
        kind: "decision",
        decision: scriptedSpecialistDecision("decision_04", {
          kind: "continue",
        }),
      },
    ])
    await expect(
      neverReturned.decide(request(alreadyAborted.signal))
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("validates tool results and exposes compact ordered invocations", async () => {
    const result = scriptedSpecialistToolOutput({
      outcome: "succeeded",
      summary: "Located a symbol.",
      evidenceIds: [],
      references: [{ kind: "repository_path", id: "packages/example.ts" }],
      usage: { contentBytes: 40, sourceLines: 4 },
    })
    const tool = new ScriptedSpecialistTool({
      name: "read_symbol",
      description: "Read one bounded source symbol by repository path.",
      agents: ["code"],
      modes: ["implementation_trace"],
      argumentsSchema: z.strictObject({ path: z.string() }),
      validateScope: ({ path }) => path.startsWith("packages/"),
      estimate: () => ({ toolCalls: 1, contentBytes: 40, sourceLines: 4 }),
      steps: [{ kind: "result", result }],
    })
    const selectedState = state()
    const context = {
      state: selectedState,
      mission: selectedState.mission,
      callId: "call_01",
      decisionId: "decision_01",
      requestHash: `sha256:${"e".repeat(64)}`,
      signal: new AbortController().signal,
    }

    await expect(
      tool.definition.execute({ path: "packages/example.ts" }, context)
    ).resolves.toEqual(result)
    expect(tool.callCount).toBe(1)
    expect(tool.calls).toEqual([
      expect.objectContaining({
        sequence: 1,
        callId: "call_01",
        arguments: { path: "packages/example.ts" },
      }),
    ])
    expect(Object.isFrozen(tool.calls[0])).toBe(true)
    tool.assertComplete()
  })

  it("makes blocking tool scripts abort-aware", async () => {
    const tool = new ScriptedSpecialistTool({
      name: "read_symbol",
      description: "Read one bounded source symbol by repository path.",
      agents: ["code"],
      modes: ["implementation_trace"],
      argumentsSchema: z.strictObject({ path: z.string() }),
      validateScope: () => true,
      estimate: () => ({ toolCalls: 1 }),
      steps: [{ kind: "wait_for_abort" }],
    })
    const selectedState = state()
    const controller = new AbortController()
    const pending = tool.definition.execute(
      { path: "packages/example.ts" },
      {
        state: selectedState,
        mission: selectedState.mission,
        callId: "call_02",
        decisionId: "decision_02",
        requestHash: `sha256:${"f".repeat(64)}`,
        signal: controller.signal,
      }
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(tool.callCount).toBe(1)
    tool.assertComplete()
  })
})
