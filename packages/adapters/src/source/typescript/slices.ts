import { invalidIndexerInput } from "./errors.ts"
import type { TypeScriptIndexLimits } from "./limits.ts"

/** 1-based inclusive line range, matching the contracts `lineRangeSchema`. */
export interface SourceRange {
  readonly startLine: number
  readonly endLine: number
}

export interface SourceSlice extends SourceRange {
  readonly text: string
  /** The returned text covers less than the requested range. */
  readonly truncated: boolean
}

/**
 * Splits source text into content lines.
 *
 * A single trailing newline terminates the last line rather than starting a new
 * empty one, so `"a\n"` is one line. Empty text has no lines at all. CRLF, LF,
 * and CR are all recognized so ranges line up with what ts-morph reports.
 */
export function splitSourceLines(text: string): readonly string[] {
  if (text.length === 0) return []
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.at(-1) === "") lines.pop()
  return lines
}

export function countSourceLines(text: string): number {
  return splitSourceLines(text).length
}

export function normalizeRange(range: SourceRange): SourceRange {
  const startLine = Math.trunc(range.startLine)
  const endLine = Math.trunc(range.endLine)
  if (!Number.isFinite(startLine) || startLine < 1) {
    invalidIndexerInput("Source range must start at line 1 or later")
  }
  if (!Number.isFinite(endLine) || endLine < startLine) {
    invalidIndexerInput("Source range must end at or after its start line")
  }
  return { startLine, endLine }
}

/**
 * Returns a bounded display slice of source text.
 *
 * The slice is clamped by the file's own length, the line budget, and the byte
 * budget, in that order. `truncated` is set whenever the returned text covers
 * less than the caller asked for, so a consumer never mistakes a clipped slice
 * for a complete declaration.
 */
export function readSourceSlice(
  text: string,
  range: SourceRange,
  limits: Pick<TypeScriptIndexLimits, "maxSliceBytes" | "maxSliceLines">
): SourceSlice {
  const requested = normalizeRange(range)
  const lines = splitSourceLines(text)
  if (lines.length === 0) {
    return {
      startLine: requested.startLine,
      endLine: requested.startLine,
      text: "",
      truncated: true,
    }
  }
  if (requested.startLine > lines.length) {
    return {
      startLine: lines.length,
      endLine: lines.length,
      text: "",
      truncated: true,
    }
  }

  const clampedEnd = Math.min(requested.endLine, lines.length)
  const lineCapped = Math.min(
    clampedEnd,
    requested.startLine + limits.maxSliceLines - 1
  )
  const selected = lines.slice(requested.startLine - 1, lineCapped)

  const encoder = new TextEncoder()
  const kept: string[] = []
  let bytes = 0
  let byteTruncated = false
  for (const line of selected) {
    const lineBytes = encoder.encode(line).byteLength + 1
    if (kept.length > 0 && bytes + lineBytes > limits.maxSliceBytes) {
      byteTruncated = true
      break
    }
    bytes += lineBytes
    kept.push(line)
  }

  // Always return at least one line so a caller can anchor the slice, even when
  // that single line is itself over the byte budget.
  const firstLine = selected[0]
  if (kept.length === 0 && firstLine !== undefined) {
    kept.push(firstLine)
    byteTruncated = true
  }

  const endLine = requested.startLine + kept.length - 1
  return {
    startLine: requested.startLine,
    endLine,
    text: kept.join("\n"),
    truncated:
      byteTruncated ||
      endLine < requested.endLine ||
      kept.length < selected.length,
  }
}
