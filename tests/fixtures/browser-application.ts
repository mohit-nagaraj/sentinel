import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { once } from "node:events"

export interface BrowserFixtureApplication {
  readonly origin: string
  readonly requests: readonly { method: string; path: string }[]
  close(): Promise<void>
}

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

function fixturePage(authenticated: boolean, stale: boolean): string {
  const authText = authenticated ? "Authenticated session" : "Public session"
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sentinel browser fixture</title></head>
<body>
  <main>
    <h1>Ticket selection</h1>
    <p data-sentinel-evidence>${authText}</p>
    <form id="checkout-form">
      <label>Email <input name="email" type="email" autocomplete="username"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <label>Ticket type <select name="ticket"><option value="general">General admission</option><option value="vip">VIP</option></select></label>
      <label><input name="terms" type="checkbox"> Accept terms</label>
      <button type="submit">Continue</button>
    </form>
    <button type="button" id="modal">Open modal</button>
    <button type="button" id="refresh">Refresh state</button>
    <button type="button" id="summary">Load summary</button>
    <button type="button" id="slow">Slow action</button>
    <button type="button" id="page-error">Throw page error</button>
    <button type="button">Delete account</button>
    <button type="button">Place order</button>
    <button type="button">Send message</button>
    <button type="button">Make administrator</button>
    <button type="submit">Submit mystery</button>
    <a href="/redirect-external">Redirect outside</a>
    <a href="/redirect/0">Redirect chain</a>
    <a href="/download" download>Download invoice</a>
    <a href="/popup" target="_blank">Open popup</a>
  </main>
  <script>
    const form = document.querySelector('#checkout-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = form.elements.email.value;
      await fetch('/api/step', { method: 'POST', body: JSON.stringify({ email }) });
      history.pushState({}, '', '/details/123');
      document.querySelector('main').innerHTML = '<h1>Attendee details</h1><p data-sentinel-evidence></p><button type="button" id="done">Next</button>';
      document.querySelector('[data-sentinel-evidence]').textContent = 'Attendee ' + email + ' is ready';
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
      await fetch('/api/summary?token=must-not-appear');
      console.error('Summary failed for test.person@example.test');
      document.querySelector('[data-sentinel-evidence]').textContent = 'Summary loaded for test.person@example.test';
    });
    document.querySelector('#slow').addEventListener('click', () => fetch('/api/slow'));
    document.querySelector('#page-error').addEventListener('click', () => {
      setTimeout(() => { throw new Error('Page crashed for buyer@example.test'); }, 0);
    });
    ${stale ? "setTimeout(() => { const button = document.createElement('button'); button.textContent = 'Late action'; document.querySelector('main').append(button); }, 500);" : ""}
  </script>
</body>
</html>`
}

export async function startBrowserFixtureApplication(): Promise<BrowserFixtureApplication> {
  const requests: Array<{ method: string; path: string }> = []
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      requests.push({ method: request.method ?? "GET", path: url.pathname })
      if (url.pathname === "/api/step") {
        send(response, 201, JSON.stringify({ ok: true }), {
          "content-type": "application/json",
        })
        return
      }
      if (url.pathname === "/api/summary") {
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
      const authenticated =
        request.headers.cookie?.includes("fixture_auth=yes") ?? false
      send(response, 200, fixturePage(authenticated, url.pathname === "/stale"))
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
    async close() {
      server.close()
      await once(server, "close")
    },
  }
}
