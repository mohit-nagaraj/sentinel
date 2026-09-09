import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  REPORT_FIXTURE_ASSESSMENT_ID,
  REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID,
  FixtureAssessmentReportService,
} from "@/lib/assessment-report-service"

import { handleAssessmentReportRequest } from "./route"

const token = "report-operator-token-that-is-long-enough"
const environment = {
  NODE_ENV: "test",
  SENTINEL_OPERATOR_TOKEN: token,
}

function request(path: string, authorization?: string) {
  return new Request(`https://sentinel.example${path}`, {
    headers:
      authorization === undefined
        ? {}
        : { authorization: `Bearer ${authorization}` },
  })
}

describe("assessment report API", () => {
  let reports: FixtureAssessmentReportService

  beforeEach(() => {
    reports = new FixtureAssessmentReportService()
  })

  it("authorizes before returning a private no-store report", async () => {
    const unauthorized = await handleAssessmentReportRequest(
      request(`/api/assessments/${REPORT_FIXTURE_ASSESSMENT_ID}`),
      [REPORT_FIXTURE_ASSESSMENT_ID],
      reports,
      environment
    )
    expect(unauthorized.status).toBe(401)

    const response = await handleAssessmentReportRequest(
      request(`/api/assessments/${REPORT_FIXTURE_ASSESSMENT_ID}`, token),
      [REPORT_FIXTURE_ASSESSMENT_ID],
      reports,
      environment
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toMatchObject({
      assessmentId: REPORT_FIXTURE_ASSESSMENT_ID,
      overallRisk: "high",
    })
  })

  it("redirects authorized downloads without exposing object keys", async () => {
    const spy = vi.spyOn(reports, "signedDownload")
    const response = await handleAssessmentReportRequest(
      request(
        `/api/assessments/${REPORT_FIXTURE_ASSESSMENT_ID}/download`,
        token
      ),
      [REPORT_FIXTURE_ASSESSMENT_ID, "download"],
      reports,
      environment
    )

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toContain("expires=300")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(spy).toHaveBeenCalledWith(REPORT_FIXTURE_ASSESSMENT_ID, 300)
    expect(await response.text()).not.toContain("applications/")
  })

  it("returns only report-scoped private evidence excerpts", async () => {
    const response = await handleAssessmentReportRequest(
      request(
        `/api/assessments/${REPORT_FIXTURE_ASSESSMENT_ID}/artifacts/${REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID}/excerpt`,
        token
      ),
      [
        REPORT_FIXTURE_ASSESSMENT_ID,
        "artifacts",
        REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID,
        "excerpt",
      ],
      reports,
      environment
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toMatchObject({
      artifactId: REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID,
      truncated: false,
    })

    const missing = await handleAssessmentReportRequest(
      request(
        `/api/assessments/${REPORT_FIXTURE_ASSESSMENT_ID}/artifacts/artifact:v1:${"5".repeat(64)}/excerpt`,
        token
      ),
      [
        REPORT_FIXTURE_ASSESSMENT_ID,
        "artifacts",
        `artifact:v1:${"5".repeat(64)}`,
        "excerpt",
      ],
      reports,
      environment
    )
    expect(missing.status).toBe(404)
  })

  it("fails closed when report authorization is not configured", async () => {
    const response = await handleAssessmentReportRequest(
      request(`/api/assessments/${REPORT_FIXTURE_ASSESSMENT_ID}`, token),
      [REPORT_FIXTURE_ASSESSMENT_ID],
      reports,
      { NODE_ENV: "production" }
    )
    expect(response.status).toBe(503)
  })

  it("returns private not-found and validation responses", async () => {
    const missing = await handleAssessmentReportRequest(
      request("/api/assessments/00000000-0000-4000-8000-000000000999", token),
      ["00000000-0000-4000-8000-000000000999"],
      reports,
      environment
    )
    expect(missing.status).toBe(404)
    const invalid = await handleAssessmentReportRequest(
      request("/api/assessments/not-an-id", token),
      ["not-an-id"],
      reports,
      environment
    )
    expect(invalid.status).toBe(400)
  })
})
