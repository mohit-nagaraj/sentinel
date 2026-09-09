import { describe, expect, it } from "vitest"

import {
  onboardingConfigurationSchema,
  type OnboardingConfiguration,
} from "@sentinel/contracts"

import {
  CompatibilityInspector,
  resolvePinnedBrowserHost,
  type ApplicationReadinessProbe,
  type RepositoryCompatibilityProbe,
  type RepositoryCompatibilitySnapshot,
  type UrlReadinessProbe,
} from "./compatibility.ts"

const fixedTime = new Date("2026-09-08T00:00:00.000Z")

function configuration(): OnboardingConfiguration {
  return onboardingConfigurationSchema.parse({
    schemaVersion: 1,
    name: "Hi.Events",
    deploymentUrl: "https://demo.hi.events",
    repository: {
      url: "https://github.com/mohit-nagaraj/Hi.Events",
      ref: "develop",
      accessMode: "manual",
    },
    documentationSources: ["https://hi.events/docs", "repository://README.md"],
    authentication: { method: "none", revision: 0 },
    crawl: {
      allowedHosts: ["demo.hi.events"],
      maxActions: 40,
      maxScreens: 20,
      maxDurationSeconds: 300,
      allowFormSubmission: true,
      denyDestructiveActions: true,
      denyRealPayments: true,
      denyExternalMessaging: true,
      denyPrivilegeChanges: true,
    },
    capabilityHints: ["Attendee checkout"],
  })
}

class FakeRepositoryProbe implements RepositoryCompatibilityProbe {
  disposeCalls = 0
  openCalls = 0

  constructor(
    private readonly files: Readonly<Record<string, string>>,
    private readonly identity = "mohit-nagaraj/hi.events",
    private readonly failure?: Error
  ) {}

  async open(): Promise<RepositoryCompatibilitySnapshot> {
    this.openCalls += 1
    if (this.failure !== undefined) throw this.failure
    return {
      identity: this.identity,
      resolvedCommitSha: "a".repeat(40),
      paths: Object.keys(this.files).sort(),
      readText: async (path) => {
        const value = this.files[path]
        if (value === undefined) throw new Error("Fixture file not found")
        return value
      },
      dispose: async () => {
        this.disposeCalls += 1
      },
    }
  }
}

class FakeUrlProbe implements UrlReadinessProbe {
  readonly checked: string[] = []

  constructor(private readonly failures = new Set<string>()) {}

  async check(url: string) {
    this.checked.push(url)
    if (this.failures.has(url)) {
      throw new Error("Destination resolved to a private or unavailable host")
    }
    return { finalUrl: url, status: 200, contentType: "text/html" }
  }
}

class FakeApplicationProbe implements ApplicationReadinessProbe {
  constructor(private readonly failure?: Error) {}

  async check(url: string, allowedOrigins: readonly string[]) {
    if (this.failure !== undefined) throw this.failure
    expect(allowedOrigins).toEqual(["https://demo.hi.events"])
    return { finalUrl: url, title: "Hi.Events" }
  }
}

const supportedFiles = {
  "README.md": "# Hi.Events",
  "frontend/package.json": JSON.stringify({
    dependencies: { react: "19.0.0" },
  }),
  "frontend/src/App.tsx": "export function App() { return null }",
  "composer.json": JSON.stringify({
    require: {
      "laravel/framework": "^13.0",
      "dedoc/scramble": "^0.13",
    },
  }),
  artisan: "#!/usr/bin/env php",
  "routes/api.php": "<?php",
  "playwright.config.ts": "export default {}",
} as const

function inspector(input: {
  repository: RepositoryCompatibilityProbe
  urls?: UrlReadinessProbe
  application?: ApplicationReadinessProbe
  approvedRepositories?: ReadonlySet<string>
}) {
  return new CompatibilityInspector({
    repository: input.repository,
    urls: input.urls ?? new FakeUrlProbe(),
    application: input.application ?? new FakeApplicationProbe(),
    ...(input.approvedRepositories === undefined
      ? {}
      : { approvedRepositories: input.approvedRepositories }),
    now: () => fixedTime,
  })
}

describe("onboarding compatibility inspector", () => {
  it("reports the complete Hi.Events adapter contract from cited evidence", async () => {
    const repository = new FakeRepositoryProbe(supportedFiles)

    const report = await inspector({ repository }).inspect(configuration())

    expect(report).toMatchObject({
      status: "supported",
      resolvedCommitSha: "a".repeat(40),
      selectedAdapters: [
        "laravel_routes",
        "openapi_scramble",
        "php_laravel",
        "playwright",
        "playwright_network",
        "typescript_react",
      ],
      findings: [],
      inspectedAt: fixedTime.toISOString(),
    })
    expect(
      report.evidence.map(({ capability, status }) => [capability, status])
    ).toEqual(
      expect.arrayContaining([
        ["typescript_react", "detected"],
        ["php_laravel", "detected"],
        ["laravel_routes", "detected"],
        ["openapi_scramble", "detected"],
        ["playwright_assets", "detected"],
        ["application_reachable", "detected"],
        ["documentation_reachable", "detected"],
      ])
    )
    expect(report.proposedScope).toMatchObject({
      documentationSources: [
        "https://hi.events/docs",
        "repository://README.md",
      ],
      applicationOrigins: ["https://demo.hi.events/"],
      maxActions: 40,
    })
    expect(repository.openCalls).toBe(1)
    expect(repository.disposeCalls).toBe(1)
  })

  it("uses warnings for optional Playwright target assets", async () => {
    const partialFiles = Object.fromEntries(
      Object.entries(supportedFiles).filter(
        ([path]) => path !== "playwright.config.ts"
      )
    )
    const repository = new FakeRepositoryProbe(partialFiles)

    const report = await inspector({ repository }).inspect(configuration())

    expect(report.status).toBe("partial")
    expect(report.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "playwright_assets_missing",
      }),
    ])
    expect(report.selectedAdapters).not.toContain("playwright")
    expect(repository.disposeCalls).toBe(1)
  })

  it("detects Laravel in a nested application root", async () => {
    const nestedFiles = Object.fromEntries(
      Object.entries(supportedFiles)
        .filter(([path]) => path !== "composer.json" && path !== "artisan")
        .concat([
          ["backend/composer.json", supportedFiles["composer.json"]],
          ["backend/artisan", supportedFiles["artisan"]],
        ])
    )
    const repository = new FakeRepositoryProbe(nestedFiles)

    const report = await inspector({ repository }).inspect(configuration())

    expect(report.evidence).toContainEqual(
      expect.objectContaining({
        capability: "php_laravel",
        status: "detected",
        references: ["backend/composer.json", "backend/artisan"],
      })
    )
    expect(report.findings).not.toContainEqual(
      expect.objectContaining({ code: "php_laravel_missing" })
    )
  })

  it("blocks protected targets until automated login is explicitly confirmed", async () => {
    const protectedConfiguration = onboardingConfigurationSchema.parse({
      ...configuration(),
      authentication: {
        method: "credentials",
        automationConfirmed: false,
        revision: 1,
        fields: [
          {
            key: "password",
            label: "Password",
            reference: `secret-ref:v1:${"f".repeat(64)}`,
          },
        ],
      },
    })

    const report = await inspector({
      repository: new FakeRepositoryProbe(supportedFiles),
    }).inspect(protectedConfiguration)

    expect(report.status).toBe("blocked")
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "authentication_requires_confirmation",
        severity: "blocker",
      })
    )
    expect(report.evidence).toContainEqual(
      expect.objectContaining({
        capability: "authentication_automatable",
        status: "blocked",
      })
    )
  })

  it("blocks unapproved, unsafe, unreachable, and incomplete targets", async () => {
    const repository = new FakeRepositoryProbe(
      { "README.md": "# Other" },
      "other/example"
    )
    const urls = new FakeUrlProbe(
      new Set(["https://hi.events/docs", "https://demo.hi.events/"])
    )

    const unapprovedConfiguration = onboardingConfigurationSchema.parse({
      ...configuration(),
      repository: {
        url: "https://github.com/other/example",
        ref: "main",
        accessMode: "manual",
      },
    })
    const report = await inspector({
      repository,
      urls,
      application: new FakeApplicationProbe(
        new Error("Redirect left the approved origin")
      ),
    }).inspect(unapprovedConfiguration)

    expect(report.status).toBe("blocked")
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "application_unreachable",
      "documentation_source_unreachable",
      "repository_not_approved",
    ])
    expect(report.humanActions).toHaveLength(3)
    expect(JSON.stringify(report)).not.toContain("Redirect left")
    expect(repository.openCalls).toBe(0)
    expect(repository.disposeCalls).toBe(0)
  })

  it("is deterministic apart from a supplied clock and always disposes checkout", async () => {
    const first = await inspector({
      repository: new FakeRepositoryProbe(supportedFiles),
    }).inspect(configuration())
    const failingRepository = new FakeRepositoryProbe(supportedFiles)
    const second = await inspector({
      repository: failingRepository,
      application: new FakeApplicationProbe(new Error("browser failed")),
    }).inspect(configuration())

    expect(first.inputFingerprint).toBe(second.inputFingerprint)
    expect(second.status).toBe("blocked")
    expect(failingRepository.disposeCalls).toBe(1)
  })

  it("pins public DNS results and rejects any private or reserved answer", async () => {
    await expect(
      resolvePinnedBrowserHost("https://demo.hi.events", {
        resolver: {
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        },
      })
    ).resolves.toEqual({
      hostname: "demo.hi.events",
      address: "8.8.8.8",
    })
    await expect(
      resolvePinnedBrowserHost("https://demo.hi.events", {
        resolver: {
          lookup: async () => [
            { address: "8.8.8.8", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ],
        },
      })
    ).rejects.toThrow("private or reserved")
    await expect(resolvePinnedBrowserHost("https://127.0.0.1")).rejects.toThrow(
      "private or reserved"
    )
  })
})
