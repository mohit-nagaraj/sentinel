import { z } from "zod"

import { type SkipReason } from "./errors.ts"
import {
  isWithinRoot,
  normalizeRootPrefix,
  type TypeScriptSourceEntry,
} from "./reader.ts"

/**
 * Declared, versioned admission policy. The policy participates in the index
 * fingerprint, so tightening or relaxing it is visible in emitted output rather
 * than being an invisible behaviour change.
 */
export const POLICY_VERSION = 1 as const

const pathFragmentSchema = z.string().trim().min(1).max(128)

export const indexPolicySchema = z.strictObject({
  policyVersion: z.literal(POLICY_VERSION),
  /** Path segments that exclude a file anywhere in its path. */
  excludedSegments: z.array(pathFragmentSchema).max(128),
  /** Filename suffixes that exclude a file outright. */
  excludedSuffixes: z.array(pathFragmentSchema).max(128),
  /** Path segments that mark a locale or translation bundle. */
  localeSegments: z.array(pathFragmentSchema).max(64),
  /** Path segments that mark vendored third-party code. */
  vendorSegments: z.array(pathFragmentSchema).max(64),
  /** Path segments that mark build or tooling output. */
  buildSegments: z.array(pathFragmentSchema).max(64),
  /** Path segments that mark test scaffolding. */
  testSegments: z.array(pathFragmentSchema).max(64),
  /** Filename infixes that mark a test file, e.g. `.test.` in `a.test.ts`. */
  testInfixes: z.array(pathFragmentSchema).max(64),
  /** Admit test files. Focused test indexing is opt-in, never the default. */
  includeTests: z.boolean(),
  /**
   * When {@link includeTests} is set, restrict admitted tests to these prefixes.
   * An empty list admits every test file under the requested roots.
   */
  testPathPrefixes: z.array(z.string().trim().min(1).max(2_048)).max(32),
})

export type IndexPolicy = z.infer<typeof indexPolicySchema>

export const defaultIndexPolicy: IndexPolicy = {
  policyVersion: POLICY_VERSION,
  excludedSegments: [".git", ".idea", ".vscode", "__snapshots__"],
  excludedSuffixes: [".d.ts", ".d.tsx", ".min.ts", ".min.js"],
  localeSegments: ["locale", "locales", "i18n", "lang", "translations"],
  vendorSegments: ["node_modules", "vendor", "third_party", "bower_components"],
  buildSegments: [
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "out",
    "storybook-static",
  ],
  testSegments: [
    "__mocks__",
    "__tests__",
    "cypress",
    "e2e",
    "playwright",
    "test",
    "tests",
  ],
  testInfixes: [".test.", ".spec.", ".stories.", ".mock."],
  includeTests: false,
  testPathPrefixes: [],
}

export const indexableExtensions = Object.freeze([".ts", ".tsx"] as const)

export type IndexableExtension = (typeof indexableExtensions)[number]

export function extensionOf(path: string): IndexableExtension | undefined {
  return indexableExtensions.find((extension) => path.endsWith(extension))
}

export type AdmissionResult =
  | { readonly admitted: true; readonly extension: IndexableExtension }
  | { readonly admitted: false; readonly reason: SkipReason }

function hasSegment(
  segments: readonly string[],
  candidates: readonly string[]
): boolean {
  const lowered = new Set(candidates.map((value) => value.toLowerCase()))
  return segments.some((segment) => lowered.has(segment.toLowerCase()))
}

function isTestPath(
  path: string,
  segments: readonly string[],
  policy: IndexPolicy
): boolean {
  const fileName = segments.at(-1) ?? ""
  return (
    hasSegment(segments.slice(0, -1), policy.testSegments) ||
    policy.testInfixes.some((infix) => fileName.includes(infix)) ||
    path.endsWith(".test.ts") ||
    path.endsWith(".test.tsx")
  )
}

/**
 * Decides whether a reader entry may enter the compiler host, and reports the
 * exclusion category when it may not.
 *
 * Order matters: structural rejections come before policy categories so a
 * vendored test file is reported as vendored rather than as a test.
 */
export function admitEntry(
  entry: TypeScriptSourceEntry,
  roots: readonly string[],
  policy: IndexPolicy,
  maxFileBytes: number
): AdmissionResult {
  if (entry.kind !== "file") {
    return { admitted: false, reason: "symlink" }
  }
  const normalizedRoots = roots.map(normalizeRootPrefix)
  const inRoot =
    normalizedRoots.length === 0 ||
    normalizedRoots.some((root) => isWithinRoot(entry.path, root))
  if (!inRoot) {
    return { admitted: false, reason: "out_of_root" }
  }

  const segments = entry.path.split("/")
  if (hasSegment(segments, policy.excludedSegments)) {
    return { admitted: false, reason: "build_output" }
  }
  if (hasSegment(segments, policy.vendorSegments)) {
    return { admitted: false, reason: "vendor_dependency" }
  }
  if (hasSegment(segments, policy.buildSegments)) {
    return { admitted: false, reason: "build_output" }
  }
  if (hasSegment(segments, policy.localeSegments)) {
    return { admitted: false, reason: "locale_bundle" }
  }
  if (policy.excludedSuffixes.some((suffix) => entry.path.endsWith(suffix))) {
    return { admitted: false, reason: "generated_declaration" }
  }

  const extension = extensionOf(entry.path)
  if (extension === undefined) {
    return { admitted: false, reason: "excluded_extension" }
  }

  if (isTestPath(entry.path, segments, policy)) {
    if (!policy.includeTests) {
      return { admitted: false, reason: "test_file" }
    }
    const prefixes = policy.testPathPrefixes.map(normalizeRootPrefix)
    const allowed =
      prefixes.length === 0 ||
      prefixes.some((prefix) => isWithinRoot(entry.path, prefix))
    if (!allowed) {
      return { admitted: false, reason: "test_file" }
    }
  }

  if (entry.sizeBytes > maxFileBytes) {
    return { admitted: false, reason: "oversized_file" }
  }

  return { admitted: true, extension }
}
