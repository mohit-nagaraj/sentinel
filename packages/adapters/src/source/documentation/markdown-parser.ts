import type { Content, Heading, Link, Root } from "mdast"
import { toString } from "mdast-util-to-string"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { visit } from "unist-util-visit"

import { DocumentationSourceError } from "./errors.ts"
import {
  boundedHeading,
  materializeSections,
  normalizeEvidenceText,
  type SectionChunk,
} from "./parse-utils.ts"
import type { ParsedDocument } from "./types.ts"

function nodeText(node: Content): string {
  if (node.type === "html" || node.type === "definition") return ""
  if (node.type === "code") return normalizeEvidenceText(node.value)
  return normalizeEvidenceText(toString(node))
}

function nodeLinks(node: Content): readonly string[] {
  const links: string[] = []
  visit(node, "link", (link: Link) => {
    if (link.url.length > 0) links.push(link.url)
  })
  return links
}

export function parseMarkdownDocument(
  markdown: string,
  sourceUri: string,
  fallbackTitle?: string
): ParsedDocument {
  if (Buffer.byteLength(markdown, "utf8") === 0) {
    throw new DocumentationSourceError(
      "invalid_content",
      "Repository document is empty"
    )
  }
  const tree = unified().use(remarkParse).parse(markdown) as Root
  const inferredTitle =
    fallbackTitle ??
    sourceUri
      .split("/")
      .at(-1)
      ?.replace(/\.(?:md|mdx)$/i, "") ??
    "Documentation"
  const firstHeading = tree.children.find(
    (node): node is Heading => node.type === "heading"
  )
  const title = boundedHeading(
    firstHeading === undefined ? inferredTitle : toString(firstHeading),
    inferredTitle
  )
  const headingStack: string[] = []
  const chunks: { headingPath: string[]; blocks: string[] }[] = []
  const links: string[] = []
  let current: { headingPath: string[]; blocks: string[] } | undefined

  for (const node of tree.children) {
    links.push(...nodeLinks(node))
    if (node.type === "heading") {
      const heading = boundedHeading(toString(node), title)
      headingStack.splice(node.depth - 1)
      headingStack[node.depth - 1] = heading
      current = {
        headingPath: headingStack.filter((value) => value !== undefined),
        blocks: [heading],
      }
      chunks.push(current)
      continue
    }
    const text = nodeText(node)
    if (text.length === 0) continue
    current ??= { headingPath: [title], blocks: [] }
    if (!chunks.includes(current)) chunks.push(current)
    current.blocks.push(text)
  }

  const materialized = materializeSections(
    chunks satisfies readonly SectionChunk[]
  )
  if (materialized.sections.length === 0) {
    throw new DocumentationSourceError(
      "invalid_content",
      "Repository document contains no readable sections"
    )
  }
  return {
    title,
    sanitizedText: materialized.sanitizedText,
    sections: materialized.sections,
    links: Object.freeze(links),
  }
}
