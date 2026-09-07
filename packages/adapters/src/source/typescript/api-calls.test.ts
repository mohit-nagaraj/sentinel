import { Node } from "ts-morph"
import { describe, expect, it } from "vitest"

import {
  extractApiCalls,
  normalizeRequestPath,
  type ApiCallExtraction,
} from "./api-calls.ts"
import { IndexBudget, resolveIndexLimits } from "./limits.ts"
import { extractSymbols, type SymbolRecord } from "./symbols.ts"
import { loadFixtureProject } from "./testing.ts"

const tsconfig = '{ "compilerOptions": { "jsx": "react-jsx" } }'

const axiosClient = [
  'import axios from "axios"',
  "export const api = axios.create({ baseURL: '/api' })",
].join("\n")

async function apiCallsOf(
  files: Readonly<Record<string, string>>,
  target: string
): Promise<ApiCallExtraction> {
  const loaded = await loadFixtureProject(files)
  try {
    const limits = resolveIndexLimits()
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
    return extractApiCalls(
      file,
      symbolsByFile.get(target) ?? [],
      byDeclaration,
      limits
    )
  } finally {
    loaded.dispose()
  }
}

describe("request path normalization", () => {
  it("normalizes a literal path", () => {
    expect(
      normalizeRequestPath([{ kind: "literal", text: "events" }])
    ).toStrictEqual({
      pathTemplate: "/events",
      hasQueryString: false,
      reasons: [],
    })
  })

  it("normalizes a concatenation into a parameter placeholder", () => {
    expect(
      normalizeRequestPath([
        { kind: "literal", text: "events/" },
        { kind: "parameter", expressionText: "eventId" },
        { kind: "literal", text: "/counts" },
      ])
    ).toMatchObject({
      pathTemplate: "/events/{param}/counts",
      hasQueryString: false,
    })
  })

  it("splits a literal query string off the path", () => {
    expect(
      normalizeRequestPath([{ kind: "literal", text: "events?page=1" }])
    ).toStrictEqual({
      pathTemplate: "/events",
      hasQueryString: true,
      reasons: [],
    })
  })

  it("treats a trailing query-building substitution as a query string", () => {
    expect(
      normalizeRequestPath([
        { kind: "literal", text: "events/" },
        { kind: "parameter", expressionText: "eventId" },
        { kind: "literal", text: "/stats" },
        { kind: "parameter", expressionText: "qs ? '?' + qs : ''" },
        { kind: "literal", text: "" },
      ])
    ).toMatchObject({
      pathTemplate: "/events/{param}/stats",
      hasQueryString: true,
    })
  })

  it("keeps a path parameter that follows a separator", () => {
    expect(
      normalizeRequestPath([
        { kind: "literal", text: "events/" },
        { kind: "parameter", expressionText: "id ? id : fallback" },
      ])
    ).toMatchObject({ pathTemplate: "/events/{param}" })
  })

  it("refuses to guess when nothing literal survives", () => {
    expect(
      normalizeRequestPath([{ kind: "parameter", expressionText: "url" }])
    ).toStrictEqual({
      pathTemplate: undefined,
      hasQueryString: false,
      reasons: ["computed_request_path"],
    })
  })
})

describe("API call extraction", () => {
  it("extracts the three literal, concatenated, and template shapes", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/api/client.ts": axiosClient,
        "src/api/event.client.ts": [
          'import { api } from "./client.ts"',
          "export const eventsClient = {",
          "  create: async (event: unknown) => api.post('events', event),",
          "  findByID: async (eventId: string) => api.get('events/' + eventId),",
          "  getEventStats: async (eventId: string, qs: string) =>",
          "    api.get(`events/${eventId}/stats${qs ? '?' + qs : ''}`),",
          "  remove: async (eventId: string) => api.delete('events/' + eventId),",
          "}",
        ].join("\n"),
      },
      "src/api/event.client.ts"
    )

    expect(
      candidates.map(
        ({ method, pathTemplate, ownerQualifiedName, hasQueryString }) => ({
          method,
          pathTemplate,
          ownerQualifiedName,
          hasQueryString,
        })
      )
    ).toStrictEqual([
      {
        method: "POST",
        pathTemplate: "/events",
        ownerQualifiedName: "src/api/event.client.ts#eventsClient.create",
        hasQueryString: false,
      },
      {
        method: "GET",
        pathTemplate: "/events/{param}",
        ownerQualifiedName: "src/api/event.client.ts#eventsClient.findByID",
        hasQueryString: false,
      },
      {
        method: "GET",
        pathTemplate: "/events/{param}/stats",
        ownerQualifiedName:
          "src/api/event.client.ts#eventsClient.getEventStats",
        hasQueryString: true,
      },
      {
        method: "DELETE",
        pathTemplate: "/events/{param}",
        ownerQualifiedName: "src/api/event.client.ts#eventsClient.remove",
        hasQueryString: false,
      },
    ])
  })

  it("never emits a backend endpoint identity", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/api/client.ts": axiosClient,
        "src/api/a.client.ts": [
          'import { api } from "./client.ts"',
          "export const aClient = { all: async () => api.get('events') }",
        ].join("\n"),
      },
      "src/api/a.client.ts"
    )

    expect(Object.keys(candidates[0] ?? {}).sort()).toStrictEqual([
      "client",
      "filePath",
      "hasQueryString",
      "method",
      "ownerQualifiedName",
      "pathTemplate",
      "range",
      "rawPath",
      "unresolvedReasons",
    ])
  })

  it("recognizes an axios instance only through its declaration", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/notAClient.ts": [
          "const api = { get: (path: string) => path }",
          "export const run = () => api.get('events')",
        ].join("\n"),
      },
      "src/notAClient.ts"
    )

    expect(candidates).toStrictEqual([])
  })

  it("extracts a direct axios call with a literal method", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": [
          'import axios from "axios"',
          "export const run = () => axios({ method: 'put', url: 'events/1' })",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(candidates.at(0)).toMatchObject({
      client: "axios",
      method: "PUT",
      pathTemplate: "/events/1",
    })
  })

  it("extracts an axios request call", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/api/client.ts": axiosClient,
        "src/a.ts": [
          'import { api } from "./api/client.ts"',
          "export const run = () => api.request({ method: 'PATCH', url: 'orders/1' })",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(candidates.at(0)).toMatchObject({
      client: "axios",
      method: "PATCH",
      pathTemplate: "/orders/1",
    })
  })

  it("defaults a fetch call without options to GET", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": "export const run = () => fetch('/api/events')\n",
      },
      "src/a.ts"
    )

    expect(candidates.at(0)).toMatchObject({
      client: "fetch",
      method: "GET",
      pathTemplate: "/api/events",
    })
  })

  it("reads an explicit fetch method", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts":
          "export const run = () => fetch('/api/events', { method: 'POST' })\n",
      },
      "src/a.ts"
    )

    expect(candidates.at(0)).toMatchObject({ method: "POST" })
  })

  it("marks a fully computed request path unresolved", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/api/client.ts": axiosClient,
        "src/a.ts": [
          'import { api } from "./api/client.ts"',
          "export const run = (url: string) => api.get(url)",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(candidates.at(0)).toMatchObject({
      method: "GET",
      pathTemplate: undefined,
      rawPath: "url",
      unresolvedReasons: ["computed_request_path"],
    })
  })

  it("does not treat a path-shaped string outside a request as a call", async () => {
    const { candidates } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": [
          "// api.get('events') in a comment",
          "export const docs = \"api.post('events')\"",
          "export const paths = ['events/1', 'orders/2']",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(candidates).toStrictEqual([])
  })

  it("links a React Query hook to the API client method it calls", async () => {
    const { hooks } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/api/client.ts": axiosClient,
        "src/api/user.client.ts": [
          'import { api } from "./client.ts"',
          "export const userClient = { me: async () => api.get('users/me') }",
        ].join("\n"),
        "src/queries/useGetMe.ts": [
          'import { useQuery } from "@tanstack/react-query"',
          'import { userClient } from "../api/user.client.ts"',
          "export const useGetMe = () =>",
          "  useQuery({",
          "    queryKey: ['getMe'],",
          "    queryFn: async () => {",
          "      const { data } = await userClient.me()",
          "      return data",
          "    },",
          "  })",
        ].join("\n"),
      },
      "src/queries/useGetMe.ts"
    )

    expect(hooks).toStrictEqual([
      {
        filePath: "src/queries/useGetMe.ts",
        ownerQualifiedName: "src/queries/useGetMe.ts#useGetMe",
        hook: "useQuery",
        range: { startLine: 4, endLine: 10 },
        callTargetQualifiedNames: ["src/api/user.client.ts#userClient.me"],
        unresolvedReasons: [],
      },
    ])
  })

  it("links a mutation hook to its client method", async () => {
    const { hooks } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/api/client.ts": axiosClient,
        "src/api/event.client.ts": [
          'import { api } from "./client.ts"',
          "export const eventsClient = { create: async (e: unknown) => api.post('events', e) }",
        ].join("\n"),
        "src/mutations/useCreateEvent.ts": [
          'import { useMutation } from "@tanstack/react-query"',
          'import { eventsClient } from "../api/event.client.ts"',
          "export const useCreateEvent = () =>",
          "  useMutation({ mutationFn: (e: unknown) => eventsClient.create(e) })",
        ].join("\n"),
      },
      "src/mutations/useCreateEvent.ts"
    )

    expect(hooks.at(0)).toMatchObject({
      hook: "useMutation",
      callTargetQualifiedNames: ["src/api/event.client.ts#eventsClient.create"],
    })
  })

  it("ignores a same-named hook not imported from react-query", async () => {
    const { hooks } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/local.ts": [
          "const useQuery = (options: unknown) => options",
          "export const run = () => useQuery({ queryFn: () => 1 })",
        ].join("\n"),
      },
      "src/local.ts"
    )

    expect(hooks).toStrictEqual([])
  })

  it("records an aliased react-query hook import", async () => {
    const { hooks } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": [
          'import { useQuery as useRemoteQuery } from "@tanstack/react-query"',
          "export const run = () => useRemoteQuery({ queryFn: () => 1 })",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(hooks.at(0)).toMatchObject({ hook: "useQuery" })
  })

  it("marks a hook with no recognizable query function as unsupported", async () => {
    const { hooks } = await apiCallsOf(
      {
        "tsconfig.json": tsconfig,
        "src/a.ts": [
          'import { useQuery } from "@tanstack/react-query"',
          "declare const options: { queryKey: string[] }",
          "export const run = () => useQuery(options)",
        ].join("\n"),
      },
      "src/a.ts"
    )

    expect(hooks.at(0)?.unresolvedReasons).toStrictEqual(["unsupported_syntax"])
  })
})
