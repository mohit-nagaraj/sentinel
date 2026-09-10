import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export interface OperatorAuthEnvironment {
  readonly NODE_ENV?: string | undefined
  readonly SENTINEL_CONTROL_PLANE_FIXTURE?: string | undefined
  readonly SENTINEL_OPERATOR_TOKEN?: string | undefined
}

const minimumTokenLength = 32
const maximumTokenLength = 4_096
const operatorSessionVersion = "v1"
const operatorSessionDurationSeconds = 12 * 60 * 60

export const operatorSessionCookieName = "sentinel_operator_session"

export interface OperatorSession {
  readonly value: string
  readonly expiresAt: Date
  readonly maxAge: number
}

export function isControlPlaneFixture(
  environment: OperatorAuthEnvironment
): boolean {
  return (
    environment.NODE_ENV !== "production" &&
    environment.SENTINEL_CONTROL_PLANE_FIXTURE === "1"
  )
}

export function isOperatorAuthConfigured(
  environment: OperatorAuthEnvironment
): boolean {
  const token = environment.SENTINEL_OPERATOR_TOKEN
  return (
    isControlPlaneFixture(environment) ||
    (token !== undefined &&
      token.length >= minimumTokenLength &&
      token.length <= maximumTokenLength)
  )
}

function presentedToken(authorization: string | null): string | undefined {
  if (authorization === null) return undefined
  const bearer = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
  if (bearer !== undefined) return bearer
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization)?.[1]
  if (encoded === undefined) return undefined
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    const separator = decoded.indexOf(":")
    return separator < 0 ? undefined : decoded.slice(separator + 1)
  } catch {
    return undefined
  }
}

function matchesToken(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented, "utf8").digest()
  const right = createHash("sha256").update(expected, "utf8").digest()
  return timingSafeEqual(left, right)
}

function configuredToken(
  environment: OperatorAuthEnvironment
): string | undefined {
  const token = environment.SENTINEL_OPERATOR_TOKEN
  return token !== undefined &&
    token.length >= minimumTokenLength &&
    token.length <= maximumTokenLength
    ? token
    : undefined
}

export function isOperatorTokenAuthorized(
  presented: string,
  environment: OperatorAuthEnvironment
): boolean {
  if (isControlPlaneFixture(environment)) return true
  const expected = configuredToken(environment)
  return expected !== undefined && matchesToken(presented, expected)
}

function sessionSignature(payload: string, token: string): string {
  return createHmac("sha256", token)
    .update(`sentinel-operator-session:${payload}`, "utf8")
    .digest("hex")
}

export function createOperatorSession(
  environment: OperatorAuthEnvironment,
  now = Date.now()
): OperatorSession | undefined {
  const token = configuredToken(environment)
  if (token === undefined) return undefined
  const expiresAtSeconds =
    Math.floor(now / 1_000) + operatorSessionDurationSeconds
  const payload = `${operatorSessionVersion}.${expiresAtSeconds}`
  return {
    value: `${payload}.${sessionSignature(payload, token)}`,
    expiresAt: new Date(expiresAtSeconds * 1_000),
    maxAge: operatorSessionDurationSeconds,
  }
}

export function isOperatorSessionAuthorized(
  session: string | undefined,
  environment: OperatorAuthEnvironment,
  now = Date.now()
): boolean {
  if (isControlPlaneFixture(environment)) return true
  const token = configuredToken(environment)
  if (token === undefined || session === undefined) return false
  const match = /^(v1)\.(\d{10})\.([a-f0-9]{64})$/.exec(session)
  if (match === null) return false
  const expiresAtSeconds = Number(match[2])
  if (
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds <= Math.floor(now / 1_000)
  ) {
    return false
  }
  const payload = `${match[1]}.${match[2]}`
  return matchesToken(match[3]!, sessionSignature(payload, token))
}

export function isOperatorRequestAuthorized(
  authorization: string | null,
  environment: OperatorAuthEnvironment
): boolean {
  if (isControlPlaneFixture(environment)) return true
  const presented = presentedToken(authorization)
  return (
    presented !== undefined && isOperatorTokenAuthorized(presented, environment)
  )
}
