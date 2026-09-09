import {
  REFRESH_KNOWLEDGE_POLICY_VERSION,
  hashCanonical,
  refreshChangeSetSchema,
  refreshContextValidationSchema,
  refreshGraphInventorySchema,
  refreshKnowledgeStartInputSchema,
  type RefreshChangedFile,
  type RefreshGraphEntity,
  type RefreshGraphLink,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  RefreshPlanningError,
  planRefreshScope,
} from "./knowledge-refresh-planning.ts"

const timestamp = "2026-09-09T10:00:00.000Z"
const applicationId = entityId("application", "a")
const runId = "run:11111111-1111-4111-8111-111111111111"
const activeCommitSha = "1".repeat(40)
const targetCommitSha = "2".repeat(40)
const repository = { host: "github.com", owner: "acme", name: "shop" }

function entityId(kind: string, character: string): string {
  return `${kind}:v1:${character.repeat(64)}`
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`
}

function evidenceId(character: string): string {
  return entityId("evidence", character)
}

function zeroBudget() {
  return {
    toolCalls: 90,
    contentBytes: 900_000,
    documentBytes: 300_000,
    documentPages: 90,
    documentSections: 180,
    sourceLines: 9_000,
    repositoryBytes: 9_000_000,
    repositoryFiles: 900,
    browserActions: 90,
    modelCalls: 30,
    modelInputTokens: 90_000,
    modelOutputTokens: 15_000,
    reconciliationRounds: 3,
    elapsedMs: 900_000,
  }
}

const start = refreshKnowledgeStartInputSchema.parse({
  schemaVersion: 1,
  policyVersion: REFRESH_KNOWLEDGE_POLICY_VERSION,
  applicationId,
  runId,
  repository,
  activeCommitSha,
  targetCommitSha,
  expectedGraphRevision: 7,
  graphRevision: 8,
  inputFingerprint: hash("f"),
  budget: zeroBudget(),
  startedAt: timestamp,
})

function context(status: "ready" | "denied" = "ready") {
  const ready = status === "ready"
  return refreshContextValidationSchema.parse({
    schemaVersion: 1,
    id: hash("c"),
    applicationId,
    activeCommitSha,
    targetCommitSha,
    activeGraphRevision: 7,
    activeGraphMatches: true,
    relationship: ready ? "descendant" : "unrelated",
    deployment: {
      schemaVersion: 1,
      applicationId,
      registrationId: hash("d"),
      purpose: "post_deployment_refresh",
      expectedCommitSha: targetCommitSha,
      identityState: ready ? "exact" : "mismatch",
      trustState: ready ? "trusted" : "untrusted",
      readinessState: ready ? "ready" : "not_checked",
      browserAccessAllowed: ready,
      credentialAccessAllowed: ready,
      reason: ready ? "deployment_ready" : "deployment_commit_mismatch",
      ...(ready
        ? {
            proof: {
              schemaVersion: 1,
              provider: "render",
              serviceId: "srv-1",
              deployId: "dep-1",
              repository,
              commitSha: targetCommitSha,
              publicUrl: "https://shop.example.test/",
              status: "live",
              observedAt: timestamp,
            },
          }
        : { actionRequired: "Deploy the expected merged commit." }),
      validatedAt: timestamp,
    },
    status,
    reason: ready ? "refresh_ready" : "target_not_descendant",
    ...(ready
      ? {}
      : { actionRequired: "Deploy a descendant of current knowledge." }),
    validatedAt: timestamp,
  })
}

function changeSet(files: readonly RefreshChangedFile[], complete = true) {
  const ordered = [...files].sort((left, right) =>
    Buffer.from(
      `${left.oldPath ?? ""}\u0000${left.newPath ?? ""}`,
      "utf8"
    ).compare(
      Buffer.from(`${right.oldPath ?? ""}\u0000${right.newPath ?? ""}`, "utf8")
    )
  )
  return refreshChangeSetSchema.parse({
    schemaVersion: 1,
    id: hashCanonical({ files: ordered }),
    baseSha: activeCommitSha,
    targetSha: targetCommitSha,
    files: ordered,
    complete,
    warnings: complete ? [] : ["Comparison was truncated."],
  })
}

function inventory(
  entities: readonly RefreshGraphEntity[],
  links: readonly RefreshGraphLink[] = []
) {
  return refreshGraphInventorySchema.parse({
    schemaVersion: 1,
    id: hashCanonical({ entities, links }),
    applicationId,
    graphRevision: 7,
    indexedCommitSha: activeCommitSha,
    entities: [...entities].sort((left, right) =>
      left.id.localeCompare(right.id)
    ),
    links: [...links].sort((left, right) => left.id.localeCompare(right.id)),
    immutableAssessments: [
      {
        assessmentId: "22222222-2222-4222-8222-222222222222",
        evidenceIds: [evidenceId("e")],
        artifactIds: [entityId("artifact", "f")],
      },
    ],
  })
}

function entity(
  kind: string,
  character: string,
  input: {
    paths?: readonly string[]
    uris?: readonly string[]
    dependencies?: readonly string[]
    evidence?: readonly string[]
    stale?: boolean
  } = {}
): RefreshGraphEntity {
  return {
    id: entityId(kind, character) as RefreshGraphEntity["id"],
    kind: kind as RefreshGraphEntity["kind"],
    sourcePaths: [
      ...(input.paths ?? []),
    ].sort() as RefreshGraphEntity["sourcePaths"],
    sourceUris: [
      ...(input.uris ?? []),
    ].sort() as RefreshGraphEntity["sourceUris"],
    dependsOnIds: [
      ...(input.dependencies ?? []),
    ].sort() as RefreshGraphEntity["dependsOnIds"],
    evidenceIds: [
      ...(input.evidence ?? []),
    ].sort() as RefreshGraphEntity["evidenceIds"],
    stale: input.stale ?? false,
  }
}

describe("incremental knowledge refresh scope planning", () => {
  it("plans add, modify, delete, OpenAPI, PHP, TypeScript, document, and workflow refreshes", () => {
    const section = entity("document-section", "b", {
      paths: ["docs/checkout.md"],
      uris: ["https://docs.example.test/checkout"],
      evidence: [evidenceId("1")],
    })
    const requirement = entity("requirement", "c", {
      dependencies: [section.id],
      evidence: [evidenceId("2")],
    })
    const phpSymbol = entity("code-symbol", "d", {
      paths: ["server/app/Order.php"],
      evidence: [evidenceId("3")],
    })
    const endpoint = entity("api-endpoint", "e", {
      paths: ["openapi.yaml"],
      dependencies: [phpSymbol.id],
    })
    const workflow = entity("workflow", "f", {
      dependencies: [requirement.id, endpoint.id],
      uris: ["https://shop.example.test/checkout"],
      evidence: [evidenceId("4")],
    })
    const staleWorkflow = entity("workflow", "7", {
      uris: ["https://shop.example.test/account"],
      stale: true,
    })
    const unrelated = entity("code-symbol", "9", {
      paths: ["src/unrelated.ts"],
    })
    const affectedLink: RefreshGraphLink = {
      id: evidenceId("5") as RefreshGraphLink["id"],
      fromId: requirement.id,
      toId: workflow.id,
      relationship: "COVERED_BY",
      evidenceTier: "C",
      reviewState: "accepted",
      sourceIdentityHash: hash("5") as RefreshGraphLink["sourceIdentityHash"],
      sourcePaths: ["docs/checkout.md"] as RefreshGraphLink["sourcePaths"],
      sourceUris: [],
      evidenceIds: [evidenceId("5")] as RefreshGraphLink["evidenceIds"],
    }
    const reusableLink: RefreshGraphLink = {
      id: evidenceId("6") as RefreshGraphLink["id"],
      fromId: unrelated.id,
      toId: unrelated.id,
      relationship: "CALLS",
      evidenceTier: "C",
      reviewState: "accepted",
      sourceIdentityHash: hash("6") as RefreshGraphLink["sourceIdentityHash"],
      sourcePaths: ["src/unrelated.ts"] as RefreshGraphLink["sourcePaths"],
      sourceUris: [],
      evidenceIds: [evidenceId("6")] as RefreshGraphLink["evidenceIds"],
    }
    const files = [
      {
        operation: "added",
        newPath: "docs/new-checkout.md",
        classifications: ["source"],
        contentHash: hash("a"),
      },
      {
        operation: "modified",
        oldPath: "docs/checkout.md",
        newPath: "docs/checkout.md",
        classifications: ["source"],
        contentHash: hash("b"),
      },
      {
        operation: "modified",
        oldPath: "src/checkout.tsx",
        newPath: "src/checkout.tsx",
        classifications: ["source"],
        contentHash: hash("c"),
      },
      {
        operation: "modified",
        oldPath: "server/app/Order.php",
        newPath: "server/app/Order.php",
        classifications: ["source"],
        contentHash: hash("d"),
      },
      {
        operation: "modified",
        oldPath: "openapi.yaml",
        newPath: "openapi.yaml",
        classifications: ["schema"],
        contentHash: hash("e"),
      },
      {
        operation: "deleted",
        oldPath: "docs/legacy.md",
        classifications: ["source"],
      },
      {
        operation: "renamed",
        oldPath: ".github/workflows/old.yml",
        newPath: ".github/workflows/ci.yml",
        classifications: ["configuration"],
        contentHash: hash("f"),
      },
    ] as const

    const plan = planRefreshScope({
      start,
      context: context(),
      changeSet: changeSet(files as unknown as RefreshChangedFile[]),
      inventory: inventory(
        [
          section,
          requirement,
          phpSymbol,
          endpoint,
          workflow,
          staleWorkflow,
          unrelated,
        ],
        [affectedLink, reusableLink]
      ),
    })

    expect(plan.sourceScope.documentationPaths).toEqual([
      "docs/checkout.md",
      "docs/new-checkout.md",
    ])
    expect(plan.sourceScope.typeScriptPaths).toEqual(["src/checkout.tsx"])
    expect(plan.sourceScope.phpPaths).toEqual(["server/app/Order.php"])
    expect(plan.sourceScope.openApiPaths).toEqual(["openapi.yaml"])
    expect(plan.sourceScope.removedPaths).toEqual([
      ".github/workflows/old.yml",
      "docs/legacy.md",
    ])
    expect(plan.affectedEntityIds).toEqual(
      [
        section.id,
        requirement.id,
        phpSymbol.id,
        endpoint.id,
        workflow.id,
        staleWorkflow.id,
      ].sort()
    )
    expect(plan.reusedEntityIds).toEqual([unrelated.id])
    expect(plan.affectedWorkflowIds).toEqual(
      [staleWorkflow.id, workflow.id].sort()
    )
    expect(plan.reassessRequirementIds).toEqual([requirement.id])
    expect(plan.invalidatedLinkIds).toEqual([affectedLink.id])
    expect(plan.reusableReviewedLinkIds).toEqual([reusableLink.id])
    expect(plan.missions.map(({ agent }) => agent)).toEqual([
      "documentation",
      "code",
      "application",
    ])
    expect(
      plan.missions.every(({ seedEvidenceIds }) => seedEvidenceIds.length > 0)
    ).toBe(true)
    expect(plan.immutableAssessmentIds).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ])
    expect(plan.retainedEvidenceIds).toEqual([evidenceId("e")])
    expect(plan.retainedArtifactIds).toEqual([entityId("artifact", "f")])
    expect(plan.replacementStableKeys).toContain(applicationId)
    expect(plan.replacementStableKeys).not.toContain(unrelated.id)
    const applicationMission = plan.missions.find(
      ({ agent }) => agent === "application"
    )
    expect(applicationMission?.scope.allowedHosts).toEqual([
      "shop.example.test",
    ])
  })

  it("reassesses unchanged requirements covered by a code-affected workflow", () => {
    const requirement = entity("requirement", "1")
    const symbol = entity("code-symbol", "2", {
      paths: ["src/orders.ts"],
    })
    const endpoint = entity("api-endpoint", "3", {
      dependencies: [symbol.id],
    })
    const workflow = entity("workflow", "4", {
      dependencies: [requirement.id, endpoint.id],
    })
    const coverageLink: RefreshGraphLink = {
      id: evidenceId("7") as RefreshGraphLink["id"],
      fromId: requirement.id,
      toId: workflow.id,
      relationship: "COVERED_BY",
      evidenceTier: "A",
      reviewState: "not_required",
      sourceIdentityHash: hash("7") as RefreshGraphLink["sourceIdentityHash"],
      sourcePaths: [],
      sourceUris: [],
      evidenceIds: [evidenceId("7")] as RefreshGraphLink["evidenceIds"],
    }
    const plan = planRefreshScope({
      start,
      context: context(),
      changeSet: changeSet([
        {
          operation: "modified",
          oldPath: "src/orders.ts",
          newPath: "src/orders.ts",
          classifications: ["source"],
          contentHash: hash("8"),
        } as RefreshChangedFile,
      ]),
      inventory: inventory(
        [requirement, symbol, endpoint, workflow],
        [coverageLink]
      ),
    })

    expect(plan.affectedEntityIds).toEqual(
      [symbol.id, endpoint.id, workflow.id].sort()
    )
    expect(plan.reassessRequirementIds).toEqual([requirement.id])
  })

  it("reuses all unrelated facts without dispatching a specialist", () => {
    const unrelated = entity("code-symbol", "9", {
      paths: ["src/orders.ts"],
    })
    const plan = planRefreshScope({
      start,
      context: context(),
      changeSet: changeSet([
        {
          operation: "modified",
          oldPath: "README.txt",
          newPath: "README.txt",
          classifications: ["source"],
          contentHash: hash("7"),
        } as RefreshChangedFile,
      ]),
      inventory: inventory([unrelated]),
    })

    expect(plan.affectedEntityIds).toEqual([])
    expect(plan.reusedEntityIds).toEqual([unrelated.id])
    expect(plan.missions).toEqual([])
    expect(plan.replacementStableKeys).toEqual([applicationId])
    expect(plan.requiresPublication).toBe(true)
  })

  it("rejects denied context and incomplete comparisons", () => {
    const complete = changeSet([])
    const currentInventory = inventory([])
    expect(() =>
      planRefreshScope({
        start,
        context: context("denied"),
        changeSet: complete,
        inventory: currentInventory,
      })
    ).toThrowError(new RefreshPlanningError("context_not_ready"))
    expect(() =>
      planRefreshScope({
        start,
        context: context(),
        changeSet: changeSet([], false),
        inventory: currentInventory,
      })
    ).toThrowError(new RefreshPlanningError("incomplete_change_set"))
  })
})
