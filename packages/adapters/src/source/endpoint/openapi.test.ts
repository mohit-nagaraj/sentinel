import {
  applicationIdSchema,
  commitShaSchema,
  parseCodeFactEnvelope,
} from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

import {
  importOpenApiDocument,
  OPENAPI_IMPORTER_VERSION,
  OpenApiImportError,
} from "./openapi.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"1".repeat(64)}`
)
const commitSha = commitShaSchema.parse("2".repeat(40))
const openApiOrderFixture = `openapi: 3.1.0
info: { title: Orders, version: 1.0.0 }
servers: [{ url: https://api.example.test/api/v1 }]
paths:
  /events/{event_id}/orders:
    post:
      operationId: createOrder
      tags: [Orders, Public]
      requestBody: { $ref: '#/components/requestBodies/CreateOrder' }
      responses:
        '201': { $ref: '#/components/responses/OrderCreated' }
components:
  requestBodies:
    CreateOrder:
      content:
        application/json:
          schema: { $ref: '#/components/schemas/CreateOrderRequest' }
  responses:
    OrderCreated:
      description: Created
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Order' }
  schemas:
    CreateOrderRequest: { type: object }
    Order: { type: object }
`

function importFixture(document: string | Readonly<Record<string, unknown>>) {
  return importOpenApiDocument({
    applicationId,
    sourceUri: "https://api.example.test/openapi.yaml",
    commitSha,
    document,
    stripPrefixes: ["/api/v1"],
  })
}

describe("OpenAPI importer", () => {
  it("imports local refs and preserves operation metadata", () => {
    const result = importFixture(openApiOrderFixture)

    expect(result.importerVersion).toBe(OPENAPI_IMPORTER_VERSION)
    expect(result.openApiVersion).toBe("3.1.0")
    expect(result.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.endpoints).toHaveLength(1)
    expect(result.endpoints[0]).toMatchObject({
      endpoint: {
        method: "POST",
        normalizedPath: "/events/{param}/orders",
      },
      sourceKind: "openapi",
      provenance: {
        extractor: {
          name: "openapi_importer",
          version: OPENAPI_IMPORTER_VERSION,
        },
        sourceHash: result.sourceHash,
        sourceUri: "https://api.example.test/openapi.yaml",
        commitSha,
      },
      operation: {
        operationId: "createOrder",
        tags: ["Orders", "Public"],
        requestSchemaRefs: ["#/components/schemas/CreateOrderRequest"],
        responseSchemaRefs: ["#/components/schemas/Order"],
      },
    })
    expect(parseCodeFactEnvelope(result.facts[0])).toMatchObject({
      factKind: "api_endpoint",
      fact: {
        operationId: "createOrder",
        tags: ["Orders", "Public"],
      },
    })
  })

  it("is deterministic for object input", () => {
    const document = {
      openapi: "3.0.3",
      info: { title: "Health", version: "1" },
      paths: {
        "/health": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    }
    expect(importFixture(document)).toStrictEqual(importFixture(document))
  })

  it.each([
    ["malformed YAML", "openapi: [", "invalid_document"],
    [
      "unsupported version",
      '{"openapi":"2.0","info":{},"paths":{}}',
      "unsupported_openapi_version",
    ],
    ["missing paths", '{"openapi":"3.1.0","info":{}}', "invalid_document"],
    [
      "missing responses",
      '{"openapi":"3.1.0","info":{},"paths":{"/x":{"get":{}}}}',
      "invalid_document",
    ],
  ])("rejects %s", (_name, document, code) => {
    expect(() => importFixture(document)).toThrowError(
      expect.objectContaining({ code })
    )
  })

  it("rejects duplicate YAML keys and alias expansion", () => {
    expect(() =>
      importFixture("openapi: 3.1.0\ninfo: {}\npaths: {}\npaths: {}\n")
    ).toThrow(OpenApiImportError)
    expect(() =>
      importOpenApiDocument({
        applicationId,
        sourceUri: "https://api.example.test/openapi.yaml",
        document:
          "openapi: 3.1.0\ninfo: &info {title: x, version: '1'}\npaths: {}\nx: *info\n",
        limits: { maxYamlAliases: 0 },
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_document" }))
  })

  it.each([
    "https://attacker.example/schema.yaml#/Thing",
    "file:///etc/passwd",
    "./schema.yaml#/Thing",
  ])("denies an external ref without performing I/O", (reference) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const document = JSON.stringify({
      openapi: "3.1.0",
      info: {},
      paths: {},
      components: { schemas: { Thing: { $ref: reference } } },
    })

    expect(() => importFixture(document)).toThrowError(
      expect.objectContaining({ code: "external_reference_denied" })
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it("enforces byte, operation, and local-ref depth limits", () => {
    expect(() =>
      importOpenApiDocument({
        applicationId,
        sourceUri: "https://api.example.test/openapi.json",
        document: JSON.stringify({ openapi: "3.1.0", info: {}, paths: {} }),
        limits: { maxBytes: 8 },
      })
    ).toThrowError(expect.objectContaining({ code: "byte_limit_exceeded" }))

    expect(() =>
      importOpenApiDocument({
        applicationId,
        sourceUri: "https://api.example.test/openapi.json",
        document: {
          openapi: "3.1.0",
          info: {},
          paths: {
            "/one": { get: { responses: { "200": { description: "ok" } } } },
            "/two": { get: { responses: { "200": { description: "ok" } } } },
          },
        },
        limits: { maxOperations: 1 },
      })
    ).toThrowError(
      expect.objectContaining({ code: "operation_limit_exceeded" })
    )

    expect(() =>
      importOpenApiDocument({
        applicationId,
        sourceUri: "https://api.example.test/openapi.json",
        document: {
          openapi: "3.1.0",
          info: {},
          paths: { "/x": { $ref: "#/components/pathItems/First" } },
          components: {
            pathItems: {
              First: { $ref: "#/components/pathItems/Second" },
              Second: {
                get: { responses: { "200": { description: "ok" } } },
              },
            },
          },
        },
        limits: { maxReferenceDepth: 1 },
      })
    ).toThrowError(
      expect.objectContaining({ code: "reference_limit_exceeded" })
    )
  })

  it("does not include denied reference values in errors", () => {
    const secret = "secret-token-value"
    let error: unknown
    try {
      importFixture(
        JSON.stringify({
          openapi: "3.1.0",
          info: {},
          paths: {},
          components: {
            schemas: {
              Unsafe: { $ref: `https://example.test/${secret}` },
            },
          },
        })
      )
    } catch (caught) {
      error = caught
    }
    expect(String(error)).not.toContain(secret)
  })
})
