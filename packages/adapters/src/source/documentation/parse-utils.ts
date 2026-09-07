import type { ParsedSection } from "./types.ts"

export function normalizeEvidenceText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export interface SectionChunk {
  readonly headingPath: readonly string[]
  readonly blocks: readonly string[]
}

export function materializeSections(chunks: readonly SectionChunk[]): {
  readonly sanitizedText: string
  readonly sections: readonly ParsedSection[]
} {
  const excerpts = chunks
    .map((chunk) => ({
      headingPath: chunk.headingPath,
      excerpt: normalizeEvidenceText(chunk.blocks.join("\n\n")),
    }))
    .filter((chunk) => chunk.excerpt.length > 0)

  let sanitizedText = ""
  const sections = excerpts.map((chunk) => {
    if (sanitizedText.length > 0) sanitizedText += "\n\n"
    const startOffset = sanitizedText.length
    sanitizedText += chunk.excerpt
    return {
      headingPath: chunk.headingPath,
      excerpt: chunk.excerpt,
      startOffset,
      endOffset: sanitizedText.length,
    }
  })
  return { sanitizedText, sections }
}

export function boundedHeading(value: string, fallback: string): string {
  const normalized = normalizeEvidenceText(value || fallback)
  return normalized.slice(0, 512) || fallback.slice(0, 512) || "Documentation"
}
