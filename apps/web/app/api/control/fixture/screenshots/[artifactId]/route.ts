import { artifactIdSchema } from "@sentinel/contracts"

import { isControlPlaneFixture } from "@/lib/operator-auth"
import {
  ACTIVITY_FIXTURE_SCREENSHOT_ID,
  getActivityFixtureScreenshot,
  storeActivityFixtureScreenshot,
} from "@/lib/run-activity-fixture"

export const dynamic = "force-dynamic"

type Context = { readonly params: Promise<{ readonly artifactId: string }> }

async function validArtifact(context: Context): Promise<boolean> {
  const parsed = artifactIdSchema.safeParse((await context.params).artifactId)
  return parsed.success && parsed.data === ACTIVITY_FIXTURE_SCREENSHOT_ID
}

export async function GET(
  _request: Request,
  context: Context
): Promise<Response> {
  if (!isControlPlaneFixture(process.env) || !(await validArtifact(context))) {
    return new Response("Not found", { status: 404 })
  }
  const screenshot = getActivityFixtureScreenshot()
  if (screenshot === undefined)
    return new Response("Not found", { status: 404 })
  return new Response(screenshot, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
    },
  })
}

export async function POST(
  request: Request,
  context: Context
): Promise<Response> {
  if (!isControlPlaneFixture(process.env) || !(await validArtifact(context))) {
    return new Response("Not found", { status: 404 })
  }
  if (request.headers.get("content-type")?.toLowerCase() !== "image/png") {
    return new Response("PNG required", { status: 415 })
  }
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > 2_000_000) return new Response("Too large", { status: 413 })
  try {
    storeActivityFixtureScreenshot(await request.arrayBuffer())
    return Response.json(
      { schemaVersion: 1, artifactId: ACTIVITY_FIXTURE_SCREENSHOT_ID },
      {
        status: 201,
        headers: { "cache-control": "private, no-store" },
      }
    )
  } catch {
    return new Response("Invalid PNG", { status: 400 })
  }
}
