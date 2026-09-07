import { describe, expect, it } from "vitest"

import {
  admitEntry,
  defaultIndexPolicy,
  extensionOf,
  indexPolicySchema,
  type IndexPolicy,
} from "./policy.ts"
import type { TypeScriptSourceEntry } from "./reader.ts"

const file = (path: string, sizeBytes = 128): TypeScriptSourceEntry => ({
  path,
  kind: "file",
  sizeBytes,
})

const admit = (
  path: string,
  policy: IndexPolicy = defaultIndexPolicy,
  roots: readonly string[] = [""]
) => admitEntry(file(path), roots, policy, 1_024)

describe("index admission policy", () => {
  it("validates as a versioned contract and rejects unknown keys", () => {
    expect(indexPolicySchema.parse(defaultIndexPolicy)).toStrictEqual(
      defaultIndexPolicy
    )
    expect(() =>
      indexPolicySchema.parse({ ...defaultIndexPolicy, surprise: true })
    ).toThrow()
    expect(() =>
      indexPolicySchema.parse({ ...defaultIndexPolicy, policyVersion: 2 })
    ).toThrow()
  })

  it.each([".ts", ".tsx"])("admits %s sources", (extension) => {
    expect(admit(`src/app${extension}`)).toStrictEqual({
      admitted: true,
      extension,
    })
  })

  it.each([
    ["src/app.js", "excluded_extension"],
    ["src/app.jsx", "excluded_extension"],
    ["src/app.mjs", "excluded_extension"],
    ["src/styles.scss", "excluded_extension"],
    ["src/types.d.ts", "generated_declaration"],
    ["src/bundle.min.ts", "generated_declaration"],
    ["node_modules/pkg/index.ts", "vendor_dependency"],
    ["vendor/lib/index.ts", "vendor_dependency"],
    ["dist/app.ts", "build_output"],
    ["build/app.ts", "build_output"],
    ["coverage/app.ts", "build_output"],
    [".next/app.ts", "build_output"],
    ["storybook-static/app.ts", "build_output"],
    ["src/__snapshots__/a.ts", "build_output"],
    ["src/locales/en.ts", "locale_bundle"],
    ["src/i18n/en.ts", "locale_bundle"],
    ["src/translations/en.ts", "locale_bundle"],
    ["src/app.test.ts", "test_file"],
    ["src/app.spec.tsx", "test_file"],
    ["src/app.stories.tsx", "test_file"],
    ["src/__tests__/app.ts", "test_file"],
    ["src/__mocks__/app.ts", "test_file"],
    ["e2e/checkout.ts", "test_file"],
    ["cypress/support/index.ts", "test_file"],
  ])("excludes %s as %s", (path, reason) => {
    expect(admit(path)).toStrictEqual({ admitted: false, reason })
  })

  it("reports a vendored test file as vendored, not as a test", () => {
    expect(admit("node_modules/pkg/index.test.ts")).toStrictEqual({
      admitted: false,
      reason: "vendor_dependency",
    })
  })

  it("never admits symlinks even when the path would qualify", () => {
    expect(
      admitEntry(
        { path: "src/app.ts", kind: "symlink", sizeBytes: 12 },
        [""],
        defaultIndexPolicy,
        1_024
      )
    ).toStrictEqual({ admitted: false, reason: "symlink" })
  })

  it("rejects files outside the requested roots", () => {
    expect(
      admit("backend/app.ts", defaultIndexPolicy, ["frontend/src"])
    ).toStrictEqual({ admitted: false, reason: "out_of_root" })
    expect(
      admit("frontend/src/app.ts", defaultIndexPolicy, ["frontend/src"])
    ).toStrictEqual({ admitted: true, extension: ".ts" })
  })

  it("rejects files above the per-file byte budget", () => {
    expect(
      admitEntry(file("src/app.ts", 4_096), [""], defaultIndexPolicy, 1_024)
    ).toStrictEqual({ admitted: false, reason: "oversized_file" })
  })

  it("admits tests only when focused test indexing is requested", () => {
    const policy: IndexPolicy = { ...defaultIndexPolicy, includeTests: true }

    expect(admit("src/app.test.ts", policy)).toStrictEqual({
      admitted: true,
      extension: ".ts",
    })
  })

  it("restricts focused test indexing to the declared prefixes", () => {
    const policy: IndexPolicy = {
      ...defaultIndexPolicy,
      includeTests: true,
      testPathPrefixes: ["frontend/src"],
    }

    expect(admit("frontend/src/app.test.ts", policy)).toStrictEqual({
      admitted: true,
      extension: ".ts",
    })
    expect(admit("backend/app.test.ts", policy)).toStrictEqual({
      admitted: false,
      reason: "test_file",
    })
  })

  it("resolves indexable extensions", () => {
    expect(extensionOf("a.tsx")).toBe(".tsx")
    expect(extensionOf("a.ts")).toBe(".ts")
    expect(extensionOf("a.json")).toBeUndefined()
  })
})
