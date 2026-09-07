import { execFile } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Bare Git fixture holding a small TypeScript/React frontend across two
 * commits. The head commit renames one component and deletes another, which is
 * what the indexer's deleted/renamed file behaviour is verified against.
 */
export interface TypeScriptRepositoryFixture {
  readonly rootPath: string
  readonly workPath: string
  readonly barePath: string
  readonly baseSha: string
  readonly headSha: string
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    windowsHide: true,
  })
  return result.stdout.trim()
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, "commit", "-m", message)
  return await git(cwd, "rev-parse", "HEAD")
}

const TSCONFIG = `{
  "compilerOptions": {
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": { "@app/*": ["src/*"] },
    "plugins": [{ "name": "unused" }]
  },
  "include": ["src"]
}
`

const API_CLIENT = `import axios from "axios"

export const api = axios.create({ baseURL: "/api" })
`

const ORDER_CLIENT = `import { api } from "./client.ts"

export const ordersClient = {
  all: async () => (await api.get("orders")).data,
  findByID: async (orderId: string) => (await api.get("orders/" + orderId)).data,
}
`

const ORDERS_COMPONENT = `import { useQuery } from "@tanstack/react-query"

import { ordersClient } from "../../api/order.client.ts"

const Orders = () => {
  const orders = useQuery({ queryKey: ["orders"], queryFn: () => ordersClient.all() })

  const handleReload = () => orders.refetch()

  return (
    <section>
      <h1 data-testid="orders-title">Orders</h1>
      <button aria-label="Reload orders" onClick={handleReload}>Reload</button>
    </section>
  )
}

export default Orders
`

const LEGACY_COMPONENT = `const Legacy = () => <div data-testid="legacy" />

export default Legacy
`

function routerSource(componentDirectory: string): string {
  return `export const router = [
  {
    path: "manage",
    children: [
      {
        path: "orders/:orderId?",
        async lazy() {
          const Orders = await import("./components/${componentDirectory}/Orders")
          return { Component: Orders.default }
        },
      },
    ],
  },
]
`
}

export async function createTypeScriptRepositoryFixture(): Promise<TypeScriptRepositoryFixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "sentinel-ts-fixture-"))
  const workPath = join(rootPath, "source")
  const barePath = join(rootPath, "fixture.git")
  await mkdir(workPath)
  await git(workPath, "init", "--initial-branch=main")
  await git(workPath, "config", "user.email", "sentinel-tests@example.invalid")
  await git(workPath, "config", "user.name", "Sentinel Tests")

  await mkdir(join(workPath, "frontend", "src", "api"), { recursive: true })
  await mkdir(join(workPath, "frontend", "src", "components", "pages"), {
    recursive: true,
  })
  await mkdir(join(workPath, "frontend", "src", "locales"), { recursive: true })
  await mkdir(join(workPath, "frontend", "node_modules", "axios"), {
    recursive: true,
  })

  const write = async (
    relativePath: string,
    content: string
  ): Promise<void> => {
    await writeFile(join(workPath, relativePath), content)
  }

  await write("frontend/tsconfig.json", TSCONFIG)
  await write("frontend/src/api/client.ts", API_CLIENT)
  await write("frontend/src/api/order.client.ts", ORDER_CLIENT)
  await write("frontend/src/components/pages/Orders.tsx", ORDERS_COMPONENT)
  await write("frontend/src/components/pages/Legacy.tsx", LEGACY_COMPONENT)
  await write("frontend/src/router.tsx", routerSource("pages"))
  await write("frontend/src/locales/en.ts", "export default {}\n")
  await write("frontend/src/generated.d.ts", "export type Generated = string\n")
  await write(
    "frontend/node_modules/axios/index.ts",
    "export default { create: () => ({}) }\n"
  )
  await git(workPath, "add", ".")
  const baseSha = await commit(workPath, "base frontend")

  // Head renames the component directory and drops the legacy component, so the
  // indexer must produce a new code-file identity for the moved file and no
  // identity at all for the deleted one.
  await git(workPath, "switch", "-c", "feature")
  await mkdir(join(workPath, "frontend", "src", "components", "screens"), {
    recursive: true,
  })
  await git(
    workPath,
    "mv",
    "frontend/src/components/pages/Orders.tsx",
    "frontend/src/components/screens/Orders.tsx"
  )
  await git(workPath, "rm", "frontend/src/components/pages/Legacy.tsx")
  await write("frontend/src/router.tsx", routerSource("screens"))
  await git(workPath, "add", ".")
  const headSha = await commit(workPath, "rename and delete components")

  await git(rootPath, "init", "--bare", barePath)
  await git(workPath, "remote", "add", "fixture", barePath)
  await git(workPath, "push", "--all", "fixture")
  return { rootPath, workPath, barePath, baseSha, headSha }
}
