import {
  applicationIdSchema,
  commitShaSchema,
  repositoryIdentitySchema,
  runIdSchema,
} from "@sentinel/contracts"

import type { CommitScope } from "./identity.ts"
import { indexTypeScriptSource, type TypeScriptSourceIndex } from "./indexer.ts"
import { resolveIndexLimits, type TypeScriptIndexLimits } from "./limits.ts"
import { defaultIndexPolicy, type IndexPolicy } from "./policy.ts"
import { loadTypeScriptProject, type LoadedProject } from "./project.ts"
import {
  createFakeSourceReader,
  type TypeScriptSourceReader,
} from "./reader.ts"

/**
 * Deterministic scope used by fixtures and tests so emitted IDs are reproducible
 * without needing a real application, run, or checkout.
 */
export const fixtureCommitScope: CommitScope = {
  applicationId: applicationIdSchema.parse(`application:v1:${"a".repeat(64)}`),
  repository: repositoryIdentitySchema.parse({
    host: "github.com",
    owner: "HiEventsDev",
    name: "Hi.Events",
  }),
  commitSha: commitShaSchema.parse("2064f88ff7590e93c738efb8becaa7d732063619"),
}

export const fixtureRunId = runIdSchema.parse(
  "run:6f1d1b64-6f2a-4b6f-9f2e-2a1c3d4e5f60"
)

/**
 * A React fixture tree that mirrors the structural shapes verified in
 * `HiEventsDev/Hi.Events@2064f88f`, so tests exercise real patterns rather than
 * invented ones:
 *
 * - `router.tsx` exports a nested `RouteObject[]` with an empty root path, an
 *   `element` reference, `async lazy()` dynamic imports, a `:token` parameter,
 *   and an optional `:eventsState?` parameter;
 * - `api/client.ts` builds an Axios instance and `api/*.client.ts` exports an
 *   object literal of async methods using literal, concatenated, and template
 *   request paths;
 * - `queries/` and `mutations/` wrap `@tanstack/react-query` hooks around those
 *   client methods;
 * - route components bind handlers through JSX `on*` attributes and label
 *   controls with `@lingui/macro` `t` tagged templates.
 *
 * It also carries the files the policy must exclude: a generated declaration, a
 * locale bundle, a vendored dependency, a build artifact, and a test file.
 */
export const reactAppFixtureFiles: Readonly<Record<string, string>> =
  Object.freeze({
    "frontend/tsconfig.json": `{
  "compilerOptions": {
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": { "@app/*": ["src/*"] },
    "plugins": [{ "name": "unused-transformer" }],
    "types": ["vite/client"]
  },
  "extends": "./tsconfig.base.json",
  "include": ["src"]
}
`,
    "frontend/src/api/client.ts": `import axios from "axios"

export const api = axios.create({ baseURL: "/api" })
`,
    "frontend/src/api/event.client.ts": `import { api } from "./client.ts"

export const eventsClient = {
  create: async (event: unknown) => {
    const response = await api.post("events", event)
    return response.data
  },
  findByID: async (eventId: string) => {
    const response = await api.get("events/" + eventId)
    return response.data
  },
  getEventStats: async (eventId: string, qs: string) => {
    const response = await api.get(\`events/\${eventId}/stats\${qs ? "?" + qs : ""}\`)
    return response.data
  },
}
`,
    "frontend/src/queries/useGetEvent.ts": `import { useQuery } from "@tanstack/react-query"

import { eventsClient } from "../api/event.client.ts"

export const GET_EVENT_QUERY_KEY = "getEvent"

export const useGetEvent = (eventId: string) =>
  useQuery({
    queryKey: [GET_EVENT_QUERY_KEY, eventId],
    queryFn: async () => await eventsClient.findByID(eventId),
  })
`,
    "frontend/src/mutations/useCreateEvent.ts": `import { useMutation } from "@tanstack/react-query"

import { eventsClient } from "../api/event.client.ts"

export const useCreateEvent = () =>
  useMutation({
    mutationFn: (event: unknown) => eventsClient.create(event),
  })
`,
    "frontend/src/components/layouts/DefaultLayout/index.tsx": `const DefaultLayout = () => <main data-testid="default-layout" />

export default DefaultLayout
`,
    "frontend/src/components/routes/events/Dashboard/index.tsx": `import { t } from "@lingui/macro"

import { useCreateEvent } from "../../../../mutations/useCreateEvent.ts"

const Dashboard = () => {
  const createEvent = useCreateEvent()

  const handleCreate = () => {
    createEvent.mutate({ title: "New event" })
  }

  return (
    <section>
      <h1>Events</h1>
      <button data-testid="create-event" aria-label={t\`Create event\`} onClick={handleCreate}>
        Create
      </button>
    </section>
  )
}

export default Dashboard
`,
    "frontend/src/components/routes/auth/ResetPassword/index.tsx": `const ResetPassword = () => <form data-testid="reset-password" />

export default ResetPassword
`,
    "frontend/src/error-page.tsx": `const ErrorPage = () => <div role="alert">Something went wrong</div>

export default ErrorPage
`,
    "frontend/src/router.tsx": `import ErrorPage from "./error-page.tsx"

export const router = [
  {
    path: "",
    element: <ErrorPage />,
    errorElement: <ErrorPage />,
  },
  {
    path: "auth",
    errorElement: <ErrorPage />,
    children: [
      {
        path: "reset-password/:token",
        async lazy() {
          const ResetPassword = await import("./components/routes/auth/ResetPassword")
          return { Component: ResetPassword.default }
        },
      },
    ],
  },
  {
    path: "manage",
    async lazy() {
      const DefaultLayout = await import("./components/layouts/DefaultLayout")
      return { Component: DefaultLayout.default }
    },
    children: [
      {
        path: "events/:eventsState?",
        async lazy() {
          const Dashboard = await import("./components/routes/events/Dashboard")
          return { Component: Dashboard.default }
        },
      },
    ],
  },
]
`,
    "frontend/src/types.d.ts": `export type GenericDataResponse<T> = { data: T }
`,
    "frontend/src/locales/en.ts": `export default { "Create event": "Create event" }
`,
    "frontend/src/router.test.tsx": `import { router } from "./router.tsx"

export const routeCount = router.length
`,
    "frontend/node_modules/axios/index.ts": `export default { create: () => ({}) }
`,
    "frontend/dist/bundle.ts": `export const bundled = true
`,
  })

export interface LoadFixtureProjectOptions {
  readonly roots?: readonly string[]
  readonly policy?: IndexPolicy
  readonly limits?: Partial<TypeScriptIndexLimits>
  readonly tsconfigPath?: string
}

/**
 * Loads an in-memory fixture tree through the same code path production uses,
 * so fixture-backed tests exercise the real reader port, policy, and compiler
 * host rather than a shortcut.
 */
export async function loadFixtureProject(
  files: Readonly<Record<string, string>>,
  options: LoadFixtureProjectOptions = {}
): Promise<LoadedProject> {
  return await loadTypeScriptProject({
    reader: createFakeSourceReader(files),
    roots: options.roots ?? [""],
    policy: options.policy ?? defaultIndexPolicy,
    limits: resolveIndexLimits(options.limits ?? {}),
    ...(options.tsconfigPath === undefined
      ? {}
      : { tsconfigPath: options.tsconfigPath }),
  })
}

export interface IndexFixtureOptions {
  readonly files?: Readonly<Record<string, string>>
  readonly roots?: readonly string[]
  readonly policy?: IndexPolicy
  readonly limits?: Partial<TypeScriptIndexLimits>
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface IndexedFixture {
  readonly index: TypeScriptSourceIndex
  readonly reader: TypeScriptSourceReader
}

/**
 * Indexes a fixture tree with the deterministic scope above, returning the
 * reader alongside the index so query tests can exercise on-demand slices.
 */
export async function indexFixture(
  options: IndexFixtureOptions = {}
): Promise<IndexedFixture> {
  const reader = createFakeSourceReader(options.files ?? reactAppFixtureFiles)
  const index = await indexTypeScriptSource({
    reader,
    applicationId: fixtureCommitScope.applicationId,
    runId: fixtureRunId,
    repository: fixtureCommitScope.repository,
    commitSha: fixtureCommitScope.commitSha,
    roots: options.roots ?? ["frontend/src"],
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { index, reader }
}
