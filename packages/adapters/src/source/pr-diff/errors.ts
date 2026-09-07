export type PrDiffErrorCode =
  | "invalid_input"
  | "malformed_diff"
  | "limit_exceeded"
  | "git_failed"
  | "ancestry_mismatch"
  | "content_mismatch"

export class PrDiffError extends Error {
  readonly compatibility: boolean

  constructor(
    readonly code: PrDiffErrorCode,
    message: string,
    options: { readonly compatibility?: boolean; readonly cause?: unknown } = {}
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    )
    this.name = "PrDiffError"
    this.compatibility = options.compatibility ?? false
  }
}
