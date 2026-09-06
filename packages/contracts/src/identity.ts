import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

import {
  actionIdSchema,
  artifactIdSchema,
  claimIdSchema,
  contentHashSchema,
  entityKindSchema,
  eventIdSchema,
  evidenceIdSchema,
  findingIdSchema,
  missionIdSchema,
  stableEntityIdSchema,
  type ActionId,
  type ArtifactId,
  type ClaimId,
  type ContentHash,
  type EntityKind,
  type EventId,
  type EvidenceId,
  type FindingId,
  type MissionId,
  type RunId,
  type StableEntityId,
} from "./primitives.ts"

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Non-finite number at ${path} is not canonical JSON`)
  }

  return Object.is(value, -0) ? "0" : JSON.stringify(value)
}

export function canonicalSerialize(value: unknown): string {
  const ancestors = new WeakSet<object>()

  function serialize(current: unknown, path: string): string {
    if (current === null) {
      return "null"
    }

    if (typeof current === "boolean") {
      return current ? "true" : "false"
    }

    if (typeof current === "number") {
      return serializeNumber(current, path)
    }

    if (typeof current === "string") {
      return JSON.stringify(current)
    }

    if (Array.isArray(current)) {
      if (ancestors.has(current)) {
        throw new TypeError(
          `Circular reference at ${path} is not canonical JSON`
        )
      }
      ancestors.add(current)
      const result = `[${current
        .map((item, index) => serialize(item, `${path}[${index}]`))
        .join(",")}]`
      ancestors.delete(current)
      return result
    }

    if (typeof current !== "object") {
      throw new TypeError(`${typeof current} at ${path} is not canonical JSON`)
    }

    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path} is not canonical JSON`)
    }

    if (ancestors.has(current)) {
      throw new TypeError(`Circular reference at ${path} is not canonical JSON`)
    }
    ancestors.add(current)

    const object = current as Readonly<Record<string, unknown>>
    const result = `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serialize(object[key], `${path}.${key}`)}`
      )
      .join(",")}}`
    ancestors.delete(current)
    return result
  }

  return serialize(value, "$")
}

export function hashCanonical(value: unknown): ContentHash {
  const digest = bytesToHex(sha256(utf8ToBytes(canonicalSerialize(value))))
  return contentHashSchema.parse(`sha256:${digest}`)
}

function digestWithoutPrefix(value: unknown): string {
  return hashCanonical(value).slice("sha256:".length)
}

export function createStableEntityId(
  kind: EntityKind,
  identity: unknown
): StableEntityId {
  const parsedKind = entityKindSchema.parse(kind)
  return stableEntityIdSchema.parse(
    `${parsedKind}:v1:${digestWithoutPrefix({ identity, kind: parsedKind, version: 1 })}`
  )
}

export function createMissionId(identity: unknown): MissionId {
  return missionIdSchema.parse(
    `mission:v1:${digestWithoutPrefix({ identity, kind: "mission", version: 1 })}`
  )
}

export function createClaimId(identity: unknown): ClaimId {
  return claimIdSchema.parse(
    `claim:v1:${digestWithoutPrefix({ identity, kind: "claim", version: 1 })}`
  )
}

export function createRunScopedEvidenceId(
  runId: RunId,
  identity: unknown
): EvidenceId {
  return evidenceIdSchema.parse(
    `evidence:v1:${digestWithoutPrefix({ identity, kind: "evidence", runId, version: 1 })}`
  )
}

export function createArtifactId(identity: unknown): ArtifactId {
  return artifactIdSchema.parse(
    `artifact:v1:${digestWithoutPrefix({ identity, kind: "artifact", version: 1 })}`
  )
}

export function createActionId(runId: RunId, identity: unknown): ActionId {
  return actionIdSchema.parse(
    `action:v1:${digestWithoutPrefix({ identity, kind: "action", runId, version: 1 })}`
  )
}

export function createFindingId(identity: unknown): FindingId {
  return findingIdSchema.parse(
    `finding:v1:${digestWithoutPrefix({ identity, kind: "finding", version: 1 })}`
  )
}

export function createEventId(runId: RunId, sequence: number): EventId {
  return eventIdSchema.parse(
    `event:v1:${digestWithoutPrefix({ kind: "event", runId, sequence, version: 1 })}`
  )
}
