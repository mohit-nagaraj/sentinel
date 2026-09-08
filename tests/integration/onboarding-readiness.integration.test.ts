import { createServer, type Server } from "node:http"

import { chromium } from "@playwright/test"
import { afterEach, describe, expect, it } from "vitest"

import { PlaywrightApplicationReadinessProbe } from "@sentinel/adapters/onboarding"

const servers: Server[] = []

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not expose a TCP port")
  }
  return address.port
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) =>
              error === undefined ? resolve() : reject(error)
            )
          )
      )
  )
})

describe("onboarding Playwright readiness", () => {
  it("blocks off-origin WebSocket egress before a connection is opened", async () => {
    let upgradeAttempts = 0
    const socketServer = createServer()
    socketServer.on("upgrade", (_request, socket) => {
      upgradeAttempts += 1
      socket.destroy()
    })
    const socketPort = await listen(socketServer)
    const applicationServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" })
      response.end(`<!doctype html>
        <html><head><title>Readiness fixture</title></head>
        <body><main>Ready</main>
        <script>new WebSocket('ws://127.0.0.1:${socketPort}/leak')</script>
        </body></html>`)
    })
    const applicationPort = await listen(applicationServer)
    const applicationUrl = `http://127.0.0.1:${applicationPort}/`
    const probe = new PlaywrightApplicationReadinessProbe(chromium, {
      allowInsecureLocalhost: true,
      allowPrivateNetworkForTests: true,
    })

    await expect(
      probe.check(applicationUrl, [new URL(applicationUrl).origin])
    ).resolves.toMatchObject({ title: "Readiness fixture" })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(upgradeAttempts).toBe(0)
  })
})
