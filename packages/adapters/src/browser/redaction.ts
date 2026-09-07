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
        /\b(?:locator|getByRole|getByLabel|getByText)\([^\r\n]*\)(?=\s+(?:failed|resolved|timed out|waiting)|$)/gi,
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
    const segments = url.pathname.split("/").map((segment) => {
      if (segment.length === 0) return segment
      const decoded = decodeURIComponent(segment)
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
