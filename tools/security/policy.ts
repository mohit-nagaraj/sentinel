import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

import { z } from "zod"

const dateSchema = z.iso.date()
const exceptionFields = {
  rationale: z.string().trim().min(20).max(2_000),
  expiresOn: dateSchema,
}

export const securityPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  allowedLicenses: z.array(z.string().trim().min(1)).min(1),
  licenseExceptions: z.array(
    z.strictObject({
      package: z.string().trim().min(1),
      version: z.string().trim().min(1),
      reportedLicense: z.literal("Unknown"),
      source: z.url({ protocol: /^https$/ }),
      ...exceptionFields,
    })
  ),
  dependencyExceptions: z.array(
    z.strictObject({
      advisory: z.string().regex(/^GHSA-[a-z0-9-]+$/),
      package: z.string().trim().min(1),
      severity: z.enum(["low", "moderate"]),
      source: z.url({ protocol: /^https$/ }),
      ...exceptionFields,
    })
  ),
  secretExceptions: z.array(
    z.strictObject({
      path: z.string().trim().min(1),
      fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      ...exceptionFields,
    })
  ),
})

export type SecurityPolicy = z.infer<typeof securityPolicySchema>

export interface SecurityFinding {
  readonly path: string
  readonly line: number
  readonly rule: string
  readonly fingerprint: string
}

interface SecretRule {
  readonly name: string
  readonly pattern: RegExp
}

const secretRules: readonly SecretRule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9._-]{20,}\b/g,
  },
  {
    name: "github-fine-grained-pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: "openai-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
]

export function loadSecurityPolicy(root: string): SecurityPolicy {
  return securityPolicySchema.parse(
    JSON.parse(readFileSync(resolve(root, "security/policy.json"), "utf8"))
  )
}

export function scanSecretText(path: string, text: string): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  for (const rule of secretRules) {
    for (const match of text.matchAll(rule.pattern)) {
      const index = match.index ?? 0
      const line = text.slice(0, index).split("\n").length
      findings.push({
        path,
        line,
        rule: rule.name,
        fingerprint: fingerprint(`${rule.name}:${match[0]}`),
      })
    }
  }
  return findings
}

export function findUnapprovedSecrets(
  findings: readonly SecurityFinding[],
  policy: SecurityPolicy,
  today: string
): SecurityFinding[] {
  return findings.filter(
    (finding) =>
      !policy.secretExceptions.some(
        (exception) =>
          exception.path === finding.path &&
          exception.fingerprint === finding.fingerprint &&
          exception.expiresOn >= today
      )
  )
}

export function checkTrackedSecrets(
  root: string,
  policy: SecurityPolicy,
  today: string
): { scannedFiles: number; exceptions: number } {
  const listed = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    root
  )
  const paths = listed.stdout
    .split("\0")
    .filter((path) => path.length > 0)
    .sort(compareStrings)
  const findings: SecurityFinding[] = []
  let scannedFiles = 0
  for (const path of paths) {
    const content = readFileSync(resolve(root, path))
    if (content.includes(0)) continue
    scannedFiles += 1
    findings.push(
      ...scanSecretText(path.replaceAll("\\", "/"), content.toString("utf8"))
    )
  }
  const unapproved = findUnapprovedSecrets(findings, policy, today)
  if (unapproved.length > 0) {
    throw new Error(
      `Secret scan found unapproved high-confidence matches:\n${unapproved
        .map(
          ({ path, line, rule, fingerprint }) =>
            `${path}:${line} ${rule} ${fingerprint}`
        )
        .join("\n")}`
    )
  }
  return { scannedFiles, exceptions: findings.length }
}

export function checkSensitiveIgnores(root: string): void {
  const ignored = [
    ".env",
    ".env.local",
    ".env.production",
    ".auth/state.json",
    "playwright/.auth/user.json",
    "github-app.private-key.pem",
  ]
  for (const path of ignored) {
    const result = run(
      "git",
      ["check-ignore", "--no-index", "--quiet", "--", path],
      root,
      true
    )
    if (result.status !== 0) {
      throw new Error(`Sensitive path is not ignored: ${path}`)
    }
  }
  const example = run(
    "git",
    ["check-ignore", "--no-index", "--quiet", "--", ".env.example"],
    root,
    true
  )
  if (example.status === 0) {
    throw new Error(".env.example must remain tracked and reviewable")
  }
}

const licenseInventorySchema = z.record(
  z.string(),
  z.array(
    z.object({
      name: z.string(),
      versions: z.array(z.string()).min(1),
    })
  )
)

export function findLicenseViolations(
  inventoryValue: unknown,
  policy: SecurityPolicy,
  today: string
): string[] {
  const inventory = licenseInventorySchema.parse(inventoryValue)
  const allowed = new Set(policy.allowedLicenses)
  const violations: string[] = []
  for (const [license, packages] of Object.entries(inventory)) {
    for (const package_ of packages) {
      for (const version of package_.versions) {
        const exception = policy.licenseExceptions.find(
          (candidate) =>
            candidate.package === package_.name &&
            candidate.version === version &&
            candidate.reportedLicense === license &&
            candidate.expiresOn >= today
        )
        if (!allowed.has(license) && exception === undefined) {
          violations.push(`${package_.name}@${version}: ${license}`)
        }
      }
    }
  }
  return violations.sort(compareStrings)
}

const auditSchema = z.object({
  advisories: z.record(
    z.string(),
    z.object({
      module_name: z.string(),
      severity: z.enum(["info", "low", "moderate", "high", "critical"]),
      github_advisory_id: z.string(),
    })
  ),
})

export function findDependencyViolations(
  auditValue: unknown,
  policy: SecurityPolicy,
  today: string
): string[] {
  const audit = auditSchema.parse(auditValue)
  return Object.values(audit.advisories)
    .filter((advisory) => {
      if (["high", "critical"].includes(advisory.severity)) return true
      return !policy.dependencyExceptions.some(
        (exception) =>
          exception.advisory === advisory.github_advisory_id &&
          exception.package === advisory.module_name &&
          exception.severity === advisory.severity &&
          exception.expiresOn >= today
      )
    })
    .map(
      (advisory) =>
        `${advisory.github_advisory_id} ${advisory.module_name} (${advisory.severity})`
    )
    .sort(compareStrings)
}

export function readPnpmJson(root: string, arguments_: string[]): unknown {
  const pnpmCli = process.env["npm_execpath"]
  if (pnpmCli === undefined) {
    throw new Error("Security inventory must run through pnpm")
  }
  const result = run(process.execPath, [pnpmCli, ...arguments_], root, true)
  if (result.stdout.trim().length === 0) {
    throw new Error("pnpm security inventory returned no JSON")
  }
  return JSON.parse(result.stdout)
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function run(
  command: string,
  arguments_: string[],
  cwd: string,
  allowFailure = false
): { stdout: string; status: number } {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    shell: false,
    maxBuffer: 32 * 1_024 * 1_024,
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  const status = result.status ?? 1
  if (!allowFailure && status !== 0) {
    throw new Error(`${command} failed with status ${status}`)
  }
  return { stdout: result.stdout, status }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
