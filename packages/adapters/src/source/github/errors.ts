import { redactPersistedText } from "@sentinel/contracts"

export type SourceConnectorErrorCode =
  | "aborted"
  | "authentication_failed"
  | "binary_file"
  | "git_failed"
  | "invalid_input"
  | "limit_exceeded"
  | "not_found"
  | "provider_unavailable"
  | "rate_limited"
  | "stale_lease_invalid"
  | "timeout"
  | "unsafe_path"
  | "unsafe_repository"
  | "unsupported_repository"

export interface SourceConnectorErrorOptions {
  readonly retryable?: boolean
  readonly compatibility?: boolean
  readonly secrets?: readonly string[]
}

const credentialUrlPattern = /\b(https?:\/\/)[^\s/@]+@/gi

export function redactConnectorText(
  value: string,
  secrets: readonly string[] = []
): string {
  let redacted = value.replace(credentialUrlPattern, "$1[REDACTED]@")
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]")
  }
  redacted = redactPersistedText(redacted).trim()
  return (
    redacted.length > 0 ? redacted : "Source connector operation failed"
  ).slice(0, 2_048)
}

export class SourceConnectorError extends Error {
  readonly code: SourceConnectorErrorCode
  readonly retryable: boolean
  readonly compatibility: boolean

  constructor(
    code: SourceConnectorErrorCode,
    message: string,
    options: SourceConnectorErrorOptions = {}
  ) {
    super(redactConnectorText(message, options.secrets))
    this.name = "SourceConnectorError"
    this.code = code
    this.retryable = options.retryable ?? false
    this.compatibility = options.compatibility ?? false
  }
}

export function connectorError(
  error: unknown,
  fallback: SourceConnectorErrorCode = "provider_unavailable",
  secrets: readonly string[] = []
): SourceConnectorError {
  if (error instanceof SourceConnectorError) return error
  if (error instanceof Error && error.name === "AbortError") {
    return new SourceConnectorError("aborted", "Source operation was cancelled")
  }
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { readonly status?: unknown; readonly name?: unknown })
      : undefined
  if (candidate?.status === 401 || candidate?.status === 403) {
    return new SourceConnectorError(
      "authentication_failed",
      "GitHub rejected the read-only credentials"
    )
  }
  if (candidate?.status === 404) {
    return new SourceConnectorError(
      "not_found",
      "The requested GitHub source was not found or is not readable"
    )
  }
  if (candidate?.status === 429) {
    return new SourceConnectorError(
      "rate_limited",
      "GitHub rate limit reached",
      {
        retryable: true,
      }
    )
  }
  if (candidate?.name === "TimeoutError") {
    return new SourceConnectorError("timeout", "GitHub request timed out", {
      retryable: true,
    })
  }
  const message =
    error instanceof Error ? error.message : "Source operation failed"
  return new SourceConnectorError(fallback, message, {
    retryable: fallback === "provider_unavailable",
    secrets,
  })
}
