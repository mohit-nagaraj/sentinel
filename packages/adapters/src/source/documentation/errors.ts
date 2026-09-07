import { redactPersistedText } from "@sentinel/contracts"

export type DocumentationErrorCode =
  | "aborted"
  | "fetch_failed"
  | "invalid_content"
  | "invalid_input"
  | "limit_exceeded"
  | "robots_denied"
  | "unsafe_destination"

export class DocumentationSourceError extends Error {
  readonly code: DocumentationErrorCode
  readonly retryable: boolean

  constructor(
    code: DocumentationErrorCode,
    message: string,
    options: { readonly cause?: unknown; readonly retryable?: boolean } = {}
  ) {
    super(redactPersistedText(message), { cause: options.cause })
    this.name = "DocumentationSourceError"
    this.code = code
    this.retryable = options.retryable ?? false
  }
}

export function documentationError(
  error: unknown,
  fallback: DocumentationErrorCode = "fetch_failed"
): DocumentationSourceError {
  if (error instanceof DocumentationSourceError) return error
  if (
    error instanceof Error &&
    error.cause instanceof DocumentationSourceError
  ) {
    return error.cause
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new DocumentationSourceError(
      "aborted",
      "Documentation crawl was cancelled"
    )
  }
  return new DocumentationSourceError(
    fallback,
    fallback === "fetch_failed"
      ? "Documentation source request failed"
      : "Documentation source processing failed",
    { cause: error, retryable: fallback === "fetch_failed" }
  )
}
