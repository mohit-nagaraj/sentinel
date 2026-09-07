import {
  applicationIdSchema,
  codeSymbolIdSchema,
  commitShaSchema,
  contentHashSchema,
  repositoryIdentitySchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { phpIndexerResponseSchema } from "../../php-laravel/schema.ts"
import type { ApiCallCandidateRecord } from "../typescript/indexer.ts"
import type { IndexRepositoryIdentity } from "../typescript/identity.ts"
import { compareEndpointEvidence, matchRuntimeRequest } from "./matching.ts"
import { createEndpointTemplate } from "./normalize.ts"
import { endpointEvidenceSchema, type EndpointEvidence } from "./schema.ts"
import {
  endpointFromFrontendCandidate,
  endpointsFromLaravelRoute,
} from "./sources.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"3".repeat(64)}`
)
const sourceHash = contentHashSchema.parse(`sha256:${"4".repeat(64)}`)
const commitSha = commitShaSchema.parse("5".repeat(40))
const repository = repositoryIdentitySchema.parse({
  host: "github.com",
  owner: "HiEventsDev",
  name: "Hi.Events",
}) as IndexRepositoryIdentity
const observedAt = "2026-09-07T08:00:00.000Z"

function evidence(
  sourceKind: EndpointEvidence["sourceKind"],
  method: string,
  path: string
): EndpointEvidence {
  return endpointEvidenceSchema.parse({
    sourceKind,
    endpoint: createEndpointTemplate({ applicationId, method, path }),
    provenance: {
      sourceKind,
      extractor: { name: `${sourceKind}_fixture`, version: "1.0.0" },
      sourceHash,
      ...(sourceKind === "browser" ? { observedAt } : {}),
    },
  })
}

describe("endpoint evidence comparison", () => {
  it("matches source templates exactly by method and positional shape", () => {
    const openapi = evidence(
      "openapi",
      "POST",
      "/events/{event_id}/orders/{order_id}"
    )
    const laravel = evidence(
      "laravel",
      "post",
      "/events/{event}/orders/{order}"
    )

    expect(compareEndpointEvidence(openapi, laravel)).toMatchObject({
      kind: "exact",
      endpoint: { id: openapi.endpoint.id },
    })
  })

  it("keeps method and path disagreements inspectable", () => {
    const get = evidence("openapi", "GET", "/orders/{id}")
    const post = evidence("laravel", "POST", "/orders/{id}")
    const users = evidence("frontend", "GET", "/users/{id}")

    expect(compareEndpointEvidence(get, post)).toMatchObject({
      kind: "conflict",
      reason: "method_mismatch",
      evidence: [get, post],
    })
    expect(compareEndpointEvidence(get, users)).toMatchObject({
      kind: "conflict",
      reason: "path_mismatch",
      evidence: [get, users],
    })

    const forgedMethod = {
      ...post,
      endpoint: { ...post.endpoint, id: get.endpoint.id },
    }
    expect(compareEndpointEvidence(get, forgedMethod)).toMatchObject({
      kind: "conflict",
      reason: "method_mismatch",
    })

    const forgedPath = {
      ...users,
      endpoint: { ...users.endpoint, id: get.endpoint.id },
    }
    expect(compareEndpointEvidence(get, forgedPath)).toMatchObject({
      kind: "conflict",
      reason: "path_mismatch",
    })
  })

  it("never links endpoint evidence across applications", () => {
    const first = evidence("openapi", "GET", "/orders/{id}")
    const otherApplicationId = applicationIdSchema.parse(
      `application:v1:${"a".repeat(64)}`
    )
    const second = endpointEvidenceSchema.parse({
      sourceKind: "laravel",
      endpoint: createEndpointTemplate({
        applicationId: otherApplicationId,
        method: "GET",
        path: "/orders/{orderId}",
      }),
      provenance: {
        sourceKind: "laravel",
        extractor: { name: "laravel_fixture", version: "1.0.0" },
        sourceHash,
      },
    })

    expect(compareEndpointEvidence(first, second)).toMatchObject({
      kind: "conflict",
      reason: "application_mismatch",
    })
  })

  it("surfaces static and dynamic overlap as a candidate", () => {
    expect(
      compareEndpointEvidence(
        evidence("openapi", "GET", "/users/me"),
        evidence("laravel", "GET", "/users/{id}")
      )
    ).toMatchObject({ kind: "candidate", reason: "static_dynamic_overlap" })
  })
})

describe("cross-source adapters", () => {
  it("converges a frontend candidate with OpenAPI evidence", () => {
    const candidate: ApiCallCandidateRecord = {
      ownerSymbolId: codeSymbolIdSchema.parse(
        `code-symbol:v1:${"6".repeat(64)}`
      ),
      filePath: "frontend/src/api/orders.ts",
      ownerQualifiedName: "frontend/src/api/orders.ts#createOrder",
      client: "axios",
      method: "POST",
      pathTemplate: "/api/v1/events/{param}/orders",
      rawPath: "redacted fixture expression",
      hasQueryString: true,
      range: { startLine: 12, endLine: 12 },
      unresolvedReasons: [],
    }
    const result = endpointFromFrontendCandidate({
      applicationId,
      repository,
      commitSha,
      indexerVersion: "1.0.0",
      contentHash: sourceHash,
      candidate,
      stripPrefixes: ["/api/v1"],
    })
    const openapi = evidence("openapi", "POST", "/events/{event_id}/orders")

    expect(result.unresolved).toStrictEqual([])
    expect(compareEndpointEvidence(result.endpoints[0]!, openapi).kind).toBe(
      "exact"
    )
  })

  it("adapts Laravel grouped routes and expands ANY without guessing dynamics", () => {
    const response = phpIndexerResponseSchema.parse({
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
              id: `php-route:v1:${"7".repeat(64)}`,
              methods: ["ANY"],
              path: "/api/v1/events/{event}/orders",
              middleware: ["api"],
              action: {
                originalName: "CreateOrderAction::class",
                resolvedName: "App\\Actions\\CreateOrderAction",
                method: "__invoke",
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
            {
              id: `php-route:v1:${"8".repeat(64)}`,
              methods: ["GET"],
              path: "/api/v1/events/{event?}",
              middleware: ["api"],
              action: {
                originalName: "ShowEventAction::class",
                resolvedName: "App\\Actions\\ShowEventAction",
                dynamic: false,
              },
              dynamic: false,
              range: {
                startLine: 11,
                endLine: 11,
                startFilePos: 181,
                endFilePos: 250,
                startTokenPos: 31,
                endTokenPos: 40,
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
        routeCount: 2,
        errorCount: 0,
      },
    })
    const result = endpointsFromLaravelRoute({
      response,
      file: response.files[0]!,
      route: response.files[0]!.routes[0]!,
      stripPrefixes: ["/api/v1"],
    })

    expect(
      result.endpoints.map(({ endpoint }) => endpoint.method)
    ).toStrictEqual([
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
    ])
    expect(result.endpoints[5]).toMatchObject({
      endpoint: { normalizedPath: "/events/{param}/orders" },
      handler: {
        qualifiedName: "App\\Actions\\CreateOrderAction",
        method: "__invoke",
      },
    })
    const optional = endpointsFromLaravelRoute({
      response,
      file: response.files[0]!,
      route: response.files[0]!.routes[1]!,
      stripPrefixes: ["/api/v1"],
    })
    expect(
      optional.endpoints.map(({ endpoint }) => endpoint.normalizedPath)
    ).toStrictEqual(["/events", "/events/{param}"])

    const otherFile = {
      ...response.files[0]!,
      path: "backend/routes/other.php",
      contentHash: contentHashSchema.parse(`sha256:${"9".repeat(64)}`),
      routes: [response.files[0]!.routes[1]!],
    }
    const reboundResponse = phpIndexerResponseSchema.parse({
      ...response,
      files: [
        { ...response.files[0]!, routes: [response.files[0]!.routes[0]!] },
        otherFile,
      ],
      summary: { ...response.summary, fileCount: 2 },
    })
    expect(() =>
      endpointsFromLaravelRoute({
        response: reboundResponse,
        file: reboundResponse.files[0]!,
        route: reboundResponse.files[1]!.routes[0]!,
      })
    ).toThrow("Laravel route is not indexed by the supplied response")
  })
})

describe("runtime endpoint matching", () => {
  const runtime = (method: string, url: string) => ({
    applicationId,
    method,
    url,
    sourceHash,
    observedAt,
  })

  it("prefers a static route over an overlapping dynamic route", () => {
    const dynamic = evidence("openapi", "GET", "/users/{id}")
    const exact = evidence("laravel", "GET", "/users/me")

    expect(
      matchRuntimeRequest(runtime("GET", "https://api.example.test/users/me"), [
        dynamic,
        exact,
      ])
    ).toMatchObject({
      kind: "exact",
      endpoint: { id: exact.endpoint.id, normalizedPath: "/users/me" },
    })
  })

  it("keeps disjoint embedded templates as path conflicts", () => {
    expect(
      compareEndpointEvidence(
        evidence("openapi", "GET", "/reports/{format}.json"),
        evidence("laravel", "GET", "/reports/{extension}.xml")
      )
    ).toMatchObject({ kind: "conflict", reason: "path_mismatch" })
  })

  it("returns tied patterns as ambiguous candidates", () => {
    const left = evidence("openapi", "GET", "/stores/{id}/orders/current")
    const right = evidence("laravel", "GET", "/stores/current/orders/{id}")

    expect(
      matchRuntimeRequest(runtime("GET", "/stores/current/orders/current"), [
        left,
        right,
      ])
    ).toMatchObject({
      kind: "candidate",
      reason: "ambiguous_path",
      candidateEndpointIds: [left.endpoint.id, right.endpoint.id].sort(),
    })
  })

  it("does not break a dynamic-position tie by literal character count", () => {
    const trailingDynamic = evidence("openapi", "GET", "/long-static-name/{id}")
    const leadingDynamic = evidence("laravel", "GET", "/{id}/x")

    expect(
      matchRuntimeRequest(runtime("GET", "/long-static-name/x"), [
        trailingDynamic,
        leadingDynamic,
      ])
    ).toMatchObject({
      kind: "candidate",
      reason: "ambiguous_path",
    })
  })

  it("returns method disagreement as a conflict", () => {
    const post = evidence("openapi", "POST", "/orders/{id}")
    expect(
      matchRuntimeRequest(runtime("DELETE", "/orders/42"), [post])
    ).toMatchObject({
      kind: "conflict",
      reason: "method_mismatch",
      evidence: [post],
    })
  })

  it("matches embedded source placeholders to a concrete runtime segment", () => {
    const report = evidence("openapi", "GET", "/reports/{format}.json")
    expect(
      matchRuntimeRequest(runtime("GET", "/reports/monthly.json"), [report])
    ).toMatchObject({
      kind: "exact",
      endpoint: { id: report.endpoint.id },
    })
  })

  it("matches adjacent placeholders without regex backtracking", () => {
    const adjacent = evidence(
      "openapi",
      "GET",
      "/segments/{first}{second}{third}{fourth}{fifth}y"
    )
    const result = matchRuntimeRequest(
      runtime("GET", `/segments/${"a".repeat(2_000)}z`),
      [adjacent]
    )

    expect(result).toMatchObject({
      kind: "unmatched",
      reason: "unmatched_runtime_path",
    })
  })

  it("bounds work for large adjacent-placeholder catalogs", () => {
    const placeholders = "{param}".repeat(250)
    const catalog = Array.from({ length: 200 }, (_, index) =>
      evidence("openapi", "GET", `/segments/${placeholders}y${index}`)
    )
    const startedAt = performance.now()

    expect(
      matchRuntimeRequest(
        runtime("GET", `/segments/${"a".repeat(1_800)}z`),
        catalog
      )
    ).toMatchObject({
      kind: "unmatched",
      reason: "unmatched_runtime_path",
    })
    expect(performance.now() - startedAt).toBeLessThan(500)

    const repeatedLiteralCatalog = Array.from({ length: 200 }, (_, index) =>
      evidence("openapi", "GET", `/segments/{param}${"a".repeat(900)}b${index}`)
    )
    const repeatedLiteralStartedAt = performance.now()
    expect(
      matchRuntimeRequest(
        runtime("GET", `/segments/${"a".repeat(1_900)}c`),
        repeatedLiteralCatalog
      )
    ).toMatchObject({
      kind: "unmatched",
      reason: "unmatched_runtime_path",
    })
    expect(performance.now() - repeatedLiteralStartedAt).toBeLessThan(500)
  })
})
