import { beforeAll, describe, expect, it } from "vitest"

import {
  createTypeScriptIndexQuery,
  type TypeScriptIndexQuery,
} from "./query.ts"
import { indexFixture } from "./testing.ts"
import type { TypeScriptSourceIndex } from "./indexer.ts"

const DASHBOARD =
  "frontend/src/components/routes/events/Dashboard/index.tsx#Dashboard"
const CLIENT_CREATE = "frontend/src/api/event.client.ts#eventsClient.create"
const USE_CREATE_EVENT =
  "frontend/src/mutations/useCreateEvent.ts#useCreateEvent"

let query: TypeScriptIndexQuery
let index: TypeScriptSourceIndex

beforeAll(async () => {
  const fixture = await indexFixture()
  index = fixture.index
  query = createTypeScriptIndexQuery(fixture.index, fixture.reader)
})

describe("index query surface", () => {
  it("lists modules bounded by prefix and limit", () => {
    expect(
      query
        .listModules({ pathPrefix: "frontend/src/api" })
        .map(({ path }) => path)
    ).toStrictEqual(["frontend/src/api"])
    expect(query.listModules({ limit: 2 })).toHaveLength(2)
  })

  it("searches symbols by name and qualified name", () => {
    expect(
      query
        .searchSymbols({ query: "Dashboard" })
        .map(({ qualifiedName }) => qualifiedName)
    ).toContain(DASHBOARD)
    expect(
      query.searchSymbols({ query: "eventsClient" }).length
    ).toBeGreaterThan(1)
  })

  it("filters symbol search by kind, path, and export status", () => {
    expect(
      query
        .searchSymbols({ query: "", kinds: ["component"] })
        .every(({ kind }) => kind === "component")
    ).toBe(true)
    expect(
      query
        .searchSymbols({ query: "", pathPrefix: "frontend/src/api" })
        .every(({ filePath }) => filePath.startsWith("frontend/src/api"))
    ).toBe(true)
    expect(
      query
        .searchSymbols({ query: "", exportedOnly: true })
        .every(({ exported }) => exported)
    ).toBe(true)
  })

  it("clamps a search limit to the configured ceiling", () => {
    expect(
      query.searchSymbols({ query: "", limit: 10_000 }).length
    ).toBeLessThanOrEqual(index.limits.maxQueryResults)
    expect(query.searchSymbols({ query: "", limit: 0 })).toHaveLength(1)
  })

  it("finds a definition by qualified name", () => {
    expect(query.findDefinition(DASHBOARD)).toMatchObject({
      kind: "component",
      filePath: "frontend/src/components/routes/events/Dashboard/index.tsx",
    })
    expect(query.findDefinition("does/not#exist")).toBeUndefined()
  })

  it("returns incoming and outgoing references for a symbol", () => {
    const references = query.findReferences(CLIENT_CREATE)

    expect(references.length).toBeGreaterThan(0)
    expect(
      references.some(
        ({ targetQualifiedName }) => targetQualifiedName === CLIENT_CREATE
      )
    ).toBe(true)
  })

  it("returns an empty list for an unknown symbol rather than throwing", () => {
    expect(query.findReferences("nope#nope")).toStrictEqual([])
    expect(query.traceCallers("nope#nope")).toStrictEqual([])
    expect(query.traceCallees("nope#nope")).toStrictEqual([])
  })

  it("inspects a symbol with a bounded slice and its structural context", async () => {
    const inspection = await query.inspectSymbol(DASHBOARD)

    expect(inspection.symbol.qualifiedName).toBe(DASHBOARD)
    expect(inspection.slice.startLine).toBe(inspection.symbol.range.startLine)
    expect(inspection.slice.text).toContain("const Dashboard")
    expect(inspection.slice.truncated).toBe(false)
    expect(inspection.jsxElements.length).toBeGreaterThan(0)
    expect(inspection.handlerBindings.length).toBeGreaterThan(0)
    expect(inspection.file.path).toBe(inspection.symbol.filePath)
  })

  it("refuses to inspect a symbol outside the index", async () => {
    await expect(query.inspectSymbol("ghost#ghost")).rejects.toMatchObject({
      code: "unsafe_path",
    })
  })

  it("traces callers from an API client method back to the mutation hook", () => {
    const callers = query.traceCallers(CLIENT_CREATE, { depth: 3 })

    expect(callers.map(({ symbol }) => symbol.qualifiedName)).toContain(
      USE_CREATE_EVENT
    )
    expect(callers.every(({ depth }) => depth <= 3)).toBe(true)
  })

  it("traces callees from the mutation hook to the client method", () => {
    expect(
      query
        .traceCallees(USE_CREATE_EVENT, { depth: 3 })
        .map(({ symbol }) => symbol.qualifiedName)
    ).toContain(CLIENT_CREATE)
  })

  it("clamps trace depth and result count", () => {
    expect(
      query
        .traceCallers(CLIENT_CREATE, { depth: 999 })
        .every(({ depth }) => depth <= index.limits.maxTraceDepth)
    ).toBe(true)
    expect(
      query.traceCallers(CLIENT_CREATE, { limit: 1 }).length
    ).toBeLessThanOrEqual(1)
  })

  it("does not revisit a symbol when call edges form a cycle", async () => {
    const fixture = await indexFixture({
      files: {
        "tsconfig.json": '{ "compilerOptions": { "jsx": "react-jsx" } }',
        "src/cycle.ts": [
          "export const first = (): number => second()",
          "export const second = (): number => first()",
        ].join("\n"),
      },
      roots: ["src"],
    })
    const cyclic = createTypeScriptIndexQuery(fixture.index, fixture.reader)

    const steps = cyclic.traceCallees("src/cycle.ts#first")
    expect(steps.map(({ symbol }) => symbol.qualifiedName)).toStrictEqual([
      "src/cycle.ts#second",
    ])
  })

  it("lists routes filtered by pattern prefix", () => {
    expect(
      query
        .listRoutes({ pathPrefix: "/manage" })
        .map(({ pathPattern }) => pathPattern)
    ).toStrictEqual(["/manage", "/manage/events/:eventsState?"])
  })

  it("finds frontend callers for a normalized request path", () => {
    const callers = query.findFrontendCallersForPath({
      pathTemplate: "/events",
      method: "POST",
    })

    expect(callers).toHaveLength(1)
    expect(callers[0]?.ownerSymbol.qualifiedName).toBe(CLIENT_CREATE)
    expect(
      callers[0]?.routes.map(({ pathPattern }) => pathPattern)
    ).toStrictEqual(["/manage/events/:eventsState?"])
  })

  it("returns no callers for a path nothing requests", () => {
    expect(
      query.findFrontendCallersForPath({ pathTemplate: "/not/requested" })
    ).toStrictEqual([])
  })

  it("filters frontend callers by method", () => {
    expect(
      query.findFrontendCallersForPath({
        pathTemplate: "/events",
        method: "DELETE",
      })
    ).toStrictEqual([])
  })

  it("searches indexed text and reports 1-based line numbers", async () => {
    const matches = await query.searchText({ query: "handleCreate" })

    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]?.path).toBe(
      "frontend/src/components/routes/events/Dashboard/index.tsx"
    )
    expect(matches[0]?.line).toBeGreaterThan(0)
  })

  it("honours case sensitivity and a path prefix in text search", async () => {
    await expect(
      query.searchText({ query: "HANDLECREATE", caseSensitive: true })
    ).resolves.toStrictEqual([])
    const scoped = await query.searchText({
      query: "axios",
      pathPrefix: "frontend/src/api",
    })
    expect(
      scoped.every(({ path }) => path.startsWith("frontend/src/api"))
    ).toBe(true)
  })

  it("clamps text search results", async () => {
    const matches = await query.searchText({ query: "e", limit: 3 })

    expect(matches).toHaveLength(3)
  })

  it("returns an empty text search for an empty needle", async () => {
    await expect(query.searchText({ query: "" })).resolves.toStrictEqual([])
  })

  it("reads a bounded slice of an indexed file", async () => {
    const slice = await query.readSlice({
      path: "frontend/src/api/client.ts",
      startLine: 1,
      endLine: 3,
    })

    expect(slice.startLine).toBe(1)
    expect(slice.text).toContain("axios")
  })

  it.each([
    ["../../../etc/passwd", "traverse parents"],
    ["/etc/passwd", "must be relative"],
    ["C:/Windows/system32/config", "must be relative"],
    ["frontend/src/../../outside.ts", "traverse parents"],
  ])("refuses the unsafe slice path %s", async (path) => {
    await expect(
      query.readSlice({ path, startLine: 1, endLine: 1 })
    ).rejects.toThrow()
  })

  it("refuses to read a file the policy excluded", async () => {
    await expect(
      query.readSlice({
        path: "frontend/src/locales/en.ts",
        startLine: 1,
        endLine: 1,
      })
    ).rejects.toMatchObject({ code: "unsafe_path" })
    await expect(
      query.readSlice({
        path: "frontend/node_modules/axios/index.ts",
        startLine: 1,
        endLine: 1,
      })
    ).rejects.toMatchObject({ code: "unsafe_path" })
    await expect(
      query.readSlice({
        path: "frontend/src/types.d.ts",
        startLine: 1,
        endLine: 1,
      })
    ).rejects.toMatchObject({ code: "unsafe_path" })
  })

  it("refuses to read a file outside the indexed roots", async () => {
    await expect(
      query.readSlice({
        path: "frontend/tsconfig.json",
        startLine: 1,
        endLine: 1,
      })
    ).rejects.toMatchObject({ code: "unsafe_path" })
  })

  it("clamps an oversized slice request to the slice budget", async () => {
    const fixture = await indexFixture({
      limits: { maxSliceLines: 2 },
    })
    const bounded = createTypeScriptIndexQuery(fixture.index, fixture.reader)

    const slice = await bounded.readSlice({
      path: "frontend/src/router.tsx",
      startLine: 1,
      endLine: 40,
    })
    expect(slice.endLine).toBe(2)
    expect(slice.truncated).toBe(true)
  })
})
