import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { z } from "zod"

import {
  actionIdSchema,
  agentKindSchema,
  applicationIdSchema,
  artifactIdSchema,
  claimIdSchema,
  contentHashSchema,
  eventIdSchema,
  evidenceIdSchema,
  findingIdSchema,
  missionIdSchema,
  pullRequestIdSchema,
  reasonCodeSchema,
  runIdSchema,
  stableEntityIdSchema,
  type ActionId,
  type ArtifactId,
  type ClaimId,
  type ContentHash,
  type EventId,
  type EvidenceId,
  type FindingId,
  type MissionId,
  type RunId,
} from "./primitives.ts"

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Non-finite number at ${path} is not canonical JSON`)
  }

  return Object.is(value, -0) ? "0" : JSON.stringify(value)
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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
      const items: string[] = []
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, index)
        if (descriptor === undefined) {
          throw new TypeError(
            `Sparse array entry at ${path}[${index}] is not canonical JSON`
          )
        }
        if (!("value" in descriptor)) {
          throw new TypeError(
            `Accessor at ${path}[${index}] is not canonical JSON`
          )
        }
        items.push(serialize(descriptor.value, `${path}[${index}]`))
      }
      if (Object.keys(current).length !== current.length) {
        throw new TypeError(
          `Non-index array property at ${path} is not canonical JSON`
        )
      }
      const result = `[${items.join(",")}]`
      ancestors.delete(current)
      return result
    }

    if (typeof current !== "object") {
      throw new TypeError(`${typeof current} at ${path} is not canonical JSON`)
    }

    if (!isPlainRecord(current)) {
      throw new TypeError(`Non-plain object at ${path} is not canonical JSON`)
    }

    if (ancestors.has(current)) {
      throw new TypeError(`Circular reference at ${path} is not canonical JSON`)
    }
    ancestors.add(current)

    const symbolKeys = Object.getOwnPropertySymbols(current)
    if (symbolKeys.length > 0) {
      throw new TypeError(`Symbol key at ${path} is not canonical JSON`)
    }

    const keys = Object.keys(current)
    if (Object.getOwnPropertyNames(current).length !== keys.length) {
      throw new TypeError(
        `Non-enumerable property at ${path} is not canonical JSON`
      )
    }

    const result = `{${keys
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new TypeError(
            `Accessor at ${path}.${key} is not canonical JSON`
          )
        }
        return `${JSON.stringify(key)}:${serialize(descriptor.value, `${path}.${key}`)}`
      })
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

export const missionIdentityInputSchema = z.strictObject({
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  agent: agentKindSchema.exclude(["curator", "system"]),
  mode: reasonCodeSchema,
  ordinal: z.number().int().nonnegative(),
})

export const claimIdentityInputSchema = z.strictObject({
  applicationId: applicationIdSchema,
  missionId: missionIdSchema,
  subjectId: stableEntityIdSchema,
  predicate: reasonCodeSchema,
  objectId: stableEntityIdSchema,
  ordinal: z.number().int().nonnegative(),
})

export const evidenceIdentityInputSchema = z.strictObject({
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  sourceId: stableEntityIdSchema,
  kind: reasonCodeSchema,
  ordinal: z.number().int().nonnegative(),
})

export const artifactIdentityInputSchema = z.strictObject({
  applicationId: applicationIdSchema,
  contentHash: contentHashSchema,
  kind: reasonCodeSchema,
})

export const actionIdentityInputSchema = z.strictObject({
  applicationId: applicationIdSchema,
  runId: runIdSchema,
  stateFingerprint: contentHashSchema,
  actionType: reasonCodeSchema,
  ordinal: z.number().int().nonnegative(),
})

export const findingIdentityInputSchema = z.strictObject({
  applicationId: applicationIdSchema,
  pullRequestId: pullRequestIdSchema,
  titleFingerprint: contentHashSchema,
})

export function createMissionId(identity: unknown): MissionId {
  const parsed = missionIdentityInputSchema.parse(identity)
  return missionIdSchema.parse(
    `mission:v1:${digestWithoutPrefix({ identity: parsed, kind: "mission", version: 1 })}`
  )
}

export function createClaimId(identity: unknown): ClaimId {
  const parsed = claimIdentityInputSchema.parse(identity)
  return claimIdSchema.parse(
    `claim:v1:${digestWithoutPrefix({ identity: parsed, kind: "claim", version: 1 })}`
  )
}

export function createRunScopedEvidenceId(identity: unknown): EvidenceId {
  const parsed = evidenceIdentityInputSchema.parse(identity)
  return evidenceIdSchema.parse(
    `evidence:v1:${digestWithoutPrefix({ identity: parsed, kind: "evidence", version: 1 })}`
  )
}

export function createArtifactId(identity: unknown): ArtifactId {
  const parsed = artifactIdentityInputSchema.parse(identity)
  return artifactIdSchema.parse(
    `artifact:v1:${digestWithoutPrefix({ identity: parsed, kind: "artifact", version: 1 })}`
  )
}

export function createActionId(identity: unknown): ActionId {
  const parsed = actionIdentityInputSchema.parse(identity)
  return actionIdSchema.parse(
    `action:v1:${digestWithoutPrefix({ identity: parsed, kind: "action", version: 1 })}`
  )
}

export function createFindingId(identity: unknown): FindingId {
  const parsed = findingIdentityInputSchema.parse(identity)
  return findingIdSchema.parse(
    `finding:v1:${digestWithoutPrefix({ identity: parsed, kind: "finding", version: 1 })}`
  )
}

export function createEventId(runId: RunId, sequence: number): EventId {
  const parsedRunId = runIdSchema.parse(runId)
  const parsedSequence = z.number().int().positive().parse(sequence)
  return eventIdSchema.parse(
    `event:v1:${digestWithoutPrefix({ kind: "event", runId: parsedRunId, sequence: parsedSequence, version: 1 })}`
  )
}
