import { describe, expect, it } from "vitest"

import { parseHtmlDocument } from "./html-parser.ts"
import { parseMarkdownDocument } from "./markdown-parser.ts"

describe("documentation parsers", () => {
  it("sanitizes HTML, strips chrome, and retains exact offset excerpts", () => {
    const parsed = parseHtmlDocument(
      `<!doctype html><html><head><title>Guide</title></head><body>
       <header>Repeated navigation</header><main>
       <h1>Checkout</h1><p>Choose a ticket and continue to attendee details.</p>
       <h2>Payment</h2><p onclick="steal()">Submit payment safely.</p>
       <script>stealSecrets()</script><form><input onfocus="steal()"></form>
       <a href="/docs/orders">Orders</a></main></body></html>`,
      "https://docs.example.com/docs/checkout"
    )
    expect(parsed.sanitizedText).toContain("Choose a ticket")
    expect(parsed.sanitizedText).not.toMatch(
      /Repeated navigation|steal|onfocus|onclick|<script/i
    )
    expect(parsed.links).toEqual(["/docs/orders"])
    expect(parsed.sections.map((section) => section.headingPath)).toEqual([
      ["Checkout"],
      ["Checkout", "Payment"],
    ])
    for (const section of parsed.sections) {
      expect(
        parsed.sanitizedText.slice(section.startOffset, section.endOffset)
      ).toBe(section.excerpt)
    }
  })

  it("parses Markdown headings, lists, links, and code without durable raw HTML", () => {
    const parsed = parseMarkdownDocument(
      `# Orders

- Choose a ticket
- Enter attendee details

## API

[Create order](./api.md#create)

\`\`\`ts
await createOrder()
\`\`\`

<script>steal()</script>
`,
      "repository://github.com/acme/app/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/docs/orders.md"
    )
    expect(parsed.title).toBe("Orders")
    expect(parsed.links).toEqual(["./api.md#create"])
    expect(parsed.sanitizedText).toContain("await createOrder()")
    expect(parsed.sanitizedText).not.toContain("steal")
    expect(parsed.sections[1]?.headingPath).toEqual(["Orders", "API"])
    for (const section of parsed.sections) {
      expect(
        parsed.sanitizedText.slice(section.startOffset, section.endOffset)
      ).toBe(section.excerpt)
    }
  })
})
