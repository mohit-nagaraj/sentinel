import {
  browserPolicyDecisionSchema,
  type BrowserActionKind,
  type BrowserPolicyCategory,
  type BrowserPolicyDecision,
} from "@sentinel/contracts"
import { z } from "zod"

const safeCategories = new Set<BrowserPolicyCategory>([
  "safe_read",
  "safe_navigation",
  "safe_form_progress",
  "credential_entry",
])

const browserBudgetSchema = z.strictObject({
  maxActions: z.number().int().min(1).max(500).default(50),
  maxDurationMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  maxScreens: z.number().int().min(1).max(500).default(100),
  maxRedirects: z.number().int().min(0).max(50).default(10),
  maxTabs: z.number().int().min(1).max(10).default(1),
  maxDownloads: z.number().int().min(0).max(20).default(0),
  maxInputLength: z.number().int().min(1).max(16_384).default(2_048),
  actionTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  navigationTimeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  actionExpiryMs: z.number().int().min(100).max(300_000).default(30_000),
  observationSettleMs: z.number().int().min(0).max(5_000).default(50),
})

export type BrowserBudgets = z.infer<typeof browserBudgetSchema>

export interface BrowserPolicy {
  readonly allowedOrigins: ReadonlySet<string>
  readonly allowedCategories: ReadonlySet<BrowserPolicyCategory>
  readonly allowInsecureLocalhost: boolean
  readonly budgets: BrowserBudgets
}

export interface BrowserPolicyInput {
  readonly allowedOrigins: readonly string[]
  readonly allowedCategories?: readonly BrowserPolicyCategory[]
  readonly allowInsecureLocalhost?: boolean
  readonly budgets?: Partial<BrowserBudgets>
}

export interface ActionClassificationInput {
  readonly kind: BrowserActionKind
  readonly role?: string | undefined
  readonly name?: string | undefined
  readonly inputSlot?: string | undefined
  readonly targetUrl?: string | undefined
  readonly submit?: boolean | undefined
  readonly download?: boolean | undefined
  readonly opensNewTab?: boolean | undefined
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  )
}

export function canonicalizeAllowedOrigin(
  input: string,
  allowInsecureLocalhost = false
): string {
  const url = new URL(input)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Allowed origins cannot contain credentials")
  }
  if (url.protocol !== "https:") {
    const allowedHttp =
      url.protocol === "http:" &&
      allowInsecureLocalhost &&
      isLoopback(url.hostname)
    if (!allowedHttp) throw new Error("Browser origins require HTTPS")
  }
  if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
    throw new Error(
      "Allowed origins must not include a path, query, or fragment"
    )
  }
  return url.origin
}

export function createBrowserPolicy(input: BrowserPolicyInput): BrowserPolicy {
  const allowInsecureLocalhost = input.allowInsecureLocalhost ?? false
  if (input.allowedOrigins.length === 0) {
    throw new Error("At least one browser origin must be allowlisted")
  }
  const allowedOrigins = new Set(
    input.allowedOrigins.map((origin) =>
      canonicalizeAllowedOrigin(origin, allowInsecureLocalhost)
    )
  )
  const allowedCategories = new Set(
    input.allowedCategories ?? [...safeCategories]
  )
  return {
    allowedOrigins,
    allowedCategories,
    allowInsecureLocalhost,
    budgets: browserBudgetSchema.parse(input.budgets ?? {}),
  }
}

export function isAllowedBrowserUrl(
  input: string,
  policy: BrowserPolicy
): boolean {
  try {
    const url = new URL(input)
    if (url.username.length > 0 || url.password.length > 0) return false
    if (url.protocol !== "https:") {
      if (
        url.protocol !== "http:" ||
        !policy.allowInsecureLocalhost ||
        !isLoopback(url.hostname)
      ) {
        return false
      }
    }
    return policy.allowedOrigins.has(url.origin)
  } catch {
    return false
  }
}

export function isAllowedBrowserWebSocketUrl(
  input: string,
  policy: BrowserPolicy
): boolean {
  try {
    const url = new URL(input)
    if (url.protocol === "wss:") url.protocol = "https:"
    else if (url.protocol === "ws:") url.protocol = "http:"
    else return false
    return isAllowedBrowserUrl(url.toString(), policy)
  } catch {
    return false
  }
}

export function normalizeRoute(input: string): string {
  const pathname = new URL(input, "https://sentinel.invalid").pathname
  const normalized = pathname
    .split("/")
    .map((segment) => {
      if (/^\d+$/.test(segment)) return "{id}"
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return "{id}"
      if (/^[0-9a-f]{24,64}$/i.test(segment)) return "{id}"
      return segment
    })
    .join("/")
  return normalized.length === 0 ? "/" : normalized
}

export function toPublicBrowserUrl(input: string): string {
  const url = new URL(input)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("Observed URL contained credentials")
  }
  url.search = ""
  url.hash = ""
  return url.toString()
}

function classifyUnsafeName(name: string): BrowserPolicyCategory | undefined {
  if (
    /\b(delete|destroy|erase|remove|terminate|cancel account|close account|close registration|refund|revoke|disable|archive)\b/i.test(
      name
    )
  ) {
    return "destructive"
  }
  if (
    /\b(pay|payment|purchase|buy|place order|complete order|card|billing)\b/i.test(
      name
    )
  ) {
    return "payment"
  }
  if (
    /\b(admin|administrator|permission|privilege|change role|promote|demote|grant)\b/i.test(
      name
    )
  ) {
    return "account_privilege"
  }
  if (
    /\b(send|email|message|notify|publish|broadcast|invite|post|comment|reply)\b/i.test(
      name
    )
  ) {
    return "external_message"
  }
  if (
    /\b(save|create|update|submit|confirm|approve|reserve|register|upload|add)\b/i.test(
      name
    )
  ) {
    return "unknown_submission"
  }
  return undefined
}

function isSafeReadName(name: string): boolean {
  return (
    /^(?:details?|preview|summary|status)$/i.test(name) ||
    /^(?:view|show|inspect|preview)\b/i.test(name) ||
    /^(?:open|dismiss|close)\s+(?:modal|dialog|menu|panel|popover|drawer|section|details?|preview|window)$/i.test(
      name
    ) ||
    /^(?:expand|collapse)\b/i.test(name) ||
    /^refresh\s+(?:state|status|view|page|preview)$/i.test(name) ||
    /^load\s+(?:[a-z0-9_-]+\s+){0,3}(?:details?|summary|status|preview|page|response|state)$/i.test(
      name
    )
  )
}

export function classifyBrowserAction(
  input: ActionClassificationInput,
  policy: BrowserPolicy
): BrowserPolicyDecision {
  const name = input.name?.trim() ?? ""
  let category: BrowserPolicyCategory

  if (input.download) {
    category = "download"
  } else if (input.opensNewTab) {
    category = "popup"
  } else if (
    input.targetUrl !== undefined &&
    !isAllowedBrowserUrl(input.targetUrl, policy)
  ) {
    category = "external_navigation"
  } else if (input.kind === "fill" || input.kind === "select") {
    category =
      input.inputSlot === undefined ? "unknown_submission" : "credential_entry"
  } else {
    const unsafe = classifyUnsafeName(name)
    if (unsafe !== undefined) {
      category = unsafe
    } else if (input.submit) {
      category = "unknown_submission"
    } else if (input.kind === "navigate" || input.kind === "back") {
      category = "safe_navigation"
    } else if (input.kind === "reload") {
      category = "safe_read"
    } else if (input.kind === "check") {
      category = "safe_form_progress"
    } else if (isSafeReadName(name)) {
      category = "safe_read"
    } else {
      category = "unknown_submission"
    }
  }

  const allowed = policy.allowedCategories.has(category)
  const replaySafeCategory = safeCategories.has(category)
  return browserPolicyDecisionSchema.parse({
    category,
    allowed,
    reason: allowed ? category : `${category}_denied`,
    replaySafe:
      allowed &&
      replaySafeCategory &&
      input.kind !== "check" &&
      input.kind !== "back" &&
      input.submit !== true,
  })
}
