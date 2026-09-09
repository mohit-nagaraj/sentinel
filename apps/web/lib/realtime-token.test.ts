// @vitest-environment node

import {
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from "jose"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  RealtimeTokenConfigurationError,
  createRealtimeTokenIssuer,
} from "./realtime-token"

const operatorId = "11111111-1111-4111-8111-111111111111"
const runId = "22222222-2222-4222-8222-222222222222"
const now = new Date("2026-09-08T00:00:00.000Z")

describe("realtime operator token issuer", () => {
  it("mints a four-minute local token with only owner/run authorization claims", async () => {
    const secret = "local-realtime-secret-at-least-32-characters"
    const issuer = createRealtimeTokenIssuer(
      {
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_JWT_SECRET: secret,
      },
      () => now
    )
    const result = await issuer.issue({ operatorId, runId })
    const verified = await jwtVerify(
      result.accessToken,
      new TextEncoder().encode(secret),
      {
        audience: "authenticated",
        issuer: "http://127.0.0.1:54321/auth/v1",
        currentDate: now,
      }
    )
    expect(verified.payload).toMatchObject({
      sub: operatorId,
      role: "authenticated",
      run_id: runId,
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(now.getTime() / 1_000) + 240,
    })
    expect(JSON.stringify(verified.payload)).not.toContain("secret")
    expect(result.expiresAt).toBe("2026-09-08T00:04:00.000Z")
  })

  it("prefers an imported asymmetric signing key and publishes its key id", async () => {
    const keys = await generateKeyPair("ES256", { extractable: true })
    const privateJwk = await exportJWK(keys.privateKey)
    const issuer = createRealtimeTokenIssuer(
      {
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_REALTIME_SIGNING_JWK: JSON.stringify({
          ...privateJwk,
          alg: "ES256",
          kid: "sentinel-realtime-v1",
        }),
      },
      () => now
    )
    const result = await issuer.issue({ operatorId, runId })
    expect(decodeProtectedHeader(result.accessToken)).toEqual({
      alg: "ES256",
      kid: "sentinel-realtime-v1",
      typ: "JWT",
    })
    await expect(
      jwtVerify(result.accessToken, keys.publicKey, { currentDate: now })
    ).resolves.toMatchObject({ payload: { sub: operatorId, run_id: runId } })
  })

  it("fails closed for absent, public-only, or malformed signing keys", () => {
    for (const environment of [
      { SUPABASE_URL: "https://project.supabase.co" },
      {
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_REALTIME_SIGNING_JWK: JSON.stringify({
          kty: "EC",
          alg: "ES256",
          kid: "public-only",
        }),
      },
      {
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_REALTIME_SIGNING_JWK: "not-json",
      },
    ]) {
      expect(() => createRealtimeTokenIssuer(environment)).toThrow(
        RealtimeTokenConfigurationError
      )
    }
  })

  it("treats a blank JWK as absent locally and rejects HS256 in production", async () => {
    const secret = "local-realtime-secret-at-least-32-characters"
    const local = createRealtimeTokenIssuer(
      {
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_REALTIME_SIGNING_JWK: "   ",
        SUPABASE_JWT_SECRET: secret,
      },
      () => now
    )
    await expect(local.issue({ operatorId, runId })).resolves.toMatchObject({
      expiresAt: "2026-09-08T00:04:00.000Z",
    })

    for (const environment of [
      {
        NODE_ENV: "production",
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_JWT_SECRET: secret,
      },
      {
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_JWT_SECRET: secret,
      },
      {
        SUPABASE_URL: "https://project.supabase.co/auth/v1",
        SUPABASE_REALTIME_SIGNING_JWK: "{}",
      },
    ]) {
      expect(() => createRealtimeTokenIssuer(environment)).toThrow(
        RealtimeTokenConfigurationError
      )
    }
  })
})
