import { hashCanonical } from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { DocumentationMapIndex } from "./map-index.ts"
import { buildDocumentationMap } from "./map-builder.ts"
import type { PreparedPage } from "./types.ts"

const applicationId = `application:v1:${"a".repeat(64)}`

function page(
  uri: string,
  title: string,
  text: string,
  links: string[] = []
): PreparedPage {
  return {
    sourceUri: uri,
    canonicalUri: uri,
    mediaType: "text/html",
    document: {
      title,
      sanitizedText: text,
      sections: [
        {
          headingPath: [title],
          excerpt: text,
          startOffset: 0,
          endOffset: text.length,
        },
      ],
      links,
    },
  }
}

describe("documentation map", () => {
  it("builds stable facts, links, duplicate collapse, and bounded search", () => {
    const orders = page(
      "https://docs.example.com/docs/orders",
      "Orders",
      "Create an order after choosing a ticket.",
      ["https://docs.example.com/docs/payment"]
    )
    const duplicate = {
      ...orders,
      sourceUri: "https://docs.example.com/docs/orders-copy",
      canonicalUri: "https://docs.example.com/docs/orders-copy",
    }
    const payment = page(
      "https://docs.example.com/docs/payment",
      "Payment",
      "Payment completes checkout and creates a receipt."
    )
    const first = buildDocumentationMap({
      applicationId,
      kind: "web",
      rootUri: "https://docs.example.com/docs",
      pages: [payment, duplicate, orders],
      attemptedPages: 3,
    })
    const second = buildDocumentationMap({
      applicationId,
      kind: "web",
      rootUri: "https://docs.example.com/docs",
      pages: [orders, payment, duplicate],
      attemptedPages: 3,
    })
    expect(second.mapHash).toBe(first.mapHash)
    expect(first.pages).toHaveLength(2)
    expect(first.coverage.duplicatePages).toBe(1)
    expect(first.links).toHaveLength(1)
    const index = new DocumentationMapIndex(first)
    expect(index.search("payment checkout", 1)).toHaveLength(1)
    expect(index.listPages(1)).toHaveLength(1)
    expect(index.linkedPages(first.pages[0]?.fact.id ?? "")).toHaveLength(1)
    expect(() =>
      index.readSection(`document-section:v1:${"f".repeat(64)}`)
    ).toThrow(/outside the approved map/)
  })

  it("classifies changed, unchanged, and removed pages", () => {
    const unchanged = page(
      "https://docs.example.com/docs/a",
      "A",
      "Stable documentation content."
    )
    const changed = page(
      "https://docs.example.com/docs/b",
      "B",
      "New documentation content."
    )
    const current = buildDocumentationMap({
      applicationId,
      kind: "web",
      rootUri: "https://docs.example.com/docs",
      pages: [unchanged, changed],
      previousPages: [
        {
          canonicalUri: unchanged.canonicalUri,
          contentHash: hashCanonical({
            mediaType: unchanged.mediaType,
            sanitizedText: unchanged.document.sanitizedText,
            title: unchanged.document.title,
          }),
        },
        {
          canonicalUri: changed.canonicalUri,
          contentHash: hashCanonical({ old: true }),
        },
        {
          canonicalUri: "https://docs.example.com/docs/removed",
          contentHash: hashCanonical({ removed: true }),
        },
      ],
    })
    expect(current.pages.map((record) => record.change)).toEqual([
      "unchanged",
      "changed",
    ])
    expect(current.coverage.removedPages).toBe(1)
  })
})
