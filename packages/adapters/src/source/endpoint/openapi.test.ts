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
        openApiVersion: "3.1.0",
        tags: ["Orders", "Public"],
        requestSchemaRefs: ["#/components/schemas/CreateOrderRequest"],
        responseSchemaRefs: ["#/components/schemas/Order"],
      },
    })
    expect(parseCodeFactEnvelope(result.facts[0])).toMatchObject({
      factKind: "api_endpoint",
      fact: {
        operationId: "createOrder",
        openApiVersion: "3.1.0",
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

  it("rejects object accessors without invoking them", () => {
    let reads = 0
    const info: Record<string, unknown> = { version: "1" }
    Object.defineProperty(info, "title", {
      enumerable: true,
      get: () => {
        reads += 1
        return "unsafe"
      },
    })

    expect(() =>
      importFixture({ openapi: "3.1.0", info, paths: {} })
    ).toThrowError(expect.objectContaining({ code: "invalid_document" }))
    expect(reads).toBe(0)
  })

  it("rejects hidden array accessors without invoking them or leaking errors", () => {
    const secret = "secret-accessor-message"
    let reads = 0
    const tags = ["safe"]
    Object.defineProperty(tags, "map", {
      get: () => {
        reads += 1
        throw new Error(secret)
      },
    })

    let error: unknown
    try {
      importFixture({
        openapi: "3.1.0",
        info: { title: "Accessors", version: "1" },
        paths: {
          "/accessors": {
            get: {
              tags,
              responses: { "200": { description: "ok" } },
            },
          },
        },
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toEqual(expect.objectContaining({ code: "invalid_document" }))
    expect(String(error)).not.toContain(secret)
    expect(reads).toBe(0)
  })

  it("rejects inherited array accessors without invoking them", () => {
    let reads = 0
    const tags = ["safe"]
    Object.setPrototypeOf(tags, {
      get map() {
        reads += 1
        return Array.prototype.map
      },
    })

    expect(() =>
      importFixture({
        openapi: "3.1.0",
        info: { title: "Accessors", version: "1" },
        paths: {
          "/accessors": {
            get: {
              tags,
              responses: { "200": { description: "ok" } },
            },
          },
        },
      })
    ).toThrowError(expect.objectContaining({ code: "invalid_document" }))
    expect(reads).toBe(0)
  })

  it("redacts reflective errors from hostile object inputs", () => {
    const secret = "secret-proxy-message"
    const document = new Proxy(
      {},
      {
        getPrototypeOf: () => Object.prototype,
        ownKeys: () => {
          throw new Error(secret)
        },
      }
    )

    let error: unknown
    try {
      importFixture(document)
    } catch (caught) {
      error = caught
    }

    expect(error).toEqual(expect.objectContaining({ code: "invalid_document" }))
    expect(String(error)).not.toContain(secret)
  })

  it("rejects live proxies before later property access", () => {
    const secret = "late-proxy-message"
    let reads = 0
    const document = new Proxy(
      { openapi: "3.1.0", info: {}, paths: {} },
      {
        get: (target, property, receiver) => {
          if (property === "openapi") {
            reads += 1
            throw new Error(secret)
          }
          return Reflect.get(target, property, receiver)
        },
      }
    )

    let error: unknown
    try {
      importFixture(document)
    } catch (caught) {
      error = caught
    }

    expect(error).toEqual(expect.objectContaining({ code: "invalid_document" }))
    expect(String(error)).not.toContain(secret)
    expect(reads).toBe(0)
  })

  it("enforces the byte limit while canonically hashing object input", () => {
    expect(() =>
      importOpenApiDocument({
        applicationId,
        sourceUri: "repository://openapi.json",
        document: {
          openapi: "3.1.0",
          info: { title: "a".repeat(1_000), version: "1" },
          paths: {},
        },
        limits: { maxBytes: 100 },
      })
    ).toThrowError(expect.objectContaining({ code: "byte_limit_exceeded" }))
  })

  it("uses an explicit base path and accepts empty server arrays", () => {
    const result = importOpenApiDocument({
      applicationId,
      sourceUri: "repository://openapi.json",
      document: {
        openapi: "3.0.3",
        info: { title: "Health", version: "1" },
        servers: [],
        paths: {
          "/health": {
            get: { responses: { "200": { description: "ok" } } },
          },
        },
      },
      basePath: "//api/v2",
    })

    expect(result.endpoints[0]?.endpoint.normalizedPath).toBe("/v2/health")
  })

  it("preserves recursive and sibling OpenAPI 3.1 schema refs", () => {
    const result = importOpenApiDocument({
      applicationId,
      sourceUri: "repository://openapi.json",
      document: {
        openapi: "3.1.0",
        info: { title: "Tree", version: "1" },
        paths: {
          "/tree": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: {
                        $ref: "#/components/schemas/Node",
                        properties: {
                          leaf: { $ref: "#/components/schemas/Leaf" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Node: {
              type: "object",
              properties: {
                child: { $ref: "#/components/schemas/Node" },
              },
            },
            Leaf: { type: "string" },
          },
        },
      },
    })

    expect(result.endpoints[0]?.operation?.responseSchemaRefs).toStrictEqual([
      "#/components/schemas/Leaf",
      "#/components/schemas/Node",
    ])
  })

  it("redacts paths from unsupported-method warnings", () => {
    const secret = "personal-path-value"
    const result = importOpenApiDocument({
      applicationId,
      sourceUri: "repository://openapi.json",
      document: {
        openapi: "3.1.0",
        info: { title: "Trace", version: "1" },
        paths: {
          [`/${secret}`]: {
            trace: { responses: { "200": { description: "ok" } } },
          },
        },
      },
    })

    expect(result.warnings).toStrictEqual([
      { code: "unsupported_http_method", location: "paths[0].trace" },
    ])
    expect(JSON.stringify(result.warnings)).not.toContain(secret)
  })

  it("bounds metadata traversal across all operations", () => {
    const paths = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `/items/${index}`,
        {
          get: {
            responses: {
              "200": { $ref: "#/components/responses/Shared" },
            },
          },
        },
      ])
    )
    const properties = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `field${index}`,
        { type: "string" },
      ])
    )

    expect(() =>
      importOpenApiDocument({
        applicationId,
        sourceUri: "repository://openapi.json",
        document: {
          openapi: "3.1.0",
          info: { title: "Large", version: "1" },
          paths,
          components: {
            responses: {
              Shared: {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      $ref: "#/components/schemas/Shared",
                    },
                  },
                },
              },
            },
            schemas: { Shared: { type: "object", properties } },
          },
        },
        limits: { maxNodes: 1_000 },
      })
    ).toThrowError(
      expect.objectContaining({ code: "reference_limit_exceeded" })
    )
  })

  it("enforces reference depth independently of object key order", () => {
    const document = (order: readonly string[]) => ({
      openapi: "3.1.0",
      info: { title: "Depth", version: "1" },
      paths: {
        "/depth": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      properties: Object.fromEntries(
                        order.map((name) => [
                          name,
                          {
                            $ref:
                              name === "shortcut"
                                ? "#/components/schemas/C"
                                : "#/components/schemas/B",
                          },
                        ])
                      ),
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          B: { $ref: "#/components/schemas/C" },
          C: { $ref: "#/components/schemas/D" },
          D: { type: "string" },
        },
      },
    })

    for (const order of [
      ["shortcut", "long"],
      ["long", "shortcut"],
    ]) {
      expect(() =>
        importOpenApiDocument({
          applicationId,
          sourceUri: "repository://openapi.json",
          document: document(order),
          limits: { maxReferenceDepth: 2 },
        })
      ).toThrowError(
        expect.objectContaining({ code: "reference_limit_exceeded" })
      )
    }
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
