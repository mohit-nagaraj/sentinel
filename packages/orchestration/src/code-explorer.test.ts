import {
  codeExplorerMissionSchema,
  codeExplorerToolNames,
  codeToolObservationSchema,
  createClaimId,
  findEndpointHandlerInputSchema,
  finishCodeMissionInputSchema,
  hashCanonical,
  submitCodeClaimInputSchema,
  type CodeExplorerMission,
  type CodeToolObservation,
  type MissionBudget,
} from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

import {
  CodeExplorerService,
  type CodeExplorerModelDecision,
  type CodeExplorerModelGateway,
  type CodeExplorerToolExecution,
  type CodeExplorerToolPort,
} from "./code-explorer.ts"

const applicationId = `application:v1:${"a".repeat(64)}` as const
const runId = "run:00000000-0000-4000-8000-000000000016" as const
const missionId = `mission:v1:${"b".repeat(64)}` as const
const endpointId = `api-endpoint:v1:${"c".repeat(64)}` as const
const actionId = `code-symbol:v1:${"d".repeat(64)}` as const
const evidenceId = `evidence:v1:${"e".repeat(64)}` as const

const baseBudget: MissionBudget = {
  toolCalls: 20,
  contentBytes: 50_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 100,
  repositoryBytes: 10_000,
  repositoryFiles: 10,
  browserActions: 0,
  modelCalls: 20,
  modelInputTokens: 10_000,
  modelOutputTokens: 2_000,
  reconciliationRounds: 0,
  elapsedMs: 10_000,
}

function mission(
  budget: MissionBudget = baseBudget,
  allowedTools: readonly string[] = [
    "find_endpoint_handler",
    "submit_code_claim",
    "finish_code_mission",
  ]
): CodeExplorerMission {
  return codeExplorerMissionSchema.parse({
    schemaVersion: 1,
    id: missionId,
    runId,
    applicationId,
    agent: "code",
    mode: "implementation_trace",
    goal: "Trace order creation from the normalized endpoint.",
    seedEvidenceIds: [],
    questions: ["Which source-backed handler implements order creation?"],
    scope: {
      repositoryPaths: ["frontend/src", "backend/app", "backend/routes"],
      languages: ["typescript", "tsx", "php"],
      sourceUris: [],
      allowedHosts: [],
      allowedTools,
    },
    budget,
    successCriteria: ["Return a source-cited endpoint-to-handler path."],
  })
}

function observation(
  strength: "structural" | "lexical" = "structural",
  metrics: CodeToolObservation["metrics"] = {
    sourceLines: 1,
    contentBytes: 24,
    resultItems: 4,
    traversalHops: 1,
  }
): CodeToolObservation {
  return codeToolObservationSchema.parse({
    schemaVersion: 1,
    toolName: "find_endpoint_handler",
    summary: "Found one exact Laravel route handler edge.",
    entities: [
      {
        entityType: "endpoint",
        id: endpointId,
        method: "POST",
        normalizedPath: "/api/events/{param}/orders",
        sourceKinds: ["laravel", "openapi"],
        handlerSymbolIds: [actionId],
      },
      {
        entityType: "symbol",
        id: actionId,
        qualifiedName: "Fixture\\Actions\\CreateOrderAction::__invoke",
        name: "__invoke",
        language: "php",
        kind: "action",
        filePath: "backend/app/Actions/CreateOrderAction.php",
        range: { startLine: 12, endLine: 20 },
      },
    ],
    edges: [
      {
        kind: "route_handler",
        sourceId: endpointId,
        targetId: actionId,
        evidenceIds: [evidenceId],
      },
    ],
    sourceSlices: [
      {
        filePath: "backend/routes/api.php",
        language: "php",
        range: { startLine: 12, endLine: 12 },
        text: "Route::post('orders', CreateOrderAction::class);",
        contentHash: hashCanonical("route-source"),
        truncated: false,
        evidenceId,
      },
    ],
    evidence: [
      {
        evidenceId,
        kind: strength === "structural" ? "route_handler" : "lexical_match",
        strength,
        filePath: "backend/routes/api.php",
        range: { startLine: 12, endLine: 12 },
        sourceEntityId: endpointId,
        targetEntityId: actionId,
      },
    ],
    unresolved: [],
    metrics,
  })
}

const claimId = createClaimId({
  applicationId,
  missionId,
  subjectId: endpointId,
  predicate: "handled_by",
  objectId: actionId,
  ordinal: 0,
})

const endpointArguments = {
  method: "POST",
  normalizedPath: "/api/events/{event}/orders",
}

const claimArguments = {
  subjectId: endpointId,
  predicate: "handled_by",
  objectId: actionId,
  evidenceIds: [evidenceId],
  explanation: "The normalized Laravel route structurally names this action.",
}

const finishArguments = {
  status: "complete",
  claimIds: [claimId],
  paths: [
    {
      nodes: [endpointId, actionId],
      edges: [
        {
          subjectId: endpointId,
          predicate: "handled_by",
          objectId: actionId,
          evidenceIds: [evidenceId],
        },
      ],
    },
  ],
  unresolved: [],
  exclusions: ["No runtime behavior was asserted."],
  suggestedFollowups: [],
  stopReason: {
    code: "criteria_met",
    summary: "The endpoint-to-handler path has structural source evidence.",
  },
}

function toolDecision(
  callId: string,
  name: string,
  argumentsInput: unknown,
  usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 }
): CodeExplorerModelDecision {
  return {
    kind: "tool_calls",
    output: [{ callId, name, arguments: argumentsInput }],
    model: "scripted-code-explorer",
    usage,
  }
}

class ScriptedModel implements CodeExplorerModelGateway {
  readonly requests: Parameters<CodeExplorerModelGateway["decideTools"]>[0][] =
    []
  private cursor = 0

  constructor(
    private readonly decisions: readonly CodeExplorerModelDecision[]
  ) {}

  async decideTools(
    request: Parameters<CodeExplorerModelGateway["decideTools"]>[0]
  ): Promise<CodeExplorerModelDecision> {
    this.requests.push(request)
    const decision = this.decisions[this.cursor]
    this.cursor += 1
    if (decision === undefined) throw new Error("No scripted decision remains")
    return decision
  }
}

class ScriptedTools implements CodeExplorerToolPort {
  readonly definitions
  readonly execute = vi.fn(
    async (
      name: string,
      argumentsInput: unknown
    ): Promise<CodeExplorerToolExecution> => {
      if (name === "find_endpoint_handler") {
        findEndpointHandlerInputSchema.parse(argumentsInput)
        return { kind: "observation", observation: this.currentObservation }
      }
      if (name === "submit_code_claim") {
        return {
          kind: "claim",
          input: submitCodeClaimInputSchema.parse(argumentsInput),
        }
      }
      if (name === "finish_code_mission") {
        return {
          kind: "finish",
          input: finishCodeMissionInputSchema.parse(argumentsInput),
        }
      }
      throw new Error("Unexpected scripted tool")
    }
  )

  constructor(
    allowedTools: readonly string[],
    private readonly currentObservation: CodeToolObservation
  ) {
    const schemas = {
      find_endpoint_handler: findEndpointHandlerInputSchema,
      submit_code_claim: submitCodeClaimInputSchema,
      finish_code_mission: finishCodeMissionInputSchema,
    } as const
    this.definitions = allowedTools.map((name) => ({
      name,
      description: `Execute the bounded ${name} operation.`,
      parameters: schemas[name as keyof typeof schemas],
    }))
  }
}

function successfulDecisions(): readonly CodeExplorerModelDecision[] {
  return [
    toolDecision("call-1", "find_endpoint_handler", endpointArguments),
    toolDecision("call-2", "submit_code_claim", claimArguments),
    toolDecision("call-3", "finish_code_mission", finishArguments),
  ]
}

describe("Code Explorer specialist loop", () => {
  it("runs a strict observation, claim, and deterministic finish trajectory", async () => {
    const model = new ScriptedModel(successfulDecisions())
    const tools = new ScriptedTools(
      ["find_endpoint_handler", "submit_code_claim", "finish_code_mission"],
      observation()
    )
    const service = new CodeExplorerService(model, tools, { now: () => 1_000 })

    const result = await service.run(mission())

    expect(result).toMatchObject({
      status: "complete",
      claims: [{ id: claimId, status: "proposed" }],
      paths: [{ nodes: [endpointId, actionId] }],
      stopReason: { code: "criteria_met" },
      traversalHopsUsed: 1,
    })
    expect(result.paths[0]?.key).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(model.requests).toHaveLength(3)
    expect(model.requests[1]?.input).toContain("Route::post")
    expect(model.requests[0]?.instructions).toContain("untrusted data")
    expect(tools.execute).toHaveBeenCalledTimes(3)
  })

  it("produces byte-equivalent results for repeated scripted trajectories", async () => {
    const run = async () => {
      const model = new ScriptedModel(successfulDecisions())
      const tools = new ScriptedTools(
        ["find_endpoint_handler", "submit_code_claim", "finish_code_mission"],
        observation()
      )
      return await new CodeExplorerService(model, tools, {
        now: () => 1_000,
      }).run(mission())
    }
    expect(JSON.stringify(await run())).toBe(JSON.stringify(await run()))
  })

  it("does not execute an identical symbol, edge, or query visit twice", async () => {
    const repeated = toolDecision(
      "call-repeat",
      "find_endpoint_handler",
      endpointArguments
    )
    const model = new ScriptedModel([
      toolDecision("call-first", "find_endpoint_handler", endpointArguments),
      repeated,
    ])
    const tools = new ScriptedTools(
      ["find_endpoint_handler", "finish_code_mission"],
      observation()
    )
    const result = await new CodeExplorerService(model, tools, {
      now: () => 1_000,
    }).run(
      mission(baseBudget, ["find_endpoint_handler", "finish_code_mission"])
    )

    expect(result).toMatchObject({
      status: "partial",
      stopReason: { code: "no_progress" },
    })
    expect(tools.execute).toHaveBeenCalledOnce()
  })

  it("rejects lexical or test-only support for a code relationship", async () => {
    const model = new ScriptedModel([
      toolDecision("call-1", "find_endpoint_handler", endpointArguments),
      toolDecision("call-2", "submit_code_claim", claimArguments),
    ])
    const tools = new ScriptedTools(
      ["find_endpoint_handler", "submit_code_claim", "finish_code_mission"],
      observation("lexical")
    )
    const result = await new CodeExplorerService(model, tools, {
      now: () => 1_000,
    }).run(mission())

    expect(result).toMatchObject({
      status: "partial",
      claims: [],
      stopReason: { code: "claim_evidence_invalid" },
    })
  })

  it.each([
    ["model calls", { modelCalls: 0 }, "model_budget_exhausted"],
    ["model input tokens", { modelInputTokens: 10 }, "model_budget_exhausted"],
    ["model output tokens", { modelOutputTokens: 5 }, "model_budget_exhausted"],
    ["tool calls", { toolCalls: 0 }, "tool_budget_exhausted"],
    ["source lines", { sourceLines: 0 }, "content_budget_exhausted"],
    ["content bytes", { contentBytes: 1 }, "content_budget_exhausted"],
    ["repository bytes", { repositoryBytes: 0 }, "content_budget_exhausted"],
    ["repository files", { repositoryFiles: 0 }, "content_budget_exhausted"],
  ])(
    "fails closed when the %s budget is exhausted",
    async (_name, override, code) => {
      const model = new ScriptedModel([
        toolDecision("call-1", "find_endpoint_handler", endpointArguments),
      ])
      const tools = new ScriptedTools(
        ["find_endpoint_handler", "finish_code_mission"],
        observation()
      )
      const result = await new CodeExplorerService(model, tools, {
        now: () => 1_000,
      }).run(
        mission({ ...baseBudget, ...override }, [
          "find_endpoint_handler",
          "finish_code_mission",
        ])
      )
      expect(result).toMatchObject({
        status: "budget_exhausted",
        stopReason: { code },
      })
    }
  )

  it("enforces elapsed, hop, result, and recursion boundaries", async () => {
    let clock = 0
    const elapsed = await new CodeExplorerService(
      new ScriptedModel([]),
      new ScriptedTools(
        ["find_endpoint_handler", "finish_code_mission"],
        observation()
      ),
      { now: () => (clock += 100) }
    ).run(
      mission({ ...baseBudget, elapsedMs: 50 }, [
        "find_endpoint_handler",
        "finish_code_mission",
      ])
    )
    expect(elapsed.stopReason.code).toBe("elapsed_budget_exhausted")

    const bounded = async (limits: {
      maxTotalTraversalHops: number
      maxTotalResultItems: number
    }) =>
      await new CodeExplorerService(
        new ScriptedModel([
          toolDecision("call-1", "find_endpoint_handler", endpointArguments),
        ]),
        new ScriptedTools(
          ["find_endpoint_handler", "finish_code_mission"],
          observation("structural", {
            sourceLines: 1,
            contentBytes: 24,
            resultItems: 4,
            traversalHops: 2,
          })
        ),
        { now: () => 1_000, limits }
      ).run(
        mission(baseBudget, ["find_endpoint_handler", "finish_code_mission"])
      )

    expect(
      (await bounded({ maxTotalTraversalHops: 1, maxTotalResultItems: 10 }))
        .status
    ).toBe("budget_exhausted")
    expect(
      (await bounded({ maxTotalTraversalHops: 10, maxTotalResultItems: 1 }))
        .status
    ).toBe("budget_exhausted")

    const recursion = await new CodeExplorerService(
      new ScriptedModel([
        toolDecision("call-1", "find_endpoint_handler", endpointArguments),
      ]),
      new ScriptedTools(
        ["find_endpoint_handler", "finish_code_mission"],
        observation()
      ),
      {
        now: () => 1_000,
        limits: { maxIterations: 1 },
      }
    ).run(mission(baseBudget, ["find_endpoint_handler", "finish_code_mission"]))
    expect(recursion.stopReason.code).toBe("recursion_limit")
  })

  it("rejects unauthorized, multiple, and free-text model decisions", async () => {
    const tools = new ScriptedTools(
      ["find_endpoint_handler", "finish_code_mission"],
      observation()
    )
    const unauthorized = await new CodeExplorerService(
      new ScriptedModel([
        toolDecision("call-1", "search_code_text", { query: "x" }),
      ]),
      tools,
      { now: () => 1_000 }
    ).run(mission(baseBudget, ["find_endpoint_handler", "finish_code_mission"]))
    expect(unauthorized).toMatchObject({
      status: "blocked",
      stopReason: { code: "tool_not_allowed" },
    })

    const multiple = await new CodeExplorerService(
      new ScriptedModel([
        {
          kind: "tool_calls",
          output: [
            {
              callId: "1",
              name: "find_endpoint_handler",
              arguments: endpointArguments,
            },
            {
              callId: "2",
              name: "find_endpoint_handler",
              arguments: endpointArguments,
            },
          ],
          model: "scripted",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
      tools,
      { now: () => 1_000 }
    ).run(mission(baseBudget, ["find_endpoint_handler", "finish_code_mission"]))
    expect(multiple.stopReason.code).toBe("model_protocol_invalid")

    const text = await new CodeExplorerService(
      new ScriptedModel([
        {
          kind: "final_text",
          output: "done",
          model: "scripted",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
      tools,
      { now: () => 1_000 }
    ).run(mission(baseBudget, ["find_endpoint_handler", "finish_code_mission"]))
    expect(text.stopReason.code).toBe("model_protocol_invalid")
  })

  it("emits concise events without prompts, source, arguments, or hidden reasoning", async () => {
    const events: unknown[] = []
    const result = await new CodeExplorerService(
      new ScriptedModel(successfulDecisions()),
      new ScriptedTools(
        ["find_endpoint_handler", "submit_code_claim", "finish_code_mission"],
        observation()
      ),
      {
        now: () => 1_000,
        events: { append: async (event) => void events.push(event) },
      }
    ).run(mission())
    expect(result.status).toBe("complete")
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("Route::post")
    expect(serialized).not.toContain("arguments")
    expect(serialized).not.toContain("reasoning")
    expect(serialized).toContain("tool_completed")
  })

  it("accepts all four Code Explorer mission modes", () => {
    for (const mode of [
      "baseline_architecture_discovery",
      "implementation_trace",
      "pr_change_investigation",
      "unmapped_endpoint_resolution",
    ] as const) {
      expect(
        codeExplorerMissionSchema.safeParse({ ...mission(), mode }).success
      ).toBe(true)
    }
    expect(codeExplorerToolNames).toContain("finish_code_mission")
  })
})
