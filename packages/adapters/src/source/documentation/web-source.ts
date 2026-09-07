import { BasicCrawler } from "@crawlee/basic"
import { Configuration, RequestQueue } from "@crawlee/core"
import { MemoryStorage } from "@crawlee/memory-storage"
import { parseSitemap } from "@crawlee/utils"
import { JSDOM } from "jsdom"
import robotsParser from "robots-parser"

import { DocumentationSourceError, documentationError } from "./errors.ts"
import { parseHtmlDocument } from "./html-parser.ts"
import { buildDocumentationMap } from "./map-builder.ts"
import type { DocumentationRenderer } from "./playwright-renderer.ts"
import { safeFetchText } from "./safe-fetch.ts"
import type {
  CrawlWarning,
  DocumentationMap,
  PreviousPageSnapshot,
  PreparedPage,
} from "./types.ts"
import { DocumentationUrlPolicy } from "./url-policy.ts"

interface RobotsPolicy {
  isAllowed(url: string, userAgent?: string): boolean | undefined
  getSitemaps(): string[]
}

export interface WebDocumentationOptions {
  readonly applicationId: string
  readonly roots: readonly string[]
  readonly allowHttp?: boolean
  readonly allowPrivateNetworkForTests?: boolean
  readonly maxPages?: number
  readonly maxTotalBytes?: number
  readonly maxPageBytes?: number
  readonly timeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly maxRequestRetries?: number
  readonly maxSitemaps?: number
  readonly minimumSuccessfulPages?: number
  readonly previousPages?: readonly PreviousPageSnapshot[]
  readonly userAgent?: string
  readonly clientRenderedPaths?: readonly string[]
  readonly renderer?: DocumentationRenderer
  readonly signal?: AbortSignal
}

function extractCanonical(html: string, base: string): string | undefined {
  const document = new JSDOM(html, { url: base }).window.document
  return (
    document
      .querySelector('link[rel~="canonical"][href]')
      ?.getAttribute("href") ?? undefined
  )
}

async function parseSitemapSafely(content: string): Promise<{
  readonly pages: readonly string[]
  readonly nested: readonly string[]
}> {
  const pages: string[] = []
  const nested: string[] = []
  for await (const item of parseSitemap([{ type: "raw", content }], undefined, {
    emitNestedSitemaps: true,
    maxDepth: 0,
    reportNetworkErrors: false,
  })) {
    if (item.originSitemapUrl === null) nested.push(item.loc)
    else pages.push(item.loc)
  }
  return { pages, nested }
}

function configuredForRendering(
  url: string,
  patterns: readonly string[]
): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern
    return new URL(url).pathname.startsWith(normalized)
  })
}

export async function crawlWebDocumentation(
  options: WebDocumentationOptions
): Promise<DocumentationMap> {
  const maxPages = options.maxPages ?? 500
  const maxTotalBytes = options.maxTotalBytes ?? 32 * 1_024 * 1_024
  const maxPageBytes = options.maxPageBytes ?? 2 * 1_024 * 1_024
  const timeoutMs = options.timeoutMs ?? 120_000
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000
  const maxRequestRetries = options.maxRequestRetries ?? 2
  const maxSitemaps = options.maxSitemaps ?? 20
  const userAgent = options.userAgent ?? "SentinelDocumentationBot/0.0.1"
  const parseRobots = robotsParser as unknown as (
    url: string,
    content: string
  ) => RobotsPolicy
  if (
    maxPages < 1 ||
    maxPages > 10_000 ||
    maxTotalBytes < 1 ||
    maxPageBytes < 1 ||
    maxRequestRetries < 0 ||
    maxRequestRetries > 10 ||
    maxSitemaps < 0 ||
    maxSitemaps > 100
  ) {
    throw new DocumentationSourceError(
      "invalid_input",
      "Web documentation limits are invalid"
    )
  }
  const policy = new DocumentationUrlPolicy({
    roots: options.roots,
    ...(options.allowHttp === undefined
      ? {}
      : { allowHttp: options.allowHttp }),
    ...(options.allowPrivateNetworkForTests === undefined
      ? {}
      : { allowPrivateNetworkForTests: options.allowPrivateNetworkForTests }),
  })
  const dispatcher = policy.createDispatcher()
  const startedAt = Date.now()
  const robotsByOrigin = new Map<string, RobotsPolicy>()
  const sitemapQueue: string[] = []
  const sitemapSeen = new Set<string>()
  let fetchedBytes = 0

  try {
    for (const root of policy.roots) {
      const origin = new URL(root).origin
      if (robotsByOrigin.has(origin)) continue
      const robotsUrl = policy.canonicalizeControl("/robots.txt", origin)
      try {
        const response = await safeFetchText(robotsUrl, {
          policy,
          dispatcher,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: requestTimeoutMs,
          maxBytes: Math.min(maxPageBytes, 512 * 1_024),
          userAgent,
          controlRequest: true,
        })
        if (response.status === 429 || response.status >= 500) {
          throw new DocumentationSourceError(
            "fetch_failed",
            "robots.txt was temporarily unavailable",
            { retryable: true }
          )
        }
        const robots = parseRobots(
          robotsUrl,
          response.status === 404 ? "" : response.body
        )
        robotsByOrigin.set(origin, robots)
        for (const sitemap of robots.getSitemaps()) {
          try {
            sitemapQueue.push(policy.canonicalizeControl(sitemap, origin))
          } catch {
            // An off-origin robots directive is not permitted to expand crawl authority.
          }
        }
      } catch (error) {
        const normalized = documentationError(error)
        if (
          normalized.code === "aborted" ||
          normalized.code === "unsafe_destination" ||
          normalized.retryable
        ) {
          throw normalized
        }
        robotsByOrigin.set(origin, parseRobots(robotsUrl, ""))
      }
      sitemapQueue.push(policy.canonicalizeControl("/sitemap.xml", origin))
    }

    const sitemapPages: string[] = []
    while (sitemapQueue.length > 0 && sitemapSeen.size < maxSitemaps) {
      const sitemapUrl = sitemapQueue.shift()
      if (sitemapUrl === undefined || sitemapSeen.has(sitemapUrl)) continue
      sitemapSeen.add(sitemapUrl)
      try {
        const response = await safeFetchText(sitemapUrl, {
          policy,
          dispatcher,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: requestTimeoutMs,
          maxBytes: Math.min(maxPageBytes, 2 * 1_024 * 1_024),
          userAgent,
          controlRequest: true,
        })
        if (response.status >= 400) continue
        const parsed = await parseSitemapSafely(response.body)
        for (const page of parsed.pages) {
          try {
            const candidate = policy.canonicalize(page, sitemapUrl)
            if (
              robotsByOrigin
                .get(new URL(candidate).origin)
                ?.isAllowed(candidate, userAgent) !== false
            ) {
              sitemapPages.push(candidate)
            }
          } catch {
            // Sitemap entries are candidates only and cannot widen approved scope.
          }
        }
        for (const nested of parsed.nested) {
          try {
            sitemapQueue.push(policy.canonicalizeControl(nested, sitemapUrl))
          } catch {
            // Nested sitemaps remain restricted to the approved origin.
          }
        }
      } catch (error) {
        const normalized = documentationError(error)
        if (
          normalized.code === "aborted" ||
          normalized.code === "unsafe_destination"
        ) {
          throw normalized
        }
      }
    }

    const configuration = new Configuration({
      persistStorage: false,
      purgeOnStart: true,
    })
    const storage = new MemoryStorage({ persistStorage: false })
    const queue = await RequestQueue.open(null, {
      config: configuration,
      storageClient: storage,
    })
    const seeds = [...new Set([...policy.roots, ...sitemapPages])].sort()
    const allowedSeeds = seeds.filter(
      (seed) =>
        robotsByOrigin.get(new URL(seed).origin)?.isAllowed(seed, userAgent) !==
        false
    )
    const enqueuedUris = new Set<string>()
    let frontierTruncated = allowedSeeds.length > maxPages
    for (const seed of allowedSeeds.slice(0, maxPages)) {
      await queue.addRequest({ url: seed })
      enqueuedUris.add(seed)
    }
    const prepared: PreparedPage[] = []
    const failedUris: string[] = []
    const warnings: CrawlWarning[] = []

    const crawler = new BasicCrawler(
      {
        requestQueue: queue,
        maxConcurrency: 1,
        maxRequestRetries,
        maxRequestsPerCrawl: maxPages,
        requestHandlerTimeoutSecs: Math.ceil(requestTimeoutMs / 1_000) + 2,
        requestHandler: async ({ request }) => {
          if (options.signal?.aborted === true) {
            request.noRetry = true
            throw new DocumentationSourceError(
              "aborted",
              "Documentation crawl was cancelled"
            )
          }
          if (Date.now() - startedAt >= timeoutMs) {
            request.noRetry = true
            warnings.push({
              code: "time_limit_reached",
              message: "Web documentation time limit was reached",
            })
            return
          }
          const requestedUrl = policy.canonicalize(request.url)
          const robots = robotsByOrigin.get(new URL(requestedUrl).origin)
          if (robots?.isAllowed(requestedUrl, userAgent) === false) {
            request.noRetry = true
            throw new DocumentationSourceError(
              "robots_denied",
              "Documentation page is disallowed by robots.txt"
            )
          }
          const remainingBytes = maxTotalBytes - fetchedBytes
          if (remainingBytes <= 0) {
            request.noRetry = true
            warnings.push({
              code: "byte_limit_reached",
              message: "Web documentation byte limit was reached",
            })
            return
          }
          try {
            const response = await safeFetchText(requestedUrl, {
              policy,
              dispatcher,
              ...(options.signal === undefined
                ? {}
                : { signal: options.signal }),
              timeoutMs: requestTimeoutMs,
              maxBytes: Math.min(maxPageBytes, remainingBytes),
              userAgent,
            })
            if (response.status === 429 || response.status >= 500) {
              throw new DocumentationSourceError(
                "fetch_failed",
                "Documentation source returned a transient failure",
                { retryable: true }
              )
            }
            if (response.status >= 400) {
              request.noRetry = true
              throw new DocumentationSourceError(
                "fetch_failed",
                "Documentation page was unavailable"
              )
            }
            if (
              response.contentType !== "text/html" &&
              response.contentType !== ""
            ) {
              request.noRetry = true
              throw new DocumentationSourceError(
                "invalid_content",
                "Documentation page is not HTML"
              )
            }
            fetchedBytes += response.bytes
            let html = response.body
            const canRender =
              options.renderer !== undefined &&
              configuredForRendering(
                response.finalUrl,
                options.clientRenderedPaths ?? []
              )
            const authorizeRenderedRequest = async (target: string) => {
              const canonical = policy.canonicalize(target, response.finalUrl)
              await policy.assertResolvedTarget(canonical)
            }
            let parsed
            try {
              parsed = parseHtmlDocument(html, response.finalUrl)
            } catch (error) {
              if (!canRender || options.renderer === undefined) throw error
              html = await options.renderer.render(
                response.finalUrl,
                options.signal,
                authorizeRenderedRequest
              )
              parsed = parseHtmlDocument(html, response.finalUrl)
            }
            if (
              parsed.sanitizedText.length < 80 &&
              canRender &&
              options.renderer !== undefined
            ) {
              html = await options.renderer.render(
                response.finalUrl,
                options.signal,
                authorizeRenderedRequest
              )
              parsed = parseHtmlDocument(html, response.finalUrl)
            }
            const canonicalHint = extractCanonical(html, response.finalUrl)
            let canonicalUri = response.finalUrl
            if (canonicalHint !== undefined) {
              try {
                canonicalUri = policy.canonicalize(
                  canonicalHint,
                  response.finalUrl
                )
              } catch {
                // An invalid canonical hint is ignored rather than granted authority.
              }
            }
            const links = parsed.links
              .map((link) => {
                try {
                  return policy.canonicalize(link, response.finalUrl)
                } catch {
                  return undefined
                }
              })
              .filter((link): link is string => link !== undefined)
              .filter(
                (link) =>
                  robotsByOrigin
                    .get(new URL(link).origin)
                    ?.isAllowed(link, userAgent) !== false
              )
            prepared.push({
              sourceUri: response.finalUrl,
              canonicalUri,
              mediaType: "text/html",
              document: { ...parsed, links },
            })
            for (const link of [...new Set(links)].sort()) {
              if (enqueuedUris.has(link)) continue
              if (enqueuedUris.size >= maxPages) {
                frontierTruncated = true
                break
              }
              await queue.addRequest({ url: link })
              enqueuedUris.add(link)
            }
          } catch (error) {
            const normalized = documentationError(error)
            if (!normalized.retryable) request.noRetry = true
            throw normalized
          }
        },
        failedRequestHandler: ({ request }) => {
          failedUris.push(request.url)
        },
      },
      configuration
    )
    await crawler.run()
    if (frontierTruncated) {
      warnings.push({
        code: "page_limit_reached",
        message: "Web documentation page limit was reached",
      })
    }
    return buildDocumentationMap({
      applicationId: options.applicationId,
      kind: "web",
      rootUri: policy.roots[0] ?? options.roots[0] ?? "",
      pages: prepared,
      failedUris,
      warnings,
      attemptedPages: prepared.length + failedUris.length,
      fetchedBytes,
      ...(options.minimumSuccessfulPages === undefined
        ? {}
        : { minimumSuccessfulPages: options.minimumSuccessfulPages }),
      ...(options.previousPages === undefined
        ? {}
        : { previousPages: options.previousPages }),
    })
  } finally {
    await dispatcher.close()
  }
}
