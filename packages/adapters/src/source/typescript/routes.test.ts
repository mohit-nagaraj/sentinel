import { Node } from "ts-morph"
import { describe, expect, it } from "vitest"

import { IndexBudget, resolveIndexLimits } from "./limits.ts"
import {
  composeRoutePattern,
  extractRoutes,
  type RouteRecord,
} from "./routes.ts"
import { extractSymbols, type SymbolRecord } from "./symbols.ts"
import { loadFixtureProject } from "./testing.ts"

const tsconfig = '{ "compilerOptions": { "jsx": "react-jsx" } }'

async function routesOf(
  files: Readonly<Record<string, string>>,
  target: string,
  overrides: Parameters<typeof resolveIndexLimits>[0] = {}
): Promise<readonly RouteRecord[]> {
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
    return extractRoutes(
      file,
      loaded.project,
      byDeclaration,
      symbolsByFile,
      limits
    ).routes
  } finally {
    loaded.dispose()
  }
}

describe("route pattern composition", () => {
  it.each([
    ["/", "", "/"],
    ["/", "auth", "/auth"],
    ["/auth", "login", "/auth/login"],
    ["/auth", "", "/auth"],
    ["/auth", "/manage", "/manage"],
    ["/manage", "events/:eventsState?", "/manage/events/:eventsState?"],
    ["/auth", "reset-password/:token", "/auth/reset-password/:token"],
    ["/", "manage/event/:eventId", "/manage/event/:eventId"],
  ])("composes %s + %s into %s", (parent, segment, expected) => {
    expect(composeRoutePattern(parent, segment)).toBe(expected)
  })
})

describe("route extraction", () => {
  it("walks the nested router array Hi.Events declares", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/error-page.tsx": [
          "const ErrorPage = () => <div />",
          "export default ErrorPage",
        ].join("\n"),
        "src/components/layouts/AuthLayout/index.tsx": [
          "const AuthLayout = () => <div />",
          "export default AuthLayout",
        ].join("\n"),
        "src/components/routes/auth/Login/index.tsx": [
          "const Login = () => <div />",
          "export default Login",
        ].join("\n"),
        "src/components/routes/auth/ResetPassword/index.tsx": [
          "const ResetPassword = () => <div />",
          "export default ResetPassword",
        ].join("\n"),
        "src/router.tsx": [
          'import ErrorPage from "./error-page.tsx"',
          "export const router = [",
          "  {",
          '    path: "auth",',
          "    async lazy() {",
          '      const AuthLayout = await import("./components/layouts/AuthLayout")',
          "      return { Component: AuthLayout.default }",
          "    },",
          "    errorElement: <ErrorPage />,",
          "    children: [",
          "      {",
          '        path: "login",',
          "        async lazy() {",
          '          const Login = await import("./components/routes/auth/Login")',
          "          return { Component: Login.default }",
          "        },",
          "      },",
          "      {",
          '        path: "reset-password/:token",',
          "        async lazy() {",
          '          const ResetPassword = await import("./components/routes/auth/ResetPassword")',
          "          return { Component: ResetPassword.default }",
          "        },",
          "      },",
          "    ],",
          "  },",
          "]",
        ].join("\n"),
      },
      "src/router.tsx"
    )

    expect(
      routes.map(
        ({ pathPattern, componentQualifiedNames, layoutQualifiedNames }) => ({
          pathPattern,
          componentQualifiedNames,
          layoutQualifiedNames,
        })
      )
    ).toStrictEqual([
      {
        pathPattern: "/auth",
        componentQualifiedNames: [
          "src/components/layouts/AuthLayout/index.tsx#AuthLayout",
        ],
        layoutQualifiedNames: [],
      },
      {
        pathPattern: "/auth/login",
        componentQualifiedNames: [
          "src/components/routes/auth/Login/index.tsx#Login",
        ],
        layoutQualifiedNames: [
          "src/components/layouts/AuthLayout/index.tsx#AuthLayout",
        ],
      },
      {
        pathPattern: "/auth/reset-password/:token",
        componentQualifiedNames: [
          "src/components/routes/auth/ResetPassword/index.tsx#ResetPassword",
        ],
        layoutQualifiedNames: [
          "src/components/layouts/AuthLayout/index.tsx#AuthLayout",
        ],
      },
    ])
    expect(
      routes.every(({ unresolvedReasons }) => unresolvedReasons.length === 0)
    ).toBe(true)
  })

  it("resolves an element JSX component reference", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/Root.tsx": [
          "const Root = () => <div />",
          "export default Root",
        ].join("\n"),
        "src/router.tsx": [
          'import Root from "./Root.tsx"',
          'export const router = [{ path: "", element: <Root /> }]',
        ].join("\n"),
      },
      "src/router.tsx"
    )

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      pathPattern: "/",
      declaredSegment: "",
      componentQualifiedNames: ["src/Root.tsx#Root"],
      unresolvedReasons: [],
    })
  })

  it("resolves a Component property reference", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/Page.tsx": [
          "const Page = () => <div />",
          "export default Page",
        ].join("\n"),
        "src/router.tsx": [
          'import Page from "./Page.tsx"',
          'export const router = [{ path: "page", Component: Page }]',
        ].join("\n"),
      },
      "src/router.tsx"
    )

    expect(routes[0]).toMatchObject({
      pathPattern: "/page",
      componentQualifiedNames: ["src/Page.tsx#Page"],
    })
  })

  it("extracts routes handed to createBrowserRouter", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/Home.tsx": [
          "const Home = () => <div />",
          "export default Home",
        ].join("\n"),
        "src/main.tsx": [
          'import { createBrowserRouter } from "react-router-dom"',
          'import Home from "./Home.tsx"',
          'export const router = createBrowserRouter([{ path: "/", element: <Home /> }])',
        ].join("\n"),
      },
      "src/main.tsx"
    )

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      pathPattern: "/",
      componentQualifiedNames: ["src/Home.tsx#Home"],
    })
  })

  it("extracts a JSX Routes tree", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/Dashboard.tsx": [
          "const Dashboard = () => <div />",
          "export default Dashboard",
        ].join("\n"),
        "src/App.tsx": [
          'import { Route, Routes } from "react-router"',
          'import Dashboard from "./Dashboard.tsx"',
          "export const App = () => (",
          "  <Routes>",
          '    <Route path="manage">',
          '      <Route path="dashboard" element={<Dashboard />} />',
          "    </Route>",
          "  </Routes>",
          ")",
        ].join("\n"),
      },
      "src/App.tsx"
    )

    expect(
      routes.map(({ pathPattern, componentQualifiedNames }) => [
        pathPattern,
        componentQualifiedNames,
      ])
    ).toStrictEqual([
      ["/manage", []],
      ["/manage/dashboard", ["src/Dashboard.tsx#Dashboard"]],
    ])
  })

  it("inherits the parent pattern for an index route", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/Index.tsx": [
          "const IndexPage = () => <div />",
          "export default IndexPage",
        ].join("\n"),
        "src/router.tsx": [
          'import IndexPage from "./Index.tsx"',
          "export const router = [",
          '  { path: "manage", children: [{ index: true, element: <IndexPage /> }] },',
          "]",
        ].join("\n"),
      },
      "src/router.tsx"
    )

    expect(
      routes.map(({ pathPattern, isIndexRoute }) => [pathPattern, isIndexRoute])
    ).toStrictEqual([
      ["/manage", false],
      ["/manage", true],
    ])
  })

  it("marks a computed route path unresolved rather than guessing", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/Page.tsx": [
          "const Page = () => <div />",
          "export default Page",
        ].join("\n"),
        "src/router.tsx": [
          'import Page from "./Page.tsx"',
          'const prefix = "manage"',
          "export const router = [{ path: `${prefix}/events`, element: <Page /> }]",
        ].join("\n"),
      },
      "src/router.tsx"
    )

    expect(routes[0]).toMatchObject({
      pathPattern: "/",
      declaredSegment: "",
      unresolvedReasons: ["computed_route_path"],
    })
  })

  it("marks an unresolvable lazy import as a dynamic component", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/router.tsx": [
          "export const router = [",
          "  {",
          '    path: "ghost",',
          "    async lazy() {",
          '      const Missing = await import("./does-not-exist")',
          "      return { Component: Missing.default }",
          "    },",
          "  },",
          "]",
        ].join("\n"),
      },
      "src/router.tsx"
    )

    expect(routes[0]).toMatchObject({
      pathPattern: "/ghost",
      componentQualifiedNames: [],
      unresolvedReasons: ["dynamic_component"],
      unresolvedComponents: ["./does-not-exist"],
    })
  })

  it("marks a computed lazy specifier as a dynamic component", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/router.tsx": [
          'const name = "Login"',
          "export const router = [",
          "  {",
          '    path: "dyn",',
          "    lazy: async () => {",
          "      const Mod = await import(`./components/${name}`)",
          "      return { Component: Mod.default }",
          "    },",
          "  },",
          "]",
        ].join("\n"),
      },
      "src/router.tsx"
    )

    expect(routes[0]?.unresolvedReasons).toStrictEqual(["dynamic_component"])
    expect(routes[0]?.componentQualifiedNames).toStrictEqual([])
  })

  it("marks an inline anonymous element as a dynamic component", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/router.tsx":
          'export const router = [{ path: "x", Component: () => null }]\n',
      },
      "src/router.tsx"
    )

    expect(routes[0]?.unresolvedReasons).toStrictEqual(["dynamic_component"])
  })

  it("does not treat an unrelated object array as routes", async () => {
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/config.ts": 'export const items = [{ label: "a", value: 1 }]\n',
      },
      "src/config.ts"
    )

    expect(routes).toStrictEqual([])
  })

  it("reports a route budget overrun", async () => {
    const entries = Array.from(
      { length: 6 },
      (_unused, index) => `  { path: "p${index}" },`
    ).join("\n")
    const routes = await routesOf(
      {
        "tsconfig.json": tsconfig,
        "src/router.tsx": `export const router = [\n${entries}\n]\n`,
      },
      "src/router.tsx",
      { maxRoutes: 3 }
    )

    expect(routes).toHaveLength(3)
  })
})
