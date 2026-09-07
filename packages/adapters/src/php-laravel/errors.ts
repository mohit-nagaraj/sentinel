import { redactPersistedText } from "@sentinel/contracts"

export type PhpIndexerErrorCode =
  | "aborted"
  | "content_mismatch"
  | "executable_missing"
  | "invalid_input"
  | "limit_exceeded"
  | "malformed_output"
  | "process_failed"
  | "timeout"
  | "unsafe_path"

export class PhpIndexerError extends Error {
  readonly code: PhpIndexerErrorCode
  readonly retryable: boolean
  readonly compatibility: boolean

  constructor(
    code: PhpIndexerErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean
      readonly compatibility?: boolean
    } = {}
  ) {
    super(
      redactPersistedText(message).trim().slice(0, 2_048) ||
        "PHP indexer failed"
    )
    this.name = "PhpIndexerError"
    this.code = code
    this.retryable = options.retryable ?? false
    this.compatibility = options.compatibility ?? false
  }
}
