import "server-only"

import { databaseRunIdSchema } from "@sentinel/contracts"
import { SignJWT, importJWK, type JWK } from "jose"
import { z } from "zod"

const operatorIdSchema = z.uuid()
const algorithmSchema = z.enum(["ES256", "RS256"])

export interface RealtimeSigningEnvironment {
  readonly NODE_ENV?: string | undefined
  readonly SUPABASE_URL?: string | undefined
  readonly SUPABASE_REALTIME_SIGNING_JWK?: string | undefined
  readonly SUPABASE_JWT_SECRET?: string | undefined
}

export interface RealtimeTokenIssuer {
  issue(input: {
    readonly operatorId: string
    readonly runId: string
  }): Promise<{ readonly accessToken: string; readonly expiresAt: string }>
}

export class RealtimeTokenConfigurationError extends Error {
  constructor() {
    super("Realtime token signing is unavailable")
    this.name = "RealtimeTokenConfigurationError"
  }
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(z.string().min(32).max(4_096).parse(secret))
}

export function createRealtimeTokenIssuer(
  environment: RealtimeSigningEnvironment,
  now: () => Date = () => new Date()
): RealtimeTokenIssuer {
  let endpoint: URL
  try {
    endpoint = new URL(
      z.url({ protocol: /^https?$/ }).parse(environment.SUPABASE_URL)
    )
    if (
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.pathname !== "/" ||
      endpoint.search !== "" ||
      endpoint.hash !== ""
    ) {
      throw new RealtimeTokenConfigurationError()
    }
  } catch {
    throw new RealtimeTokenConfigurationError()
  }
  const issuer = endpoint.origin
  const jwkInput = environment.SUPABASE_REALTIME_SIGNING_JWK?.trim()
  let algorithm: "ES256" | "RS256" | "HS256"
  let key: Uint8Array | ReturnType<typeof importJWK>
  let kid: string | undefined
  if (jwkInput !== undefined && jwkInput.length > 0) {
    let jwk: JWK
    try {
      jwk = z.record(z.string(), z.unknown()).parse(JSON.parse(jwkInput)) as JWK
      algorithm = algorithmSchema.parse(jwk.alg)
      kid = z.string().min(1).max(255).parse(jwk.kid)
      if (typeof jwk.d !== "string" || jwk.d.length === 0) {
        throw new RealtimeTokenConfigurationError()
      }
      key = importJWK(jwk, algorithm)
    } catch {
      throw new RealtimeTokenConfigurationError()
    }
  } else if (environment.SUPABASE_JWT_SECRET !== undefined) {
    if (
      environment.NODE_ENV === "production" ||
      !new Set(["127.0.0.1", "::1", "localhost"]).has(endpoint.hostname)
    ) {
      throw new RealtimeTokenConfigurationError()
    }
    algorithm = "HS256"
    key = encodeSecret(environment.SUPABASE_JWT_SECRET)
  } else {
    throw new RealtimeTokenConfigurationError()
  }

  return {
    issue: async (input) => {
      const operatorId = operatorIdSchema.parse(input.operatorId)
      const runId = databaseRunIdSchema.parse(input.runId)
      const issuedAt = Math.floor(now().getTime() / 1_000)
      const expiresAt = issuedAt + 240
      const signer = new SignJWT({
        role: "authenticated",
        run_id: runId,
      })
        .setProtectedHeader({
          alg: algorithm,
          typ: "JWT",
          ...(kid === undefined ? {} : { kid }),
        })
        .setSubject(operatorId)
        .setAudience("authenticated")
        .setIssuer(`${issuer}/auth/v1`)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
      return {
        accessToken: await signer.sign(await key),
        expiresAt: new Date(expiresAt * 1_000).toISOString(),
      }
    },
  }
}
