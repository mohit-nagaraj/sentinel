import { once } from "node:events"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"

export interface ApplicationExplorerFixtureRequest {
  readonly method: string
  readonly path: string
}

export interface ApplicationExplorerFixtureApplication {
  readonly origin: string
  readonly requests: readonly ApplicationExplorerFixtureRequest[]
  triggerStaleMutation(): void
  close(): Promise<void>
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = "text/html; charset=utf-8"
): void {
  response.writeHead(status, { "content-type": contentType })
  response.end(body)
}

function page(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
  </head>
  <body>
    <main>${body}</main>
    ${script.length === 0 ? "" : `<script>${script}</script>`}
  </body>
</html>`
}

function dashboardPage(): string {
  return page(
    "Event operations",
    `<h1>Event operations</h1>
     <p data-sentinel-evidence>Explore registration and organizer workflows.</p>
     <nav aria-label="Application areas">
       <a href="/events/42">View event details</a>
       <a href="/organizer">View organizer overview</a>
     </nav>
     <button type="button" id="open-modal">Open modal</button>
     <button type="button" id="refresh-state">Refresh state</button>
     <button type="button">Place order</button>`,
    `
      document.querySelector("#open-modal").addEventListener("click", () => {
        const dialog = document.createElement("dialog");
        dialog.setAttribute("aria-label", "Event guidance");
        dialog.innerHTML = "<h2>Event guidance</h2><p>Choose an application area.</p>";
        document.querySelector("main").append(dialog);
        dialog.showModal();
      });
      document.querySelector("#refresh-state").addEventListener("click", () => {
        globalThis.fixtureRefreshCount = (globalThis.fixtureRefreshCount ?? 0) + 1;
      });
    `
  )
}

function eventPage(): string {
  return page(
    "Autumn Summit",
    `<h1>Autumn Summit</h1>
     <p data-sentinel-evidence>Registration is open.</p>
     <a href="/register">View registration details</a>
     <a href="/schedule">View event schedule</a>`
  )
}

function registrationPage(): string {
  return page(
    "Registration details",
    `<h1>Registration details</h1>
     <p data-sentinel-evidence id="ticket-status">Ticket status has not been loaded.</p>
     <form>
       <label for="attendee-email">Attendee email</label>
       <input id="attendee-email" name="attendee-email" type="email">
       <label for="ticket-tier">Ticket tier</label>
       <select id="ticket-tier" name="ticket-tier">
         <option value="general">General</option>
         <option value="vip">VIP</option>
       </select>
       <label for="attendee-contact" id="attendee-contact-label">General attendee contact</label>
       <input id="attendee-contact" name="attendee-contact" type="text">
       <label><input name="terms" type="checkbox"> Accept event terms</label>
     </form>
     <button type="button" id="load-status">Load ticket status</button>
     <a href="/review">View registration review</a>`,
    `
      document.querySelector("#ticket-tier").addEventListener("change", (event) => {
        const tier = event.target.value === "vip" ? "VIP" : "General";
        document.querySelector("#attendee-contact-label").textContent = tier + " attendee contact";
      });
      document.querySelector("#load-status").addEventListener("click", async () => {
        const response = await fetch("/api/ticket-status");
        const result = await response.json();
        document.querySelector("#ticket-status").textContent = result.summary;
      });
    `
  )
}

function stalePage(): string {
  return page(
    "Stale action",
    `<h1>Stale action</h1>
     <p data-sentinel-evidence>The visible action changes after observation.</p>
     <button type="button" id="stale-action">View stable details</button>`,
    `
      fetch("/api/wait-mutation/stale").then(async (response) => {
        if (!response.ok) return;
        document.querySelector("#stale-action").textContent = "View changed details";
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
        await fetch("/api/mutation-ready/stale");
      });
    `
  )
}

export async function startApplicationExplorerFixture(): Promise<ApplicationExplorerFixtureApplication> {
  const requests: ApplicationExplorerFixtureRequest[] = []
  const pendingStaleWaiters: ServerResponse[] = []
  let staleTriggered = false

  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      requests.push({ method: request.method ?? "GET", path: url.pathname })

      if (url.pathname === "/api/wait-mutation/stale") {
        if (staleTriggered) {
          staleTriggered = false
          response.writeHead(204)
          response.end()
          return
        }
        pendingStaleWaiters.push(response)
        return
      }
      if (url.pathname === "/api/mutation-ready/stale") {
        response.writeHead(204)
        response.end()
        return
      }

      switch (url.pathname) {
        case "/":
          send(response, 200, dashboardPage())
          return
        case "/events/42":
          send(response, 200, eventPage())
          return
        case "/schedule":
          send(
            response,
            200,
            page(
              "Event schedule",
              "<h1>Event schedule</h1><p data-sentinel-evidence>Doors open at 09:00.</p>"
            )
          )
          return
        case "/register":
          send(response, 200, registrationPage())
          return
        case "/review":
          send(
            response,
            200,
            page(
              "Registration review",
              `<h1>Registration review</h1>
               <p data-sentinel-evidence>Review the attendee and ticket information.</p>
               <button type="button">Place order</button>`
            )
          )
          return
        case "/organizer":
          send(
            response,
            200,
            page(
              "Organizer overview",
              `<h1>Organizer overview</h1>
               <p data-sentinel-evidence>Attendance and check-in status are available.</p>
               <button type="button">Load attendance summary</button>`
            )
          )
          return
        case "/stale":
          send(response, 200, stalePage())
          return
        case "/api/ticket-status":
          send(
            response,
            200,
            JSON.stringify({
              summary: "VIP and general tickets are available.",
            }),
            "application/json; charset=utf-8"
          )
          return
        default:
          send(response, 404, page("Not found", "<h1>Not found</h1>"))
      }
    }
  )

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Application Explorer fixture did not bind a TCP port")
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    triggerStaleMutation() {
      if (pendingStaleWaiters.length === 0) {
        staleTriggered = true
        return
      }
      for (const waiter of pendingStaleWaiters) {
        waiter.writeHead(204)
        waiter.end()
      }
      pendingStaleWaiters.length = 0
    },
    async close() {
      for (const waiter of pendingStaleWaiters) {
        waiter.writeHead(410)
        waiter.end()
      }
      pendingStaleWaiters.length = 0
      server.close()
      await once(server, "close")
    },
  }
}
