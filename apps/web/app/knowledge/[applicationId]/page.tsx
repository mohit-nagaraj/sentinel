import { redirect } from "next/navigation"

export default async function LegacyKnowledgePage({
  params,
}: {
  readonly params: Promise<{ readonly applicationId: string }>
}) {
  const { applicationId } = await params
  redirect(`/applications/${applicationId}/knowledge`)
}
