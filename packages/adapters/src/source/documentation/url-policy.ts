import { lookup as dnsLookup } from "node:dns"
import type { LookupAddress } from "node:dns"
import { lookup as dnsLookupPromise } from "node:dns/promises"
import { isIP, type LookupFunction } from "node:net"

import ipaddr from "ipaddr.js"
import { Agent } from "undici"
import { z } from "zod"

import { DocumentationSourceError } from "./errors.ts"

const pathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => value.startsWith("/"))
const sensitiveQueryKey =
  /^(?:access_token|api[_-]?key|auth|authorization|client[_-]?secret|code|credential|id_token|key|oauth_token|password|private[_-]?key|refresh_token|secret|session(?:[_-]?id)?|sig|signature|token|x-amz-.+|x-goog-.+)$/i

export interface UrlPolicyOptions {
  readonly roots: readonly string[]
  readonly allowHttp?: boolean
  readonly allowPrivateNetworkForTests?: boolean
}

function unsafe(message: string): never {
  throw new DocumentationSourceError("unsafe_destination", message)
}

function normalizePath(pathname: string): string {
  const decodedSegments = pathname.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return unsafe("Documentation URL contains invalid percent encoding")
    }
  })
  if (decodedSegments.some((segment) => segment === "." || segment === "..")) {
    return unsafe("Documentation URL path contains traversal segments")
  }
  const normalized = pathname.replace(/\/{2,}/g, "/")
  return pathSchema.parse(normalized.length === 0 ? "/" : normalized)
}

function isWithinPath(pathname: string, rootPath: string): boolean {
  const root =
    rootPath.endsWith("/") && rootPath !== "/"
      ? rootPath.slice(0, -1)
      : rootPath
  return root === "/" || pathname === root || pathname.startsWith(`${root}/`)
}

export function canonicalizeDocumentationUrl(
  input: string,
  base?: string
): string {
  if (/\\|%(?:25|2e|2f|5c)/i.test(input)) {
    return unsafe(
      "Documentation URL contains ambiguous encoded path traversal syntax"
    )
  }
  let url: URL
  try {
    url = base === undefined ? new URL(input) : new URL(input, base)
  } catch {
    return unsafe("Documentation URL is invalid")
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return unsafe("Documentation URLs must use HTTP or HTTPS")
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return unsafe("Documentation URLs cannot contain credentials")
  }
  if ([...url.searchParams.keys()].some((key) => sensitiveQueryKey.test(key))) {
    return unsafe(
      "Documentation URLs cannot contain credential query parameters"
    )
  }
  url.hash = ""
  url.pathname = normalizePath(url.pathname)
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key)
  }
  url.searchParams.sort()
  return url.toString()
}

export function isPublicAddress(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(address)
  } catch {
    return false
  }
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address()
  }
  return parsed.range() === "unicast"
}

export class DocumentationUrlPolicy {
  readonly roots: readonly string[]
  private readonly parsedRoots: readonly URL[]
  private readonly allowPrivateNetworkForTests: boolean

  constructor(options: UrlPolicyOptions) {
    if (options.roots.length < 1 || options.roots.length > 20) {
      throw new DocumentationSourceError(
        "invalid_input",
        "Documentation scope must contain between 1 and 20 roots"
      )
    }
    this.roots = Object.freeze(
      [
        ...new Set(
          options.roots.map((root) => canonicalizeDocumentationUrl(root))
        ),
      ].sort()
    )
    this.parsedRoots = this.roots.map((root) => new URL(root))
    if (
      !options.allowHttp &&
      this.parsedRoots.some((root) => root.protocol !== "https:")
    ) {
      throw new DocumentationSourceError(
        "invalid_input",
        "Production documentation roots must use HTTPS"
      )
    }
    this.allowPrivateNetworkForTests =
      options.allowPrivateNetworkForTests ?? false
  }

  canonicalize(input: string, base?: string): string {
    const canonical = canonicalizeDocumentationUrl(input, base)
    this.assertInScope(canonical)
    return canonical
  }

  canonicalizeControl(input: string, base?: string): string {
    const canonical = canonicalizeDocumentationUrl(input, base)
    const candidate = new URL(canonical)
    if (
      !this.parsedRoots.some(
        (root) =>
          candidate.protocol === root.protocol &&
          candidate.hostname === root.hostname &&
          candidate.port === root.port
      )
    ) {
      unsafe("Documentation control URL is outside the approved origin")
    }
    return canonical
  }

  isInScope(input: string, base?: string): boolean {
    try {
      this.canonicalize(input, base)
      return true
    } catch {
      return false
    }
  }

  assertInScope(input: string): void {
    const candidate = new URL(input)
    const allowed = this.parsedRoots.some(
      (root) =>
        candidate.protocol === root.protocol &&
        candidate.hostname === root.hostname &&
        candidate.port === root.port &&
        isWithinPath(candidate.pathname, root.pathname)
    )
    if (!allowed)
      unsafe(
        "Documentation URL is outside the approved host, protocol, port, or path"
      )
  }

  assertAddress(address: string): void {
    if (!this.allowPrivateNetworkForTests && !isPublicAddress(address)) {
      unsafe(
        "Documentation destination resolved to a private or reserved address"
      )
    }
  }

  assertNetworkTarget(input: string): void {
    const hostname = new URL(input).hostname.replace(/^\[|\]$/g, "")
    if (isIP(hostname) !== 0) this.assertAddress(hostname)
  }

  async assertResolvedTarget(input: string): Promise<void> {
    const hostname = new URL(input).hostname.replace(/^\[|\]$/g, "")
    if (isIP(hostname) !== 0) {
      this.assertAddress(hostname)
      return
    }
    const addresses = await dnsLookupPromise(hostname, {
      all: true,
      verbatim: true,
    })
    for (const address of addresses) this.assertAddress(address.address)
  }

  createDispatcher(): Agent {
    const secureLookup = ((
      hostname: string,
      options: Record<string, unknown>,
      callback: (
        error: NodeJS.ErrnoException | null,
        addresses: LookupAddress[]
      ) => void
    ) => {
      dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error !== null) {
          callback(error, [])
          return
        }
        try {
          for (const address of addresses) this.assertAddress(address.address)
          callback(null, addresses)
        } catch (policyError) {
          callback(
            policyError instanceof Error
              ? policyError
              : new Error("Documentation DNS policy rejected the destination"),
            []
          )
        }
      })
    }) as unknown as LookupFunction
    return new Agent({
      connect: {
        lookup: secureLookup,
      },
    })
  }
}
