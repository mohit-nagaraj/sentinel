import { describe, expect, it } from "vitest"

import { indexFixture } from "./testing.ts"

const COMPONENT_COUNT = 120

/**
 * Generated tree roughly the shape of a real frontend: a route file, an API
 * client, a React Query hook, and a component per feature, all cross-importing.
 */
function generateFixtureTree(count: number): Record<string, string> {
  const files: Record<string, string> = {
    "app/tsconfig.json": '{ "compilerOptions": { "jsx": "react-jsx" } }',
    "app/src/api/client.ts": [
      'import axios from "axios"',
      'export const api = axios.create({ baseURL: "/api" })',
    ].join("\n"),
  }

  const routeEntries: string[] = []
  for (let index = 0; index < count; index += 1) {
    const name = `Feature${index}`
    files[`app/src/api/feature${index}.client.ts`] = [
      'import { api } from "./client.ts"',
      `export const feature${index}Client = {`,
      `  all: async () => (await api.get("feature${index}")).data,`,
      `  findByID: async (id: string) => (await api.get("feature${index}/" + id)).data,`,
      `  create: async (body: unknown) => (await api.post("feature${index}", body)).data,`,
      "}",
    ].join("\n")

    files[`app/src/queries/use${name}.ts`] = [
      'import { useQuery } from "@tanstack/react-query"',
      `import { feature${index}Client } from "../api/feature${index}.client.ts"`,
      `export const use${name} = () =>`,
      `  useQuery({ queryKey: ["${name}"], queryFn: async () => await feature${index}Client.all() })`,
    ].join("\n")

    files[`app/src/components/${name}/index.tsx`] = [
      `import { use${name} } from "../../queries/use${name}.ts"`,
      `const ${name} = () => {`,
      `  const data = use${name}()`,
      "  const handleRefresh = () => data.refetch()",
      "  return (",
      "    <section>",
      `      <h2 data-testid="${name.toLowerCase()}-title">${name}</h2>`,
      `      <button aria-label="Refresh ${name}" onClick={handleRefresh}>Refresh</button>`,
      "    </section>",
      "  )",
      "}",
      `export default ${name}`,
    ].join("\n")

    routeEntries.push(
      [
        "  {",
        `    path: "feature-${index}",`,
        "    async lazy() {",
        `      const mod = await import("./components/${name}")`,
        "      return { Component: mod.default }",
        "    },",
        "  },",
      ].join("\n")
    )
  }

  files["app/src/router.tsx"] = `export const router = [\n${routeEntries.join(
    "\n"
  )}\n]\n`
  return files
}

describe("index performance budget", () => {
  it("indexes a representative tree within the documented budget", async () => {
    const files = generateFixtureTree(COMPONENT_COUNT)
    const startedAt = Date.now()
    const { index } = await indexFixture({ files, roots: ["app/src"] })
    const elapsedMs = Date.now() - startedAt

    // Sanity-check the generated tree really is representative before
    // asserting anything about how long it took.
    expect(index.files).toHaveLength(COMPONENT_COUNT * 3 + 2)
    expect(index.routes).toHaveLength(COMPONENT_COUNT)
    expect(
      index.routes.every(
        ({ componentSymbolIds }) => componentSymbolIds.length === 1
      )
    ).toBe(true)
    expect(index.apiCallCandidates).toHaveLength(COMPONENT_COUNT * 3)
    expect(index.queryHooks).toHaveLength(COMPONENT_COUNT)

    // A generous ceiling on purpose. The point is to catch an
    // order-of-magnitude regression — an accidental quadratic walk or a
    // per-identifier type-checker call — not to police small variance on a
    // shared CI runner.
    expect(elapsedMs).toBeLessThan(60_000)
    expect(index.statistics.nodeCount).toBeLessThan(index.limits.maxTotalNodes)
  }, 120_000)

  it("reports a node budget overrun instead of silently truncating", async () => {
    const { index } = await indexFixture({
      files: generateFixtureTree(6),
      roots: ["app/src"],
      limits: { maxTotalNodes: 500 },
    })

    expect(
      index.warnings.some(({ reason }) => reason === "node_budget_exhausted")
    ).toBe(true)
    expect(index.files.length).toBeGreaterThan(
      index.statistics.symbolCount / 10
    )
  })

  it("reports a file budget overrun instead of silently truncating", async () => {
    const { index } = await indexFixture({
      files: generateFixtureTree(6),
      roots: ["app/src"],
      limits: { maxFiles: 5 },
    })

    expect(index.files).toHaveLength(5)
    expect(
      index.warnings.filter(({ reason }) => reason === "file_budget_exhausted")
        .length
    ).toBeGreaterThan(0)
  })
})
