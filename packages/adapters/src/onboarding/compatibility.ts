import type { LookupAddress } from "node:dns"
import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"

import { chromium, type BrowserType } from "playwright"

import {
  compatibilityEvidenceSchema,
  compatibilityFindingSchema,
  compatibilityReportSchema,
  createOnboardingInputFingerprint,
  onboardingConfigurationSchema,
  type CompatibilityCapability,
  type CompatibilityEvidence,
  type CompatibilityFinding,
  type CompatibilityReport,
  type OnboardingConfiguration,
} from "@sentinel/contracts"

import {
  createBrowserPolicy,
  isAllowedBrowserUrl,
  isAllowedBrowserWebSocketUrl,
} from "../browser/policy.ts"
import {
  DocumentationUrlPolicy,
  isPublicAddress,
} from "../source/documentation/url-policy.ts"
import { safeFetchBytes } from "../source/documentation/safe-fetch.ts"
import {
  GitHubSourceConnector,
  type GitHubSourceConnectorOptions,
} from "../source/github/connector.ts"

const APPROVED_REPOSITORIES = new Set([
  "hieventsdev/hi.events",
  "mohit-nagaraj/hi.events",
])

export interface RepositoryCompatibilitySnapshot {
  readonly identity: string
  readonly resolvedCommitSha: string
  readonly paths: readonly string[]
  readText(path: string, maxBytes?: number): Promise<string>
  dispose(): Promise<void>
}

export interface RepositoryCompatibilityProbe {
  open(
    repositoryUrl: string,
    repositoryRef: string,
    signal?: AbortSignal
  ): Promise<RepositoryCompatibilitySnapshot>
}

export interface UrlReadinessResult {
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string
}

export interface UrlReadinessProbe {
  check(url: string, signal?: AbortSignal): Promise<UrlReadinessResult>
}

export interface ApplicationReadinessResult {
  readonly finalUrl: string
  readonly title: string
}

export interface ApplicationReadinessProbe {
  check(
    url: string,
    allowedOrigins: readonly string[],
    signal?: AbortSignal
  ): Promise<ApplicationReadinessResult>
}

export interface BrowserHostResolver {
  lookup(hostname: string): Promise<readonly LookupAddress[]>
}

const defaultBrowserHostResolver: BrowserHostResolver = {
  lookup: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
}

export async function resolvePinnedBrowserHost(
  url: string,
  options: {
    readonly allowPrivateNetworkForTests?: boolean
    readonly resolver?: BrowserHostResolver
  } = {}
): Promise<{ readonly hostname: string; readonly address: string } | null> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "")
  const allowPrivate = options.allowPrivateNetworkForTests ?? false
  if (isIP(hostname) !== 0) {
    if (!allowPrivate && !isPublicAddress(hostname)) {
      throw new Error("Application destination is private or reserved")
    }
    return null
  }
  const addresses = await (
    options.resolver ?? defaultBrowserHostResolver
  ).lookup(hostname)
  if (addresses.length === 0) {
    throw new Error("Application destination did not resolve")
  }
  if (
    !allowPrivate &&
    addresses.some((entry) => !isPublicAddress(entry.address))
  ) {
    throw new Error("Application destination is private or reserved")
  }
  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0]
  if (selected === undefined) {
    throw new Error("Application destination did not resolve")
  }
  return { hostname, address: selected.address }
}

export interface CompatibilityInspectorOptions {
  readonly repository: RepositoryCompatibilityProbe
  readonly urls: UrlReadinessProbe
  readonly application: ApplicationReadinessProbe
  readonly approvedRepositories?: ReadonlySet<string>
  readonly now?: () => Date
}

export interface ProductionCompatibilityOptions extends GitHubSourceConnectorOptions {
  readonly allowPrivateNetworkForTests?: boolean
  readonly allowInsecureLocalhost?: boolean
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

export class GitHubRepositoryCompatibilityProbe implements RepositoryCompatibilityProbe {
  constructor(private readonly connector: GitHubSourceConnector) {}

  async open(
    repositoryUrl: string,
    repositoryRef: string,
    signal?: AbortSignal
  ): Promise<RepositoryCompatibilitySnapshot> {
    const resolved = await this.connector.resolveCommit(
      repositoryUrl,
      repositoryRef,
      signal
    )
    const snapshot = resolved.checkout.snapshots.get("source")
    if (snapshot === undefined) {
      await resolved.checkout.dispose()
      throw new Error("Repository checkout omitted the source snapshot")
    }
    const identity =
      `${resolved.repository.repository.owner}/${resolved.repository.repository.name}`.toLowerCase()
    return {
      identity,
      resolvedCommitSha: resolved.commit.sha,
      paths: snapshot
        .enumerate()
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.path)
        .sort(),
      readText: (path, maxBytes = 512 * 1_024) =>
        snapshot.readText(path, maxBytes),
      dispose: () => resolved.checkout.dispose(),
    }
  }
}

export class BoundedUrlReadinessProbe implements UrlReadinessProbe {
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(
    private readonly options: {
      readonly allowPrivateNetworkForTests?: boolean
      readonly allowInsecureLocalhost?: boolean
      readonly timeoutMs?: number
      readonly maxResponseBytes?: number
    } = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.maxResponseBytes = options.maxResponseBytes ?? 128 * 1_024
  }

  async check(url: string, signal?: AbortSignal): Promise<UrlReadinessResult> {
    const policy = new DocumentationUrlPolicy({
      roots: [url],
      allowHttp: this.options.allowInsecureLocalhost ?? false,
      allowPrivateNetworkForTests:
        this.options.allowPrivateNetworkForTests ?? false,
    })
    await policy.assertResolvedTarget(url)
    const dispatcher = policy.createDispatcher()
    try {
      const response = await safeFetchBytes(url, {
        policy,
        dispatcher,
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxResponseBytes,
        maxRedirects: 3,
        userAgent: "SentinelCompatibilityProbe/0.0.1",
      })
      if (response.status < 200 || response.status >= 400) {
        throw new Error("Configured URL returned a non-success status")
      }
      return {
        finalUrl: response.finalUrl,
        status: response.status,
        contentType: response.contentType,
      }
    } finally {
      await dispatcher.close()
    }
  }
}

export class PlaywrightApplicationReadinessProbe implements ApplicationReadinessProbe {
  constructor(
    private readonly browserType: BrowserType = chromium,
    private readonly options: {
      readonly allowInsecureLocalhost?: boolean
      readonly allowPrivateNetworkForTests?: boolean
      readonly timeoutMs?: number
    } = {}
  ) {}

  async check(
    url: string,
    allowedOrigins: readonly string[],
    signal?: AbortSignal
  ): Promise<ApplicationReadinessResult> {
    const policy = createBrowserPolicy({
      allowedOrigins,
      allowInsecureLocalhost: this.options.allowInsecureLocalhost ?? false,
      budgets: {
        maxActions: 1,
        maxScreens: 1,
        maxDurationMs: this.options.timeoutMs ?? 20_000,
      },
    })
    const pinnedHost = await resolvePinnedBrowserHost(url, {
      allowPrivateNetworkForTests:
        this.options.allowPrivateNetworkForTests ?? false,
    })
    const pinnedAddress =
      pinnedHost === null || !pinnedHost.address.includes(":")
        ? pinnedHost?.address
        : `[${pinnedHost.address}]`
    const browser = await this.browserType.launch({
      headless: true,
      ...(pinnedHost === null || pinnedAddress === undefined
        ? {}
        : {
            args: [
              `--host-resolver-rules=MAP ${pinnedHost.hostname} ${pinnedAddress}`,
            ],
          }),
    })
    try {
      const context = await browser.newContext({ serviceWorkers: "block" })
      try {
        await context.route("**/*", async (route) => {
          if (isAllowedBrowserUrl(route.request().url(), policy)) {
            await route.continue()
          } else {
            await route.abort("blockedbyclient")
          }
        })
        await context.routeWebSocket("**/*", (webSocket) => {
          if (isAllowedBrowserWebSocketUrl(webSocket.url(), policy)) {
            webSocket.connectToServer()
          } else {
            webSocket.close({ code: 1008, reason: "Blocked by browser policy" })
          }
        })
        const page = await context.newPage()
        const timeoutMs = this.options.timeoutMs ?? 20_000
        const navigation = page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        })
        const response =
          signal === undefined
            ? await navigation
            : await Promise.race([
                navigation,
                new Promise<never>((_, reject) => {
                  signal.addEventListener(
                    "abort",
                    () =>
                      reject(new Error("Application readiness was cancelled")),
                    { once: true }
                  )
                }),
              ])
        if (response === null || response.status() >= 400) {
          throw new Error("Application page returned a non-success status")
        }
        if (!isAllowedBrowserUrl(page.url(), policy)) {
          throw new Error("Application redirected outside the approved origin")
        }
        if ((await page.locator("body").count()) !== 1) {
          throw new Error("Application did not expose a document body")
        }
        return { finalUrl: page.url(), title: await page.title() }
      } finally {
        await context.close()
      }
    } finally {
      await browser.close()
    }
  }
}

function normalizeError(_error: unknown): void {
  void _error
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function repositoryRoot(path: string): string {
  const [root] = path.split("/")
  return root ?? path
}

async function readJsonFiles(
  repository: RepositoryCompatibilitySnapshot,
  names: ReadonlySet<string>
): Promise<ReadonlyMap<string, unknown>> {
  const result = new Map<string, unknown>()
  for (const path of repository.paths) {
    const base = path.split("/").at(-1)?.toLowerCase()
    if (base === undefined || !names.has(base)) continue
    try {
      result.set(path, JSON.parse(await repository.readText(path)))
    } catch {
      // Malformed configuration is reported by the corresponding missing capability.
    }
  }
  return result
}

function objectKeys(value: unknown, key: string): readonly string[] {
  if (typeof value !== "object" || value === null) return []
  const nested = (value as Record<string, unknown>)[key]
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return []
  }
  return Object.keys(nested as Record<string, unknown>).map((name) =>
    name.toLowerCase()
  )
}

export class CompatibilityInspector {
  private readonly approvedRepositories: ReadonlySet<string>
  private readonly now: () => Date

  constructor(private readonly options: CompatibilityInspectorOptions) {
    this.approvedRepositories =
      options.approvedRepositories ?? APPROVED_REPOSITORIES
    this.now = options.now ?? (() => new Date())
  }

  async inspect(
    configurationInput: OnboardingConfiguration,
    signal?: AbortSignal
  ): Promise<CompatibilityReport> {
    const configuration =
      onboardingConfigurationSchema.parse(configurationInput)
    const evidence: CompatibilityEvidence[] = []
    const findings: CompatibilityFinding[] = []
    const selectedAdapters: string[] = []
    const repositoryPaths: string[] = []
    let resolvedCommitSha: string | undefined
    let repository: RepositoryCompatibilitySnapshot | undefined

    const addEvidence = (
      capability: CompatibilityCapability,
      status: CompatibilityEvidence["status"],
      code: string,
      summary: string,
      source: CompatibilityEvidence["source"],
      references: readonly string[] = []
    ) => {
      evidence.push(
        compatibilityEvidenceSchema.parse({
          capability,
          status,
          code,
          summary,
          source,
          references,
        })
      )
    }
    const addFinding = (
      severity: CompatibilityFinding["severity"],
      code: string,
      summary: string,
      humanAction: string
    ) =>
      findings.push(
        compatibilityFindingSchema.parse({
          severity,
          code,
          summary,
          humanAction,
        })
      )

    const allowedOrigin = new URL(configuration.deploymentUrl).origin
    const allowedActionCategories = [
      "safe_read",
      "safe_navigation",
      "safe_form_progress",
      "credential_entry",
      ...(configuration.crawl.allowFormSubmission
        ? (["unknown_submission"] as const)
        : []),
    ] as const

    addEvidence(
      "safe_action_policy",
      "detected",
      "safe_policy_validated",
      "Crawl limits and mandatory action denials are valid",
      "configuration",
      configuration.crawl.allowedHosts
    )
    const authenticationNeedsConfirmation =
      configuration.authentication.method !== "none" &&
      !configuration.authentication.automationConfirmed
    addEvidence(
      "authentication_automatable",
      authenticationNeedsConfirmation ? "blocked" : "detected",
      authenticationNeedsConfirmation
        ? "authentication_requires_confirmation"
        : `${configuration.authentication.method}_authentication_configured`,
      configuration.authentication.method === "none"
        ? "The selected workflow does not require authentication"
        : authenticationNeedsConfirmation
          ? "Automated login without human verification has not been confirmed"
          : "The operator confirmed automated login without human verification",
      "configuration"
    )
    if (authenticationNeedsConfirmation) {
      addFinding(
        "blocker",
        "authentication_requires_confirmation",
        "Protected application access is not confirmed as automatable",
        "Verify login without CAPTCHA or human verification and inspect again"
      )
    }

    const addUnavailableRepositoryCapabilities = () => {
      for (const capability of [
        "typescript_react",
        "php_laravel",
        "laravel_routes",
        "openapi_scramble",
        "playwright_assets",
      ] as const) {
        addEvidence(
          capability,
          "blocked",
          `${capability}_not_evaluated`,
          `${capability.replaceAll("_", " ")} could not be evaluated without an approved repository checkout`,
          "repository"
        )
      }
    }
    const repositoryUrl = new URL(configuration.repository.url)
    const requestedRepositoryIdentity = repositoryUrl.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .toLowerCase()
    if (!this.approvedRepositories.has(requestedRepositoryIdentity)) {
      addEvidence(
        "repository_resolved",
        "blocked",
        "repository_not_approved",
        "Repository identity is outside the approved Hi.Events sources",
        "repository"
      )
      addFinding(
        "blocker",
        "repository_not_approved",
        "The repository is not an approved Hi.Events source",
        "Select the configured Hi.Events fork or request explicit upstream approval"
      )
      addUnavailableRepositoryCapabilities()
    } else {
      try {
        repository = await this.options.repository.open(
          configuration.repository.url,
          configuration.repository.ref,
          signal
        )
        resolvedCommitSha = repository.resolvedCommitSha
        if (!this.approvedRepositories.has(repository.identity.toLowerCase())) {
          addEvidence(
            "repository_resolved",
            "blocked",
            "repository_not_approved",
            "Repository identity is outside the approved Hi.Events sources",
            "repository"
          )
          addFinding(
            "blocker",
            "repository_not_approved",
            "The repository is not an approved Hi.Events source",
            "Select the configured Hi.Events fork or request explicit upstream approval"
          )
          addUnavailableRepositoryCapabilities()
        } else {
          addEvidence(
            "repository_resolved",
            "detected",
            "immutable_commit_resolved",
            "Repository reference resolved to an immutable commit",
            "repository",
            [resolvedCommitSha]
          )
          const paths = new Set(
            repository.paths.map((path) => path.toLowerCase())
          )
          const configs = await readJsonFiles(
            repository,
            new Set(["package.json", "composer.json"])
          )
          const packageEntries = [...configs.entries()].filter(([path]) =>
            path.toLowerCase().endsWith("package.json")
          )
          const composerEntries = [...configs.entries()].filter(([path]) =>
            path.toLowerCase().endsWith("composer.json")
          )
          const reactConfigs = packageEntries
            .filter(([, value]) =>
              ["dependencies", "devDependencies", "peerDependencies"].some(
                (key) => objectKeys(value, key).includes("react")
              )
            )
            .map(([path]) => path)
          const laravelConfigs = composerEntries
            .filter(([, value]) =>
              ["require", "require-dev"].some((key) =>
                objectKeys(value, key).includes("laravel/framework")
              )
            )
            .map(([path]) => path)
          const scrambleConfigs = composerEntries
            .filter(([, value]) =>
              ["require", "require-dev"].some((key) =>
                objectKeys(value, key).includes("dedoc/scramble")
              )
            )
            .map(([path]) => path)
          const tsxPaths = repository.paths.filter((path) =>
            /\.(?:tsx|jsx)$/i.test(path)
          )
          const routePaths = repository.paths.filter((path) =>
            /(?:^|\/)routes\/(?:api|web)\.php$/i.test(path)
          )
          const openApiPaths = repository.paths.filter((path) =>
            /(?:^|\/)(?:openapi|swagger)(?:\.[^.]+)?\.(?:json|ya?ml)$/i.test(
              path
            )
          )
          const playwrightPaths = repository.paths.filter((path) =>
            /(?:^|\/)playwright\.config\.(?:js|mjs|cjs|ts)$|(?:^|\/)tests?\/.*\.spec\.(?:js|ts)$/i.test(
              path
            )
          )

          const capability = (
            name: CompatibilityCapability,
            detected: boolean,
            references: readonly string[],
            adapter: string,
            required: boolean,
            missingSummary: string,
            humanAction: string
          ) => {
            if (detected) {
              addEvidence(
                name,
                "detected",
                `${name}_detected`,
                `${name.replaceAll("_", " ")} evidence was detected`,
                "repository",
                references
              )
              selectedAdapters.push(adapter)
              repositoryPaths.push(...references.map(repositoryRoot))
              return
            }
            addEvidence(
              name,
              "missing",
              `${name}_missing`,
              missingSummary,
              "repository"
            )
            addFinding(
              required ? "blocker" : "warning",
              `${name}_missing`,
              missingSummary,
              humanAction
            )
          }

          capability(
            "typescript_react",
            reactConfigs.length > 0 && tsxPaths.length > 0,
            [...reactConfigs, ...tsxPaths.slice(0, 5)],
            "typescript_react",
            true,
            "TypeScript or React source evidence is incomplete",
            "Point the repository ref at a commit containing the React frontend"
          )
          capability(
            "php_laravel",
            laravelConfigs.length > 0 && paths.has("artisan"),
            [...laravelConfigs, ...(paths.has("artisan") ? ["artisan"] : [])],
            "php_laravel",
            true,
            "PHP or Laravel source evidence is incomplete",
            "Point the repository ref at a commit containing the Laravel backend"
          )
          capability(
            "laravel_routes",
            routePaths.length > 0,
            routePaths.slice(0, 10),
            "laravel_routes",
            scrambleConfigs.length === 0 && openApiPaths.length === 0,
            "Laravel route evidence was not detected",
            "Add or expose Laravel API/web route files or a supported OpenAPI artifact"
          )
          capability(
            "openapi_scramble",
            scrambleConfigs.length > 0 || openApiPaths.length > 0,
            [...scrambleConfigs, ...openApiPaths].slice(0, 10),
            "openapi_scramble",
            routePaths.length === 0,
            "OpenAPI or Scramble evidence was not detected",
            "Expose a supported OpenAPI artifact or retain parseable Laravel routes"
          )
          capability(
            "playwright_assets",
            playwrightPaths.length > 0,
            playwrightPaths.slice(0, 10),
            "playwright",
            false,
            "Existing Playwright assets were not detected",
            "Confirm the target can use Sentinel's browser adapter without target-owned fixtures"
          )
        }
      } catch (error) {
        normalizeError(error)
        addEvidence(
          "repository_resolved",
          "blocked",
          "repository_unreachable",
          "Repository metadata or bounded checkout could not be inspected",
          "repository"
        )
        addFinding(
          "blocker",
          "repository_unreachable",
          "The repository or requested ref could not be inspected",
          "Verify repository access and select an existing branch or immutable commit"
        )
        addUnavailableRepositoryCapabilities()
      }
    }

    try {
      for (const source of configuration.documentationSources) {
        if (source.startsWith("repository://")) {
          const path = source.slice("repository://".length)
          if (
            repository === undefined ||
            !repository.paths.some(
              (candidate) => candidate.toLowerCase() === path.toLowerCase()
            )
          ) {
            throw new Error("Configured repository documentation was not found")
          }
        } else {
          await this.options.urls.check(source, signal)
        }
      }
      addEvidence(
        "documentation_reachable",
        "detected",
        "documentation_sources_reachable",
        "Every configured documentation source is reachable",
        "documentation",
        configuration.documentationSources
      )
    } catch (error) {
      normalizeError(error)
      addEvidence(
        "documentation_reachable",
        "blocked",
        "documentation_source_unreachable",
        "At least one configured documentation source is unavailable or unsafe",
        "documentation",
        configuration.documentationSources
      )
      addFinding(
        "blocker",
        "documentation_source_unreachable",
        "Documentation readiness could not be established",
        "Correct the documentation URL or repository-relative path and retry inspection"
      )
    }

    try {
      await this.options.urls.check(configuration.deploymentUrl, signal)
      const browser = await this.options.application.check(
        configuration.deploymentUrl,
        [allowedOrigin],
        signal
      )
      addEvidence(
        "application_reachable",
        "detected",
        "application_browser_ready",
        "The deployment is reachable and exposes a browser document",
        "application",
        [browser.finalUrl]
      )
      selectedAdapters.push("playwright_network")
    } catch (error) {
      normalizeError(error)
      addEvidence(
        "application_reachable",
        "blocked",
        "application_unreachable",
        "The application is unavailable, unsafe, or not browser ready",
        "application",
        [configuration.deploymentUrl]
      )
      addFinding(
        "blocker",
        "application_unreachable",
        "Application readiness could not be established",
        "Verify the deployment URL, TLS, allowed host, and worker reachability"
      )
    } finally {
      await repository?.dispose()
    }

    const sortedFindings = findings.sort((left, right) =>
      `${left.severity}:${left.code}`.localeCompare(
        `${right.severity}:${right.code}`
      )
    )
    const blockerCount = sortedFindings.filter(
      (finding) => finding.severity === "blocker"
    ).length
    const warningCount = sortedFindings.length - blockerCount
    const status =
      blockerCount > 0 ? "blocked" : warningCount > 0 ? "partial" : "supported"
    const humanActions = uniqueSorted(
      sortedFindings.map((finding) => finding.humanAction)
    )
    const report = {
      schemaVersion: 1,
      inputFingerprint: createOnboardingInputFingerprint(configuration),
      status,
      ...(resolvedCommitSha === undefined ? {} : { resolvedCommitSha }),
      selectedAdapters: uniqueSorted(selectedAdapters),
      evidence,
      findings: sortedFindings,
      humanActions,
      proposedScope: {
        repositoryPaths: uniqueSorted(repositoryPaths).slice(0, 100),
        documentationSources: configuration.documentationSources,
        applicationOrigins: [allowedOrigin],
        allowedActionCategories: [...allowedActionCategories],
        maxActions: configuration.crawl.maxActions,
        maxScreens: configuration.crawl.maxScreens,
        maxDurationSeconds: configuration.crawl.maxDurationSeconds,
      },
      inspectedAt: this.now().toISOString(),
    }
    return compatibilityReportSchema.parse(report)
  }
}

export function createProductionCompatibilityInspector(
  options: ProductionCompatibilityOptions = {}
): CompatibilityInspector {
  const connector = new GitHubSourceConnector(options)
  return new CompatibilityInspector({
    repository: new GitHubRepositoryCompatibilityProbe(connector),
    urls: new BoundedUrlReadinessProbe(options),
    application: new PlaywrightApplicationReadinessProbe(chromium, options),
  })
}
