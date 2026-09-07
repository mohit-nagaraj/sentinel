import { Node } from "ts-morph"
import { describe, expect, it } from "vitest"

import { IndexBudget, resolveIndexLimits } from "./limits.ts"
import { extractReferences, type ReferenceExtraction } from "./references.ts"
import { extractSymbols, type SymbolRecord } from "./symbols.ts"
import { loadFixtureProject } from "./testing.ts"

const tsconfig = '{ "compilerOptions": { "jsx": "react-jsx" } }'

interface Extracted {
  readonly byFile: ReadonlyMap<string, ReferenceExtraction>
  readonly symbols: readonly SymbolRecord[]
}

/**
 * Runs the real two-pass sequence: symbols for every file first, then references
 * against the merged declaration index. Resolving across files is the whole
 * point, so a single-file shortcut would not exercise it.
 */
async function extract(
  files: Readonly<Record<string, string>>,
  overrides: Parameters<typeof resolveIndexLimits>[0] = {}
): Promise<Extracted> {
  const loaded = await loadFixtureProject(files)
  try {
    const limits = resolveIndexLimits(overrides)
    const budget = new IndexBudget(limits)
    const byDeclaration = new Map<Node, SymbolRecord>()
    const perFile = new Map<string, readonly SymbolRecord[]>()
    const symbols: SymbolRecord[] = []

    for (const file of loaded.files) {
      const extraction = extractSymbols(file, limits, budget)
      perFile.set(file.path, extraction.symbols)
      symbols.push(...extraction.symbols)
      for (const [declaration, symbol] of extraction.byDeclaration) {
        byDeclaration.set(declaration, symbol)
      }
    }
    const indexedNames = new Set(symbols.map((symbol) => symbol.name))
    const byFile = new Map<string, ReferenceExtraction>()
    for (const file of loaded.files) {
      byFile.set(
        file.path,
        extractReferences(
          file,
          perFile.get(file.path) ?? [],
          byDeclaration,
          indexedNames,
          limits
        )
      )
    }
    return { byFile, symbols }
  } finally {
    loaded.dispose()
  }
}

function referencesOf(
  extracted: Extracted,
  path: string
): ReferenceExtraction["references"] {
  return extracted.byFile.get(path)?.references ?? []
}

describe("reference extraction", () => {
  it("resolves a relative import to the indexed declaration it names", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/api/event.client.ts":
        "export const eventsClient = { create: async () => 1 }\n",
      "src/useCreate.ts": [
        'import { eventsClient } from "./api/event.client.ts"',
        "export const useCreate = () => eventsClient.create()",
      ].join("\n"),
    })

    const imports = extracted.byFile.get("src/useCreate.ts")?.imports ?? []
    expect(imports).toStrictEqual([
      {
        filePath: "src/useCreate.ts",
        moduleSpecifier: "./api/event.client.ts",
        resolvedPath: "src/api/event.client.ts",
        unresolvedReason: undefined,
        isReexport: false,
        bindings: [{ local: "eventsClient", imported: "eventsClient" }],
        range: { startLine: 1, endLine: 1 },
      },
    ])
    expect(
      referencesOf(extracted, "src/useCreate.ts").find(
        ({ kind }) => kind === "import"
      )
    ).toMatchObject({
      targetQualifiedName: "src/api/event.client.ts#eventsClient",
      targetFilePath: "src/api/event.client.ts",
      unresolvedReason: undefined,
    })
  })

  it("resolves extensionless and index-file imports", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/pages/Login/index.tsx": [
        "const Login = () => <div />",
        "export default Login",
      ].join("\n"),
      "src/router.tsx": [
        'import Login from "./pages/Login"',
        "export const routes = () => Login",
      ].join("\n"),
    })

    expect(extracted.byFile.get("src/router.tsx")?.imports.at(0)).toMatchObject(
      {
        resolvedPath: "src/pages/Login/index.tsx",
        bindings: [{ local: "Login", imported: "default" }],
      }
    )
    expect(
      referencesOf(extracted, "src/router.tsx").find(
        ({ kind }) => kind === "import"
      )?.targetQualifiedName
    ).toBe("src/pages/Login/index.tsx#Login")
  })

  it("marks a bare package specifier as an external module, not a failure", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": [
        'import { useQuery } from "@tanstack/react-query"',
        "export const run = () => useQuery",
      ].join("\n"),
    })

    expect(extracted.byFile.get("src/a.ts")?.imports.at(0)).toMatchObject({
      moduleSpecifier: "@tanstack/react-query",
      resolvedPath: undefined,
      unresolvedReason: "external_module",
    })
  })

  it("marks a relative import that does not resolve as unresolved", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts":
        'import { missing } from "./nowhere.ts"\nexport const run = () => missing\n',
    })

    expect(extracted.byFile.get("src/a.ts")?.imports.at(0)).toMatchObject({
      moduleSpecifier: "./nowhere.ts",
      resolvedPath: undefined,
      unresolvedReason: "unresolved_import",
    })
  })

  it("records import aliases with both local and imported names", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/api.ts": "export const original = () => 1\n",
      "src/a.ts": [
        'import { original as renamed } from "./api.ts"',
        'import * as everything from "./api.ts"',
        "export const run = () => renamed() + everything.original()",
      ].join("\n"),
    })

    const bindings = (extracted.byFile.get("src/a.ts")?.imports ?? []).flatMap(
      ({ bindings: entries }) => entries
    )
    expect(bindings).toStrictEqual([
      { local: "renamed", imported: "original" },
      { local: "everything", imported: "*" },
    ])
  })

  it("resolves a call through an import alias to the original declaration", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/api.ts": "export const original = () => 1\n",
      "src/a.ts": [
        'import { original as renamed } from "./api.ts"',
        "export const run = () => renamed()",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/a.ts").find(({ kind }) => kind === "call")
    ).toMatchObject({
      fromQualifiedName: "src/a.ts#run",
      targetQualifiedName: "src/api.ts#original",
      unresolvedTarget: undefined,
    })
  })

  it("records a re-export as a resolved import edge", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/api.ts": "export const original = () => 1\n",
      "src/index.ts": 'export { original } from "./api.ts"\n',
    })

    expect(extracted.byFile.get("src/index.ts")?.imports.at(0)).toMatchObject({
      isReexport: true,
      resolvedPath: "src/api.ts",
      bindings: [{ local: "original", imported: "original" }],
    })
  })

  it("attributes a call to the enclosing declaration, not the module", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": [
        "export const helper = () => 1",
        "export const outer = () => {",
        "  return helper()",
        "}",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/a.ts").filter(({ kind }) => kind === "call")
    ).toStrictEqual([
      {
        filePath: "src/a.ts",
        fromQualifiedName: "src/a.ts#outer",
        kind: "call",
        targetQualifiedName: "src/a.ts#helper",
        targetFilePath: "src/a.ts",
        unresolvedTarget: undefined,
        unresolvedReason: undefined,
        range: { startLine: 3, endLine: 3 },
      },
    ])
  })

  it("attributes a call inside an object-literal method to that method", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/api/event.client.ts": [
        "const helper = () => 1",
        "export const eventsClient = {",
        "  create: async () => helper(),",
        "}",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/api/event.client.ts").find(
        ({ kind }) => kind === "call"
      )?.fromQualifiedName
    ).toBe("src/api/event.client.ts#eventsClient.create")
  })

  it("attributes a module-level call to the module symbol", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": ["export const helper = () => 1", "helper()"].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/a.ts").find(({ kind }) => kind === "call")
        ?.fromQualifiedName
    ).toBe("src/a.ts")
  })

  it("does not treat a call written inside a comment as an edge", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": [
        "export const helper = () => 1",
        "export const outer = () => {",
        "  // helper()",
        "  /* helper() */",
        "  /** @example helper() */",
        "  return 0",
        "}",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/a.ts").filter(({ kind }) => kind === "call")
    ).toStrictEqual([])
  })

  it("does not treat call text inside a string literal as an edge", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": [
        "export const helper = () => 1",
        "export const outer = () => {",
        '  const docs = "call helper() to do the thing"',
        "  const template = `helper()`",
        "  return docs.length + template.length",
        "}",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/a.ts")
        .filter(({ kind }) => kind === "call")
        .map(({ targetQualifiedName }) => targetQualifiedName)
    ).toStrictEqual([])
  })

  it("does not create edges from type-only positions", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": [
        "export const helper = () => 1",
        "export type HelperResult = ReturnType<typeof helper>",
        "export interface Wrapper { run: typeof helper }",
      ].join("\n"),
    })

    expect(referencesOf(extracted, "src/a.ts")).toStrictEqual([])
  })

  it("does not create an edge for dead code that names nothing indexed", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": [
        "export const outer = () => {",
        "  return notDefinedAnywhere()",
        "}",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/a.ts").filter(({ kind }) => kind === "call")
    ).toStrictEqual([
      {
        filePath: "src/a.ts",
        fromQualifiedName: "src/a.ts#outer",
        kind: "call",
        targetQualifiedName: undefined,
        targetFilePath: undefined,
        unresolvedTarget: "notDefinedAnywhere",
        unresolvedReason: "unresolved_import",
        range: { startLine: 2, endLine: 2 },
      },
    ])
  })

  it("reports an unsupported callee shape rather than guessing", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": [
        "const registry: Record<string, () => number> = {}",
        "export const outer = (key: string) => registry[key]!()",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/a.ts").find(({ kind }) => kind === "call")
    ).toMatchObject({ unresolvedReason: "unsupported_syntax" })
  })

  it("records a non-call reference to an indexed symbol", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/Login.tsx": [
        "const Login = () => <div />",
        "export default Login",
      ].join("\n"),
      "src/router.tsx": [
        'import Login from "./Login.tsx"',
        "export const routes = () => [{ element: Login }]",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/router.tsx").find(
        ({ kind }) => kind === "reference"
      )
    ).toMatchObject({
      fromQualifiedName: "src/router.tsx#routes",
      targetQualifiedName: "src/Login.tsx#Login",
    })
  })

  it("bounds long unresolved target text", async () => {
    const longName = `notIndexed${"x".repeat(400)}`
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": `export const outer = () => ${longName}()\n`,
    })

    const target = referencesOf(extracted, "src/a.ts").find(
      ({ kind }) => kind === "call"
    )?.unresolvedTarget
    expect(target).toHaveLength(256)
  })

  it("reports a per-file reference budget overrun", async () => {
    const calls = Array.from({ length: 12 }, () => "  helper()").join("\n")
    const extracted = await extract(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": [
          "export const helper = () => 1",
          "export const outer = () => {",
          calls,
          "}",
        ].join("\n"),
      },
      { maxReferencesPerFile: 4 }
    )

    expect(referencesOf(extracted, "src/a.ts")).toHaveLength(4)
    expect(extracted.byFile.get("src/a.ts")?.warnings.at(0)?.reason).toBe(
      "node_budget_exhausted"
    )
  })

  it("orders references deterministically", async () => {
    const extracted = await extract({
      "tsconfig.json": tsconfig,
      "src/a.ts": [
        "export const zebra = () => 1",
        "export const apple = () => 2",
        "export const outer = () => zebra() + apple()",
      ].join("\n"),
    })

    expect(
      referencesOf(extracted, "src/a.ts")
        .filter(({ kind }) => kind === "call")
        .map(({ targetQualifiedName }) => targetQualifiedName)
    ).toStrictEqual(["src/a.ts#apple", "src/a.ts#zebra"])
  })
})
