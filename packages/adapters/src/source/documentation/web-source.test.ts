import { createServer, type Server } from "node:http"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { DocumentationRenderer } from "./playwright-renderer.ts"
import { crawlWebDocumentation } from "./web-source.ts"

const applicationId = `application:v1:${"c".repeat(64)}`
let server: Server
let origin: string
const requests: string[] = []

function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? "/"
    requests.push(url)
    if (url === "/robots.txt") {
      response.setHeader("content-type", "text/plain")
      response.end(
        `User-agent: *\nDisallow: /docs/private\nSitemap: ${origin}/sitemap.xml`
      )
      return
    }
    if (url === "/sitemap.xml") {
      response.setHeader("content-type", "application/xml")
      response.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>${origin}/docs/</loc></url>
        <url><loc>${origin}/docs/redirect</loc></url>
        <url><loc>${origin}/docs/duplicate</loc></url>
        <url><loc>${origin}/docs/malicious</loc></url>
        <url><loc>${origin}/docs/client</loc></url>
        <url><loc>${origin}/docs/private</loc></url>
        <url><loc>http://169.254.169.254/latest/meta-data</loc></url>
      </urlset>`)
      return
    }
    if (url === "/docs/redirect") {
      response.statusCode = 302
      response.setHeader("location", "/docs/page")
      response.end()
      return
    }
    if (url === "/docs/" || url === "/docs") {
      response.setHeader("content-type", "text/html")
      response.end(
        page(
          "Guide",
          `This approved guide links to checkout documentation and contains enough useful content for deterministic extraction.
           <a href="/docs/page">Checkout</a><a href="/admin">Admin</a>
           <a href="https://evil.example/docs">Off host</a><a href="javascript:alert(1)">Bad</a>`
        )
      )
      return
    }
    if (url === "/docs/page" || url === "/docs/duplicate") {
      response.setHeader("content-type", "text/html")
      response.end(
        page(
          "Checkout",
          "Choose a ticket, provide attendee details, and submit the order through the documented checkout flow.",
          `<link rel="canonical" href="${origin}/docs/page">`
        )
      )
      return
    }
    if (url === "/docs/malicious") {
      response.setHeader("content-type", "text/html")
      response.end(
        page(
          "Safety",
          'Safe visible evidence remains available after sanitization.<img src=x onerror="steal()"><script>steal()</script>'
        )
      )
      return
    }
    if (url === "/docs/client") {
      response.setHeader("content-type", "text/html")
      response.end(
        "<!doctype html><html><head><title>Client</title></head><body><div id=root></div></body></html>"
      )
      return
    }
    response.statusCode = 404
    response.end("not found")
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new Error("fixture failed")
  origin = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  )
})

describe("web documentation source", () => {
  it("uses a bounded, robots-aware, canonicalized, sanitized crawl frontier", async () => {
    let rendered = 0
    const renderer: DocumentationRenderer = {
      render: async () => {
        rendered += 1
        return page(
          "Client reference",
          "Client-rendered documentation is fetched only for the explicitly configured path and then sanitized."
        )
      },
      close: async () => undefined,
    }
    const map = await crawlWebDocumentation({
      applicationId,
      roots: [`${origin}/docs`],
      allowHttp: true,
      allowPrivateNetworkForTests: true,
      maxPages: 20,
      maxRequestRetries: 0,
      clientRenderedPaths: ["/docs/client"],
      renderer,
    })
    expect(rendered).toBe(1)
    expect(
      map.pages.some((record) => record.fact.title === "Client reference")
    ).toBe(true)
    expect(map.coverage.duplicatePages).toBeGreaterThanOrEqual(1)
    expect(
      map.pages.some((record) =>
        record.fact.canonicalUri.endsWith("/docs/page")
      )
    ).toBe(true)
    expect(
      map.sections.map((section) => section.sanitizedText).join(" ")
    ).not.toMatch(/onerror|steal|<script/i)
    expect(requests).not.toContain("/admin")
    expect(requests).not.toContain("/latest/meta-data")
    expect(requests.filter((url) => url === "/docs/private")).toHaveLength(0)
    expect(map.failedUris).not.toContain(`${origin}/docs/private`)
    expect(map.coverage.successfulPages).toBeGreaterThanOrEqual(4)
  }, 30_000)

  it("rejects local-network destinations unless the test-only escape hatch is explicit", async () => {
    await expect(
      crawlWebDocumentation({
        applicationId,
        roots: [`${origin}/docs`],
        allowHttp: true,
        maxPages: 1,
        maxRequestRetries: 0,
      })
    ).rejects.toThrow(/private|reserved|request failed/i)
  })
})
