import { notFound } from "next/navigation"

import { KnowledgeWorkspace } from "@/components/knowledge-workspace"
import {
  getKnowledgeService,
  KnowledgeNotFoundError,
} from "@/lib/knowledge-service"

export const dynamic = "force-dynamic"

export default async function ApplicationKnowledgePage({
  params,
}: {
  readonly params: Promise<{ readonly applicationId: string }>
}) {
  const { applicationId } = await params
  const service = getKnowledgeService()
  let data
  try {
    const [initialOverview, initialCoverage, initialWorkflows, initialReviews] =
      await Promise.all([
        service.overview(applicationId),
        service.coverage(applicationId, { limit: 20 }),
        service.workflows(applicationId, { limit: 20 }),
        service.reviews(applicationId, { limit: 20 }),
      ])
    const firstRequirementId = initialCoverage.items[0]?.requirementId
    const initialPath =
      firstRequirementId === undefined
        ? null
        : await service
            .evidencePath(applicationId, firstRequirementId)
            .catch((error) => {
              if (error instanceof KnowledgeNotFoundError) return null
              throw error
            })
    data = {
      initialOverview,
      initialCoverage,
      initialWorkflows,
      initialReviews,
      initialPath,
    }
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError) notFound()
    throw error
  }
  return <KnowledgeWorkspace {...data} />
}
