import {
  codeExplorerMissionSchema,
  createClaimId,
  finishCodeMissionInputSchema,
  submitCodeClaimInputSchema,
  type CodeExplorerMission,
  type CodeSourceEvidence,
} from "@sentinel/contracts"
import {
  InMemoryResumeCoordinator,
  InMemorySpecialistToolExecutionCoordinator,
  createInMemorySpecialistCheckpointer,
  type OrchestrationEvent,
  type RuntimeDependencies,
} from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"

import {
  InMemoryCodeExplorerSpecialistStoreForTesting,
  createCodeExplorerSpecialist,
} from "../../packages/orchestration/src/code-explorer-specialist.ts"
import type {
  CodeExplorerModelDecision,
  CodeExplorerModelGateway,
} from "../../packages/orchestration/src/code-explorer.ts"
import { createCodeExplorerGoldenFixture } from "../fixtures/code-explorer.ts"

class AdaptiveCodeSpecialistModel implements CodeExplorerModelGateway {
  readonly requests: Parameters<CodeExplorerModelGateway["decideTools"]>[0][] =
    []

  constructor(private readonly mission: CodeExplorerMission) {}

  async decideTools(
    request: Parameters<CodeExplorerModelGateway["decideTools"]>[0]
  ): Promise<CodeExplorerModelDecision> {
    this.requests.push(request)
    const context = JSON.parse(request.input) as {
      latestObservation?: {
        evidence?: CodeSourceEvidence[]
      } | null
      submittedClaims?: {
        id: string
        subjectId: string
        predicate: string
        objectId: string
        evidenceIds: string[]
      }[]
    }
    const usage = { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
    if (this.requests.length === 1) {
      return {
        kind: "tool_calls",
        output: [
          {
            callId: "provider_endpoint",
            name: "find_endpoint_handler",
            arguments: {
              method: "POST",
              normalizedPath: "/events/{event}/orders",
            },
          },
        ],
        model: "scripted-agent-code-v1",
        usage,
      }
    }
    if (this.requests.length === 2) {
      const evidence = context.latestObservation?.evidence?.find(
        ({ kind, strength, targetEntityId }) =>
          kind === "route_handler" &&
          strength === "structural" &&
          targetEntityId !== undefined
      )
      if (
        evidence?.sourceEntityId === undefined ||
        evidence.targetEntityId === undefined
      ) {
        throw new Error("Expected structural endpoint-handler evidence")
      }
      return {
        kind: "tool_calls",
        output: [
          {
            callId: "provider_claim",
            name: "submit_code_claim",
            arguments: submitCodeClaimInputSchema.parse({
              subjectId: evidence.sourceEntityId,
              predicate: "handled_by",
              objectId: evidence.targetEntityId,
              evidenceIds: [evidence.evidenceId],
              explanation:
                "The normalized Laravel route structurally names this action.",
            }),
          },
        ],
        model: "scripted-agent-code-v1",
        usage,
      }
    }
    const claim = context.submittedClaims?.[0]
    if (claim === undefined) throw new Error("Expected a submitted code claim")
    const claimId = createClaimId({
      applicationId: this.mission.applicationId,
      missionId: this.mission.id,
      subjectId: claim.subjectId,
      predicate: claim.predicate,
      objectId: claim.objectId,
      ordinal: 0,
    })
    return {
      kind: "tool_calls",
      output: [
        {
          callId: "provider_finish",
          name: "finish_code_mission",
          arguments: finishCodeMissionInputSchema.parse({
            status: "complete",
            claimIds: [claimId],
            paths: [
              {
                nodes: [claim.subjectId, claim.objectId],
                edges: [
                  {
                    subjectId: claim.subjectId,
                    predicate: claim.predicate,
                    objectId: claim.objectId,
                    evidenceIds: claim.evidenceIds,
                  },
                ],
              },
            ],
            unresolved: [],
            exclusions: ["Runtime behavior remains outside this code mission."],
            suggestedFollowups: [],
            stopReason: {
              code: "endpoint_handler_established",
              summary: "The endpoint-handler relationship has source evidence.",
            },
          }),
        },
      ],
      model: "scripted-agent-code-v1",
      usage,
    }
  }
}

function runtime() {
  const events: OrchestrationEvent[] = []
  const dependencies: RuntimeDependencies = {
    owner: "code-specialist-agent-test",
    control: { assertActive: async () => undefined },
    events: { append: async (event) => void events.push(event) },
    effects: { execute: async () => undefined },
    resumeAuthorization: { authorize: async () => true },
    resumeCoordinator: new InMemoryResumeCoordinator(),
    now: () => new Date("2026-09-08T00:00:00.000Z"),
  }
  return { dependencies, events }
}

describe("Code Explorer shared-kernel agent trajectory", () => {
  it("coordinates endpoint evidence, claim, finish, and restart replay", async () => {
    const fixture = await createCodeExplorerGoldenFixture()
    const test = runtime()
    const model = new AdaptiveCodeSpecialistModel(fixture.mission)
    const store = new InMemoryCodeExplorerSpecialistStoreForTesting()
    const coordinator = new InMemorySpecialistToolExecutionCoordinator()
    const checkpointer = createInMemorySpecialistCheckpointer()
    const composition = createCodeExplorerSpecialist({
      mission: fixture.mission,
      model,
      tools: fixture.tools,
      store,
      executionCoordinator: coordinator,
      runtime: test.dependencies,
      checkpointer,
    })

    const result = await composition.service.start()
    expect(result.status).toBe("complete")
    expect(result.codeMission?.claims).toHaveLength(1)
    expect(result.codeMission?.paths).toHaveLength(1)
    expect(result.mission.budgetUsed.toolCalls).toBe(3)
    expect(model.requests).toHaveLength(3)
    expect(
      test.events.filter(({ kind }) => kind === "tool_completed")
    ).toHaveLength(3)

    const replayModel = new AdaptiveCodeSpecialistModel(fixture.mission)
    const replay = createCodeExplorerSpecialist({
      mission: fixture.mission,
      model: replayModel,
      tools: fixture.tools,
      store,
      executionCoordinator: coordinator,
      runtime: test.dependencies,
      checkpointer,
    })
    const replayed = await replay.service.start()
    expect(replayed.idempotent).toBe(true)
    expect(replayModel.requests).toHaveLength(0)
  })

  it("terminates before provider execution when model output budget is zero", async () => {
    const fixture = await createCodeExplorerGoldenFixture()
    const test = runtime()
    const selectedMission = codeExplorerMissionSchema.parse({
      ...fixture.mission,
      id: `mission:v1:${"9".repeat(64)}`,
      budget: { ...fixture.mission.budget, modelOutputTokens: 0 },
    })
    const model = new AdaptiveCodeSpecialistModel(selectedMission)
    const result = await createCodeExplorerSpecialist({
      mission: selectedMission,
      model,
      tools: fixture.tools,
      store: new InMemoryCodeExplorerSpecialistStoreForTesting(),
      executionCoordinator: new InMemorySpecialistToolExecutionCoordinator(),
      runtime: test.dependencies,
      checkpointer: createInMemorySpecialistCheckpointer(),
    }).service.start()

    expect(result.status).toBe("budget_exhausted")
    expect(result.mission.stopReason.code).toBe("model_budget_exhausted")
    expect(model.requests).toHaveLength(0)
  })
})
