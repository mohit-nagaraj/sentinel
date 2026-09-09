import { z } from "zod"

import { isControlPlaneFixture } from "@/lib/operator-auth"
import {
  advanceActivityFixture,
  getActivityFixtureSnapshot,
  resetActivityFixture,
} from "@/lib/run-activity-fixture"

export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<Response> {
  if (!isControlPlaneFixture(process.env)) {
    return new Response("Not found", { status: 404 })
  }
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== new URL(request.url).origin) {
    return new Response("Forbidden", { status: 403 })
  }
  try {
    const command = z
      .strictObject({ action: z.enum(["reset", "advance"]) })
      .parse(await request.json())
    if (command.action === "reset") resetActivityFixture()
    else advanceActivityFixture()
    const snapshot = getActivityFixtureSnapshot()
    return Response.json(
      {
        schemaVersion: 1,
        run: snapshot.run,
        eventCount: snapshot.eventPage.items.length,
      },
      { headers: { "cache-control": "private, no-store" } }
    )
  } catch {
    return Response.json(
      { schemaVersion: 1, error: { code: "invalid_fixture_command" } },
      {
        status: 400,
        headers: { "cache-control": "private, no-store" },
      }
    )
  }
}
