import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { AssessmentReportWorkspace } from "@/components/assessment-report-workspace"
import { AssessmentReportStatus } from "@/components/assessment-report-status"
import { getAssessmentReportService } from "@/lib/assessment-report-service"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Assessment report | Sentinel",
  description: "Evidence-grounded pull-request blast-radius assessment.",
}

export default async function AssessmentReportPage({
  params,
}: {
  readonly params: Promise<{ readonly assessmentId: string }>
}) {
  const parsed = z.uuid().safeParse((await params).assessmentId)
  if (!parsed.success) notFound()
  const service = getAssessmentReportService()
  const report = await service.get(parsed.data)
  if (report === null) {
    const status = await service.status(parsed.data)
    if (status === null) notFound()
    return <AssessmentReportStatus assessment={status} />
  }
  return <AssessmentReportWorkspace report={report} />
}
