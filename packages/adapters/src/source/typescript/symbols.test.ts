import { codeSymbolKindSchema } from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { IndexBudget, resolveIndexLimits } from "./limits.ts"
import { extractSymbols, type SymbolRecord } from "./symbols.ts"
import { loadFixtureProject } from "./testing.ts"

const limits = resolveIndexLimits()

async function symbolsOf(
  files: Readonly<Record<string, string>>,
  target: string,
  overrides: Partial<Parameters<typeof resolveIndexLimits>[0]> = {}
): Promise<readonly SymbolRecord[]> {
  const loaded = await loadFixtureProject(files)
  try {
    const file = loaded.files.find((candidate) => candidate.path === target)
    if (file === undefined)
      throw new Error(`fixture ${target} was not admitted`)
    const effective = resolveIndexLimits(overrides)
    return extractSymbols(file, effective, new IndexBudget(effective)).symbols
  } finally {
    loaded.dispose()
  }
}

const tsconfig = '{ "compilerOptions": { "jsx": "react-jsx" } }'

describe("symbol extraction", () => {
  it("emits a module symbol anchoring every file", async () => {
    const symbols = await symbolsOf(
      { "tsconfig.json": tsconfig, "src/a.ts": "export const x = 1\n" },
      "src/a.ts"
    )

    expect(symbols).toHaveLength(1)
    expect(symbols[0]).toMatchObject({
      qualifiedName: "src/a.ts",
      kind: "module",
      name: "a.ts",
      range: { startLine: 1, endLine: 1 },
    })
  })

  it("skips plain value constants, types, and interfaces", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": [
          "export const GET_ME_QUERY_KEY = 'getGetMe'",
          "export type User = { id: string }",
          "export interface Event { id: string }",
          "export enum Status { Draft }",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(symbols.map((symbol) => symbol.qualifiedName)).toStrictEqual([
      "src/a.ts",
    ])
  })

  it("classifies declarations into the contract symbol-kind enum", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/Login.tsx": [
          "export function plainFunction() { return 1 }",
          "export const Login = () => {",
          "  const handleSubmit = () => undefined",
          "  return <form onSubmit={handleSubmit} />",
          "}",
          "export class OrderService {",
          "  charge() { return 1 }",
          "  refund = () => 2",
          "}",
          "const notAComponent = () => 5",
        ].join("\n"),
      },
      "src/Login.tsx"
    )

    const kinds = Object.fromEntries(
      symbols.map((symbol) => [symbol.qualifiedName, symbol.kind])
    )
    expect(kinds).toStrictEqual({
      "src/Login.tsx": "module",
      "src/Login.tsx#plainFunction": "function",
      "src/Login.tsx#Login": "component",
      "src/Login.tsx#OrderService": "class",
      "src/Login.tsx#OrderService.charge": "method",
      "src/Login.tsx#OrderService.refund": "method",
      "src/Login.tsx#notAComponent": "function",
    })
    for (const symbol of symbols) {
      expect(codeSymbolKindSchema.parse(symbol.kind)).toBe(symbol.kind)
    }
  })

  it("does not classify a PascalCase declaration without JSX as a component", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/Helpers.tsx":
          "export const FormatMoney = (n: number) => String(n)\n",
      },
      "src/Helpers.tsx"
    )

    expect(
      symbols.find(({ qualifiedName }) =>
        qualifiedName.endsWith("#FormatMoney")
      )?.kind
    ).toBe("function")
  })

  it("does not classify JSX in a .ts file as a component", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/plain.ts": "export const Widget = () => 1\n",
      },
      "src/plain.ts"
    )

    expect(
      symbols.find(({ qualifiedName }) => qualifiedName.endsWith("#Widget"))
        ?.kind
    ).toBe("function")
  })

  it("classifies handler-shaped names ahead of components", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.tsx": [
          "export const handleTicketLookup = () => <div />",
          "export const onSelect = () => undefined",
        ].join("\n"),
      },
      "src/a.tsx"
    )

    expect(
      symbols.filter(({ kind }) => kind === "handler").map(({ name }) => name)
    ).toStrictEqual(["handleTicketLookup", "onSelect"])
  })

  it("extracts an API client object literal and its methods", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/api/event.client.ts": [
          "export const eventsClient = {",
          "  create: async (event: unknown) => event,",
          "  async findByID(id: string) { return id },",
          "  QUERY_KEY: 'events',",
          "}",
        ].join("\n"),
      },
      "src/api/event.client.ts"
    )

    expect(
      symbols.map(({ qualifiedName, kind }) => [qualifiedName, kind])
    ).toStrictEqual([
      ["src/api/event.client.ts", "module"],
      ["src/api/event.client.ts#eventsClient", "service"],
      ["src/api/event.client.ts#eventsClient.create", "method"],
      ["src/api/event.client.ts#eventsClient.findByID", "method"],
    ])
  })

  it("treats a non-client object literal as a module binding", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/helpers.ts": "export const helpers = { run: () => 1 }\n",
      },
      "src/helpers.ts"
    )

    expect(
      symbols.find(({ qualifiedName }) => qualifiedName.endsWith("#helpers"))
        ?.kind
    ).toBe("module")
  })

  it("marks a separate default export statement on the declaration it names", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/Login.tsx": [
          "const Login = () => <div />",
          "export default Login",
        ].join("\n"),
      },
      "src/Login.tsx"
    )

    expect(symbols.find(({ name }) => name === "Login")).toMatchObject({
      exported: true,
      exportName: "default",
      kind: "component",
    })
  })

  it("records an inline anonymous default export", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/Anon.tsx": "export default () => <div />\n",
      },
      "src/Anon.tsx"
    )

    expect(symbols.find(({ name }) => name === "default")).toMatchObject({
      qualifiedName: "src/Anon.tsx#default",
      exported: true,
      exportName: "default",
    })
  })

  it("records a default exported function declaration", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/Page.tsx": "export default function Page() { return <div /> }\n",
      },
      "src/Page.tsx"
    )

    expect(symbols.find(({ name }) => name === "Page")).toMatchObject({
      exported: true,
      exportName: "default",
      kind: "component",
    })
  })

  it("records accurate 1-based inclusive source ranges", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": [
          "// leading comment",
          "export function first() {",
          "  return 1",
          "}",
          "export const second = () => 2",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(
      symbols
        .filter(({ kind }) => kind !== "module")
        .map(({ name, range }) => [name, range])
    ).toStrictEqual([
      ["first", { startLine: 2, endLine: 4 }],
      ["second", { startLine: 5, endLine: 5 }],
    ])
  })

  it("orders symbols deterministically by position then qualified name", async () => {
    const symbols = await symbolsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": [
          "export const zebra = () => 1",
          "export const apple = () => 2",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(symbols.map(({ name }) => name)).toStrictEqual([
      "a.ts",
      "zebra",
      "apple",
    ])
  })

  it("reports a per-file node budget overrun instead of partial output", async () => {
    const loaded = await loadFixtureProject({
      "tsconfig.json": tsconfig,
      "src/a.ts": "export const a = () => 1\n",
    })
    try {
      const file = loaded.files[0]
      if (file === undefined) throw new Error("fixture not admitted")
      const tight = resolveIndexLimits({ maxNodesPerFile: 3 })
      const extraction = extractSymbols(file, tight, new IndexBudget(tight))

      expect(extraction.symbols).toStrictEqual([])
      expect(extraction.warnings).toStrictEqual([
        {
          reason: "node_budget_exhausted",
          path: "src/a.ts",
          detail: expect.stringContaining("nodes exceeds the per-file budget"),
        },
      ])
    } finally {
      loaded.dispose()
    }
  })

  it("reports a per-file symbol budget overrun", async () => {
    const source = Array.from(
      { length: 6 },
      (_unused, index) => `export const fn${index} = () => ${index}`
    ).join("\n")
    const loaded = await loadFixtureProject({
      "tsconfig.json": tsconfig,
      "src/a.ts": `${source}\n`,
    })
    try {
      const file = loaded.files[0]
      if (file === undefined) throw new Error("fixture not admitted")
      const tight = resolveIndexLimits({ maxSymbolsPerFile: 3 })
      const extraction = extractSymbols(file, tight, new IndexBudget(tight))

      expect(extraction.symbols).toHaveLength(3)
      expect(extraction.warnings.at(0)?.reason).toBe("symbol_budget_exhausted")
    } finally {
      loaded.dispose()
    }
  })

  it("counts visited nodes against the shared budget", async () => {
    const loaded = await loadFixtureProject({
      "tsconfig.json": tsconfig,
      "src/a.ts": "export const a = () => 1\n",
    })
    try {
      const file = loaded.files[0]
      if (file === undefined) throw new Error("fixture not admitted")
      const budget = new IndexBudget(limits)
      const extraction = extractSymbols(file, limits, budget)

      expect(extraction.nodeCount).toBeGreaterThan(0)
      expect(budget.nodes).toBe(extraction.nodeCount)
    } finally {
      loaded.dispose()
    }
  })
})
