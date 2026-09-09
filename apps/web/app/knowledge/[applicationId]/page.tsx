import { notFound } from "next/navigation"

import { KnowledgeWorkspace } from "@/components/knowledge-workspace"
import {
  getKnowledgeService,
  KnowledgeNotFoundError,
} from "@/lib/knowledge-service"

export const dynamic = "force-dynamic"

async function loadKnowledgeApplication(applicationId: string) {
  const service = getKnowledgeService()
  try {
    const [overview, coverage, workflows, reviews] = await Promise.all([
      service.overview(applicationId),
      service.coverage(applicationId, { limit: 20 }),
      service.workflows(applicationId, { limit: 20 }),
      service.reviews(applicationId, { limit: 20 }),
    ])
    const firstRequirementId = coverage.items[0]?.requirementId
    let path = null
    if (firstRequirementId !== undefined) {
      try {
        path = await service.evidencePath(applicationId, firstRequirementId)
      } catch (error) {
        if (!(error instanceof KnowledgeNotFoundError)) throw error
      }
    }
    return { overview, coverage, workflows, reviews, path }
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError) notFound()
    throw error
  }
}

export default async function KnowledgeApplicationPage({
  params,
}: {
  readonly params: Promise<{ readonly applicationId: string }>
}) {
  const { applicationId } = await params
  const { overview, coverage, workflows, reviews, path } =
    await loadKnowledgeApplication(applicationId)
  return (
    <KnowledgeWorkspace
      initialOverview={overview}
      initialCoverage={coverage}
      initialWorkflows={workflows}
      initialReviews={reviews}
      initialPath={path}
    />
  )
}
