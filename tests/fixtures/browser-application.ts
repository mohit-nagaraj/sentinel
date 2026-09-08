import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { once } from "node:events"

export interface BrowserFixtureApplication {
  readonly origin: string
  readonly requests: readonly { method: string; path: string }[]
  triggerMutation(kind: BrowserFixtureMutation): void
  close(): Promise<void>
}

export type BrowserFixtureMutation = "attributes" | "pii" | "position" | "stale"

function send(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    ...headers,
  })
  response.end(body)
}

function fixturePage(
  authenticationValue: string | undefined,
  stale: boolean,
  staleAttributes: boolean,
  volatileHeading: boolean,
  stalePosition: boolean,
  stalePiiName: boolean
): string {
  const authText =
    authenticationValue === undefined
      ? "Public session"
      : `Authenticated session ${authenticationValue}`
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sentinel browser fixture</title></head>
<body>
  <main>
    <h1>Ticket selection${volatileHeading ? ` ${Date.now()}` : ""}</h1>
    <p data-sentinel-evidence>${authText}</p>
    <p data-sentinel-evidence id="peer-status"></p>
    <iframe title="Embedded profile" src="/embedded"></iframe>
    <form id="checkout-form">
      <label>Email <input name="email" type="email" autocomplete="username"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <label>Ticket type <select name="ticket"><option value="general">General admission</option><option value="vip">VIP</option></select></label>
      <label><input name="terms" type="checkbox"> Accept terms</label>
      <div contenteditable="true">raw-private-note</div>
      <button type="submit">Continue</button>
      <button type="button" id="details">Load attendee details</button>
      <button type="button" id="mutable">Load mutable state</button>
      <button type="button" id="position">Show position state</button>
      <button type="button" id="person">View alice@example.test</button>
    </form>
    <button type="button" id="modal">Open modal</button>
    <button type="button" id="refresh">Refresh state</button>
    <button type="button" id="summary">Load summary</button>
    <button type="button" id="slow">Load slow response</button>
    <button type="button" id="page-error">Show page error</button>
    <button type="button" id="unexpected-popup">Open window</button>
    <button type="button" id="external-socket">Show external socket</button>
    <button type="button" id="delayed-socket">Show delayed connection</button>
    <button type="button">Close account</button>
    <button type="button">Delete account</button>
    <button type="button">Place order</button>
    <button type="button">Send message</button>
    <button type="button">Make administrator</button>
    <button type="submit">Submit mystery</button>
    <a href="/redirect-external">Redirect outside</a>
    <a href="/redirect/0">Redirect chain</a>
    <a href="/download" download>Download invoice</a>
    <a href="/popup" target="_blank">Open popup</a>
    <a href="/preview?sig=${Date.now()}">View signed preview</a>
  </main>
  <script>
    const form = document.querySelector('#checkout-form');
    document.querySelector('#peer-status').textContent = typeof globalThis.RTCPeerConnection === 'undefined' ? 'Peer connection blocked' : 'Peer connection available';
    form.addEventListener('submit', (event) => event.preventDefault());
    document.querySelector('#details').addEventListener('click', async () => {
      const email = form.elements.email.value;
      await fetch('/api/step');
      history.pushState({}, '', '/details/123');
      document.querySelector('main').innerHTML = '<h1>Attendee details</h1><p data-sentinel-evidence></p><button type="button" id="done">Next</button>';
      document.querySelector('[data-sentinel-evidence]').textContent = 'Attendee ' + email + ' is ready';
    });
    document.querySelector('#position').addEventListener('click', () => {
      document.querySelector('[data-sentinel-evidence]').textContent = 'Position target selected';
    });
    document.querySelector('#modal').addEventListener('click', () => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', 'Confirmation');
      dialog.textContent = 'Confirm test.person@example.test';
      document.querySelector('main').append(dialog);
    });
    document.querySelector('#refresh').addEventListener('click', () => {
      document.body.dataset.refreshedAt = String(Date.now());
    });
    document.querySelector('#summary').addEventListener('click', async () => {
      await fetch('/api/users/test.person%40example.test?token=must-not-appear');
      console.error('Summary failed for test.person@example.test');
      document.querySelector('[data-sentinel-evidence]').textContent = 'Summary loaded for test.person@example.test';
    });
    document.querySelector('#slow').addEventListener('click', () => fetch('/api/slow'));
    document.querySelector('#page-error').addEventListener('click', () => {
      setTimeout(() => { throw new Error('Page crashed for buyer@example.test'); }, 0);
    });
    document.querySelector('#unexpected-popup').addEventListener('click', () => {
      window.open('/popup');
    });
    document.querySelector('#external-socket').addEventListener('click', () => {
      new WebSocket('ws://127.0.0.1:9/private');
    });
    document.querySelector('#delayed-socket').addEventListener('click', () => {
      setTimeout(() => new WebSocket('ws://127.0.0.1:9/delayed'), 1000);
    });
    const runMutation = async (kind, mutate) => {
      const response = await fetch('/api/wait-mutation/' + kind);
      if (!response.ok) return;
      mutate();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await fetch('/api/mutation-ready/' + kind);
    };
    ${stale ? "runMutation('stale', () => { const button = document.createElement('button'); button.textContent = 'Late action'; document.querySelector('main').append(button); });" : ""}
    ${staleAttributes ? "runMutation('attributes', () => { document.querySelector('#mutable').type = 'submit'; });" : ""}
    ${stalePosition ? "runMutation('position', () => { const hidden = document.createElement('button'); hidden.hidden = true; document.querySelector('main').prepend(hidden); });" : ""}
    ${stalePiiName ? "runMutation('pii', () => { document.querySelector('#person').textContent = 'View bob@example.test'; });" : ""}
  </script>
</body>
</html>`
}

export async function startBrowserFixtureApplication(): Promise<BrowserFixtureApplication> {
  const requests: Array<{ method: string; path: string }> = []
  const pendingMutations = new Map<BrowserFixtureMutation, ServerResponse[]>()
  const triggeredMutations = new Set<BrowserFixtureMutation>()
  const mutationKinds = new Set<BrowserFixtureMutation>([
    "attributes",
    "pii",
    "position",
    "stale",
  ])
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      requests.push({ method: request.method ?? "GET", path: url.pathname })
      if (url.pathname === "/embedded") {
        send(
          response,
          200,
          '<!doctype html><html><body><label>Embedded secret <input value="iframe-secret-value"></label><p>iframe.person@example.test</p></body></html>',
          { "content-type": "text/html; charset=utf-8" }
        )
        return
      }
      if (url.pathname === "/api/step") {
        send(response, 201, JSON.stringify({ ok: true }), {
          "content-type": "application/json",
        })
        return
      }
      if (url.pathname.startsWith("/api/users/")) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        send(response, 200, JSON.stringify({ ok: true }), {
          "content-type": "application/json",
        })
        return
      }
      if (url.pathname === "/api/slow") {
        await new Promise((resolve) => setTimeout(resolve, 200))
        send(response, 200, JSON.stringify({ ok: true }), {
          "content-type": "application/json",
        })
        return
      }
      if (url.pathname.startsWith("/api/wait-mutation/")) {
        const kind = url.pathname.slice(
          "/api/wait-mutation/".length
        ) as BrowserFixtureMutation
        if (!mutationKinds.has(kind)) {
          response.writeHead(404)
          response.end()
          return
        }
        if (triggeredMutations.delete(kind)) {
          response.writeHead(204)
          response.end()
          return
        }
        const waiters = pendingMutations.get(kind) ?? []
        waiters.push(response)
        pendingMutations.set(kind, waiters)
        return
      }
      if (url.pathname.startsWith("/api/mutation-ready/")) {
        response.writeHead(204)
        response.end()
        return
      }
      if (url.pathname === "/redirect-external") {
        response.writeHead(302, { location: "https://outside.example.test/" })
        response.end()
        return
      }
      if (url.pathname === "/redirect/0") {
        response.writeHead(302, { location: "/redirect/1" })
        response.end()
        return
      }
      if (url.pathname === "/redirect/1") {
        response.writeHead(302, { location: "/redirect/2" })
        response.end()
        return
      }
      if (url.pathname === "/download") {
        send(response, 200, "private invoice", {
          "content-disposition": 'attachment; filename="invoice.txt"',
          "content-type": "text/plain",
        })
        return
      }
      const authenticationValue = request.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("fixture_auth="))
        ?.slice("fixture_auth=".length)
      send(
        response,
        200,
        fixturePage(
          authenticationValue,
          url.pathname === "/stale",
          url.pathname === "/stale-attributes",
          url.pathname === "/volatile",
          url.pathname === "/stale-position",
          url.pathname === "/stale-pii"
        )
      )
    }
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Browser fixture did not bind a TCP port")
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    triggerMutation(kind) {
      const waiters = pendingMutations.get(kind) ?? []
      if (waiters.length === 0) {
        triggeredMutations.add(kind)
        return
      }
      pendingMutations.delete(kind)
      for (const response of waiters) {
        response.writeHead(204)
        response.end()
      }
    },
    async close() {
      for (const waiters of pendingMutations.values()) {
        for (const response of waiters) {
          response.writeHead(410)
          response.end()
        }
      }
      pendingMutations.clear()
      server.close()
      await once(server, "close")
    },
  }
}
