import { applicationIdSchema, contentHashSchema } from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { matchRuntimeRequest, sanitizedRuntimeRequestHash } from "./matching.ts"
import { createEndpointTemplate } from "./normalize.ts"
import { endpointEvidenceSchema } from "./schema.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"8".repeat(64)}`
)
const sourceHash = contentHashSchema.parse(`sha256:${"9".repeat(64)}`)
const observedAt = "2026-09-07T08:30:00.000Z"
const endpoint = endpointEvidenceSchema.parse({
  sourceKind: "openapi",
  endpoint: createEndpointTemplate({
    applicationId,
    method: "POST",
    path: "/events/{event}/orders",
  }),
  provenance: {
    sourceKind: "openapi",
    extractor: { name: "openapi_fixture", version: "1.0.0" },
    sourceHash,
  },
})

describe("runtime request redaction", () => {
  it("matches without returning query, header, body, or concrete path values", () => {
    const secrets = [
      "personal-event-123",
      "query-secret",
      "person@example.test",
      "bearer-secret",
      "cookie-secret",
      "body-password",
    ]
    const result = matchRuntimeRequest(
      {
        applicationId,
        method: "POST",
        url: `https://api.example.test/events/${secrets[0]}/orders?token=${secrets[1]}&email=${secrets[2]}`,
        headers: {
          authorization: `Bearer ${secrets[3]}`,
          cookie: `session=${secrets[4]}`,
        },
        body: { password: secrets[5], email: secrets[2] },
        sourceHash,
        observedAt,
      },
      [endpoint]
    )

    expect(result).toMatchObject({
      kind: "exact",
      endpoint: { normalizedPath: "/events/{param}/orders" },
      redaction: {
        queryParameterCount: 2,
        headerCount: 2,
        bodyPresent: true,
      },
    })
    const serialized = JSON.stringify(result)
    for (const secret of secrets) expect(serialized).not.toContain(secret)
  })

  it("does not expose an unmatched concrete runtime path", () => {
    const secret = "reset-token-personal-value"
    const result = matchRuntimeRequest(
      {
        applicationId,
        method: "GET",
        url: `/password/reset/${secret}`,
        sourceHash,
        observedAt,
      },
      [endpoint]
    )

    expect(result).toMatchObject({
      kind: "unmatched",
      reason: "unmatched_runtime_path",
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain("password/reset")
  })

  it("hashes only redaction shape, not sensitive values", () => {
    const first = sanitizedRuntimeRequestHash({
      method: "POST",
      url: "/orders?token=first-secret",
      headers: { authorization: "Bearer first" },
      body: { password: "first" },
    })
    const second = sanitizedRuntimeRequestHash({
      method: "POST",
      url: "/different?email=second@example.test",
      headers: { cookie: "second" },
      body: { privateKey: "second" },
    })

    expect(first).toBe(second)
  })
})
