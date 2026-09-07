import { createServer, type Server } from "node:http"

import {
  crawlWebDocumentation,
  createPlaywrightDocumentationRenderer,
} from "@sentinel/adapters"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const enabled = process.env["RUN_PLAYWRIGHT_DOCUMENTATION_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip
const applicationId = `application:v1:${"9".repeat(64)}`
let server: Server
let origin: string
const requestedPaths: string[] = []

describeIntegration("Playwright documentation renderer", () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      requestedPaths.push(request.url ?? "/")
      if (request.url === "/robots.txt") {
        response.setHeader("content-type", "text/plain")
        response.end("User-agent: *\nAllow: /")
        return
      }
      if (request.url === "/docs/client") {
        response.setHeader("content-type", "text/html")
        response.end(
          '<!doctype html><html><head><title>Client</title></head><body><main id="root"></main><script src="/docs/client/app.js"></script></body></html>'
        )
        return
      }
      if (request.url === "/docs/client/app.js") {
        response.setHeader("content-type", "application/javascript")
        response.end(
          'fetch("/admin", { method: "POST" }).catch(() => undefined); navigator.serviceWorker?.register("/docs/client/sw.js").catch(() => undefined); try { new WebSocket(location.origin.replace("http", "ws") + "/socket"); } catch {} document.querySelector("#root").innerHTML = "<h1>Rendered guide</h1><p>The bounded browser renderer loaded this approved client-side documentation through the guarded Node transport.</p>";'
        )
        return
      }
      response.statusCode = 404
      response.end("not found")
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new Error("Playwright documentation fixture failed to listen")
    }
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error)
        )
      )
    }
  })

  it("renders configured client documentation through the guarded resource transport", async () => {
    const renderer = await createPlaywrightDocumentationRenderer()
    try {
      const map = await crawlWebDocumentation({
        applicationId,
        roots: [`${origin}/docs/client`],
        allowHttp: true,
        allowPrivateNetworkForTests: true,
        maxPages: 1,
        maxSitemaps: 0,
        maxTotalBytes: 64 * 1_024,
        maxPageBytes: 32 * 1_024,
        clientRenderedPaths: ["/docs/client"],
        renderer,
      })
      expect(map.pages).toHaveLength(1)
      expect(map.sections[0]?.sanitizedText).toContain("guarded Node transport")
      expect(map.coverage.fetchedBytes).toBeGreaterThan(200)
      expect(requestedPaths).not.toContain("/admin")
      expect(requestedPaths).not.toContain("/socket")
      expect(requestedPaths).not.toContain("/favicon.ico")
      expect(requestedPaths).not.toContain("/docs/client/sw.js")
    } finally {
      await renderer.close()
    }
  }, 60_000)
})
