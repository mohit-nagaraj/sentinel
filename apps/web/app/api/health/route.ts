import { createHealthReport } from "@sentinel/contracts"

export function GET(): Response {
  return Response.json(createHealthReport("web"))
}
