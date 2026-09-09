import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { z } from "zod"

import { AssessmentReportWorkspace } from "@/components/assessment-report-workspace"
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
  const report = await getAssessmentReportService().get(parsed.data)
  if (report === null) notFound()
  return <AssessmentReportWorkspace report={report} />
}
