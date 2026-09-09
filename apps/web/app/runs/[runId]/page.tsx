import { notFound, redirect } from "next/navigation"

import { databaseRunIdSchema } from "@sentinel/contracts"

import { getRunControlService } from "@/lib/run-control"

export default async function LegacyRunPage({
  params,
}: {
  readonly params: Promise<{ readonly runId: string }>
}) {
  const runId = databaseRunIdSchema.safeParse((await params).runId)
  if (!runId.success) notFound()
  const run = await getRunControlService().get(runId.data)
  if (run === null) notFound()
  redirect(`/applications/${run.applicationId}/activity/${run.id}`)
}
