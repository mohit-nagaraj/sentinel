import {
  applicationIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  contentHashSchema,
  repositoryIdentitySchema,
} from "@sentinel/contracts"
import {
  compareEndpointEvidence,
  endpointFromFrontendCandidate,
  endpointsFromLaravelRoute,
  importOpenApiDocument,
  matchRuntimeRequest,
  type ApiCallCandidateRecord,
  type IndexRepositoryIdentity,
  phpIndexerResponseSchema,
} from "@sentinel/adapters"
import { openApiOrderFixture } from "../fixtures/openapi.ts"
import { describe, expect, it } from "vitest"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"1".repeat(64)}`
)
const repository = repositoryIdentitySchema.parse({
  host: "github.com",
  owner: "HiEventsDev",
  name: "Hi.Events",
}) as IndexRepositoryIdentity
const commitSha = commitShaSchema.parse("2".repeat(40))
const sourceHash = contentHashSchema.parse(`sha256:${"3".repeat(64)}`)

describe("cross-stack endpoint normalization", () => {
  it("converges OpenAPI, TypeScript, Laravel, and browser evidence", () => {
    const openapi = importOpenApiDocument({
      applicationId,
      sourceUri: "https://api.example.test/openapi.yaml",
      commitSha,
      document: openApiOrderFixture,
      stripPrefixes: ["/api/v1"],
    }).endpoints[0]!

    const candidate: ApiCallCandidateRecord = {
      ownerSymbolId: codeSymbolIdSchema.parse(
        `code-symbol:v1:${"4".repeat(64)}`
      ),
      filePath: "frontend/src/api/orders.ts",
      ownerQualifiedName: "frontend/src/api/orders.ts#createOrder",
      client: "axios",
      method: "POST",
      pathTemplate: "/api/v1/events/{param}/orders",
      rawPath: "fixture path expression",
      hasQueryString: false,
      range: { startLine: 5, endLine: 5 },
      unresolvedReasons: [],
    }
    const frontend = endpointFromFrontendCandidate({
      applicationId,
      repository,
      commitSha,
      indexerVersion: "1.0.0",
      contentHash: sourceHash,
      candidate,
      stripPrefixes: ["/api/v1"],
    }).endpoints[0]!

    const php = phpIndexerResponseSchema.parse({
      schemaVersion: 1,
      source: { applicationId, repository, commitSha },
      parser: { name: "nikic/php-parser", version: "5.8.0" },
      files: [
        {
          path: "backend/routes/api.php",
          contentHash: sourceHash,
          symbols: [],
          relationships: [],
          routes: [
            {
              id: `php-route:v1:${"5".repeat(64)}`,
              methods: ["POST"],
              path: "/api/v1/events/{event}/orders",
              middleware: ["api"],
              action: {
                originalName: "CreateOrderAction::class",
                resolvedName: "App\\Actions\\CreateOrderAction",
                dynamic: false,
              },
              dynamic: false,
              range: {
                startLine: 10,
                endLine: 10,
                startFilePos: 100,
                endFilePos: 180,
                startTokenPos: 20,
                endTokenPos: 30,
              },
            },
          ],
          errors: [],
        },
      ],
      summary: {
        fileCount: 1,
        symbolCount: 0,
        relationshipCount: 0,
        routeCount: 1,
        errorCount: 0,
      },
    })
    const laravel = endpointsFromLaravelRoute({
      response: php,
      file: php.files[0]!,
      route: php.files[0]!.routes[0]!,
      stripPrefixes: ["/api/v1"],
    }).endpoints[0]!

    expect(frontend.endpoint.id).toBe(openapi.endpoint.id)
    expect(laravel.endpoint.id).toBe(openapi.endpoint.id)
    expect(compareEndpointEvidence(openapi, frontend).kind).toBe("exact")
    expect(compareEndpointEvidence(openapi, laravel).kind).toBe("exact")

    const browser = matchRuntimeRequest(
      {
        applicationId,
        method: "POST",
        url: "https://api.example.test/api/v1/events/private-id/orders?token=private-token",
        headers: { authorization: "Bearer private-token" },
        body: { email: "private@example.test" },
        sourceHash,
        observedAt: "2026-09-07T09:00:00.000Z",
        stripPrefixes: ["/api/v1"],
      },
      [openapi, frontend, laravel]
    )

    expect(browser).toMatchObject({
      kind: "exact",
      endpoint: { id: openapi.endpoint.id },
      evidence: [
        { sourceKind: "frontend" },
        { sourceKind: "laravel" },
        { sourceKind: "openapi" },
      ],
    })
    expect(JSON.stringify(browser)).not.toContain("private")
  })
})
