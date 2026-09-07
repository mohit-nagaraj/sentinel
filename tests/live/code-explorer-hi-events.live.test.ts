import {
  applicationIdSchema,
  codeExplorerMissionSchema,
  codeExplorerToolNames,
  commitShaSchema,
  createMissionId,
  runIdSchema,
} from "@sentinel/contracts"
import {
  CodeExplorerRepository,
  CodeExplorerTools,
  PhpCodeIndex,
  PhpLaravelIndexer,
  createAzureOpenAIModelGateway,
  createTypeScriptIndexQuery,
  endpointFromFrontendCandidate,
  endpointsFromLaravelRoute,
  indexTypeScriptSource,
  loadAzureOpenAIEnvironment,
  startGitHubSourceConnector,
  type EndpointEvidence,
  type ResolvedGitHubCommit,
} from "@sentinel/adapters"
import { CodeExplorerService } from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"

const enabled = process.env["RUN_CODE_EXPLORER_HI_EVENTS"] === "1"
const pinnedCommit = "2064f88ff7590e93c738efb8becaa7d732063619"
const applicationId = applicationIdSchema.parse(
  `application:v1:${"6".repeat(64)}`
)
const runId = runIdSchema.parse("run:16000000-0000-4000-8000-000000000099")
const phpFiles = [
  "backend/app/Http/Actions/Orders/Public/CreateOrderActionPublic.php",
  "backend/app/Http/Request/Order/CreateOrderRequest.php",
  "backend/app/Repository/Eloquent/OrderRepository.php",
  "backend/app/Services/Application/Handlers/Order/CreateOrderHandler.php",
  "backend/routes/api.php",
] as const

describe.runIf(enabled)("Hi.Events Code Explorer mission evaluation", () => {
  it(
    "runs a bounded order-creation mission over the pinned public slice",
    async () => {
      const connector = await startGitHubSourceConnector({
        ...(process.env["GITHUB_TOKEN"] === undefined
          ? {}
          : { token: process.env["GITHUB_TOKEN"] }),
        limits: {
          maxTotalBytes: 1024 * 1024 * 1024,
          maxFileBytes: 16 * 1024 * 1024,
          timeoutMs: 5 * 60_000,
        },
      })
      let resolved: ResolvedGitHubCommit | undefined
      try {
        resolved = await connector.resolveCommit(
          "https://github.com/HiEventsDev/Hi.Events",
          pinnedCommit
        )
        const snapshot = resolved.checkout.snapshots.get("source")
        if (snapshot === undefined)
          throw new Error("Source checkout is unavailable")
        const typescript = await indexTypeScriptSource({
          reader: snapshot,
          applicationId,
          runId,
          repository: resolved.repository.repository,
          commitSha: commitShaSchema.parse(resolved.commit.sha),
          roots: ["frontend/src"],
          limits: { timeoutMs: 8 * 60_000, maxTotalNodes: 40_000_000 },
        })
        const php = await new PhpLaravelIndexer({
          limits: { timeoutMs: 5 * 60_000 },
        }).indexCheckout(snapshot, phpFiles, {
          applicationId,
          repository: resolved.repository.repository,
          commitSha: commitShaSchema.parse(resolved.commit.sha),
        })
        const endpointEvidence: EndpointEvidence[] = []
        for (const file of php.files) {
          for (const route of file.routes) {
            endpointEvidence.push(
              ...endpointsFromLaravelRoute({ response: php, file, route })
                .endpoints
            )
          }
        }
        for (const candidate of typescript.apiCallCandidates) {
          const file = typescript.files.find(
            ({ path }) => path === candidate.filePath
          )
          if (file === undefined) continue
          endpointEvidence.push(
            ...endpointFromFrontendCandidate({
              applicationId,
              repository: resolved.repository.repository,
              commitSha: commitShaSchema.parse(resolved.commit.sha),
              indexerVersion: typescript.indexerVersion,
              contentHash: file.contentHash,
              candidate,
            }).endpoints
          )
        }
        const createOrder = endpointEvidence.find(
          ({ endpoint, sourceKind }) =>
            sourceKind === "laravel" &&
            endpoint.method === "POST" &&
            endpoint.normalizedPath.includes("/public/events/") &&
            endpoint.normalizedPath.endsWith("/order")
        )
        if (createOrder === undefined) {
          throw new Error("Pinned Hi.Events order endpoint was not indexed")
        }
        const mission = codeExplorerMissionSchema.parse({
          schemaVersion: 1,
          id: createMissionId({
            applicationId,
            runId,
            agent: "code",
            mode: "implementation_trace",
            ordinal: 0,
          }),
          runId,
          applicationId,
          agent: "code",
          mode: "implementation_trace",
          goal: `Trace Hi.Events order creation for POST ${createOrder.endpoint.normalizedPath}.`,
          seedEvidenceIds: [],
          questions: [
            "Which frontend symbols call this endpoint?",
            "Which Laravel action, handler, and repository implement it?",
          ],
          scope: {
            repositoryPaths: ["frontend/src", "backend/app", "backend/routes"],
            languages: ["typescript", "tsx", "php"],
            sourceUris: [],
            allowedHosts: [],
            allowedTools: [...codeExplorerToolNames],
          },
          budget: {
            toolCalls: 15,
            contentBytes: 500_000,
            documentBytes: 0,
            documentPages: 0,
            documentSections: 0,
            sourceLines: 500,
            repositoryBytes: 250_000,
            repositoryFiles: 100,
            browserActions: 0,
            modelCalls: 15,
            modelInputTokens: 100_000,
            modelOutputTokens: 8_000,
            reconciliationRounds: 0,
            elapsedMs: 2 * 60_000,
          },
          successCriteria: [
            "Return a source-cited frontend and backend path, or explicit unresolved boundaries.",
          ],
        })
        const tools = new CodeExplorerTools(
          new CodeExplorerRepository({
            applicationId,
            runId,
            typescript: {
              index: typescript,
              query: createTypeScriptIndexQuery(typescript, snapshot),
            },
            php: { index: new PhpCodeIndex(php), snapshot },
            endpoints: endpointEvidence,
          }),
          mission
        )
        const gateway = createAzureOpenAIModelGateway(
          loadAzureOpenAIEnvironment(process.env),
          {
            maxInputCharacters: 16_000,
            maxOutputTokens: 512,
            maxTools: 16,
            maxToolCalls: 1,
            maxToolOutputCharacters: 32_768,
            timeoutMs: 30_000,
            maxRetries: 1,
          }
        )
        const result = await new CodeExplorerService(gateway, tools, {
          limits: {
            maxIterations: 20,
            maxContextCharacters: 12_000,
            maxTotalTraversalHops: 50,
            maxTotalResultItems: 500,
          },
        }).run(mission)

        expect(["complete", "partial", "budget_exhausted"]).toContain(
          result.status
        )
        expect(result.stopReason.code).not.toBe("model_protocol_invalid")
        expect(
          result.claims.every((claim) =>
            claim.evidence.some(({ strength }) => strength === "structural")
          )
        ).toBe(true)
        console.info(
          `[code-explorer-hi-events] ${JSON.stringify({
            status: result.status,
            claims: result.claims.length,
            paths: result.paths.length,
            unresolved: result.unresolvedBoundaries.length,
            toolCalls: result.budgetUsed.toolCalls,
          })}`
        )
      } finally {
        await resolved?.checkout.dispose()
      }
    },
    15 * 60_000
  )
})
