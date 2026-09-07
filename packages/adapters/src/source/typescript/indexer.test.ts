import { parseCodeFactEnvelope } from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import { indexFixture, reactAppFixtureFiles } from "./testing.ts"

describe("TypeScript source index", () => {
  it("admits only policy-approved files under the requested roots", async () => {
    const { index } = await indexFixture()

    expect(index.files.map((file) => file.path)).toStrictEqual([
      "frontend/src/api/client.ts",
      "frontend/src/api/event.client.ts",
      "frontend/src/components/layouts/DefaultLayout/index.tsx",
      "frontend/src/components/routes/auth/ResetPassword/index.tsx",
      "frontend/src/components/routes/events/Dashboard/index.tsx",
      "frontend/src/error-page.tsx",
      "frontend/src/mutations/useCreateEvent.ts",
      "frontend/src/queries/useGetEvent.ts",
      "frontend/src/router.tsx",
    ])
  })

  it("reports why each excluded file was skipped", async () => {
    const { index } = await indexFixture({ roots: [""] })

    const byPath = new Map(
      index.warnings.map((warning) => [warning.path, warning.reason])
    )
    expect(byPath.get("frontend/src/types.d.ts")).toBe("generated_declaration")
    expect(byPath.get("frontend/src/locales/en.ts")).toBe("locale_bundle")
    expect(byPath.get("frontend/src/router.test.tsx")).toBe("test_file")
    expect(byPath.get("frontend/node_modules/axios/index.ts")).toBe(
      "vendor_dependency"
    )
    expect(byPath.get("frontend/dist/bundle.ts")).toBe("build_output")
  })

  it("ignores tsconfig fields that would execute or widen the file set", async () => {
    const { index } = await indexFixture()

    expect(index.config.ignoredFields).toStrictEqual([
      "extends",
      "plugins",
      "types",
    ])
    expect(index.config.pathAliases).toStrictEqual([
      { from: "@app/*", to: ["src/*"] },
    ])
  })

  it("maps route to component to JSX handler to hook to API call with provenance", async () => {
    const { index } = await indexFixture()

    const route = index.routes.find(
      ({ pathPattern }) => pathPattern === "/manage/events/:eventsState?"
    )
    expect(route).toBeDefined()
    expect(route?.componentQualifiedNames).toStrictEqual([
      "frontend/src/components/routes/events/Dashboard/index.tsx#Dashboard",
    ])
    expect(route?.layoutQualifiedNames).toStrictEqual([
      "frontend/src/components/layouts/DefaultLayout/index.tsx#DefaultLayout",
    ])
    expect(route?.unresolvedReasons).toStrictEqual([])
    expect(route?.range.startLine).toBeGreaterThan(0)

    const component = index.symbols.find(
      ({ qualifiedName }) => qualifiedName === route?.componentQualifiedNames[0]
    )
    expect(component).toMatchObject({
      kind: "component",
      exportName: "default",
    })

    const handler = index.handlerBindings.find(
      ({ event }) => event === "onClick"
    )
    expect(handler).toMatchObject({
      tagName: "button",
      ownerQualifiedName:
        "frontend/src/components/routes/events/Dashboard/index.tsx#Dashboard",
      handlerQualifiedName:
        "frontend/src/components/routes/events/Dashboard/index.tsx#Dashboard.handleCreate",
      inline: false,
      unresolvedReason: undefined,
    })
    expect(handler?.handlerSymbolId).toBeDefined()

    const button = index.jsxElements.find(({ tagName }) => tagName === "button")
    expect(button?.hints).toStrictEqual([
      { attribute: "aria-label", value: "Create event" },
      { attribute: "data-testid", value: "create-event" },
    ])
    expect(button?.text).toBe("Create")

    const hook = index.queryHooks.find(
      ({ hook: name }) => name === "useMutation"
    )
    expect(hook).toMatchObject({
      ownerQualifiedName:
        "frontend/src/mutations/useCreateEvent.ts#useCreateEvent",
      callTargetQualifiedNames: [
        "frontend/src/api/event.client.ts#eventsClient.create",
      ],
      unresolvedReasons: [],
    })

    const candidate = index.apiCallCandidates.find(
      ({ ownerQualifiedName }) =>
        ownerQualifiedName ===
        "frontend/src/api/event.client.ts#eventsClient.create"
    )
    expect(candidate).toMatchObject({
      client: "axios",
      method: "POST",
      pathTemplate: "/events",
      hasQueryString: false,
    })
    expect(candidate?.range.startLine).toBeGreaterThan(0)
  })

  it("normalizes the three request-path shapes the fixture uses", async () => {
    const { index } = await indexFixture()

    expect(
      index.apiCallCandidates.map(
        ({ method, pathTemplate, hasQueryString }) => ({
          method,
          pathTemplate,
          hasQueryString,
        })
      )
    ).toStrictEqual([
      { method: "POST", pathTemplate: "/events", hasQueryString: false },
      { method: "GET", pathTemplate: "/events/{param}", hasQueryString: false },
      {
        method: "GET",
        pathTemplate: "/events/{param}/stats",
        hasQueryString: true,
      },
    ])
  })

  it("emits contract-valid envelopes for the four modelled fact kinds", async () => {
    const { index } = await indexFixture()

    expect(index.facts.length).toBeGreaterThan(0)
    for (const envelope of index.facts) {
      expect(parseCodeFactEnvelope(envelope)).toStrictEqual(envelope)
      expect(envelope.provenance).toMatchObject({
        sourceKind: "repository",
        commitSha: index.commitSha,
      })
      expect(envelope.extractor).toStrictEqual({
        name: "typescript_react_indexer",
        version: index.indexerVersion,
      })
    }
    expect(
      [...new Set(index.facts.map(({ factKind }) => factKind))].sort()
    ).toStrictEqual([
      "code_file",
      "code_reference",
      "code_symbol",
      "frontend_route",
    ])
  })

  it("never emits an api_endpoint envelope", async () => {
    const { index } = await indexFixture()

    expect(
      index.facts.some(({ factKind }) => factKind === "api_endpoint")
    ).toBe(false)
    expect(
      index.facts.some(({ factKind }) => factKind === "domain_entity")
    ).toBe(false)
  })

  it("publishes a route fact only when a component resolved", async () => {
    const { index } = await indexFixture({
      files: {
        ...reactAppFixtureFiles,
        "frontend/src/router.tsx": [
          "export const router = [",
          "  {",
          '    path: "ghost",',
          "    async lazy() {",
          '      const Missing = await import("./nowhere")',
          "      return { Component: Missing.default }",
          "    },",
          "  },",
          "]",
        ].join("\n"),
      },
    })

    const route = index.routes.find(
      ({ pathPattern }) => pathPattern === "/ghost"
    )
    expect(route).toMatchObject({
      componentSymbolIds: [],
      unresolvedReasons: ["dynamic_component"],
    })
    expect(
      index.facts.some(({ factKind }) => factKind === "frontend_route")
    ).toBe(false)
  })

  it("assigns reference ordinals from a run-independent key", async () => {
    const { index } = await indexFixture()

    const keys = index.references.map(({ referenceKey }) => referenceKey)
    expect(keys).toStrictEqual([...keys].sort())
    expect(index.references.map(({ ordinal }) => ordinal)).toStrictEqual(
      index.references.map((_unused, position) => position)
    )
    expect(new Set(index.references.map(({ id }) => id)).size).toBe(
      index.references.length
    )
  })

  it("summarizes the module tree", async () => {
    const { index } = await indexFixture()

    const api = index.modules.find(({ path }) => path === "frontend/src/api")
    expect(api).toMatchObject({ fileCount: 2, childDirectories: [] })

    const src = index.modules.find(({ path }) => path === "frontend/src")
    expect(src?.childDirectories).toStrictEqual([
      "frontend/src/api",
      "frontend/src/components",
      "frontend/src/mutations",
      "frontend/src/queries",
    ])
  })

  it("reports statistics for the indexed tree", async () => {
    const { index } = await indexFixture()

    expect(index.statistics).toMatchObject({
      fileCount: 9,
      routeCount: expect.any(Number),
    })
    expect(index.statistics.symbolCount).toBeGreaterThan(9)
    expect(index.statistics.nodeCount).toBeGreaterThan(0)
    expect(index.statistics.totalBytes).toBeGreaterThan(0)
  })

  it("aborts before doing work when the signal is already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      indexFixture({ signal: controller.signal })
    ).rejects.toMatchObject({ code: "aborted" })
  })

  it("stops on the wall-clock budget rather than running past it", async () => {
    let now = 0
    const { index } = await indexFixture({
      limits: { timeoutMs: 1 },
      now: () => {
        now += 10
        return now
      },
    })

    expect(
      index.warnings.some(({ reason }) => reason === "time_budget_exhausted")
    ).toBe(true)
  })

  it("fails closed when the total byte budget is exceeded", async () => {
    await expect(
      indexFixture({ limits: { maxTotalBytes: 200 } })
    ).rejects.toMatchObject({ code: "limit_exceeded", compatibility: true })
  })

  it("fails closed when no tsconfig is discoverable", async () => {
    await expect(
      indexFixture({
        files: { "frontend/src/app.ts": "export const a = 1\n" },
      })
    ).rejects.toMatchObject({ code: "project_not_found" })
  })
})
