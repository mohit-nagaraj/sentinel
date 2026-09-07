import { redactPersistedText } from "@sentinel/contracts"

export const SCREENSHOT_MASK_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
].join(",")

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const paymentCardPattern = /\b(?:\d[ -]*?){13,19}\b/g
const phonePattern = /(?<!\w)(?:\+?\d[\d ().-]{7,}\d)(?!\w)/g
const sensitivePathLabelPattern =
  /^(?:access|activate|activation|auth|callback|code|confirm|confirmation|credential|invite|login|magic(?:[-_]?link)?|oauth|password|recover|recovery|reset|secret|session|signature|t|token|verify|verification)$/i
const identifierPathPattern =
  /^(?:\d+|[0-9a-f]{20,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_~.-]{32,})$/i

function looksOpaquePathSegment(value: string): boolean {
  if (identifierPathPattern.test(value)) return true
  if (!/^[A-Za-z0-9_-]{12,}$/.test(value)) return false
  return (
    (/[a-z]/.test(value) && /[A-Z]/.test(value)) ||
    (/[A-Za-z]/.test(value) && /\d/.test(value) && value.length >= 16)
  )
}

export const SCREENSHOT_PII_PATTERNS = [
  new RegExp(emailPattern.source, "i"),
  new RegExp(paymentCardPattern.source),
  new RegExp(phonePattern.source),
] as const

function replaceExact(value: string, secret: string): string {
  if (secret.length === 0) return value
  return value.split(secret).join("[REDACTED]")
}

export class BrowserEvidenceRedactor {
  private readonly secrets: readonly string[]

  constructor(secrets: Iterable<string> = []) {
    this.secrets = [...secrets]
      .filter((secret) => secret.length > 0)
      .sort((left, right) => right.length - left.length)
  }

  redactText(input: string, maxLength = 4_096): string {
    let value = input
    for (const secret of this.secrets) value = replaceExact(value, secret)
    value = redactPersistedText(value)
      .replace(
        /(?:waiting for )?\b(?:locator|getByRole|getByLabel|getByText)\([^\r\n]*/gi,
        "[INTERNAL_TARGET]"
      )
      .replace(emailPattern, "[EMAIL_REDACTED]")
      .replace(paymentCardPattern, "[PAYMENT_REDACTED]")
      .replace(phonePattern, "[PHONE_REDACTED]")
      .replace(/\s+/g, " ")
      .trim()
    if (value.length === 0) return "[EMPTY]"
    if (value.length <= maxLength) return value
    return `${value.slice(0, Math.max(1, maxLength - 11))}[TRUNCATED]`
  }

  redactUrl(input: string): string {
    const url = new URL(input)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    const rawSegments = url.pathname.split("/")
    const segments = rawSegments.map((segment, index) => {
      if (segment.length === 0) return segment
      let decoded: string
      let prior = ""
      try {
        decoded = decodeURIComponent(segment)
        prior = decodeURIComponent(rawSegments[index - 1] ?? "")
      } catch {
        return "redacted"
      }
      if (
        sensitivePathLabelPattern.test(prior) ||
        looksOpaquePathSegment(decoded)
      ) {
        return "redacted"
      }
      const redacted = this.redactText(decoded, 512)
      return redacted === decoded ? segment : "redacted"
    })
    url.pathname = segments.join("/")
    return url.toString()
  }

  errorMessage(error: unknown): string {
    if (error instanceof Error) return this.redactText(error.message, 1_024)
    if (typeof error === "string") return this.redactText(error, 1_024)
    return "Browser operation failed"
  }
}
