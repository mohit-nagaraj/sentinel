import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  findDependencyViolations,
  findLicenseViolations,
  findUnapprovedSecrets,
  loadSecurityPolicy,
  scanSecretText,
} from "../../tools/security/policy.ts"

const root = fileURLToPath(new URL("../../", import.meta.url))
const policy = loadSecurityPolicy(root)
const reviewDate = "2026-09-09"

describe("repository security policy", () => {
  it("detects high-confidence secret shapes without emitting their values", () => {
    const classic = ["ghp", "abcdefghijklmnopqrstuvwx"].join("_")
    const fineGrained = ["github", "pat", "A".repeat(40)].join("_")
    const stateless = [
      "ghs",
      "123456",
      ["eyJheader", "eyJpayload", "signature-part"].join("."),
    ].join("_")
    const findings = scanSecretText(
      "fixture.ts",
      [classic, fineGrained, stateless].join("\n")
    )

    expect(findings).toHaveLength(3)
    expect(findings[0]).toMatchObject({
      path: "fixture.ts",
      line: 1,
      rule: "github-token",
    })
    expect(findings.map(({ rule }) => rule)).toEqual([
      "github-token",
      "github-token",
      "github-fine-grained-pat",
    ])
    const serialized = JSON.stringify(findings)
    for (const token of [classic, fineGrained, stateless]) {
      expect(serialized).not.toContain(token)
    }
    expect(findUnapprovedSecrets(findings, policy, reviewDate)).toHaveLength(3)
  })

  it("allows only exact, unexpired dependency exceptions and never high severity", () => {
    const moderate = {
      advisories: {
        "1": {
          module_name: "stream-json",
          severity: "moderate",
          github_advisory_id: "GHSA-528h-pc64-c93x",
        },
      },
    }
    expect(findDependencyViolations(moderate, policy, reviewDate)).toEqual([])
    expect(findDependencyViolations(moderate, policy, "2026-10-10")).toEqual([
      "GHSA-528h-pc64-c93x stream-json (moderate)",
    ])
    expect(
      findDependencyViolations(
        {
          advisories: {
            "1": {
              module_name: "stream-json",
              severity: "high",
              github_advisory_id: "GHSA-528h-pc64-c93x",
            },
          },
        },
        policy,
        reviewDate
      )
    ).toHaveLength(1)
  })

  it("allows known licenses and exact metadata exceptions only", () => {
    expect(
      findLicenseViolations(
        {
          MIT: [{ name: "known", versions: ["1.0.0"] }],
          Unknown: [{ name: "khroma", versions: ["2.1.0"] }],
        },
        policy,
        reviewDate
      )
    ).toEqual([])
    expect(
      findLicenseViolations(
        { Unknown: [{ name: "new-package", versions: ["1.0.0"] }] },
        policy,
        reviewDate
      )
    ).toEqual(["new-package@1.0.0: Unknown"])
  })

  it("keeps live and paid credentials out of default CI", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
      "utf8"
    )
    expect(workflow).toContain("command: pnpm security")
    expect(workflow).not.toMatch(
      /RUN_LIVE_TESTS|RUN_AZURE|AZURE_OPENAI_API_KEY/
    )
  })
})
