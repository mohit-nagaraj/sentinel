import {
  applicationIdSchema,
  claimIdSchema,
  discoveryMissionSchema,
  evidenceIdSchema,
  missionIdSchema,
  missionResultSchema,
  runIdSchema,
  stableEntityIdSchema,
  type DiscoveryMission,
  type MissionBudget,
} from "@sentinel/contracts"
import {
  EMPTY_BUDGET_USAGE,
  InMemoryResumeCoordinator,
  ScriptedSpecialistDecisionModel,
  ScriptedSpecialistTool,
  SpecialistOrchestrationService,
  SpecialistToolRegistry,
  createInMemorySpecialistCheckpointer,
  createSpecialistKernel,
  scriptedSpecialistDecision,
  scriptedSpecialistToolOutput,
  type OrchestrationEvent,
  type RuntimeDependencies,
  type SpecialistAgent,
} from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const identity = {
  documentation: { mode: "baseline_discovery" },
  code: { mode: "implementation_trace" },
  application: { mode: "workflow_discovery" },
} as const

const fullBudget = (overrides: Partial<MissionBudget> = {}): MissionBudget => ({
  ...EMPTY_BUDGET_USAGE,
  toolCalls: 4,
  contentBytes: 10_000,
  sourceLines: 500,
  browserActions: 20,
  modelCalls: 6,
  modelInputTokens: 6_000,
  modelOutputTokens: 1_500,
  elapsedMs: 30_000,
  ...overrides,
})

function hexId(index: number): string {
  return index.toString(16).padStart(64, "0")
}

function mission(
  agent: SpecialistAgent,
  index: number,
  options: {
    readonly allowedTools?: readonly string[]
    readonly budget?: MissionBudget
  } = {}
): DiscoveryMission {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: missionIdSchema.parse(`mission:v1:${hexId(index)}`),
    runId: runIdSchema.parse(
      `run:00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
    ),
    applicationId: applicationIdSchema.parse(
      `application:v1:${hexId(index + 100)}`
    ),
    agent,
    mode: identity[agent].mode,
    goal: `Exercise the ${agent} specialist trajectory.`,
    seedEvidenceIds: [],
    questions: ["What bounded evidence resolves this mission?"],
    scope: {
      repositoryPaths: agent === "code" ? ["packages"] : [],
      sourceUris: [],
      allowedHosts: agent === "application" ? ["app.example.test"] : [],
      allowedTools: options.allowedTools ?? ["inspect_evidence"],
    },
    budget: options.budget ?? fullBudget(),
    successCriteria: ["Return a schema-valid bounded result."],
  })
}

function harness() {
  const events: OrchestrationEvent[] = []
  const dependencies: RuntimeDependencies = {
    owner: "agent-test-worker",
    control: { assertActive: async () => undefined },
    events: { append: async (event) => void events.push(event) },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  }
  return { dependencies, events }
}

function scriptedTool(
  selectedMission: DiscoveryMission,
  name = "inspect_evidence",
  steps: ConstructorParameters<typeof ScriptedSpecialistTool>[0]["steps"] = []
) {
  return new ScriptedSpecialistTool({
    name,
    agents: [selectedMission.agent],
    modes: [selectedMission.mode],
    argumentsSchema: z.strictObject({ resource: z.string().min(1).max(200) }),
    validateScope: () => true,
    estimate: () => ({ toolCalls: 1, contentBytes: 100 }),
    steps,
  })
}

function kernel(
  selectedMission: DiscoveryMission,
  model: ScriptedSpecialistDecisionModel,
  dependencies: RuntimeDependencies,
  tools = new SpecialistToolRegistry([
    scriptedTool(selectedMission).definition,
  ]),
  memory = createInMemorySpecialistCheckpointer()
) {
  return createSpecialistKernel(
    {
      agent: selectedMission.agent,
      modes: [selectedMission.mode],
      promptTemplateId: `${selectedMission.agent}_prompt_v1`,
      modelId: "scripted_agent_model_v1",
      toolsetId: `${selectedMission.agent}_tools_v1`,
      completionValidatorId: "agent_result_validator_v1",
      tools,
      model,
      validateCompletion: ({ proposed }) => missionResultSchema.parse(proposed),
    },
    dependencies,
    memory
  )
}

function finish(status: "complete" | "partial" | "blocked" | "failed") {
  return {
    kind: "finish" as const,
    result: {
      status,
      claims: [],
      unresolved:
        status === "complete"
          ? []
          : [
              {
                question: "What evidence remains unavailable?",
                reasonCode: `${status}_boundary`,
                evidenceIds: [],
              },
            ],
      exclusions: [],
      suggestedFollowups: [],
      stopReason: {
        code: `${status}_scripted`,
        summary: `The scripted specialist returned ${status}.`,
      },
    },
  }
}

const terminalCases = [
  { agent: "documentation", status: "complete", index: 1 },
  { agent: "code", status: "partial", index: 2 },
  { agent: "application", status: "blocked", index: 3 },
  { agent: "documentation", status: "failed", index: 4 },
  { agent: "code", status: "budget_exhausted", index: 5 },
  { agent: "application", status: "needs_human", index: 6 },
] as const

describe("specialist kernel scripted trajectories", () => {
  it.each(terminalCases)(
    "$agent produces a complete $status terminal contract",
    async ({ agent, status, index }) => {
      const test = harness()
      const selectedMission = mission(
        agent,
        index,
        status === "budget_exhausted"
          ? { budget: fullBudget({ modelCalls: 0 }) }
          : {}
      )
      const action =
        status === "needs_human"
          ? {
              kind: "needs_human" as const,
              reasonCode: "review_required",
              question: "Approve the bounded evidence scope?",
            }
          : status === "budget_exhausted"
            ? finish("complete")
            : finish(status)
      const model = new ScriptedSpecialistDecisionModel([
        {
          kind: "decision",
          decision: scriptedSpecialistDecision("decision_01", action),
        },
      ])
      const specialist = kernel(selectedMission, model, test.dependencies)
      const result = await new SpecialistOrchestrationService(
        specialist,
        test.dependencies
      ).start(selectedMission)

      expect(result.mission.status).toBe(status)
      expect(result.status).toBe(
        status === "needs_human" ? "interrupted" : status
      )
      expect(result.mission).toEqual(missionResultSchema.parse(result.mission))
      expect(result.mission).toEqual(
        expect.objectContaining({
          claims: expect.any(Array),
          unresolved: expect.any(Array),
          exclusions: expect.any(Array),
          suggestedFollowups: expect.any(Array),
          stopReason: expect.objectContaining({
            code: expect.any(String),
            summary: expect.any(String),
          }),
        })
      )
      expect(model.callCount).toBe(status === "budget_exhausted" ? 0 : 1)
      expect(JSON.stringify(test.events)).not.toMatch(
        /authorization|bearer|password|prompt|reasoning|arguments/i
      )
    }
  )

  it("resumes an authorized human trajectory on the same thread", async () => {
    const test = harness()
    const selectedMission = mission("application", 7)
    const model = new ScriptedSpecialistDecisionModel([
      {
        kind: "decision",
        decision: scriptedSpecialistDecision("decision_01", {
          kind: "needs_human",
          reasonCode: "review_required",
          question: "Approve the bounded observation?",
        }),
      },
      {
        kind: "decision",
        decision: scriptedSpecialistDecision("decision_02", finish("complete")),
      },
    ])
    const specialist = kernel(selectedMission, model, test.dependencies)
    const service = new SpecialistOrchestrationService(
      specialist,
      test.dependencies
    )
    const interrupted = await service.start(selectedMission)
    const resumed = await service.resume({
      missionId: selectedMission.id,
      decisionId: interrupted.interrupts[0]?.decisionId ?? "missing",
      actorId: "reviewer:agent_test",
      approved: true,
    })

    expect(interrupted.status).toBe("interrupted")
    expect(resumed.status).toBe("complete")
    expect(resumed.state.humanInterrupt?.status).toBe("resolved")
    expect(model.callCount).toBe(2)
    model.assertComplete()
  })

  it("denies cross-agent tools before execution", async () => {
    const test = harness()
    const selectedMission = mission("application", 8, {
      allowedTools: ["read_symbol"],
    })
    const codeMission = mission("code", 80, { allowedTools: ["read_symbol"] })
    const codeTool = scriptedTool(codeMission, "read_symbol", [
      {
        kind: "result",
        result: scriptedSpecialistToolOutput({
          outcome: "succeeded",
          summary: "This result must remain unreachable.",
          evidenceIds: [],
          references: [],
        }),
      },
    ])
    const model = new ScriptedSpecialistDecisionModel([
      {
        kind: "decision",
        decision: scriptedSpecialistDecision("decision_01", {
          kind: "tool_calls",
          calls: [
            {
              callId: "call_01",
              toolName: "read_symbol",
              arguments: { resource: "packages/example.ts" },
            },
          ],
        }),
      },
    ])
    const specialist = kernel(
      selectedMission,
      model,
      test.dependencies,
      new SpecialistToolRegistry([codeTool.definition])
    )
    const result = await new SpecialistOrchestrationService(
      specialist,
      test.dependencies
    ).start(selectedMission)

    expect(result.status).toBe("failed")
    expect(result.mission.stopReason.code).toBe("tool_request_denied")
    expect(result.mission.budgetUsed.modelCalls).toBe(1)
    expect(codeTool.callCount).toBe(0)
  })

  it("charges malformed duplicate calls and denies an over-budget batch atomically", async () => {
    const malformedTest = harness()
    const malformedMission = mission("code", 9)
    const malformedModel = new ScriptedSpecialistDecisionModel([
      {
        kind: "malformed",
        value: {
          decisionId: "decision_01",
          usage: { ...EMPTY_BUDGET_USAGE, modelCalls: 1 },
          action: {
            kind: "tool_calls",
            calls: [
              {
                callId: "call_01",
                toolName: "inspect_evidence",
                arguments: { resource: "packages/a.ts" },
              },
              {
                callId: "call_01",
                toolName: "inspect_evidence",
                arguments: { resource: "packages/b.ts" },
              },
            ],
          },
        },
      },
    ])
    const malformedResult = await new SpecialistOrchestrationService(
      kernel(malformedMission, malformedModel, malformedTest.dependencies),
      malformedTest.dependencies
    ).start(malformedMission)
    expect(malformedResult.status).toBe("failed")
    expect(malformedResult.mission.stopReason.code).toBe(
      "model_decision_invalid"
    )
    expect(malformedResult.mission.budgetUsed.modelCalls).toBe(1)

    const budgetTest = harness()
    const budgetMission = mission("code", 10, {
      budget: fullBudget({ toolCalls: 1 }),
    })
    const budgetTool = scriptedTool(budgetMission, "inspect_evidence", [])
    const budgetModel = new ScriptedSpecialistDecisionModel([
      {
        kind: "decision",
        decision: scriptedSpecialistDecision("decision_01", {
          kind: "tool_calls",
          calls: [
            {
              callId: "call_01",
              toolName: "inspect_evidence",
              arguments: { resource: "packages/a.ts" },
            },
            {
              callId: "call_02",
              toolName: "inspect_evidence",
              arguments: { resource: "packages/b.ts" },
            },
          ],
        }),
      },
    ])
    const budgetResult = await new SpecialistOrchestrationService(
      kernel(
        budgetMission,
        budgetModel,
        budgetTest.dependencies,
        new SpecialistToolRegistry([budgetTool.definition])
      ),
      budgetTest.dependencies
    ).start(budgetMission)
    expect(budgetResult.status).toBe("budget_exhausted")
    expect(budgetResult.mission.stopReason.code).toBe("tool_budget_exhausted")
    expect(budgetResult.state.pendingToolCalls).toEqual([])
    expect(budgetResult.mission.budgetUsed).toMatchObject({
      modelCalls: 1,
      toolCalls: 0,
    })
    expect(budgetTool.callCount).toBe(0)
  })

  it("replays a completed fake tool trajectory without repeating effects", async () => {
    const test = harness()
    const selectedMission = mission("code", 11)
    const evidenceId = evidenceIdSchema.parse(`evidence:v1:${hexId(11)}`)
    const tool = scriptedTool(selectedMission, "inspect_evidence", [
      {
        kind: "result",
        result: scriptedSpecialistToolOutput({
          outcome: "succeeded",
          summary: "Located the bounded implementation evidence.",
          evidenceIds: [evidenceId],
          references: [{ kind: "repository_path", id: "packages/example.ts" }],
          usage: { contentBytes: 100 },
        }),
      },
    ])
    const claim = {
      id: claimIdSchema.parse(`claim:v1:${hexId(11)}`),
      status: "proposed" as const,
      subjectId: stableEntityIdSchema.parse(`code-symbol:v1:${hexId(12)}`),
      predicate: "implemented_by",
      objectId: stableEntityIdSchema.parse(`code-symbol:v1:${hexId(13)}`),
      evidenceIds: [evidenceId],
      explanation: "The scripted symbol observation supports the proposal.",
    }
    const model = new ScriptedSpecialistDecisionModel([
      {
        kind: "decision",
        decision: scriptedSpecialistDecision("decision_01", {
          kind: "tool_calls",
          calls: [
            {
              callId: "call_01",
              toolName: "inspect_evidence",
              arguments: { resource: "packages/example.ts" },
            },
          ],
        }),
      },
      {
        kind: "decision",
        decision: scriptedSpecialistDecision("decision_02", {
          ...finish("complete"),
          result: { ...finish("complete").result, claims: [claim] },
        }),
      },
    ])
    const memory = createInMemorySpecialistCheckpointer()
    const specialist = kernel(
      selectedMission,
      model,
      test.dependencies,
      new SpecialistToolRegistry([tool.definition]),
      memory
    )
    const service = new SpecialistOrchestrationService(
      specialist,
      test.dependencies
    )
    const first = await service.start(selectedMission)
    const replay = await service.start(selectedMission)

    expect(first.status).toBe("complete")
    expect(replay.status).toBe("complete")
    expect(replay.idempotent).toBe(true)
    expect(tool.callCount).toBe(1)
    expect(model.callCount).toBe(2)
    expect(first.state.completedCalls).toHaveLength(1)
    expect(first.mission.claims).toEqual([claim])
    model.assertComplete()
    tool.assertComplete()
  })
})
