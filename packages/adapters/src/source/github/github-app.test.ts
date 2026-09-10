import {
  createPrivateKey,
  createVerify,
  generateKeyPairSync,
} from "node:crypto"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  GITHUB_CHECK_NAME,
  GithubAppClient,
  GithubAppError,
  createGithubAppJwt,
  loadGithubAppConfiguration,
  mapGithubCheckLifecycle,
  parseGithubWebhook,
  verifyGithubWebhookSignature,
  type GithubAppConfiguration,
  type GithubRequesterFactory,
} from "./github-app.ts"

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../tests/fixtures/github/pull-request-events.json",
      import.meta.url
    ),
    "utf8"
  )
) as Record<string, unknown>

const now = Date.parse("2026-09-08T12:00:00.000Z")
const assessmentId = "11111111-1111-4111-8111-111111111111"
const syncLeaseToken = "22222222-2222-4222-8222-222222222222"
const repository = { host: "github.com", owner: "owner", name: "repo" }
const generated = generateKeyPairSync("rsa", { modulusLength: 2048 })
const privateKey = createPrivateKey(
  generated.privateKey.export({ type: "pkcs8", format: "pem" })
)
const configuration: GithubAppConfiguration = {
  appId: "123",
  clientId: "Iv1.abcdef1234567890".replace(".", "_"),
  defaultInstallationId: "1234",
  privateKey,
  webhookSecret: "a-high-entropy-webhook-secret-value",
  publicBaseUrl: "https://sentinel.example/",
}
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  )
})

function payload(name: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(fixtures[name]))
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    assessmentId,
    installationId: "1234",
    repository,
    pullRequestNumber: 7,
    headSha: "b".repeat(40),
    isCurrent: true,
    checkRunId: null,
    syncLeaseToken,
    recovering: false,
    ...overrides,
  }
}

function requesterHarness(options: {
  readonly checks?: readonly unknown[]
  readonly createdId?: string | number
  readonly token?: string
}) {
  const calls: {
    auth: string
    route: string
    parameters: Record<string, unknown>
  }[] = []
  let tokenRequests = 0
  const factory: GithubRequesterFactory = (auth) => ({
    request: vi.fn(async (route, parameters) => {
      calls.push({ auth, route, parameters })
      if (route.includes("access_tokens")) {
        tokenRequests += 1
        return {
          data: {
            token: options.token ?? "ghs_abcdefghijklmnopqrstuvwxyz123456",
            expires_at: new Date(now + 60 * 60_000).toISOString(),
          },
        }
      }
      if (route.includes("/commits/{ref}/check-runs")) {
        return { data: { check_runs: options.checks ?? [] } }
      }
      if (route.startsWith("POST /repos") && route.endsWith("/check-runs")) {
        return { data: { id: options.createdId ?? 777 } }
      }
      if (route.startsWith("PATCH /repos")) return { data: { id: 777 } }
      if (route.endsWith("/pulls/{pull_number}")) {
        return {
          data: {
            id: 9012,
            number: 7,
            html_url: "https://github.com/owner/repo/pull/7",
            title: "Improve checkout attribution",
            state: "open",
            draft: false,
            updated_at: "2026-09-08T12:00:00Z",
            base: {
              sha: "a".repeat(40),
              repo: { id: 5678, full_name: "Owner/Repo" },
            },
            head: { sha: "b".repeat(40) },
          },
        }
      }
      throw new Error(`Unexpected route ${route}`)
    }),
  })
  return {
    calls,
    factory,
    get tokenRequests() {
      return tokenRequests
    },
  }
}

describe("GitHub webhook authentication", () => {
  it("matches GitHub's published HMAC vector without throwing on bad lengths", () => {
    const body = new TextEncoder().encode("Hello, World!")
    const secret = "It's a Secret to Everybody"
    expect(
      verifyGithubWebhookSignature(
        body,
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
        secret
      )
    ).toBe(true)
    expect(verifyGithubWebhookSignature(body, null, secret)).toBe(false)
    expect(verifyGithubWebhookSignature(body, "sha256=12", secret)).toBe(false)
    expect(
      verifyGithubWebhookSignature(
        new TextEncoder().encode("Hello, World?"),
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
        secret
      )
    ).toBe(false)
  })

  it.each(["opened", "reopened", "synchronize", "ready_for_review"])(
    "normalizes the recorded %s action fixture",
    (name) => {
      const decision = parseGithubWebhook(payload(name), {
        deliveryId: `delivery-${name}`,
        event: "pull_request",
      })
      expect(decision).toMatchObject({
        kind: "enqueue",
        trigger: {
          action: name,
          installationId: "1234",
          repository: { owner: "owner", name: "repo" },
          pullRequestNumber: 7,
        },
      })
    }
  )

  it("ignores drafts, unsupported actions, and unsupported events", () => {
    expect(
      parseGithubWebhook(payload("draft_opened"), {
        deliveryId: "delivery-draft",
        event: "pull_request",
      })
    ).toMatchObject({ kind: "ignored", reason: "draft_pull_request" })
    expect(
      parseGithubWebhook(payload("closed"), {
        deliveryId: "delivery-closed",
        event: "pull_request",
      })
    ).toMatchObject({ kind: "ignored", reason: "unsupported_action" })
    expect(
      parseGithubWebhook(payload("opened"), {
        deliveryId: "delivery-push",
        event: "push",
      })
    ).toMatchObject({ kind: "ignored", reason: "unsupported_event" })
  })

  it("rejects inconsistent repository and PR identities", () => {
    const malformed = structuredClone(fixtures["opened"]) as {
      repository: { id: number }
    }
    malformed.repository.id = 9999
    expect(() =>
      parseGithubWebhook(new TextEncoder().encode(JSON.stringify(malformed)), {
        deliveryId: "delivery-mismatch",
        event: "pull_request",
      })
    ).toThrowError(
      expect.objectContaining<Partial<GithubAppError>>({
        code: "payload_invalid",
      })
    )
  })
})

describe("GitHub App credentials", () => {
  it("loads a regular RSA key and rejects incomplete configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sentinel-github-app-"))
    temporaryDirectories.push(directory)
    const privateKeyPath = join(directory, "app.pem")
    await writeFile(
      privateKeyPath,
      generated.privateKey.export({ type: "pkcs8", format: "pem" })
    )
    if (process.platform !== "win32") await chmod(privateKeyPath, 0o600)
    const loaded = await loadGithubAppConfiguration({
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: configuration.clientId,
      GITHUB_APP_INSTALLATION_ID: "1234",
      GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
      GITHUB_APP_WEBHOOK_SECRET: configuration.webhookSecret,
      SENTINEL_PUBLIC_BASE_URL: configuration.publicBaseUrl,
    })
    expect(loaded.privateKey.asymmetricKeyType).toBe("rsa")
    await expect(
      loadGithubAppConfiguration({
        GITHUB_APP_ID: "123",
        GITHUB_APP_CLIENT_ID: configuration.clientId,
        GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
        GITHUB_APP_WEBHOOK_SECRET: configuration.webhookSecret,
        SENTINEL_PUBLIC_BASE_URL: "http://sentinel.example",
      })
    ).rejects.toMatchObject({ code: "configuration_invalid" })
    await expect(
      loadGithubAppConfiguration({
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
      })
    ).rejects.toMatchObject({ code: "configuration_invalid" })
  })

  it("creates a verifiable RS256 JWT with bounded GitHub claims", () => {
    const jwt = createGithubAppJwt(configuration, now)
    const [headerPart, payloadPart, signaturePart] = jwt.split(".")
    const header = JSON.parse(
      Buffer.from(headerPart!, "base64url").toString("utf8")
    ) as Record<string, unknown>
    const claims = JSON.parse(
      Buffer.from(payloadPart!, "base64url").toString("utf8")
    ) as Record<string, unknown>
    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${headerPart}.${payloadPart}`)
    verifier.end()
    expect(header).toEqual({ alg: "RS256", typ: "JWT" })
    expect(claims).toEqual({
      iat: Math.floor(now / 1_000) - 60,
      exp: Math.floor(now / 1_000) + 540,
      iss: configuration.clientId,
    })
    expect(
      verifier.verify(
        generated.publicKey,
        Buffer.from(signaturePart!, "base64url")
      )
    ).toBe(true)
  })

  it("coalesces token refresh and restricts repository permissions", async () => {
    const harness = requesterHarness({})
    const client = new GithubAppClient(configuration, {
      requesterFactory: harness.factory,
      now: () => now,
    })
    const tokens = await Promise.all([
      client.getInstallationToken("1234", repository),
      client.getInstallationToken("1234", repository),
      client.getInstallationToken("1234", repository),
    ])
    expect(new Set(tokens).size).toBe(1)
    expect(harness.tokenRequests).toBe(1)
    expect(harness.calls[0]).toMatchObject({
      route: "POST /app/installations/{installation_id}/access_tokens",
      parameters: {
        installation_id: "1234",
        repositories: ["repo"],
        permissions: {
          contents: "read",
          pull_requests: "read",
          checks: "write",
        },
      },
    })
  })

  it("refreshes tokens inside the expiry margin", async () => {
    let clock = now
    let sequence = 0
    const factory: GithubRequesterFactory = () => ({
      request: vi.fn(async () => ({
        data: {
          token: `ghs_abcdefghijklmnopqrstuvwxyz${String(++sequence).padStart(6, "0")}`,
          expires_at: new Date(clock + 60 * 60_000).toISOString(),
        },
      })),
    })
    const client = new GithubAppClient(configuration, {
      requesterFactory: factory,
      now: () => clock,
    })
    const first = await client.getInstallationToken("1234", repository)
    clock += 59 * 60_000
    const second = await client.getInstallationToken("1234", repository)
    expect(first).not.toBe(second)
    expect(sequence).toBe(2)
  })
})

describe("GitHub pull request and check API", () => {
  it("resolves current immutable PR metadata through an installation token", async () => {
    const harness = requesterHarness({})
    const client = new GithubAppClient(configuration, {
      requesterFactory: harness.factory,
      now: () => now,
    })
    await expect(
      client.resolvePullRequest({
        installationId: "1234",
        pullRequestUrl: "https://github.com/owner/repo/pull/7",
        expectedRepository: repository,
      })
    ).resolves.toMatchObject({
      repositoryId: "5678",
      pullRequestId: "9012",
      title: "Improve checkout attribution",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      state: "open",
      draft: false,
    })
  })

  it("creates a queued check bound to assessment external_id and details URL", async () => {
    const harness = requesterHarness({ createdId: 777 })
    const client = new GithubAppClient(configuration, {
      requesterFactory: harness.factory,
      now: () => now,
    })
    await expect(client.ensureQueuedCheck(target())).resolves.toBe("777")
    expect(harness.calls.at(-1)).toMatchObject({
      route: "POST /repos/{owner}/{repo}/check-runs",
      parameters: {
        name: GITHUB_CHECK_NAME,
        head_sha: "b".repeat(40),
        external_id: assessmentId,
        details_url: `https://sentinel.example/assessments/${assessmentId}`,
        status: "queued",
      },
    })
  })

  it("recovers an existing check by external_id without creating another", async () => {
    const harness = requesterHarness({
      checks: [
        {
          id: 888,
          external_id: assessmentId,
          head_sha: "b".repeat(40),
          name: GITHUB_CHECK_NAME,
        },
      ],
    })
    const client = new GithubAppClient(configuration, {
      requesterFactory: harness.factory,
      now: () => now,
    })
    await expect(
      client.ensureQueuedCheck(target({ recovering: true }))
    ).resolves.toBe("888")
    expect(
      harness.calls.some(
        ({ route }) => route === "POST /repos/{owner}/{repo}/check-runs"
      )
    ).toBe(false)
  })

  it.each([
    ["analysis_succeeded", "success"],
    ["predicted_risk", "neutral"],
    ["unknown_scope", "neutral"],
    ["verification_unavailable", "neutral"],
    ["verification_failed", "failure"],
    ["action_required", "action_required"],
    ["infrastructure_failed", "failure"],
  ] as const)("maps %s to %s", (outcome, conclusion) => {
    expect(
      mapGithubCheckLifecycle({
        state: "completed",
        outcome,
        title: "Sentinel assessment complete",
        summary: "Review the assessment details.",
        completedAt: "2026-09-08T12:05:00Z",
      })
    ).toMatchObject({ status: "completed", conclusion })
  })

  it("refuses stale check updates before contacting GitHub", async () => {
    const harness = requesterHarness({})
    const client = new GithubAppClient(configuration, {
      requesterFactory: harness.factory,
      now: () => now,
    })
    await expect(
      client.updateCheck(target({ checkRunId: "777", isCurrent: false }), {
        schemaVersion: 1,
        assessmentId,
        headSha: "b".repeat(40),
        detailsUrl: `https://sentinel.example/assessments/${assessmentId}`,
        lifecycle: { state: "queued" },
      })
    ).rejects.toMatchObject({ code: "stale_check" })
    expect(harness.calls).toHaveLength(0)
  })

  it("redacts installation tokens from provider errors", async () => {
    const token = "ghs_abcdefghijklmnopqrstuvwxyz123456"
    const factory: GithubRequesterFactory = (auth) => ({
      request: vi.fn(async (route) => {
        if (route.includes("access_tokens")) {
          return {
            data: {
              token,
              expires_at: new Date(now + 60 * 60_000).toISOString(),
            },
          }
        }
        throw new Error(`provider rejected ${auth}`)
      }),
    })
    const client = new GithubAppClient(configuration, {
      requesterFactory: factory,
      now: () => now,
    })
    const error = await client
      .resolvePullRequest({
        installationId: "1234",
        pullRequestUrl: "https://github.com/owner/repo/pull/7",
      })
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(GithubAppError)
    expect((error as GithubAppError).message).not.toContain(token)
  })
})
