import {
  applicationIdSchema,
  discoveryMissionSchema,
  evidenceIdSchema,
  missionIdSchema,
  missionResultSchema,
  runIdSchema,
  type DiscoveryMission,
  type MissionBudget,
} from "@sentinel/contracts"
import { MemorySaver } from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { InMemoryResumeCoordinator } from "../resume-coordinator.ts"
import {
  LeaseOwnershipError,
  type OrchestrationEvent,
  type RuntimeDependencies,
} from "../runtime.ts"
import {
  SpecialistOrchestrationService,
  createSpecialistKernel,
  specialistModelDecisionSchema,
  type SpecialistDecisionModel,
  type SpecialistKernelConfig,
  type SpecialistModelDecision,
} from "./kernel.ts"
import { EMPTY_BUDGET_USAGE, createSpecialistInitialState } from "./state.ts"
import {
  SpecialistToolRegistry,
  defineSpecialistTool,
  specialistToolOutputSchema,
} from "./tools.ts"

const evidenceId = evidenceIdSchema.parse(`evidence:v1:${"d".repeat(64)}`)

const budget = (overrides: Partial<MissionBudget> = {}): MissionBudget => ({
  ...EMPTY_BUDGET_USAGE,
  toolCalls: 6,
  contentBytes: 20_000,
  sourceLines: 500,
  modelCalls: 8,
  modelInputTokens: 8_000,
  modelOutputTokens: 2_000,
  elapsedMs: 30_000,
  ...overrides,
})

function mission(overrides: Partial<DiscoveryMission> = {}): DiscoveryMission {
  return discoveryMissionSchema.parse({
    schemaVersion: 1,
    id: `mission:v1:${"a".repeat(64)}`,
    runId: "run:00000000-0000-4000-8000-000000000014",
    applicationId: `application:v1:${"b".repeat(64)}`,
    agent: "code",
    mode: "implementation_trace",
    goal: "Trace the implementation boundary.",
    seedEvidenceIds: [],
    questions: ["Which symbol implements the behavior?"],
    scope: {
      repositoryPaths: ["packages"],
      sourceUris: [],
      allowedHosts: [],
      allowedTools: ["read_symbol"],
    },
    budget: budget(),
    successCriteria: ["A cited implementation path is proposed."],
    ...overrides,
  })
}

const modelUsage = budget({
  toolCalls: 0,
  contentBytes: 0,
  sourceLines: 0,
  modelCalls: 1,
  modelInputTokens: 100,
  modelOutputTokens: 30,
  elapsedMs: 0,
})

const toolUsage = budget({
  toolCalls: 1,
  contentBytes: 120,
  sourceLines: 12,
  modelCalls: 0,
  modelInputTokens: 0,
  modelOutputTokens: 0,
  elapsedMs: 0,
})

const completeAction = {
  kind: "finish",
  result: {
    status: "complete",
    claims: [],
    unresolved: [],
    exclusions: [],
    suggestedFollowups: [],
    stopReason: {
      code: "criteria_met",
      summary: "The specialist established the requested boundary.",
    },
  },
} as const

class ScriptedModel implements SpecialistDecisionModel {
  private cursor = 0

  constructor(
    private readonly steps: readonly SpecialistModelDecision[],
    private readonly repeatLast = false
  ) {}

  estimate(): Partial<MissionBudget> {
    return modelUsage
  }

  async decide(): Promise<unknown> {
    const base =
      this.steps[this.cursor] ??
      (this.repeatLast ? this.steps.at(-1) : undefined)
    if (base === undefined) throw new Error("No scripted model step")
    const step =
      this.cursor < this.steps.length
        ? base
        : specialistModelDecisionSchema.parse({
            ...base,
            decisionId: `decision_${(this.cursor + 1)
              .toString()
              .padStart(2, "0")}`,
          })
    this.cursor += 1
    return step
  }

  calls(): number {
    return this.cursor
  }
}

function modelStep(sequence: number, action: unknown): SpecialistModelDecision {
  return specialistModelDecisionSchema.parse({
    decisionId: `decision_${sequence.toString().padStart(2, "0")}`,
    usage: modelUsage,
    action,
  })
}

function harness(
  options: {
    authorize?: boolean
    now?: () => Date
    resumeCoordinator?: RuntimeDependencies["resumeCoordinator"]
  } = {}
) {
  const events: OrchestrationEvent[] = []
  const dependencies: RuntimeDependencies = {
    owner: "worker-specialist",
    control: { assertActive: async () => undefined },
    events: { append: async (event) => void events.push(event) },
    effects: { execute: async () => undefined },
    resumeAuthorization: {
      authorize: async () => options.authorize ?? true,
    },
    resumeCoordinator:
      options.resumeCoordinator ?? new InMemoryResumeCoordinator(),
    now: options.now ?? (() => new Date("2026-09-08T00:00:00.000Z")),
  }
  return { dependencies, events }
}

function registry(
  execute: (signal: AbortSignal) => unknown | Promise<unknown> = vi.fn()
) {
  const tool = defineSpecialistTool({
    name: "read_symbol",
    agents: ["code"],
    modes: ["implementation_trace"],
    argumentsSchema: z.strictObject({
      path: z.string().min(1).max(200),
    }),
    outputSchema: specialistToolOutputSchema,
    validateScope(arguments_, context) {
      return context.mission.scope.repositoryPaths.some(
        (root) =>
          arguments_.path === root || arguments_.path.startsWith(`${root}/`)
      )
    },
    estimate: () => toolUsage,
    execute: async (_arguments, context) => {
      await execute(context.signal)
      return specialistToolOutputSchema.parse({
        outcome: "succeeded",
        summary: "Located the requested symbol.",
        evidenceIds: [evidenceId],
        references: [{ kind: "repository_path", id: "packages/example.ts" }],
        usage: toolUsage,
      })
    },
  })
  return new SpecialistToolRegistry([tool])
}

function kernelConfig(
  model: SpecialistDecisionModel,
  tools = registry(),
  overrides: Partial<SpecialistKernelConfig> = {}
): SpecialistKernelConfig {
  return {
    agent: "code",
    modes: ["implementation_trace"],
    promptTemplateId: "code_specialist_prompt",
    modelId: "scripted_model_v1",
    toolsetId: "code_tools_v1",
    completionValidatorId: "mission_result_validator_v1",
    tools,
    model,
    validateCompletion: ({ proposed }) => missionResultSchema.parse(proposed),
    ...overrides,
  }
}

describe("shared specialist kernel", () => {
  it("completes directly with typed usage and lifecycle events", async () => {
    const test = harness()
    const model = new ScriptedModel([modelStep(1, completeAction)])
    const kernel = createSpecialistKernel(
      kernelConfig(model),
      test.dependencies,
      new MemorySaver()
    )
    const service = new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    )
    const result = await service.start(mission())

    expect(result.status).toBe("complete")
    expect(result.mission.budgetUsed).toMatchObject({ modelCalls: 1 })
    expect(result.mission.claims).toEqual([])
    expect(result.mission.unresolved).toEqual([])
    expect(test.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "mission_started", agent: "code" }),
        expect.objectContaining({ kind: "budget_updated" }),
        expect.objectContaining({ kind: "mission_completed" }),
      ])
    )
    expect(JSON.stringify(test.events)).not.toMatch(
      /prompt|reasoning|arguments/
    )
    const duplicate = await service.start(mission())
    expect(duplicate.idempotent).toBe(true)
    expect(model.calls()).toBe(1)
    const conflictingMission = discoveryMissionSchema.parse({
      ...mission(),
      runId: runIdSchema.parse("run:99999999-9999-4999-8999-999999999999"),
      applicationId: applicationIdSchema.parse(
        `application:v1:${"9".repeat(64)}`
      ),
    })
    await expect(service.start(conflictingMission)).rejects.toThrow()
  })

  it("serializes mission starts and rejects conflicting persisted configuration", async () => {
    const coordinator = new InMemoryResumeCoordinator()
    let exclusiveDepth = 0
    const test = harness({
      resumeCoordinator: {
        runExclusive: (input, work) =>
          coordinator.runExclusive(input, async () => {
            exclusiveDepth += 1
            try {
              return await work()
            } finally {
              exclusiveDepth -= 1
            }
          }),
      },
    })
    let enterModel!: () => void
    let releaseModel!: () => void
    const modelEntered = new Promise<void>((resolve) => {
      enterModel = resolve
    })
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve
    })
    const decide = vi.fn(async () => {
      enterModel()
      await modelGate
      return modelStep(1, completeAction)
    })
    const model: SpecialistDecisionModel = {
      estimate: () => modelUsage,
      decide,
    }
    const memory = new MemorySaver()
    const kernel = createSpecialistKernel(
      kernelConfig(model),
      test.dependencies,
      memory
    )
    const service = new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    )
    const selectedMission = mission()
    const firstStart = service.start(selectedMission)
    await modelEntered
    expect(exclusiveDepth).toBe(0)
    const duplicateStart = new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    ).start(selectedMission)
    const conflictingStart = service.start(
      mission({
        runId: runIdSchema.parse("run:99999999-9999-4999-8999-999999999999"),
        applicationId: applicationIdSchema.parse(
          `application:v1:${"9".repeat(64)}`
        ),
      })
    )
    releaseModel()

    const [first, duplicate] = await Promise.all([firstStart, duplicateStart])
    expect(first.idempotent).toBe(false)
    expect(duplicate.idempotent).toBe(true)
    expect(decide).toHaveBeenCalledOnce()
    await expect(conflictingStart).rejects.toThrow()

    const changedKernel = createSpecialistKernel(
      kernelConfig(
        new ScriptedModel([modelStep(1, completeAction)]),
        registry(),
        {
          toolsetId: "code_tools_v2",
        }
      ),
      test.dependencies,
      memory
    )
    await expect(
      new SpecialistOrchestrationService(
        changedKernel,
        test.dependencies
      ).start(selectedMission)
    ).rejects.toThrow()
  })

  it("recovers an abandoned start checkpoint under the current run lease", async () => {
    const test = harness()
    const model = new ScriptedModel([modelStep(1, completeAction)])
    const memory = new MemorySaver()
    const kernel = createSpecialistKernel(
      kernelConfig(model),
      test.dependencies,
      memory
    )
    const selectedMission = mission({
      id: missionIdSchema.parse(`mission:v1:${"c".repeat(64)}`),
    })
    const initial = createSpecialistInitialState(selectedMission, {
      graphName: kernel.config.graphName,
      promptTemplateId: kernel.config.promptTemplateId,
      configurationFingerprint: kernel.config.configurationFingerprint,
      startedAtMs: Date.parse("2026-09-08T00:00:00.000Z"),
    })
    await kernel.graph.invoke(initial, {
      configurable: { thread_id: selectedMission.id },
      interruptBefore: ["specialist_prepare"],
      recursionLimit: kernel.config.recursionLimit,
    })

    const recovered = await new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    ).start(selectedMission)
    expect(recovered.status).toBe("complete")
    expect(model.calls()).toBe(1)
  })

  it("does not persist a fresh claim without the run lease", async () => {
    const test = harness()
    const dependencies: RuntimeDependencies = {
      ...test.dependencies,
      control: {
        assertActive: async () => {
          throw new LeaseOwnershipError()
        },
      },
    }
    const model = new ScriptedModel([modelStep(1, completeAction)])
    const memory = new MemorySaver()
    const kernel = createSpecialistKernel(
      kernelConfig(model),
      dependencies,
      memory
    )
    const selectedMission = mission({
      id: missionIdSchema.parse(`mission:v1:${"4".repeat(64)}`),
    })

    await expect(
      new SpecialistOrchestrationService(kernel, dependencies).start(
        selectedMission
      )
    ).rejects.toBeInstanceOf(LeaseOwnershipError)
    const snapshot = await kernel.graph.getState({
      configurable: { thread_id: selectedMission.id },
    })
    expect(Object.keys(snapshot.values)).toEqual([])
    expect(model.calls()).toBe(0)
  })

  it("charges policy-invalid tool and completion decisions", async () => {
    const toolTest = harness()
    const toolModel = new ScriptedModel([
      modelStep(1, {
        kind: "tool_calls",
        calls: [
          {
            callId: "call_01",
            toolName: "unknown_tool",
            arguments: {},
          },
        ],
      }),
    ])
    const toolKernel = createSpecialistKernel(
      kernelConfig(toolModel),
      toolTest.dependencies,
      new MemorySaver()
    )
    const denied = await new SpecialistOrchestrationService(
      toolKernel,
      toolTest.dependencies
    ).start(mission())
    expect(denied.status).toBe("failed")
    expect(denied.mission.stopReason.code).toBe("tool_request_denied")
    expect(denied.mission.budgetUsed.modelCalls).toBe(1)
    expect(denied.state.completedCalls).toEqual([])

    const completionTest = harness()
    const completionModel = new ScriptedModel([
      modelStep(1, {
        kind: "finish",
        result: {
          ...completeAction.result,
          claims: [
            {
              id: `claim:v1:${"8".repeat(64)}`,
              status: "proposed",
              subjectId: `code-symbol:v1:${"7".repeat(64)}`,
              predicate: "implemented_by",
              objectId: `code-symbol:v1:${"6".repeat(64)}`,
              evidenceIds: [evidenceId],
              explanation: "This proposal cites evidence absent from state.",
            },
          ],
        },
      }),
    ])
    const completionKernel = createSpecialistKernel(
      kernelConfig(completionModel),
      completionTest.dependencies,
      new MemorySaver()
    )
    const invalid = await new SpecialistOrchestrationService(
      completionKernel,
      completionTest.dependencies
    ).start(mission())
    expect(invalid.status).toBe("failed")
    expect(invalid.mission.stopReason.code).toBe("completion_validation_failed")
    expect(invalid.mission.budgetUsed.modelCalls).toBe(1)
  })

  it("charges a model call that reuses an existing decision ID", async () => {
    const test = harness()
    const model = new ScriptedModel([
      modelStep(1, { kind: "continue" }),
      modelStep(1, completeAction),
    ])
    const kernel = createSpecialistKernel(
      kernelConfig(model),
      test.dependencies,
      new MemorySaver()
    )
    const result = await new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    ).start(mission())

    expect(result.status).toBe("failed")
    expect(result.mission.stopReason.code).toBe("model_decision_duplicate")
    expect(result.mission.budgetUsed.modelCalls).toBe(2)
    expect(
      result.state.decisions.map((decision) => decision.decisionId)
    ).toEqual(["decision_01", "model_failure_1"])
  })

  it("continues from a tool checkpoint without repeating execution", async () => {
    const test = harness()
    const execute = vi.fn()
    const model = new ScriptedModel([
      modelStep(1, {
        kind: "tool_calls",
        calls: [
          {
            callId: "call_01",
            toolName: "read_symbol",
            arguments: { path: "packages/example.ts" },
          },
        ],
      }),
      modelStep(2, {
        kind: "finish",
        result: {
          ...completeAction.result,
          claims: [
            {
              id: `claim:v1:${"e".repeat(64)}`,
              status: "proposed",
              subjectId: `code-symbol:v1:${"f".repeat(64)}`,
              predicate: "implemented_by",
              objectId: `code-symbol:v1:${"1".repeat(64)}`,
              evidenceIds: [evidenceId],
              explanation: "The inspected symbol supports the proposal.",
            },
          ],
        },
      }),
    ])
    const memory = new MemorySaver()
    const kernel = createSpecialistKernel(
      kernelConfig(model, registry(execute)),
      test.dependencies,
      memory
    )
    const service = new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    )
    const selectedMission = mission()
    const initial = createSpecialistInitialState(selectedMission, {
      graphName: kernel.config.graphName,
      promptTemplateId: kernel.config.promptTemplateId,
      configurationFingerprint: kernel.config.configurationFingerprint,
      startedAtMs: Date.parse("2026-09-08T00:00:00.000Z"),
    })
    await kernel.graph.invoke(initial, {
      configurable: { thread_id: selectedMission.id },
      interruptAfter: ["specialist_tool_execution"],
      recursionLimit: kernel.config.recursionLimit,
    })

    const result = await service.continue(selectedMission.id)
    expect(result.status).toBe("complete")
    expect(result.state.completedCalls).toHaveLength(1)
    expect(result.state.observations[0]?.evidenceIds).toEqual([evidenceId])
    expect(execute).toHaveBeenCalledOnce()
    expect(model.calls()).toBe(2)
  })

  it("settles an in-flight tool reservation when elapsed time expires", async () => {
    const test = harness({ now: () => new Date() })
    const execute = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve()
            return
          }
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
    )
    const model = new ScriptedModel([
      modelStep(1, {
        kind: "tool_calls",
        calls: [
          {
            callId: "call_01",
            toolName: "read_symbol",
            arguments: { path: "packages/example.ts" },
          },
        ],
      }),
    ])
    const kernel = createSpecialistKernel(
      kernelConfig(model, registry(execute)),
      test.dependencies,
      new MemorySaver()
    )
    const result = await new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    ).start(mission({ budget: budget({ elapsedMs: 500 }) }))

    expect(result.status).toBe("budget_exhausted")
    expect(result.mission.stopReason.code).toBe("elapsed_budget_exhausted")
    expect(result.mission.budgetUsed).toMatchObject({
      modelCalls: 1,
      toolCalls: 1,
    })
    expect(result.state.pendingToolCalls).toEqual([])
    expect(result.state.completedCalls).toEqual([
      expect.objectContaining({
        callId: "call_01",
        outcome: "failed",
        usage: toolUsage,
      }),
    ])
    expect(execute).toHaveBeenCalledOnce()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(test.events.some((event) => event.kind === "tool_completed")).toBe(
      false
    )
    expect(test.events.some((event) => event.kind === "evidence_gained")).toBe(
      false
    )
    expect(
      test.events.some((event) => event.reasonCode === "tool_budget_updated")
    ).toBe(false)
  })

  it("terminates repeated no-progress and unavailable model budgets", async () => {
    const noProgressTest = harness()
    const noProgressModel = new ScriptedModel([
      modelStep(1, { kind: "continue" }),
      modelStep(2, { kind: "continue" }),
    ])
    const noProgressKernel = createSpecialistKernel(
      kernelConfig(noProgressModel, registry(), { maxNoProgress: 2 }),
      noProgressTest.dependencies,
      new MemorySaver()
    )
    const noProgress = await new SpecialistOrchestrationService(
      noProgressKernel,
      noProgressTest.dependencies
    ).start(mission())
    expect(noProgress.status).toBe("partial")
    expect(noProgress.mission.stopReason.code).toBe("no_progress")
    expect(noProgress.mission.unresolved).toHaveLength(1)

    const budgetTest = harness()
    const budgetModel = new ScriptedModel([modelStep(1, completeAction)])
    const budgetKernel = createSpecialistKernel(
      kernelConfig(budgetModel),
      budgetTest.dependencies,
      new MemorySaver()
    )
    const exhausted = await new SpecialistOrchestrationService(
      budgetKernel,
      budgetTest.dependencies
    ).start(mission({ budget: budget({ modelCalls: 0 }) }))
    expect(exhausted.status).toBe("budget_exhausted")
    expect(budgetModel.calls()).toBe(0)
  })

  it("interrupts and resumes only with authorized matching input", async () => {
    const test = harness()
    const model = new ScriptedModel([
      modelStep(1, {
        kind: "needs_human",
        reasonCode: "scope_confirmation_required",
        question: "Approve the bounded scope change?",
      }),
      modelStep(2, completeAction),
    ])
    const kernel = createSpecialistKernel(
      kernelConfig(model),
      test.dependencies,
      new MemorySaver()
    )
    const service = new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    )
    const started = await service.start(mission())
    expect(started.status).toBe("interrupted")
    expect(started.mission.status).toBe("needs_human")
    expect(started.interrupts[0]).toMatchObject({
      decisionId: "decision_01",
    })

    const resumed = await service.resume({
      missionId: started.state.mission.id,
      decisionId: "decision_01",
      actorId: "reviewer:one",
      approved: true,
    })
    expect(resumed.status).toBe("complete")
    expect(resumed.state.humanInterrupt).toMatchObject({ status: "resolved" })

    const deniedTest = harness({ authorize: false })
    const deniedKernel = createSpecialistKernel(
      kernelConfig(
        new ScriptedModel([
          modelStep(1, {
            kind: "needs_human",
            reasonCode: "scope_confirmation_required",
            question: "Approve the bounded scope change?",
          }),
        ])
      ),
      deniedTest.dependencies,
      new MemorySaver()
    )
    const deniedService = new SpecialistOrchestrationService(
      deniedKernel,
      deniedTest.dependencies
    )
    const pending = await deniedService.start(mission())
    await expect(
      deniedService.resume({
        missionId: pending.state.mission.id,
        decisionId: "decision_01",
        actorId: "untrusted",
        approved: true,
      })
    ).rejects.toThrow("Resume authorization failed")
  })

  it("normalizes recursion and rejects cross-agent missions", async () => {
    const test = harness()
    const repeating = new ScriptedModel(
      [modelStep(1, { kind: "continue" })],
      true
    )
    const kernel = createSpecialistKernel(
      kernelConfig(repeating, registry(), {
        maxNoProgress: 32,
        recursionLimit: 4,
      }),
      test.dependencies,
      new MemorySaver()
    )
    const recursive = await new SpecialistOrchestrationService(
      kernel,
      test.dependencies
    ).start(mission())
    expect(recursive.status).toBe("budget_exhausted")
    expect(recursive.mission.stopReason.code).toBe("recursion_limit")

    await expect(
      new SpecialistOrchestrationService(kernel, test.dependencies).start(
        mission({
          agent: "application",
          mode: "workflow_discovery",
          scope: {
            repositoryPaths: [],
            sourceUris: [],
            allowedHosts: ["example.test"],
            allowedTools: ["read_symbol"],
          },
        })
      )
    ).rejects.toThrow()
  })
})
