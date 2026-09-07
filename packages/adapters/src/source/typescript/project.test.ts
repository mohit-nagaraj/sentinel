import { describe, expect, expectTypeOf, it } from "vitest"

import type { CheckoutSnapshot } from "../github/checkout.ts"
import { TypeScriptIndexerError } from "./errors.ts"
import { defaultTypeScriptIndexLimits, resolveIndexLimits } from "./limits.ts"
import { defaultIndexPolicy } from "./policy.ts"
import { loadTypeScriptProject, toMountedPath } from "./project.ts"
import {
  createFakeSourceReader,
  type TypeScriptSourceReader,
} from "./reader.ts"

const limits = defaultTypeScriptIndexLimits

describe("typescript project loading", () => {
  it("exposes a port a checkout snapshot satisfies", () => {
    expectTypeOf<CheckoutSnapshot>().toExtend<TypeScriptSourceReader>()
  })

  it("honours only allowlisted tsconfig fields", async () => {
    const reader = createFakeSourceReader({
      "frontend/tsconfig.json": `{
        // Comments are tolerated because the config is parsed, never evaluated.
        "extends": "./tsconfig.base.json",
        "compilerOptions": {
          "jsx": "react-jsx",
          "baseUrl": ".",
          "paths": { "@/*": ["src/*"] },
          "plugins": [{ "name": "some-transformer" }],
          "types": ["vite/client"]
        },
        "references": [{ "path": "./tsconfig.node.json" }]
      }`,
      "frontend/src/App.tsx": "export const App = () => <div />\n",
    })

    const loaded = await loadTypeScriptProject({
      reader,
      roots: ["frontend/src"],
      policy: defaultIndexPolicy,
      limits,
    })
    try {
      expect(loaded.config.tsconfigPath).toBe("frontend/tsconfig.json")
      expect(loaded.config.configDirectory).toBe("frontend")
      expect(loaded.config.jsx).toBe("react-jsx")
      expect(loaded.config.ignoredFields).toStrictEqual([
        "extends",
        "plugins",
        "references",
        "types",
      ])
      expect(loaded.config.pathAliases).toStrictEqual([
        { from: "@/*", to: ["src/*"] },
      ])
      expect(loaded.files.map((file) => file.path)).toStrictEqual([
        "frontend/src/App.tsx",
      ])
    } finally {
      loaded.dispose()
    }
  })

  it("resolves extensionless relative imports across admitted files", async () => {
    const reader = createFakeSourceReader({
      "tsconfig.json": '{ "compilerOptions": { "jsx": "react-jsx" } }',
      "src/pages/Login/index.tsx":
        "const Login = () => <div />\nexport default Login\n",
      "src/router.tsx":
        'import Login from "./pages/Login"\nexport const routes = [Login]\n',
    })

    const loaded = await loadTypeScriptProject({
      reader,
      roots: ["src"],
      policy: defaultIndexPolicy,
      limits,
    })
    try {
      const router = loaded.project.getSourceFileOrThrow(
        toMountedPath("src/router.tsx")
      )
      const [declaration] = router.getImportDeclarations()
      expect(
        declaration?.getModuleSpecifierSourceFile()?.getFilePath()
      ).toContain("src/pages/Login/index.tsx")
    } finally {
      loaded.dispose()
    }
  })

  it("resolves path aliases relative to the config directory", async () => {
    const reader = createFakeSourceReader({
      "frontend/tsconfig.json": `{
        "compilerOptions": {
          "jsx": "react-jsx",
          "baseUrl": ".",
          "paths": { "@api/*": ["src/api/*"] }
        }
      }`,
      "frontend/src/api/event.client.ts": "export const eventsClient = {}\n",
      "frontend/src/hooks/useEvent.ts":
        'import { eventsClient } from "@api/event.client.ts"\nexport const useEvent = () => eventsClient\n',
    })

    const loaded = await loadTypeScriptProject({
      reader,
      roots: ["frontend/src"],
      policy: defaultIndexPolicy,
      limits,
    })
    try {
      const hook = loaded.project.getSourceFileOrThrow(
        toMountedPath("frontend/src/hooks/useEvent.ts")
      )
      const [declaration] = hook.getImportDeclarations()
      expect(
        declaration?.getModuleSpecifierSourceFile()?.getFilePath()
      ).toContain("frontend/src/api/event.client.ts")
    } finally {
      loaded.dispose()
    }
  })

  it("reports every excluded file with its policy category", async () => {
    const reader = createFakeSourceReader({
      "tsconfig.json": "{}",
      "src/app.ts": "export const a = 1\n",
      "src/app.test.ts": "export const t = 1\n",
      "src/generated/types.d.ts": "export type A = string\n",
      "src/locales/en.ts": "export default {}\n",
      "src/styles.css": "body{}",
      "dist/app.js": "console.log(1)",
      "node_modules/pkg/index.ts": "export const p = 1\n",
    })

    const loaded = await loadTypeScriptProject({
      reader,
      roots: [""],
      policy: defaultIndexPolicy,
      limits,
    })
    try {
      expect(loaded.files.map((file) => file.path)).toStrictEqual([
        "src/app.ts",
      ])
      expect(
        loaded.warnings.map(({ path, reason }) => [path, reason])
      ).toStrictEqual([
        ["dist/app.js", "build_output"],
        ["node_modules/pkg/index.ts", "vendor_dependency"],
        ["src/app.test.ts", "test_file"],
        ["src/generated/types.d.ts", "generated_declaration"],
        ["src/locales/en.ts", "locale_bundle"],
        ["src/styles.css", "excluded_extension"],
        ["tsconfig.json", "excluded_extension"],
      ])
    } finally {
      loaded.dispose()
    }
  })

  it("admits scoped test files when focused test indexing is requested", async () => {
    const reader = createFakeSourceReader({
      "tsconfig.json": "{}",
      "src/app.test.ts": "export const a = 1\n",
      "other/thing.test.ts": "export const b = 1\n",
    })

    const loaded = await loadTypeScriptProject({
      reader,
      roots: [""],
      policy: {
        ...defaultIndexPolicy,
        includeTests: true,
        testPathPrefixes: ["src"],
      },
      limits,
    })
    try {
      expect(loaded.files.map((file) => file.path)).toStrictEqual([
        "src/app.test.ts",
      ])
      expect(
        loaded.warnings.find(({ path }) => path === "other/thing.test.ts")
          ?.reason
      ).toBe("test_file")
    } finally {
      loaded.dispose()
    }
  })

  it("never admits symlink entries", async () => {
    const reader = createFakeSourceReader(
      {
        "tsconfig.json": "{}",
        "src/link.ts": "export const a = 1\n",
      },
      { symlinkPaths: ["src/link.ts"] }
    )

    const loaded = await loadTypeScriptProject({
      reader,
      roots: [""],
      policy: defaultIndexPolicy,
      limits,
    })
    try {
      expect(loaded.files).toStrictEqual([])
      expect(
        loaded.warnings.find(({ path }) => path === "src/link.ts")?.reason
      ).toBe("symlink")
    } finally {
      loaded.dispose()
    }
  })

  it("fails closed when no tsconfig is discoverable", async () => {
    const reader = createFakeSourceReader({
      "src/app.ts": "export const a = 1\n",
    })

    await expect(
      loadTypeScriptProject({
        reader,
        roots: ["src"],
        policy: defaultIndexPolicy,
        limits,
      })
    ).rejects.toMatchObject({
      code: "project_not_found",
      compatibility: true,
    })
  })

  it("ignores tsconfig files inside vendor directories", async () => {
    const reader = createFakeSourceReader({
      "node_modules/pkg/tsconfig.json": "{}",
      "src/app.ts": "export const a = 1\n",
    })

    await expect(
      loadTypeScriptProject({
        reader,
        roots: ["src"],
        policy: defaultIndexPolicy,
        limits,
      })
    ).rejects.toBeInstanceOf(TypeScriptIndexerError)
  })

  it("rejects an unparsable tsconfig as a compatibility problem", async () => {
    const reader = createFakeSourceReader({
      "tsconfig.json": "{ this is not json ]",
      "src/app.ts": "export const a = 1\n",
    })

    await expect(
      loadTypeScriptProject({
        reader,
        roots: ["src"],
        policy: defaultIndexPolicy,
        limits,
      })
    ).rejects.toMatchObject({
      code: "unsupported_project",
      compatibility: true,
    })
  })

  it("stops at the file budget instead of truncating silently", async () => {
    const reader = createFakeSourceReader({
      "tsconfig.json": "{}",
      "src/a.ts": "export const a = 1\n",
      "src/b.ts": "export const b = 1\n",
      "src/c.ts": "export const c = 1\n",
    })

    const loaded = await loadTypeScriptProject({
      reader,
      roots: ["src"],
      policy: defaultIndexPolicy,
      limits: resolveIndexLimits({ maxFiles: 2 }),
    })
    try {
      expect(loaded.files.map((file) => file.path)).toStrictEqual([
        "src/a.ts",
        "src/b.ts",
      ])
      expect(
        loaded.warnings.find(({ path }) => path === "src/c.ts")?.reason
      ).toBe("file_budget_exhausted")
    } finally {
      loaded.dispose()
    }
  })

  it("skips files larger than the per-file byte budget", async () => {
    const reader = createFakeSourceReader({
      "tsconfig.json": "{}",
      "src/big.ts": `export const big = "${"x".repeat(4_000)}"\n`,
      "src/small.ts": "export const small = 1\n",
    })

    const loaded = await loadTypeScriptProject({
      reader,
      roots: ["src"],
      policy: defaultIndexPolicy,
      limits: resolveIndexLimits({ maxFileBytes: 1_000 }),
    })
    try {
      expect(loaded.files.map((file) => file.path)).toStrictEqual([
        "src/small.ts",
      ])
      expect(
        loaded.warnings.find(({ path }) => path === "src/big.ts")?.reason
      ).toBe("oversized_file")
    } finally {
      loaded.dispose()
    }
  })

  it("rejects a cancelled index before reading source", async () => {
    const reader = createFakeSourceReader({
      "tsconfig.json": "{}",
      "src/app.ts": "export const a = 1\n",
    })
    const controller = new AbortController()
    controller.abort()

    await expect(
      loadTypeScriptProject({
        reader,
        roots: ["src"],
        policy: defaultIndexPolicy,
        limits,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: "aborted" })
  })
})
