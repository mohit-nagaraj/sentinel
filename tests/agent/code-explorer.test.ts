import {
  codeExplorerMissionSchema,
  finishCodeMissionInputSchema,
  hashCanonical,
  type CodeUnresolvedBoundary,
} from "@sentinel/contracts"
import {
  CodeExplorerService,
  type CodeExplorerModelDecision,
  type CodeExplorerModelGateway,
  type CodeExplorerToolExecution,
  type CodeExplorerToolPort,
} from "@sentinel/orchestration"
import { beforeAll, describe, expect, it } from "vitest"

import {
  codeExplorerFixtureIds,
  createCodeExplorerGoldenFixture,
  type CodeExplorerGoldenFixture,
} from "../fixtures/code-explorer.ts"

interface RecordedEdge {
  readonly kind: string
  readonly sourceId: string
  readonly targetId?: string
  readonly evidenceIds: readonly string[]
}

const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 }

function decision(
  ordinal: number,
  name: string,
  argumentsInput: unknown
): CodeExplorerModelDecision {
  return {
    kind: "tool_calls",
    output: [
      {
        callId: `call-${ordinal}`,
        name,
        arguments: argumentsInput,
      },
    ],
    model: "scripted-golden-code-explorer",
    usage,
  }
}

class RecordingTools implements CodeExplorerToolPort {
  readonly definitions
  readonly executions: {
    readonly name: string
    readonly result: CodeExplorerToolExecution
  }[] = []

  constructor(private readonly delegate: CodeExplorerToolPort) {
    this.definitions = delegate.definitions
  }

  async execute(
    name: string,
    argumentsInput: unknown
  ): Promise<CodeExplorerToolExecution> {
    const result = await this.delegate.execute(name, argumentsInput)
    this.executions.push({ name, result })
    return result
  }
}

class AdaptiveGoldenModel implements CodeExplorerModelGateway {
  readonly selectedTools: string[] = []
  private readonly entities = new Map<string, Record<string, unknown>>()
  private readonly edges = new Map<string, RecordedEdge>()
  private readonly evidence = new Map<string, Record<string, unknown>>()
  private readonly unresolved = new Map<string, CodeUnresolvedBoundary>()
  private toolStep = 0
  private claimStep = 0
  private path: readonly RecordedEdge[] | undefined

  constructor(private readonly fixture: CodeExplorerGoldenFixture) {}

  private observe(input: Record<string, unknown>): void {
    const latest = input["latestObservation"]
    if (
      latest === null ||
      typeof latest !== "object" ||
      Array.isArray(latest)
    ) {
      return
    }
    const observation = latest as Record<string, unknown>
    for (const entity of (observation["entities"] as Record<
      string,
      unknown
    >[]) ?? []) {
      const id = (entity["id"] ?? entity["key"]) as string | undefined
      if (id !== undefined) this.entities.set(id, entity)
    }
    for (const edge of (observation["edges"] as RecordedEdge[]) ?? []) {
      if (edge.targetId === undefined) continue
      this.edges.set(`${edge.sourceId}\0${edge.kind}\0${edge.targetId}`, edge)
    }
    for (const entry of (observation["evidence"] as Record<
      string,
      unknown
    >[]) ?? []) {
      this.evidence.set(entry["evidenceId"] as string, entry)
    }
    for (const boundary of (observation[
      "unresolved"
    ] as CodeUnresolvedBoundary[]) ?? []) {
      this.unresolved.set(
        `${boundary.kind}\0${boundary.reasonCode}\0${boundary.question}`,
        boundary
      )
    }
  }

  private chooseTool():
    { readonly name: string; readonly arguments: unknown } | undefined {
    const tools = [
      {
        name: "find_frontend_callers",
        arguments: {
          method: "POST",
          normalizedPath: "/events/{event}/orders",
        },
      },
      {
        name: "trace_callers",
        arguments: {
          symbolId: this.fixture.ids.ordersClientCreate,
          maxHops: 4,
        },
      },
      {
        name: "find_endpoint_handler",
        arguments: {
          method: "POST",
          normalizedPath: "/events/{event}/orders",
        },
      },
      {
        name: "trace_callees",
        arguments: {
          symbolId: this.fixture.ids.actionMethod,
          maxHops: 4,
        },
      },
      {
        name: "find_references",
        arguments: { symbolId: this.fixture.ids.repositoryMethod },
      },
      {
        name: "inspect_symbol",
        arguments: { symbolId: this.fixture.ids.unresolvedMethod },
      },
      {
        name: "inspect_tests",
        arguments: { targetKind: "text", query: "checkoutSubject" },
      },
    ] as const
    const selected = tools[this.toolStep]
    this.toolStep += 1
    return selected
  }

  private findPath(): readonly RecordedEdge[] {
    const outgoing = new Map<string, RecordedEdge[]>()
    for (const edge of this.edges.values()) {
      const entries = outgoing.get(edge.sourceId) ?? []
      entries.push(edge)
      outgoing.set(edge.sourceId, entries)
    }
    const queue: {
      readonly node: string
      readonly path: readonly RecordedEdge[]
    }[] = [{ node: this.fixture.ids.checkout, path: [] }]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.node === this.fixture.ids.orderModel) return current.path
      if (visited.has(current.node)) continue
      visited.add(current.node)
      for (const edge of (outgoing.get(current.node) ?? []).sort(
        (left, right) =>
          `${left.kind}\0${left.targetId}`.localeCompare(
            `${right.kind}\0${right.targetId}`,
            "en"
          )
      )) {
        queue.push({
          node: edge.targetId!,
          path: [...current.path, edge],
        })
      }
    }
    throw new Error(
      `Golden structural path is incomplete: ${JSON.stringify([...this.edges.values()])}`
    )
  }

  private predicate(kind: string): string {
    switch (kind) {
      case "call":
        return "calls"
      case "frontend_call":
        return "calls_api"
      case "route_handler":
        return "handled_by"
      default:
        return "reads"
    }
  }

  async decideTools(
    request: Parameters<CodeExplorerModelGateway["decideTools"]>[0]
  ): Promise<CodeExplorerModelDecision> {
    const input = JSON.parse(request.input) as Record<string, unknown>
    this.observe(input)
    if (this.toolStep < 7) {
      const selected = this.chooseTool()!
      this.selectedTools.push(selected.name)
      return decision(
        this.selectedTools.length,
        selected.name,
        selected.arguments
      )
    }
    this.path ??= this.findPath()
    if (this.claimStep < this.path.length) {
      const edge = this.path[this.claimStep]!
      this.claimStep += 1
      this.selectedTools.push("submit_code_claim")
      return decision(this.selectedTools.length, "submit_code_claim", {
        subjectId: edge.sourceId,
        predicate: this.predicate(edge.kind),
        objectId: edge.targetId,
        evidenceIds: edge.evidenceIds,
        explanation: `The indexed ${edge.kind} edge connects these adjacent implementation facts.`,
      })
    }
    const submitted = input["submittedClaims"] as {
      readonly id: string
      readonly subjectId: string
      readonly predicate: string
      readonly objectId: string
      readonly evidenceIds: readonly string[]
    }[]
    this.selectedTools.push("finish_code_mission")
    return decision(this.selectedTools.length, "finish_code_mission", {
      status: "complete",
      claimIds: submitted.map(({ id }) => id),
      paths: [
        {
          nodes: [
            this.path[0]!.sourceId,
            ...this.path.map(({ targetId }) => targetId),
          ],
          edges: submitted.map(
            ({ subjectId, predicate, objectId, evidenceIds }) => ({
              subjectId,
              predicate,
              objectId,
              evidenceIds,
            })
          ),
        },
      ],
      unresolved: [...this.unresolved.values()],
      exclusions: [
        "Same-name OrderService and endpoint text distractors were not connected without structural evidence.",
        "Focused tests were treated as corroboration only, not runtime proof.",
      ],
      suggestedFollowups: [],
      stopReason: {
        code: "criteria_met",
        summary:
          "The cross-stack implementation path has source-backed structural edges.",
      },
    })
  }
}

class SequenceModel implements CodeExplorerModelGateway {
  readonly selectedTools: string[] = []
  private cursor = 0

  constructor(
    private readonly steps: readonly {
      readonly name: string
      readonly arguments: unknown
    }[]
  ) {}

  async decideTools(): Promise<CodeExplorerModelDecision> {
    const step = this.steps[this.cursor]
    this.cursor += 1
    if (step === undefined) throw new Error("No scripted mission step remains")
    this.selectedTools.push(step.name)
    return decision(this.cursor, step.name, step.arguments)
  }
}

const partialFinish = finishCodeMissionInputSchema.parse({
  status: "partial",
  claimIds: [],
  paths: [],
  unresolved: [],
  exclusions: [
    "The focused trajectory intentionally stopped after bounded exploration.",
  ],
  suggestedFollowups: [],
  stopReason: {
    code: "focused_trajectory_complete",
    summary: "The requested bounded entry path was explored.",
  },
})

let fixture: CodeExplorerGoldenFixture

beforeAll(async () => {
  fixture = await createCodeExplorerGoldenFixture()
})

describe("Code Explorer cross-stack missions", () => {
  it("traces a React route through API and Laravel domain facts", async () => {
    const model = new AdaptiveGoldenModel(fixture)
    const result = await new CodeExplorerService(model, fixture.tools, {
      now: () => 1_000,
    }).run(fixture.mission)

    expect(result.status).toBe("complete")
    expect(result.paths).toHaveLength(1)
    expect(result.paths[0]?.nodes).toStrictEqual([
      fixture.ids.checkout,
      fixture.ids.useCreateOrder,
      fixture.ids.ordersClientCreate,
      fixture.endpointId,
      fixture.ids.actionMethod,
      fixture.ids.handlerMethod,
      fixture.ids.serviceMethod,
      fixture.ids.repositoryMethod,
      fixture.ids.orderModel,
    ])
    expect(
      result.claims.every((claim) =>
        claim.evidence.some(({ strength }) => strength === "structural")
      )
    ).toBe(true)
    expect(result.unresolvedBoundaries).toContainEqual(
      expect.objectContaining({ kind: "dynamic_call" })
    )
    expect(JSON.stringify(result)).not.toContain(fixture.ids.distractorService)
    expect(model.selectedTools.slice(0, 7)).toStrictEqual([
      "find_frontend_callers",
      "trace_callers",
      "find_endpoint_handler",
      "trace_callees",
      "find_references",
      "inspect_symbol",
      "inspect_tests",
    ])
  })

  it("keeps the golden trajectory and evidence stable across repeated runs", async () => {
    const results: string[] = []
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const model = new AdaptiveGoldenModel(fixture)
      const result = await new CodeExplorerService(model, fixture.tools, {
        now: () => 1_000,
      }).run(fixture.mission)
      results.push(JSON.stringify(result))
    }
    expect(new Set(results)).toHaveLength(1)
  })

  it("expands a changed backend symbol to callers, endpoint, and frontend", async () => {
    const model = new SequenceModel([
      {
        name: "trace_callers",
        arguments: { symbolId: fixture.ids.handlerMethod, maxHops: 3 },
      },
      {
        name: "find_endpoint_handler",
        arguments: {
          method: "POST",
          normalizedPath: "/events/{event}/orders",
        },
      },
      {
        name: "find_frontend_callers",
        arguments: {
          method: "POST",
          normalizedPath: "/events/{event}/orders",
        },
      },
      { name: "finish_code_mission", arguments: partialFinish },
    ])
    const tools = new RecordingTools(fixture.tools)
    const changed = codeExplorerMissionSchema.parse({
      ...fixture.mission,
      mode: "pr_change_investigation" as const,
      goal: "Investigate callers and product paths for the changed handler.",
    })
    const result = await new CodeExplorerService(model, tools, {
      now: () => 1_000,
    }).run(changed)

    expect(result.status).toBe("partial")
    expect(model.selectedTools).toStrictEqual([
      "trace_callers",
      "find_endpoint_handler",
      "find_frontend_callers",
      "finish_code_mission",
    ])
    const observedPaths = tools.executions.flatMap(({ result }) =>
      result.kind === "observation"
        ? result.observation.entities.flatMap((entity) =>
            "filePath" in entity ? [entity.filePath] : []
          )
        : []
    )
    expect(observedPaths).toContain("backend/app/Actions/CreateOrderAction.php")
    expect(observedPaths).toContain("frontend/src/api/order.client.ts")
  })

  it.each([
    [
      "frontend-first",
      [
        {
          name: "inspect_symbol",
          arguments: { symbolId: () => fixture.ids.checkout },
        },
        {
          name: "trace_callees",
          arguments: { symbolId: () => fixture.ids.checkout },
        },
      ],
    ],
    [
      "backend-first",
      [
        {
          name: "inspect_symbol",
          arguments: { symbolId: () => fixture.ids.actionMethod },
        },
        {
          name: "trace_callees",
          arguments: { symbolId: () => fixture.ids.actionMethod },
        },
      ],
    ],
    [
      "capability-first",
      [
        { name: "search_symbols", arguments: { query: "Order" } },
        {
          name: "find_definition",
          arguments: { qualifiedName: "Fixture\\Services\\OrderService" },
        },
      ],
    ],
  ])("supports a %s bounded mission entry", async (_label, rawSteps) => {
    const steps = rawSteps.map((step) => ({
      name: step.name,
      arguments: Object.fromEntries(
        Object.entries(step.arguments).map(([key, value]) => [
          key,
          typeof value === "function" ? value() : value,
        ])
      ),
    }))
    const model = new SequenceModel([
      ...steps,
      { name: "finish_code_mission", arguments: partialFinish },
    ])
    const result = await new CodeExplorerService(model, fixture.tools, {
      now: () => 1_000,
    }).run(fixture.mission)
    expect(result.status).toBe("partial")
    expect(model.selectedTools).toStrictEqual([
      ...steps.map(({ name }) => name),
      "finish_code_mission",
    ])
  })

  it("returns an explicit partial boundary for an unmapped endpoint", async () => {
    const model = new SequenceModel([
      {
        name: "find_endpoint_handler",
        arguments: { method: "DELETE", normalizedPath: "/unknown/{id}" },
      },
      { name: "finish_code_mission", arguments: partialFinish },
    ])
    const mission = codeExplorerMissionSchema.parse({
      ...fixture.mission,
      mode: "unmapped_endpoint_resolution" as const,
      goal: "Resolve an endpoint that is absent from the normalized catalog.",
    })
    const result = await new CodeExplorerService(model, fixture.tools, {
      now: () => 1_000,
    }).run(mission)
    expect(result).toMatchObject({
      status: "partial",
      unresolvedBoundaries: [
        { kind: "unmapped_endpoint", reasonCode: "endpoint_not_indexed" },
      ],
    })
  })

  it("keeps same-name and comment/string hits lexical until structurally proven", async () => {
    const tools = new RecordingTools(fixture.tools)
    const model = new SequenceModel([
      { name: "search_symbols", arguments: { query: "OrderService" } },
      {
        name: "search_code_text",
        arguments: { query: "Same-name distractor" },
      },
      { name: "finish_code_mission", arguments: partialFinish },
    ])
    const result = await new CodeExplorerService(model, tools, {
      now: () => 1_000,
    }).run(fixture.mission)
    expect(result.claims).toStrictEqual([])
    const observations = tools.executions.flatMap(({ result }) =>
      result.kind === "observation" ? [result.observation] : []
    )
    expect(
      observations
        .flatMap(({ evidence }) => evidence)
        .every(({ strength }) => strength === "lexical")
    ).toBe(true)
    expect(
      hashCanonical(
        observations.map(({ toolName, entities, evidence }) => ({
          toolName,
          entities,
          evidence,
        }))
      )
    ).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it("exports the expected dynamic fixture identities", () => {
    expect(codeExplorerFixtureIds).toMatchObject({
      actionMethod: fixture.ids.actionMethod,
      orderModel: fixture.ids.orderModel,
      distractorService: fixture.ids.distractorService,
    })
  })
})
