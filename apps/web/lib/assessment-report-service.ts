import {
  REPORT_TEMPLATE_VERSION,
  REPORT_WORDING_PROMPT_VERSION,
  assessmentReportViewSchema,
  hashCanonical,
  privateArtifactExcerptSchema,
  type AssessmentReportView,
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

import { isControlPlaneFixture } from "./operator-auth"

export const REPORT_FIXTURE_ASSESSMENT_ID =
  "00000000-0000-4000-8000-000000000029"
export const REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID = `artifact:v1:${"9".repeat(64)}`

export interface AssessmentReportWebService {
  get(assessmentId: string): Promise<AssessmentReportView | null>
  signedDownload(
    assessmentId: string,
    expiresInSeconds?: number
  ): Promise<string | null>
  artifactExcerpt(
    assessmentId: string,
    artifactId: string
  ): Promise<PrivateArtifactExcerpt | null>
}

function fixtureView(): AssessmentReportView {
  const applicationId = `application:v1:${"a".repeat(64)}`
  const checkoutFindingId = hashCanonical({
    kind: "report-fixture-checkout-finding",
  })
  const workflowFindingId = hashCanonical({
    kind: "report-fixture-workflow-finding",
  })
  const requirementFindingId = hashCanonical({
    kind: "report-fixture-requirement-finding",
  })
  const unknownFindingId = hashCanonical({
    kind: "report-fixture-unknown-finding",
  })
  const checkoutPathId = hashCanonical({ kind: "report-fixture-checkout-path" })
  const workflowPathId = hashCanonical({ kind: "report-fixture-workflow-path" })
  const checkoutScenarioId = hashCanonical({
    kind: "report-fixture-checkout-scenario",
  })
  const workflowScenarioId = hashCanonical({
    kind: "report-fixture-workflow-scenario",
  })
  const checkoutEvidenceId = `evidence:v1:${"3".repeat(64)}`
  const workflowEvidenceId = `evidence:v1:${"4".repeat(64)}`
  const checkoutScreenId = `screen:v1:${"5".repeat(64)}`
  const workflowId = `workflow:v1:${"6".repeat(64)}`
  const requirementId = `requirement:v1:${"7".repeat(64)}`
  const controllerSymbolId = `code-symbol:v1:${"8".repeat(64)}`
  const reportSymbolId = `code-symbol:v1:${"c".repeat(64)}`
  const checkoutPath = {
    id: checkoutPathId,
    evidenceStrength: "A" as const,
    nodes: [
      {
        id: controllerSymbolId,
        kind: "code-symbol",
        title: "OrderController.create",
      },
      {
        id: workflowId,
        kind: "workflow",
        title: "Buyer completes ticket checkout",
      },
      {
        id: checkoutScreenId,
        kind: "screen",
        title: "Checkout confirmation",
      },
    ],
    evidenceIds: [checkoutEvidenceId],
    references: [
      {
        id: checkoutEvidenceId,
        extractionMethod: "playwright_accessibility_snapshot",
        sourceUris: [
          "https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/frontend/src/components/routes/admin/Attribution/index.tsx",
        ],
        artifactIds: [REPORT_FIXTURE_EVIDENCE_ARTIFACT_ID],
      },
    ],
  }
  const workflowPath = {
    id: workflowPathId,
    evidenceStrength: "B" as const,
    nodes: [
      {
        id: reportSymbolId,
        kind: "code-symbol",
        title: "AttendeeReport.applyAttribution",
      },
      {
        id: requirementId,
        kind: "requirement",
        title: "Preserve attribution through order reporting",
      },
      {
        id: workflowId,
        kind: "workflow",
        title: "Organizer reviews attendee acquisition",
      },
    ],
    evidenceIds: [workflowEvidenceId],
    references: [
      {
        id: workflowEvidenceId,
        extractionMethod: "repository_documentation",
        sourceUris: [
          "https://github.com/HiEventsDev/Hi.Events/blob/f68df0dabd18d04df5e6c7e873aac2b5e5201584/backend/app/Repository/Eloquent/AccountAttributionRepository.php",
        ],
        artifactIds: [],
      },
    ],
  }
  const checkoutFinding = {
    id: checkoutFindingId,
    targetId: checkoutScreenId,
    targetKind: "screen" as const,
    risk: "high" as const,
    evidenceStrength: "A" as const,
    title: "Checkout attribution confirmation",
    summary:
      "The changed attribution handling reaches the checkout confirmation screen through the order creation workflow.",
    changedSymbolIds: [controllerSymbolId],
    evidencePaths: [checkoutPath],
    scenarios: [
      {
        id: checkoutScenarioId,
        kind: "ui_interaction" as const,
        targetId: checkoutScreenId,
        checkpointEntityIds: [workflowId, checkoutScreenId],
        evidencePathIds: [checkoutPathId],
        priority: "high" as const,
      },
    ],
    caveats: [
      {
        id: hashCanonical({ kind: "fixture-checkout-caveat" }),
        summary:
          "The evidence describes the indexed baseline; dynamic verification was not available for this report.",
      },
    ],
  }
  const workflowFinding = {
    id: workflowFindingId,
    targetId: workflowId,
    targetKind: "workflow" as const,
    risk: "medium" as const,
    evidenceStrength: "B" as const,
    title: "Organizer attribution reporting",
    summary:
      "Reporting aggregation and the organizer acquisition workflow share the changed attribution contract.",
    changedSymbolIds: [reportSymbolId],
    evidencePaths: [workflowPath],
    scenarios: [
      {
        id: workflowScenarioId,
        kind: "workflow_checkpoint" as const,
        targetId: workflowId,
        checkpointEntityIds: [requirementId, workflowId],
        evidencePathIds: [workflowPathId],
        priority: "medium" as const,
      },
    ],
    caveats: [],
  }
  const requirementFinding = {
    id: requirementFindingId,
    targetId: requirementId,
    targetKind: "requirement" as const,
    risk: "low" as const,
    evidenceStrength: "B" as const,
    title: "Attribution remains attached to reported orders",
    summary:
      "Repository evidence links the changed report projection to the documented attribution requirement.",
    changedSymbolIds: [reportSymbolId],
    evidencePaths: [workflowPath],
    scenarios: [],
    caveats: [],
  }
  const unknownFinding = {
    id: unknownFindingId,
    targetKind: "unknown" as const,
    risk: "unknown" as const,
    evidenceStrength: "D" as const,
    title: "Attribution configuration",
    summary:
      "The configuration change has no eligible product evidence path within the selected scope.",
    changedSymbolIds: [],
    evidencePaths: [],
    scenarios: [],
    caveats: [],
  }
  return assessmentReportViewSchema.parse({
    schemaVersion: 1,
    id: hashCanonical({ kind: "report-fixture" }),
    assessmentId: REPORT_FIXTURE_ASSESSMENT_ID,
    applicationId,
    runId: "run:00000000-0000-4000-8000-000000000029",
    repository: {
      host: "github.com",
      owner: "mohit-nagaraj",
      name: "Hi.Events",
    },
    pullRequestId: `pull-request:v1:${"b".repeat(64)}`,
    pullRequestNumber: 1338,
    pullRequestTitle:
      "Rework UTM attribution tracking and admin attribution report",
    baseSha: "2064f88ff7590e93c738efb8becaa7d732063619",
    headSha: "f68df0dabd18d04df5e6c7e873aac2b5e5201584",
    graphCommitSha: "2064f88ff7590e93c738efb8becaa7d732063619",
    graphRevision: 3,
    policyVersion: "blast-radius-policy-v1",
    templateVersion: REPORT_TEMPLATE_VERSION,
    wordingPromptVersion: REPORT_WORDING_PROMPT_VERSION,
    model: { mode: "deterministic_fallback" },
    generatedAt: "2026-09-09T10:00:00.000Z",
    overallRisk: "high",
    overallEvidenceStrength: "B",
    executiveSummary:
      "Checkout attribution and organizer reporting may be affected across three evidence-backed product findings. One configuration change remains unknown and needs explicit review before release decisions are made.",
    sections: [
      "identity",
      "executive_summary",
      "product_areas",
      "user_interface",
      "workflows",
      "requirements",
      "evidence",
      "recommended_qa",
      "verification",
      "unknowns_and_exclusions",
      "generation",
    ],
    findings: [
      checkoutFinding,
      workflowFinding,
      requirementFinding,
      unknownFinding,
    ],
    coverage: [
      {
        requirementId,
        status: "partially_observed",
        scope:
          "Checkout and organizer attendee reporting on the indexed baseline",
        wording:
          "Attribution persistence was observed through checkout, while organizer reporting was not dynamically verified.",
        evidenceIds: [checkoutEvidenceId, workflowEvidenceId],
      },
    ],
    verification: {
      status: "verification_unavailable",
      results: [],
      reason: "No trusted pull-request head deployment was configured.",
      version: 0,
    },
    unknowns: [unknownFinding],
    exclusions: [
      "Dynamic verification was outside this report generation run.",
    ],
  })
}

export class FixtureAssessmentReportService implements AssessmentReportWebService {
  async get(assessmentId: string) {
    return assessmentId === REPORT_FIXTURE_ASSESSMENT_ID ? fixtureView() : null
  }

  async signedDownload(assessmentId: string) {
    return assessmentId === REPORT_FIXTURE_ASSESSMENT_ID
      ? "https://signed.example/reports/assessment.md?expires=300"
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
            "OrderService.submit validates attribution before persistence.",
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
    signedDownload: (assessmentId, expiresInSeconds) =>
      delivery.signedOwnedDownload({
        operatorId,
        assessmentId,
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
      }),
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
