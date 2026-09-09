// @vitest-environment node

import { GithubAppError } from "@sentinel/adapters/github-app"
import { GithubAssessmentRepositoryError } from "@sentinel/storage"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { GithubAssessmentService } from "@/lib/github-assessments"

import { POST, handleGithubRequest } from "./route"

const token = "operator-control-token-that-is-long-enough"
const operatorId = "11111111-1111-4111-8111-111111111111"
const applicationId = "22222222-2222-4222-8222-222222222222"
const assessmentId = "33333333-3333-4333-8333-333333333333"
const runId = "44444444-4444-4444-8444-444444444444"
const headSha = "b".repeat(40)
const environment = {
  SENTINEL_OPERATOR_ID: operatorId,
  SENTINEL_OPERATOR_TOKEN: token,
}
const accepted = {
  schemaVersion: 1 as const,
  status: "accepted" as const,
  assessmentId,
  runId,
  headSha,
  duplicate: false,
  check: "queued" as const,
}

afterEach(() => vi.unstubAllEnvs())

function service(
  overrides: Partial<
    Pick<GithubAssessmentService, "receiveWebhook" | "submitManual">
  > = {}
) {
  return {
    receiveWebhook: vi.fn().mockResolvedValue(accepted),
    submitManual: vi.fn().mockResolvedValue(accepted),
    ...overrides,
  }
}

function webhookRequest(
  body: string,
  headers: Record<string, string> = {}
): Request {
  return new Request("http://sentinel.test/api/github/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      ...headers,
    },
    body,
  })
}

function manualRequest(
  body: unknown,
  authorization = `Bearer ${token}`,
  headers: Record<string, string> = {}
): Request {
  return new Request("http://sentinel.test/api/github/assessments", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

describe("GitHub assessment route", () => {
  it("passes the exact unparsed webhook bytes and authentication headers", async () => {
    const target = service()
    const raw = ' {\n  "action": "opened"\n} '
    const result = await handleGithubRequest(
      webhookRequest(raw),
      ["webhooks"],
      target,
      environment
    )
    expect(result.status).toBe(202)
    expect(result.headers.get("cache-control")).toContain("no-store")
    expect(result.headers.get("x-content-type-options")).toBe("nosniff")
    const call = vi.mocked(target.receiveWebhook).mock.calls[0]?.[0]
    expect(new TextDecoder().decode(call?.body)).toBe(raw)
    expect(call).toMatchObject({
      deliveryId: "delivery-1",
      event: "pull_request",
      signature: `sha256=${"0".repeat(64)}`,
    })
  })

  it("rejects oversized webhook bodies before service side effects", async () => {
    const target = service()
    const result = await handleGithubRequest(
      webhookRequest("{}", { "content-length": String(2 * 1_024 * 1_024 + 1) }),
      ["webhooks"],
      target,
      environment
    )
    expect(result.status).toBe(413)
    expect(target.receiveWebhook).not.toHaveBeenCalled()
  })

  it("independently authenticates manual assessment mutations", async () => {
    const target = service()
    const result = await handleGithubRequest(
      manualRequest(
        {
          schemaVersion: 1,
          applicationId,
          pullRequestUrl: "https://github.com/owner/repo/pull/7",
        },
        "Bearer wrong"
      ),
      ["assessments"],
      target,
      environment
    )
    expect(result.status).toBe(401)
    expect(result.headers.get("www-authenticate")).toContain("Basic")
    expect(target.submitManual).not.toHaveBeenCalled()
  })

  it("authorizes the exported manual handler before storage construction", async () => {
    vi.stubEnv("SENTINEL_OPERATOR_TOKEN", token)
    vi.stubEnv("SENTINEL_OPERATOR_ID", "")
    vi.stubEnv("SUPABASE_DB_URL", "")
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY_PATH", "")
    const result = await POST(manualRequest({}, "Bearer wrong"), {
      params: Promise.resolve({ path: ["assessments"] }),
    })
    expect(result.status).toBe(401)
  })

  it("rejects cross-origin and non-JSON manual requests", async () => {
    const target = service()
    const crossOrigin = await handleGithubRequest(
      manualRequest({}, `Bearer ${token}`, {
        origin: "https://attacker.example",
      }),
      ["assessments"],
      target,
      environment
    )
    expect(crossOrigin.status).toBe(403)

    const nonJson = new Request("http://sentinel.test/api/github/assessments", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "not-json",
    })
    const wrongType = await handleGithubRequest(
      nonJson,
      ["assessments"],
      target,
      environment
    )
    expect(wrongType.status).toBe(415)
    expect(target.submitManual).not.toHaveBeenCalled()
  })

  it("fails closed when the server-derived operator identity is unavailable", async () => {
    const target = service()
    const result = await handleGithubRequest(
      manualRequest({}),
      ["assessments"],
      target,
      { SENTINEL_OPERATOR_TOKEN: token }
    )
    expect(result.status).toBe(503)
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "operator_identity_unavailable" },
    })
    expect(target.submitManual).not.toHaveBeenCalled()
  })

  it("submits manual PR URLs with the server-derived operator identity", async () => {
    const target = service()
    const body = {
      schemaVersion: 1,
      applicationId,
      pullRequestUrl: "https://github.com/owner/repo/pull/7",
    }
    const result = await handleGithubRequest(
      manualRequest(body),
      ["assessments"],
      target,
      environment
    )
    expect(result.status).toBe(202)
    expect(target.submitManual).toHaveBeenCalledWith(operatorId, body)
  })

  it("returns 200 for idempotent duplicate delivery replay", async () => {
    const target = service({
      receiveWebhook: vi
        .fn()
        .mockResolvedValue({ ...accepted, duplicate: true }),
    })
    const result = await handleGithubRequest(
      webhookRequest("{}"),
      ["webhooks"],
      target,
      environment
    )
    expect(result.status).toBe(200)
  })

  it("maps signature, storage, and provider failures without private details", async () => {
    const failures = [
      [
        new GithubAppError(
          "signature_invalid",
          "signature contained private-data"
        ),
        401,
        "invalid_webhook_signature",
      ],
      [
        new GithubAssessmentRepositoryError("storage_unavailable", {
          cause: new Error("password=private-data"),
        }),
        503,
        "storage_unavailable",
      ],
      [
        new GithubAppError("provider_unavailable", "token=private-data", {
          retryable: true,
        }),
        503,
        "github_provider_unavailable",
      ],
    ] as const
    for (const [error, status, code] of failures) {
      const result = await handleGithubRequest(
        webhookRequest("{}"),
        ["webhooks"],
        service({ receiveWebhook: vi.fn().mockRejectedValue(error) }),
        environment
      )
      expect(result.status).toBe(status)
      const serialized = JSON.stringify(await result.json())
      expect(serialized).toContain(code)
      expect(serialized).not.toContain("private-data")
    }
  })

  it("returns a stable not-found response for unknown paths", async () => {
    const result = await handleGithubRequest(
      webhookRequest("{}"),
      ["unknown"],
      service(),
      environment
    )
    expect(result.status).toBe(404)
    await expect(result.json()).resolves.toMatchObject({
      error: { code: "route_not_found" },
    })
  })
})
