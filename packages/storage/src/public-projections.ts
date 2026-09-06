import type { ApplicationRecord } from "./application-repository.ts"
import type { ArtifactMetadata } from "./artifact-storage.ts"
import type { RunRecord } from "./run-repository.ts"
import type { SourceRecord } from "./source-repository.ts"

export interface PublicApplicationSummary {
  readonly id: string
  readonly name: string
  readonly deploymentUrl: string
  readonly status: string
  readonly indexedCommitSha: string | null
  readonly graphRevision: number
  readonly refreshedAt: string | null
}

export function toPublicApplicationSummary(
  application: ApplicationRecord
): PublicApplicationSummary {
  return {
    id: application.id,
    name: application.name,
    deploymentUrl: application.deploymentUrl,
    status: application.status,
    indexedCommitSha: application.indexedCommitSha,
    graphRevision: application.graphRevision,
    refreshedAt: application.refreshedAt?.toISOString() ?? null,
  }
}

export interface PublicRunSummary {
  readonly id: string
  readonly applicationId: string
  readonly runType: string
  readonly status: string
  readonly attemptCount: number
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export function toPublicRunSummary(run: RunRecord): PublicRunSummary {
  return {
    id: run.id,
    applicationId: run.applicationId,
    runType: run.runType,
    status: run.status,
    attemptCount: run.attemptCount,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  }
}

export interface PublicSourceSummary {
  readonly id: string
  readonly kind: string
  readonly uri: string
  readonly status: string
  readonly contentHash: string | null
  readonly checkedAt: string | null
}

export function toPublicSourceSummary(
  source: SourceRecord
): PublicSourceSummary {
  return {
    id: source.id,
    kind: source.kind,
    uri: source.uri,
    status: source.status,
    contentHash: source.contentHash,
    checkedAt: source.checkedAt?.toISOString() ?? null,
  }
}

export interface PublicArtifactSummary {
  readonly id: string
  readonly artifactType: string
  readonly contentHash: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly retainUntil: string | null
}

export function toPublicArtifactSummary(
  artifact: ArtifactMetadata
): PublicArtifactSummary {
  return {
    id: artifact.id,
    artifactType: artifact.artifactType,
    contentHash: artifact.contentHash,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    retainUntil: artifact.retainUntil?.toISOString() ?? null,
  }
}
