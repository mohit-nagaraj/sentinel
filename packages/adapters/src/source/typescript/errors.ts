import { redactPersistedText } from "@sentinel/contracts"
import { z } from "zod"

export type TypeScriptIndexerErrorCode =
  | "aborted"
  | "invalid_input"
  | "limit_exceeded"
  | "project_not_found"
  | "read_failed"
  | "timeout"
  | "unsafe_path"
  | "unsupported_project"

export interface TypeScriptIndexerErrorOptions {
  readonly compatibility?: boolean
}

export function redactIndexerText(value: string): string {
  const redacted = redactPersistedText(value).trim()
  return (
    redacted.length > 0 ? redacted : "TypeScript indexing operation failed"
  ).slice(0, 2_048)
}

export class TypeScriptIndexerError extends Error {
  readonly code: TypeScriptIndexerErrorCode
  readonly compatibility: boolean

  constructor(
    code: TypeScriptIndexerErrorCode,
    message: string,
    options: TypeScriptIndexerErrorOptions = {}
  ) {
    super(redactIndexerText(message))
    this.name = "TypeScriptIndexerError"
    this.code = code
    this.compatibility = options.compatibility ?? false
  }
}

export function invalidIndexerInput(message: string): never {
  throw new TypeScriptIndexerError("invalid_input", message)
}

export function indexerLimitExceeded(message: string): never {
  throw new TypeScriptIndexerError("limit_exceeded", message, {
    compatibility: true,
  })
}

export function unsafeIndexerPath(message: string): never {
  throw new TypeScriptIndexerError("unsafe_path", message)
}

/**
 * Closed set of reasons a structural fact could not be resolved. The indexer
 * records one of these instead of guessing a route, component, handler, label,
 * or request path.
 */
export const unresolvedReasonSchema = z.enum([
  "computed_handler",
  "computed_request_path",
  "computed_route_path",
  "dynamic_accessible_name",
  "dynamic_component",
  "external_module",
  "file_budget_exhausted",
  "jsx_budget_exhausted",
  "node_budget_exhausted",
  "symbol_budget_exhausted",
  "time_budget_exhausted",
  "unresolved_import",
  "unsupported_syntax",
])

export type UnresolvedReason = z.infer<typeof unresolvedReasonSchema>

export const skipReasonSchema = z.enum([
  "build_output",
  "excluded_extension",
  "file_budget_exhausted",
  "generated_declaration",
  "locale_bundle",
  "out_of_root",
  "oversized_file",
  "symlink",
  "test_file",
  "vendor_dependency",
])

export type SkipReason = z.infer<typeof skipReasonSchema>

export const indexWarningSchema = z.strictObject({
  reason: z.union([unresolvedReasonSchema, skipReasonSchema]),
  path: z.string().min(1).max(2_048),
  detail: z.string().min(1).max(512).optional(),
  line: z.number().int().positive().optional(),
})

export type IndexWarning = z.infer<typeof indexWarningSchema>

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new TypeScriptIndexerError(
      "aborted",
      "TypeScript indexing was cancelled"
    )
  }
}
