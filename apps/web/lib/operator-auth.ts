import { createHash, timingSafeEqual } from "node:crypto"

export interface OperatorAuthEnvironment {
  readonly NODE_ENV?: string | undefined
  readonly SENTINEL_CONTROL_PLANE_FIXTURE?: string | undefined
  readonly SENTINEL_OPERATOR_TOKEN?: string | undefined
}

const minimumTokenLength = 32
const maximumTokenLength = 4_096

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

export function isOperatorRequestAuthorized(
  authorization: string | null,
  environment: OperatorAuthEnvironment
): boolean {
  if (isControlPlaneFixture(environment)) return true
  const expected = environment.SENTINEL_OPERATOR_TOKEN
  const presented = presentedToken(authorization)
  return (
    expected !== undefined &&
    expected.length >= minimumTokenLength &&
    expected.length <= maximumTokenLength &&
    presented !== undefined &&
    matchesToken(presented, expected)
  )
}
