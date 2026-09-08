import { createHash } from "node:crypto"

import {
  applicationIdSchema,
  codeExplorerMissionSchema,
  codeExplorerToolNames,
  commitShaSchema,
  createStableKey,
  hashCanonical,
  type CodeExplorerMission,
} from "@sentinel/contracts"
import { beforeAll, describe, expect, it } from "vitest"

import { endpointEvidenceSchema } from "../source/endpoint/schema.ts"
import { createEndpointTemplate } from "../source/endpoint/normalize.ts"
import { createTypeScriptIndexQuery } from "../source/typescript/query.ts"
import {
  fixtureCommitScope,
  fixtureRunId,
  indexFixture,
  type IndexedFixture,
} from "../source/typescript/testing.ts"
import { defaultIndexPolicy } from "../source/typescript/policy.ts"
import type { CheckoutSnapshot } from "../source/github/checkout.ts"
import { phpIndexerResponseSchema } from "../php-laravel/schema.ts"
import { PhpCodeIndex } from "../php-laravel/queries.ts"
import { CodeExplorerRepository } from "./repository.ts"
import {
  CodeExplorerToolError,
  CodeExplorerTools,
  getCodeExplorerToolDefinitions,
} from "./tools.ts"

const phpSource = `<?php
namespace Fixture;

final class CreateOrderAction
{
    public function __invoke(): void
    {
        $container->make($handler)->run();
    }
}
`

const phpClassId = createStableKey({
  kind: "code-symbol",
  applicationId: fixtureCommitScope.applicationId,
  repository: fixtureCommitScope.repository,
  commitSha: fixtureCommitScope.commitSha,
  filePath: "backend/app/CreateOrderAction.php",
  qualifiedName: "Fixture\\CreateOrderAction",
  symbolKind: "class",
})
const phpMethodId = createStableKey({
  kind: "code-symbol",
  applicationId: fixtureCommitScope.applicationId,
  repository: fixtureCommitScope.repository,
  commitSha: fixtureCommitScope.commitSha,
  filePath: "backend/app/CreateOrderAction.php",
  qualifiedName: "Fixture\\CreateOrderAction::__invoke",
  symbolKind: "method",
})

const range = (
  startLine: number,
  endLine: number,
  startFilePos: number,
  endFilePos: number
) => ({
  startLine,
  endLine,
  startFilePos,
  endFilePos,
  startTokenPos: startFilePos,
  endTokenPos: endFilePos,
})

const phpResponse = phpIndexerResponseSchema.parse({
  schemaVersion: 1,
  source: {
    applicationId: fixtureCommitScope.applicationId,
    repository: fixtureCommitScope.repository,
    commitSha: fixtureCommitScope.commitSha,
  },
  parser: { name: "nikic/php-parser", version: "5.8.0" },
  files: [
    {
      path: "backend/app/CreateOrderAction.php",
      contentHash: `sha256:${createHash("sha256").update(phpSource).digest("hex")}`,
      symbols: [
        {
          id: phpClassId,
          kind: "class",
          role: "action",
          name: "CreateOrderAction",
          qualifiedName: "Fixture\\CreateOrderAction",
          originalName: "CreateOrderAction",
          static: false,
          abstract: false,
          final: true,
          attributes: [],
          range: range(4, 10, 25, phpSource.length - 2),
          declarationRanges: [range(4, 10, 25, phpSource.length - 2)],
        },
        {
          id: phpMethodId,
          kind: "method",
          role: "action",
          name: "__invoke",
          qualifiedName: "Fixture\\CreateOrderAction::__invoke",
          originalName: "__invoke",
          containerSymbolId: phpClassId,
          visibility: "public",
          static: false,
          abstract: false,
          final: false,
          attributes: [],
          range: range(6, 9, 61, phpSource.length - 4),
          declarationRanges: [range(6, 9, 61, phpSource.length - 4)],
        },
      ],
      relationships: [
        {
          id: `php-relationship:v1:${hashCanonical("dynamic-call").slice("sha256:".length)}`,
          kind: "unresolved_dynamic",
          sourceSymbolId: phpMethodId,
          originalTarget: "$container->make($handler)->run",
          dynamic: true,
          range: range(8, 8, 104, 143),
        },
      ],
      routes: [],
      errors: [],
    },
  ],
  summary: {
    fileCount: 1,
    symbolCount: 2,
    relationshipCount: 1,
    routeCount: 0,
    errorCount: 0,
  },
})

const snapshot: CheckoutSnapshot = {
  metadata: {
    label: "fixture",
    commitSha: fixtureCommitScope.commitSha,
    treeObjectId: "1".repeat(40),
    treeFingerprint: `sha256:${"2".repeat(64)}`,
    configFingerprint: `sha256:${"3".repeat(64)}`,
    fileCount: 1,
    totalBytes: Buffer.byteLength(phpSource),
  },
  path: "fixture",
  enumerate: () => [
    {
      path: "backend/app/CreateOrderAction.php",
      kind: "file",
      mode: "100644",
      objectId: "4".repeat(40),
      sizeBytes: Buffer.byteLength(phpSource),
    },
  ],
  readText: async (path) => {
    if (path !== "backend/app/CreateOrderAction.php") {
      throw new Error("Fixture rejected an unknown path")
    }
    return phpSource
  },
}

const emptyBudget = {
  toolCalls: 40,
  contentBytes: 50_000,
  documentBytes: 0,
  documentPages: 0,
  documentSections: 0,
  sourceLines: 500,
  repositoryBytes: 0,
  repositoryFiles: 0,
  browserActions: 0,
  modelCalls: 40,
  modelInputTokens: 50_000,
  modelOutputTokens: 10_000,
  reconciliationRounds: 0,
  elapsedMs: 60_000,
}

let tools: CodeExplorerTools
let repository: CodeExplorerRepository
let baseMission: CodeExplorerMission
let indexedFixture: IndexedFixture
let dashboardId: string
let clientCreateId: string

beforeAll(async () => {
  const fixture = await indexFixture({
    policy: { ...defaultIndexPolicy, includeTests: true },
  })
  indexedFixture = fixture
  const endpoint = createEndpointTemplate({
    applicationId: fixtureCommitScope.applicationId,
    method: "POST",
    path: "/events",
  })
  repository = new CodeExplorerRepository({
    applicationId: fixtureCommitScope.applicationId,
    runId: fixtureRunId,
    typescript: {
      index: fixture.index,
      query: createTypeScriptIndexQuery(fixture.index, fixture.reader),
    },
    php: { index: new PhpCodeIndex(phpResponse), snapshot },
    endpoints: [
      endpointEvidenceSchema.parse({
        endpoint,
        sourceKind: "frontend",
        provenance: {
          sourceKind: "frontend",
          extractor: { name: "typescript_indexer", version: "1.0.0" },
          sourceHash: fixture.index.indexFingerprint,
          repository: fixtureCommitScope.repository,
          commitSha: fixtureCommitScope.commitSha,
          filePath: "frontend/src/api/event.client.ts",
          range: { startLine: 3, endLine: 7 },
        },
      }),
      endpointEvidenceSchema.parse({
        endpoint,
        sourceKind: "laravel",
        provenance: {
          sourceKind: "laravel",
          extractor: { name: "php_laravel_indexer", version: "5.8.0" },
          sourceHash: phpResponse.files[0]!.contentHash,
          repository: fixtureCommitScope.repository,
          commitSha: fixtureCommitScope.commitSha,
          filePath: "backend/routes/api.php",
          range: { startLine: 12, endLine: 12 },
        },
        handler: {
          qualifiedName: "Fixture\\CreateOrderAction",
          symbolId: phpClassId,
        },
      }),
    ],
  })
  const mission = codeExplorerMissionSchema.parse({
    schemaVersion: 1,
    id: `mission:v1:${"5".repeat(64)}`,
    runId: fixtureRunId,
    applicationId: fixtureCommitScope.applicationId,
    agent: "code",
    mode: "implementation_trace",
    goal: "Trace event creation through frontend and backend code.",
    seedEvidenceIds: [],
    questions: ["Which code handles POST /events?"],
    scope: {
      repositoryPaths: ["frontend/src", "backend/app", "backend/routes"],
      languages: ["typescript", "tsx", "php"],
      sourceUris: [],
      allowedHosts: [],
      allowedTools: [...codeExplorerToolNames],
    },
    budget: emptyBudget,
    successCriteria: ["Return a source-cited implementation path."],
  })
  baseMission = mission
  tools = new CodeExplorerTools(repository, mission, {
    maxResultsPerTool: 10,
    maxTraversalHopsPerTool: 2,
    maxSourceLinesPerTool: 2,
    maxSourceCharactersPerTool: 2_000,
  })
  dashboardId = fixture.index.symbols.find(({ qualifiedName }) =>
    qualifiedName.endsWith("#Dashboard")
  )!.id
  clientCreateId = fixture.index.symbols.find(({ qualifiedName }) =>
    qualifiedName.endsWith("#eventsClient.create")
  )!.id
})

describe("Code Explorer bounded tools", () => {
  it("exposes exactly the thirteen SNT-016 tools", () => {
    expect(
      getCodeExplorerToolDefinitions().map(({ name }) => name)
    ).toStrictEqual(codeExplorerToolNames)
    expect(tools.definitions).toHaveLength(13)
  })

  it("lists and searches TypeScript and PHP without treating names as proof", async () => {
    const modules = await tools.execute("list_repository_modules", {
      limit: 10,
    })
    expect(modules.kind).toBe("observation")
    if (modules.kind !== "observation") return
    expect(
      modules.observation.entities.some(
        (entity) =>
          entity.entityType === "module" && entity.path === "backend/app"
      )
    ).toBe(true)

    const symbols = await tools.execute("search_symbols", {
      query: "CreateOrderAction",
    })
    expect(symbols.kind).toBe("observation")
    if (symbols.kind !== "observation") return
    expect(symbols.observation.entities).toContainEqual(
      expect.objectContaining({ id: phpClassId, language: "php" })
    )
    expect(symbols.observation.evidence).toStrictEqual([])
  })

  it("labels comment and string text matches as lexical-only evidence", async () => {
    const result = await tools.execute("search_code_text", {
      query: "Create event",
      languages: ["tsx"],
    })
    expect(result.kind).toBe("observation")
    if (result.kind !== "observation") return
    expect(result.observation.evidence.length).toBeGreaterThan(0)
    expect(
      result.observation.evidence.every(
        ({ strength }) => strength === "lexical"
      )
    ).toBe(true)
  })

  it("inspects only a bounded source slice and preserves dynamic gaps", async () => {
    const frontend = await tools.execute("inspect_symbol", {
      symbolId: dashboardId,
    })
    expect(frontend.kind).toBe("observation")
    if (frontend.kind !== "observation") return
    expect(frontend.observation.metrics.sourceLines).toBeLessThanOrEqual(2)
    expect(frontend.observation.sourceSlices[0]?.truncated).toBe(true)

    const php = await tools.execute("inspect_symbol", {
      symbolId: phpMethodId,
    })
    expect(php.kind).toBe("observation")
    if (php.kind !== "observation") return
    expect(php.observation.unresolved).toContainEqual(
      expect.objectContaining({ kind: "dynamic_call" })
    )
  })

  it("follows exact definitions, references, callers, and callees", async () => {
    const definition = await tools.execute("find_definition", {
      qualifiedName: "Fixture\\CreateOrderAction::__invoke",
    })
    expect(definition.kind).toBe("observation")
    if (definition.kind !== "observation") return
    expect(definition.observation.evidence[0]?.kind).toBe("definition")

    const references = await tools.execute("find_references", {
      symbolId: clientCreateId,
    })
    expect(references.kind).toBe("observation")
    if (references.kind !== "observation") return
    expect(references.observation.edges.length).toBeGreaterThan(0)

    const callers = await tools.execute("trace_callers", {
      symbolId: clientCreateId,
      maxHops: 10,
    })
    expect(callers.kind).toBe("observation")
    if (callers.kind !== "observation") return
    expect(callers.observation.metrics.traversalHops).toBeLessThanOrEqual(2)
    expect(
      callers.observation.entities.some(
        (entity) => entity.entityType === "symbol" && entity.id === dashboardId
      )
    ).toBe(true)

    const callees = await tools.execute("trace_callees", {
      symbolId: dashboardId,
    })
    expect(callees.kind).toBe("observation")
    if (callees.kind !== "observation") return
    expect(callees.observation.entities.length).toBeGreaterThan(0)
  })

  it("bridges exact endpoints to backend handlers and frontend callers", async () => {
    const handler = await tools.execute("find_endpoint_handler", {
      method: "POST",
      normalizedPath: "/events",
    })
    expect(handler.kind).toBe("observation")
    if (handler.kind !== "observation") return
    expect(handler.observation.edges).toContainEqual(
      expect.objectContaining({
        kind: "route_handler",
        targetId: phpClassId,
      })
    )

    const frontend = await tools.execute("find_frontend_callers", {
      method: "POST",
      normalizedPath: "/events",
    })
    expect(frontend.kind).toBe("observation")
    if (frontend.kind !== "observation") return
    expect(frontend.observation.edges).toContainEqual(
      expect.objectContaining({ kind: "frontend_call" })
    )
  })

  it("returns focused tests only as corroboration", async () => {
    const result = await tools.execute("inspect_tests", {
      targetKind: "text",
      query: "routeCount",
    })
    expect(result.kind).toBe("observation")
    if (result.kind !== "observation") return
    expect(result.observation.entities).toContainEqual(
      expect.objectContaining({ entityType: "test", corroboratesOnly: true })
    )
    expect(
      result.observation.evidence.every(
        ({ strength }) => strength === "corroborating"
      )
    ).toBe(true)
  })

  it("strictly validates proposal and finish actions", async () => {
    const claim = await tools.execute("submit_code_claim", {
      subjectId: createEndpointTemplate({
        applicationId: fixtureCommitScope.applicationId,
        method: "POST",
        path: "/events",
      }).id,
      predicate: "handled_by",
      objectId: phpClassId,
      evidenceIds: [`evidence:v1:${"6".repeat(64)}`],
      explanation: "The route handler edge names this class.",
    })
    expect(claim.kind).toBe("claim")

    const finish = await tools.execute("finish_code_mission", {
      status: "partial",
      claimIds: [],
      paths: [],
      unresolved: [],
      exclusions: ["No runtime behavior was asserted."],
      suggestedFollowups: [],
      stopReason: {
        code: "insufficient_evidence",
        summary: "No supported claim was submitted.",
      },
    })
    expect(finish.kind).toBe("finish")
    await expect(
      tools.execute("finish_code_mission", {
        status: "partial",
        arbitrary: true,
      })
    ).rejects.toMatchObject({ code: "invalid_arguments" })
  })

  it("denies unknown tools, out-of-scope paths, languages, and symbols", async () => {
    await expect(tools.execute("run_shell", {})).rejects.toBeInstanceOf(
      CodeExplorerToolError
    )
    await expect(
      tools.execute("search_symbols", {
        query: "secret",
        pathPrefix: "private",
      })
    ).rejects.toMatchObject({ code: "scope_denied" })
    await expect(
      tools.execute("search_symbols", {
        query: "CreateOrderAction",
        languages: ["php", "ruby"],
      })
    ).rejects.toMatchObject({ code: "invalid_arguments" })
    await expect(
      tools.execute("inspect_symbol", {
        symbolId: `code-symbol:v1:${"7".repeat(64)}`,
      })
    ).rejects.toMatchObject({ code: "scope_denied" })
  })

  it("rejects mixed application, run, repository, and commit identities", () => {
    expect(
      () =>
        new CodeExplorerRepository({
          applicationId: applicationIdSchema.parse(
            `application:v1:${"8".repeat(64)}`
          ),
          runId: fixtureRunId,
          typescript: {
            index: indexedFixture.index,
            query: createTypeScriptIndexQuery(
              indexedFixture.index,
              indexedFixture.reader
            ),
          },
        })
    ).toThrow(expect.objectContaining({ code: "identity_mismatch" }))

    expect(
      () =>
        new CodeExplorerRepository({
          applicationId: fixtureCommitScope.applicationId,
          runId: fixtureRunId,
          typescript: {
            index: {
              ...indexedFixture.index,
              commitSha: commitShaSchema.parse("9".repeat(40)),
            },
            query: createTypeScriptIndexQuery(
              indexedFixture.index,
              indexedFixture.reader
            ),
          },
          php: { index: new PhpCodeIndex(phpResponse), snapshot },
        })
    ).toThrow(expect.objectContaining({ code: "identity_mismatch" }))
  })

  it("does not expose resolved targets outside mission path or language scope", async () => {
    const narrowMission = codeExplorerMissionSchema.parse({
      ...baseMission,
      scope: {
        ...baseMission.scope,
        repositoryPaths: ["frontend/src"],
        languages: ["typescript", "tsx"],
      },
    })
    const narrowTools = new CodeExplorerTools(repository, narrowMission)
    const result = await narrowTools.execute("find_endpoint_handler", {
      method: "POST",
      normalizedPath: "/events",
    })
    expect(result.kind).toBe("observation")
    if (result.kind !== "observation") return
    expect(result.observation.edges).toStrictEqual([])
    expect(result.observation.entities).toContainEqual(
      expect.objectContaining({ handlerSymbolIds: [] })
    )
    expect(JSON.stringify(result)).not.toContain(phpClassId)
  })

  it("tightens per-tool limits to the remaining mission allowance", async () => {
    const result = await tools.execute(
      "inspect_symbol",
      { symbolId: dashboardId },
      {
        maxResultsPerTool: 2,
        maxTraversalHopsPerTool: 1,
        maxSourceLinesPerTool: 1,
        maxSourceCharactersPerTool: 1_000,
      }
    )
    expect(result.kind).toBe("observation")
    if (result.kind !== "observation") return
    expect(result.observation.metrics.sourceLines).toBeLessThanOrEqual(1)
    expect(result.observation.metrics.traversalHops).toBeLessThanOrEqual(1)
  })

  it("honors cancellation before returning repository evidence", async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      tools.execute(
        "inspect_symbol",
        { symbolId: dashboardId },
        {},
        aborted.signal
      )
    ).rejects.toMatchObject({ code: "cancelled" })

    const controller = new AbortController()
    const pending = tools.execute(
      "inspect_symbol",
      { symbolId: dashboardId },
      {},
      controller.signal
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
  })
})
