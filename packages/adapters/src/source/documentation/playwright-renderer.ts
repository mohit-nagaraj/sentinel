import { chromium } from "playwright"

import { DocumentationSourceError, documentationError } from "./errors.ts"

export interface RenderedResource {
  readonly body: Uint8Array
  readonly contentType: string
  readonly status: number
}

export interface DocumentationRenderRequest {
  readonly url: string
  readonly initialHtml: string
  readonly maxTransferBytes: number
  readonly maxSerializedBytes: number
  readonly signal?: AbortSignal
  fetchResource(
    url: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<RenderedResource>
}

export interface RenderedDocumentation {
  readonly html: string
  readonly transferredBytes: number
}

export interface DocumentationRenderer {
  render(request: DocumentationRenderRequest): Promise<RenderedDocumentation>
  close(): Promise<void>
}

export interface PlaywrightDocumentationRendererOptions {
  readonly timeoutMs?: number
}

export async function createPlaywrightDocumentationRenderer(
  options: PlaywrightDocumentationRendererOptions = {}
): Promise<DocumentationRenderer> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-webrtc", "--disable-background-networking"],
  })
  return {
    render: async (request) => {
      const wasAborted = () => request.signal?.aborted === true
      if (wasAborted()) {
        throw new DocumentationSourceError(
          "aborted",
          "Documentation rendering was cancelled"
        )
      }
      const context = await browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: "block",
      })
      await context.addInitScript(() => {
        Object.defineProperty(globalThis, "RTCPeerConnection", {
          configurable: false,
          value: undefined,
          writable: false,
        })
      })
      await context.routeWebSocket("**/*", (webSocket) => webSocket.close())
      let transferredBytes = 0
      let renderFailure: unknown
      let fetchChain = Promise.resolve()
      await context.route("**/*", async (route) => {
        const requestedUrl = route.request().url()
        if (route.request().method() !== "GET") {
          await route.abort("blockedbyclient")
          return
        }
        if (
          route.request().isNavigationRequest() &&
          requestedUrl === request.url
        ) {
          await route.fulfill({
            body: request.initialHtml,
            contentType: "text/html; charset=utf-8",
            status: 200,
          })
          return
        }
        let resource: RenderedResource | undefined
        let failure: unknown
        fetchChain = fetchChain.then(async () => {
          try {
            const remaining = request.maxTransferBytes - transferredBytes
            if (remaining <= 0) {
              throw new DocumentationSourceError(
                "limit_exceeded",
                "Rendered documentation exceeded its transfer budget"
              )
            }
            resource = await request.fetchResource(
              requestedUrl,
              remaining,
              request.signal
            )
            transferredBytes += resource.body.byteLength
          } catch (error) {
            failure = error
            const normalized = documentationError(error)
            if (
              normalized.code === "limit_exceeded" ||
              normalized.code === "aborted"
            ) {
              renderFailure ??= normalized
            }
          }
        })
        await fetchChain
        if (failure !== undefined || resource === undefined) {
          await route.abort("blockedbyclient")
          return
        }
        await route.fulfill({
          body: Buffer.from(resource.body),
          contentType: resource.contentType || "application/octet-stream",
          status: resource.status,
        })
      })
      const page = await context.newPage()
      const abort = () => void page.close().catch(() => undefined)
      request.signal?.addEventListener("abort", abort, { once: true })
      try {
        await page.goto(request.url, {
          waitUntil: "networkidle",
          timeout: timeoutMs,
        })
        if (renderFailure !== undefined) throw renderFailure
        if (wasAborted()) {
          throw new DocumentationSourceError(
            "aborted",
            "Documentation rendering was cancelled"
          )
        }
        const html = await page.content()
        if (Buffer.byteLength(html, "utf8") > request.maxSerializedBytes) {
          throw new DocumentationSourceError(
            "limit_exceeded",
            "Rendered documentation exceeded its serialized-page budget"
          )
        }
        return { html, transferredBytes }
      } catch (error) {
        throw documentationError(error)
      } finally {
        request.signal?.removeEventListener("abort", abort)
        await context.close().catch(() => undefined)
      }
    },
    close: async () => browser.close(),
  }
}
