import { Readability } from "@mozilla/readability"
import createDOMPurify from "dompurify"
import { JSDOM } from "jsdom"

import { DocumentationSourceError } from "./errors.ts"
import {
  boundedHeading,
  materializeSections,
  normalizeEvidenceText,
  type SectionChunk,
} from "./parse-utils.ts"
import type { ParsedDocument } from "./types.ts"

const removableSelector = [
  "script",
  "style",
  "noscript",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
  "template",
  "iframe",
  "object",
  "embed",
  "canvas",
  "svg",
  "[hidden]",
  '[aria-hidden="true"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[role="navigation"]',
  '[class~="breadcrumb"]',
  '[class~="footer"]',
  '[class~="menu"]',
  '[class~="navbar"]',
  '[class~="sidebar"]',
].join(",")

const blockSelector = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "pre",
  "blockquote",
  "dt",
  "dd",
  "th",
  "td",
].join(",")

function selectContent(
  document: Document,
  sourceUri: string
): { title: string; html: string } {
  document
    .querySelectorAll(removableSelector)
    .forEach((element) => element.remove())
  const title = boundedHeading(
    document.title,
    new URL(sourceUri).pathname.split("/").at(-1) ?? "Documentation"
  )
  const explicitContent = document.querySelector("main, article")
  if (
    explicitContent !== null &&
    normalizeEvidenceText(explicitContent.textContent ?? "").length >= 40
  ) {
    return {
      title: boundedHeading(
        explicitContent.querySelector("h1")?.textContent ?? "",
        title
      ),
      html: explicitContent.innerHTML,
    }
  }
  const article = new Readability(document.cloneNode(true) as Document, {
    charThreshold: 120,
  }).parse()
  if (
    article !== null &&
    typeof article.textContent === "string" &&
    typeof article.content === "string" &&
    normalizeEvidenceText(article.textContent).length >= 80
  ) {
    return {
      title: boundedHeading(article.title ?? "", title),
      html: article.content,
    }
  }
  const fallback = document.body
  return { title, html: fallback?.innerHTML ?? "" }
}

export function parseHtmlDocument(
  html: string,
  sourceUri: string
): ParsedDocument {
  if (Buffer.byteLength(html, "utf8") === 0) {
    throw new DocumentationSourceError(
      "invalid_content",
      "Documentation page is empty"
    )
  }
  const sourceDom = new JSDOM(html, { url: sourceUri })
  const selected = selectContent(sourceDom.window.document, sourceUri)
  const sanitizerDom = new JSDOM("", { url: sourceUri })
  const purifier = createDOMPurify(sanitizerDom.window)
  const sanitizedHtml = purifier.sanitize(selected.html, {
    ALLOWED_ATTR: ["href", "title"],
    ALLOWED_TAGS: [
      "a",
      "blockquote",
      "br",
      "code",
      "dd",
      "dl",
      "dt",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "li",
      "ol",
      "p",
      "pre",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  })
  const cleanDom = new JSDOM(`<main>${sanitizedHtml}</main>`, {
    url: sourceUri,
  })
  const document = cleanDom.window.document
  const links = [...document.querySelectorAll("a[href]")]
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => href.length > 0)

  const defaultPath = [selected.title]
  const headingStack: string[] = []
  const chunks: { headingPath: string[]; blocks: string[] }[] = []
  let current: { headingPath: string[]; blocks: string[] } | undefined
  for (const element of document.querySelectorAll(blockSelector)) {
    if (element.parentElement?.closest(blockSelector) !== null) continue
    const text = normalizeEvidenceText(element.textContent ?? "")
    if (text.length === 0) continue
    const heading = /^H([1-6])$/.exec(element.tagName)
    if (heading !== null) {
      const depth = Number(heading[1])
      if (depth > 1 && headingStack[0] === undefined) {
        headingStack[0] = selected.title
      }
      headingStack.splice(depth - 1)
      headingStack[depth - 1] = boundedHeading(text, selected.title)
      const path = headingStack.filter((value) => value !== undefined)
      current = {
        headingPath: path.length > 0 ? path : defaultPath,
        blocks: [text],
      }
      chunks.push(current)
      continue
    }
    current ??= { headingPath: defaultPath, blocks: [] }
    if (!chunks.includes(current)) chunks.push(current)
    current.blocks.push(text)
  }

  const materialized = materializeSections(
    chunks satisfies readonly SectionChunk[]
  )
  if (materialized.sections.length === 0) {
    throw new DocumentationSourceError(
      "invalid_content",
      "Documentation page contains no readable sections"
    )
  }
  return {
    title: selected.title,
    sanitizedText: materialized.sanitizedText,
    sections: materialized.sections,
    links: Object.freeze(links),
  }
}
