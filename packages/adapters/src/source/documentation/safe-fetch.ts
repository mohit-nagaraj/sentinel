import type { Dispatcher } from "undici"
import { fetch } from "undici"

import { DocumentationSourceError, documentationError } from "./errors.ts"
import type { DocumentationUrlPolicy } from "./url-policy.ts"

export interface SafeFetchResult {
  readonly body: string
  readonly bytes: number
  readonly contentType: string
  readonly finalUrl: string
  readonly status: number
}

export interface SafeFetchOptions {
  readonly policy: DocumentationUrlPolicy
  readonly dispatcher: Dispatcher
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly maxRedirects?: number
  readonly userAgent: string
  readonly controlRequest?: boolean
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<{ body: string; bytes: number }> {
  if (body === null) return { body: "", bytes: 0 }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) {
        throw new DocumentationSourceError(
          "limit_exceeded",
          "Documentation response exceeded the configured byte limit"
        )
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return {
      body: new TextDecoder("utf-8", { fatal: true }).decode(combined),
      bytes,
    }
  } catch (error) {
    throw new DocumentationSourceError(
      "invalid_content",
      "Documentation response is not valid UTF-8",
      { cause: error }
    )
  }
}

export async function safeFetchText(
  input: string,
  options: SafeFetchOptions
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5
  let url = options.controlRequest
    ? options.policy.canonicalizeControl(input)
    : options.policy.canonicalize(input)
  const signals = [AbortSignal.timeout(options.timeoutMs)]
  if (options.signal !== undefined) signals.push(options.signal)
  const signal = AbortSignal.any(signals)
  try {
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      options.policy.assertNetworkTarget(url)
      const response = await fetch(url, {
        dispatcher: options.dispatcher,
        headers: {
          accept:
            "text/html,text/markdown,text/plain,application/xml,text/xml;q=0.9",
          "user-agent": options.userAgent,
        },
        redirect: "manual",
        signal,
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        await response.body?.cancel()
        if (location === null) {
          throw new DocumentationSourceError(
            "fetch_failed",
            "Documentation redirect omitted its destination"
          )
        }
        if (redirect === maxRedirects) {
          throw new DocumentationSourceError(
            "limit_exceeded",
            "Documentation redirect limit was reached"
          )
        }
        url = options.controlRequest
          ? options.policy.canonicalizeControl(location, url)
          : options.policy.canonicalize(location, url)
        continue
      }
      const contentLength = response.headers.get("content-length")
      if (
        contentLength !== null &&
        Number.isSafeInteger(Number(contentLength)) &&
        Number(contentLength) > options.maxBytes
      ) {
        await response.body?.cancel()
        throw new DocumentationSourceError(
          "limit_exceeded",
          "Documentation response declared more bytes than allowed"
        )
      }
      const content = await readBody(
        response.body as unknown as ReadableStream<Uint8Array> | null,
        options.maxBytes
      )
      return {
        ...content,
        contentType:
          response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase() ?? "",
        finalUrl: url,
        status: response.status,
      }
    }
    throw new DocumentationSourceError(
      "limit_exceeded",
      "Documentation redirect limit was reached"
    )
  } catch (error) {
    throw documentationError(error)
  }
}
