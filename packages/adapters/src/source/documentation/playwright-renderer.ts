import { chromium } from "playwright"

import { DocumentationSourceError, documentationError } from "./errors.ts"

export interface DocumentationRenderer {
  render(
    url: string,
    signal?: AbortSignal,
    authorizeRequest?: (url: string) => Promise<void> | void
  ): Promise<string>
  close(): Promise<void>
}

export interface PlaywrightDocumentationRendererOptions {
  readonly timeoutMs?: number
  readonly maxBytes?: number
}

export async function createPlaywrightDocumentationRenderer(
  options: PlaywrightDocumentationRendererOptions = {}
): Promise<DocumentationRenderer> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxBytes = options.maxBytes ?? 2 * 1_024 * 1_024
  const browser = await chromium.launch({ headless: true })
  return {
    render: async (url, signal, authorizeRequest) => {
      if (signal?.aborted === true) {
        throw new DocumentationSourceError(
          "aborted",
          "Documentation rendering was cancelled"
        )
      }
      const context = await browser.newContext({ javaScriptEnabled: true })
      await context.route("**/*", async (route) => {
        try {
          if (authorizeRequest === undefined) {
            const initial = new URL(url)
            const requested = new URL(route.request().url())
            if (requested.origin !== initial.origin)
              throw new Error("off origin")
          } else {
            await authorizeRequest(route.request().url())
          }
          await route.continue()
        } catch {
          await route.abort("blockedbyclient")
        }
      })
      const page = await context.newPage()
      const abort = () => void page.close().catch(() => undefined)
      signal?.addEventListener("abort", abort, { once: true })
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs })
        const html = await page.content()
        if (Buffer.byteLength(html, "utf8") > maxBytes) {
          throw new DocumentationSourceError(
            "limit_exceeded",
            "Rendered documentation exceeded the configured byte limit"
          )
        }
        return html
      } catch (error) {
        throw documentationError(error)
      } finally {
        signal?.removeEventListener("abort", abort)
        await context.close().catch(() => undefined)
      }
    },
    close: async () => browser.close(),
  }
}
