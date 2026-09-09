import {
  assessmentReportViewSchema,
  privateArtifactExcerptSchema,
  type AssessmentReportView,
  type ArtifactId,
  type PrivateArtifactExcerpt,
} from "@sentinel/contracts"
import {
  ArtifactMetadataRepository,
  ArtifactService,
  AssessmentReportDeliveryService,
  AssessmentReportRepository,
  S3PrivateObjectStore,
  createPostgresDatabase,
  loadStorageEnvironment,
} from "@sentinel/storage"
import { z } from "zod"

import sampleReportSource from "../../../docs/delivery/sample-report-hi-events-pr-1338.json"
import {
  buildSampleReportView,
  renderSampleReportMarkdown,
  sampleReportSchema,
} from "../../../tools/delivery/sample-report.ts"
import { isControlPlaneFixture } from "./operator-auth"

export const REPORT_FIXTURE_ASSESSMENT_ID =
  "00000000-0000-4000-8000-000000000029"
export const REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID =
  `artifact:v1:${"9".repeat(64)}` as ArtifactId

export type AssessmentReportDownload =
  | {
      readonly kind: "redirect"
      readonly url: string
    }
  | {
      readonly kind: "content"
      readonly body: string
      readonly filename: string
    }

export interface AssessmentReportWebService {
  get(assessmentId: string): Promise<AssessmentReportView | null>
  download(
    assessmentId: string,
    expiresInSeconds?: number
  ): Promise<AssessmentReportDownload | null>
  artifactExcerpt(
    assessmentId: string,
    artifactId: string
  ): Promise<PrivateArtifactExcerpt | null>
}

const sampleReport = sampleReportSchema.parse(sampleReportSource)

function fixtureView(): AssessmentReportView {
  return buildSampleReportView(sampleReport)
}

export class FixtureAssessmentReportService implements AssessmentReportWebService {
  async get(assessmentId: string) {
    return assessmentId === REPORT_FIXTURE_ASSESSMENT_ID ? fixtureView() : null
  }

  async download(assessmentId: string) {
    return assessmentId === REPORT_FIXTURE_ASSESSMENT_ID
      ? {
          kind: "content" as const,
          body: renderSampleReportMarkdown(sampleReport),
          filename: "sentinel-hi-events-pr-1338.md",
        }
      : null
  }

  async artifactExcerpt(assessmentId: string, artifactId: string) {
    return assessmentId === REPORT_FIXTURE_ASSESSMENT_ID &&
      artifactId === REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID
      ? privateArtifactExcerptSchema.parse({
          schemaVersion: 1,
          artifactId,
          mimeType: "text/plain",
          excerpt:
            "AccountAttributionRepository groups attribution statistics and revenue by the validated query dimensions.",
          truncated: false,
        })
      : null
  }
}

let service: AssessmentReportWebService | undefined

export function getAssessmentReportService(): AssessmentReportWebService {
  if (service !== undefined) return service
  if (isControlPlaneFixture(process.env)) {
    service = new FixtureAssessmentReportService()
    return service
  }
  const operatorId = z.uuid().parse(process.env["SENTINEL_OPERATOR_ID"])
  const environment = loadStorageEnvironment(process.env)
  const database = createPostgresDatabase(environment.SUPABASE_DB_URL)
  const repository = new AssessmentReportRepository(database)
  const artifacts = new ArtifactService(
    environment.SUPABASE_STORAGE_BUCKET,
    new S3PrivateObjectStore(environment),
    new ArtifactMetadataRepository(database)
  )
  const delivery = new AssessmentReportDeliveryService(repository, artifacts)
  service = {
    get: async (assessmentId) =>
      await delivery.getOwned({ operatorId, assessmentId }).then((report) =>
        report === null
          ? null
          : assessmentReportViewSchema.parse({
              ...report.view,
              ...(report.verificationEnrichment === null
                ? {}
                : {
                    verification: report.verificationEnrichment.verification,
                  }),
            })
      ),
    download: async (assessmentId, expiresInSeconds) => {
      const url = await delivery.signedOwnedDownload({
        operatorId,
        assessmentId,
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
      })
      return url === null ? null : { kind: "redirect", url }
    },
    artifactExcerpt: async (assessmentId, artifactId) => {
      const excerpt = await delivery.evidenceExcerpt({
        operatorId,
        assessmentId,
        artifactId,
      })
      return excerpt === null
        ? null
        : privateArtifactExcerptSchema.parse({ schemaVersion: 1, ...excerpt })
    },
  }
  return service
}
