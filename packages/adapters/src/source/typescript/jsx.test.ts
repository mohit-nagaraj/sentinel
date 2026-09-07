import { Node } from "ts-morph"
import { describe, expect, it } from "vitest"

import { extractJsx, type JsxExtraction } from "./jsx.ts"
import { IndexBudget, resolveIndexLimits } from "./limits.ts"
import { extractSymbols, type SymbolRecord } from "./symbols.ts"
import { loadFixtureProject } from "./testing.ts"

const tsconfig = '{ "compilerOptions": { "jsx": "react-jsx" } }'

async function jsxOf(
  files: Readonly<Record<string, string>>,
  target: string,
  overrides: Parameters<typeof resolveIndexLimits>[0] = {}
): Promise<JsxExtraction> {
  const loaded = await loadFixtureProject(files)
  try {
    const limits = resolveIndexLimits(overrides)
    const budget = new IndexBudget(limits)
    const byDeclaration = new Map<Node, SymbolRecord>()
    const symbolsByFile = new Map<string, readonly SymbolRecord[]>()
    for (const file of loaded.files) {
      const extraction = extractSymbols(file, limits, budget)
      symbolsByFile.set(file.path, extraction.symbols)
      for (const [declaration, symbol] of extraction.byDeclaration) {
        byDeclaration.set(declaration, symbol)
      }
    }
    const file = loaded.files.find((candidate) => candidate.path === target)
    if (file === undefined)
      throw new Error(`fixture ${target} was not admitted`)
    return extractJsx(
      file,
      symbolsByFile.get(target) ?? [],
      byDeclaration,
      limits
    )
  } finally {
    loaded.dispose()
  }
}

describe("JSX extraction", () => {
  it("records static accessible hints and child text", async () => {
    const { elements } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/Login.tsx": [
          "export const Login = () => (",
          "  <form>",
          '    <input data-testid="email-input" placeholder="your@email.com" aria-label="Email" />',
          '    <button type="submit">Log in</button>',
          "  </form>",
          ")",
        ].join("\n"),
      },
      "src/Login.tsx"
    )

    const input = elements.find(({ tagName }) => tagName === "input")
    expect(input?.hints).toStrictEqual([
      { attribute: "aria-label", value: "Email" },
      { attribute: "data-testid", value: "email-input" },
      { attribute: "placeholder", value: "your@email.com" },
    ])
    expect(input?.unresolvedReasons).toStrictEqual([])

    const button = elements.find(({ tagName }) => tagName === "button")
    expect(button?.text).toBe("Log in")
    expect(button?.hints).toStrictEqual([
      { attribute: "type", value: "submit" },
    ])
  })

  it("attributes elements to the enclosing component", async () => {
    const { elements } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/Login.tsx": [
          "export const Header = () => <h1>Sign in</h1>",
          "export const Login = () => <section><Header /></section>",
        ].join("\n"),
      },
      "src/Login.tsx"
    )

    expect(
      elements.map(({ tagName, ownerQualifiedName }) => [
        tagName,
        ownerQualifiedName,
      ])
    ).toStrictEqual([
      ["h1", "src/Login.tsx#Header"],
      ["Header", "src/Login.tsx#Login"],
      ["section", "src/Login.tsx#Login"],
    ])
  })

  it("treats an unsubstituted lingui macro template as a static label", async () => {
    const { elements } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/Login.tsx": [
          'import { t } from "@lingui/macro"',
          "export const Login = () => (",
          "  <input label={t`Email address`} placeholder={`static`} />",
          ")",
        ].join("\n"),
      },
      "src/Login.tsx"
    )

    expect(elements.at(0)?.hints).toStrictEqual([
      { attribute: "label", value: "Email address" },
      { attribute: "placeholder", value: "static" },
    ])
    expect(elements.at(0)?.unresolvedReasons).toStrictEqual([])
  })

  it("marks a substituted label as a dynamic accessible name", async () => {
    const { elements } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/Login.tsx": [
          'import { t } from "@lingui/macro"',
          "export const Login = ({ name }: { name: string }) => (",
          "  <input label={t`Hello ${name}`} title={name} />",
          ")",
        ].join("\n"),
      },
      "src/Login.tsx"
    )

    expect(elements.at(0)?.hints).toStrictEqual([])
    expect(elements.at(0)?.unresolvedReasons).toStrictEqual([
      "dynamic_accessible_name",
    ])
  })

  it("ignores styling attributes entirely", async () => {
    const { elements } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/A.tsx":
          'export const A = () => <div className="grid gap-2" style={{ margin: 0 }} data-testid="a" />\n',
      },
      "src/A.tsx"
    )

    expect(elements.at(0)?.hints).toStrictEqual([
      { attribute: "data-testid", value: "a" },
    ])
    expect(elements.at(0)?.unresolvedReasons).toStrictEqual([])
  })

  it("resolves a named handler binding to its declaration", async () => {
    const { handlers } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/Login.tsx": [
          "export const Login = () => {",
          "  const handleSubmit = () => undefined",
          "  return <form onSubmit={handleSubmit} />",
          "}",
        ].join("\n"),
      },
      "src/Login.tsx"
    )

    expect(handlers).toStrictEqual([
      {
        filePath: "src/Login.tsx",
        ownerQualifiedName: "src/Login.tsx#Login",
        tagName: "form",
        event: "onSubmit",
        handlerQualifiedName: "src/Login.tsx#Login.handleSubmit",
        inline: false,
        unresolvedTarget: undefined,
        unresolvedReason: undefined,
        range: { startLine: 3, endLine: 3 },
      },
    ])
  })

  it("resolves an imported handler binding across files", async () => {
    const { handlers } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/handlers.ts": "export const handleClick = () => undefined\n",
        "src/A.tsx": [
          'import { handleClick } from "./handlers.ts"',
          "export const A = () => <button onClick={handleClick} />",
        ].join("\n"),
      },
      "src/A.tsx"
    )

    expect(handlers.at(0)?.handlerQualifiedName).toBe(
      "src/handlers.ts#handleClick"
    )
  })

  it("marks an inline arrow handler as inline rather than unresolved", async () => {
    const { handlers } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/A.tsx":
          "export const A = () => <button onClick={() => undefined} />\n",
      },
      "src/A.tsx"
    )

    expect(handlers.at(0)).toMatchObject({
      inline: true,
      handlerQualifiedName: undefined,
      unresolvedReason: undefined,
    })
  })

  it("treats a wrapped inline handler as inline", async () => {
    const { handlers } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/Login.tsx": [
          "declare const form: { onSubmit: (fn: (v: unknown) => void) => () => void }",
          "declare const loginUser: (v: unknown) => void",
          "export const Login = () => (",
          "  <form onSubmit={form.onSubmit((values) => loginUser(values))} />",
          ")",
        ].join("\n"),
      },
      "src/Login.tsx"
    )

    expect(handlers.at(0)).toMatchObject({
      event: "onSubmit",
      inline: true,
      unresolvedReason: undefined,
    })
  })

  it("marks a handler it cannot resolve with a reason code", async () => {
    const { handlers } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/A.tsx": [
          "declare const registry: Record<string, () => void>",
          'export const A = () => <button onClick={registry["go"]} />',
        ].join("\n"),
      },
      "src/A.tsx"
    )

    expect(handlers.at(0)).toMatchObject({
      handlerQualifiedName: undefined,
      inline: false,
      unresolvedReason: "computed_handler",
      unresolvedTarget: 'registry["go"]',
    })
  })

  it("records no handler for a non-event attribute", async () => {
    const { handlers } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/A.tsx":
          'export const A = () => <div onlyLooksLikeAnEvent="x" />\n',
      },
      "src/A.tsx"
    )

    expect(handlers).toStrictEqual([])
  })

  it("reports a JSX element budget overrun", async () => {
    const children = Array.from(
      { length: 6 },
      (_unused, index) => `    <span>${index}</span>`
    ).join("\n")
    const { elements, warnings } = await jsxOf(
      {
        "tsconfig.json": tsconfig,
        "src/A.tsx": `export const A = () => (\n  <div>\n${children}\n  </div>\n)\n`,
      },
      "src/A.tsx",
      { maxJsxElementsPerFile: 3 }
    )

    expect(elements).toHaveLength(3)
    expect(warnings.at(0)?.reason).toBe("jsx_budget_exhausted")
  })
})
