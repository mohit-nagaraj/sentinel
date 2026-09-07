import {
  applicationIdSchema,
  commitShaSchema,
  createStableKey,
  repositoryIdentitySchema,
} from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  TYPESCRIPT_INDEXER_NAME,
  TYPESCRIPT_INDEXER_VERSION,
  compareBy,
  compareStrings,
  createCodeFileId,
  createCodeSymbolId,
  createFrontendRouteId,
  hashSourceText,
  typeScriptExtractorIdentity,
  type CommitScope,
} from "./identity.ts"
import { TypeScriptIndexerError } from "./errors.ts"

const scope: CommitScope = {
  applicationId: applicationIdSchema.parse(`application:v1:${"a".repeat(64)}`),
  repository: repositoryIdentitySchema.parse({
    host: "github.com",
    owner: "HiEventsDev",
    name: "Hi.Events",
  }),
  commitSha: commitShaSchema.parse("2064f88ff7590e93c738efb8becaa7d732063619"),
}

describe("indexer identity", () => {
  it("declares an extractor identity that satisfies the contract shape", () => {
    expect(typeScriptExtractorIdentity).toStrictEqual({
      name: TYPESCRIPT_INDEXER_NAME,
      version: TYPESCRIPT_INDEXER_VERSION,
    })
    expect(TYPESCRIPT_INDEXER_NAME).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
  })

  it("derives file IDs from the contract stable-key scheme", () => {
    const id = createCodeFileId(scope, "frontend/src/router.tsx")

    expect(id).toMatch(/^code-file:v1:[a-f0-9]{64}$/)
    expect(id).toBe(
      createStableKey({
        kind: "code-file",
        applicationId: scope.applicationId,
        repository: scope.repository,
        commitSha: scope.commitSha,
        path: "frontend/src/router.tsx",
      })
    )
  })

  it("derives symbol IDs from path, qualified name, and kind", () => {
    const id = createCodeSymbolId(
      scope,
      "frontend/src/api/event.client.ts",
      "eventsClient.findByID",
      "method"
    )

    expect(id).toMatch(/^code-symbol:v1:[a-f0-9]{64}$/)
    expect(id).toBe(
      createStableKey({
        kind: "code-symbol",
        applicationId: scope.applicationId,
        repository: scope.repository,
        commitSha: scope.commitSha,
        filePath: "frontend/src/api/event.client.ts",
        qualifiedName: "eventsClient.findByID",
        symbolKind: "method",
      })
    )
  })

  it("distinguishes symbols that differ only by kind", () => {
    expect(createCodeSymbolId(scope, "a.tsx", "Login", "component")).not.toBe(
      createCodeSymbolId(scope, "a.tsx", "Login", "function")
    )
  })

  it("derives route IDs from the normalized path pattern", () => {
    const id = createFrontendRouteId(scope, "/manage/events/:eventsState?")

    expect(id).toMatch(/^frontend-route:v1:[a-f0-9]{64}$/)
    expect(id).toBe(
      createStableKey({
        kind: "frontend-route",
        applicationId: scope.applicationId,
        repository: scope.repository,
        commitSha: scope.commitSha,
        pathPattern: "/manage/events/:eventsState?",
      })
    )
  })

  it("rejects identity inputs the contract would refuse", () => {
    expect(() => createCodeFileId(scope, "../outside.ts")).toThrow()
    expect(() => createFrontendRouteId(scope, "manage/events")).toThrow()
  })

  it("hashes source text into a content hash", () => {
    const hash = hashSourceText("export const a = 1\n")

    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(hash).toBe(hashSourceText("export const a = 1\n"))
    expect(hash).not.toBe(hashSourceText("export const a = 2\n"))
  })

  it("orders strings by code unit rather than host locale", () => {
    expect(compareStrings("a", "a")).toBe(0)
    expect(compareStrings("A", "a")).toBeLessThan(0)
    expect(compareStrings("b", "a")).toBeGreaterThan(0)
    expect([...["b", "A", "a", "B"]].sort(compareStrings)).toStrictEqual([
      "A",
      "B",
      "a",
      "b",
    ])
  })

  it("takes the first non-zero comparison result", () => {
    expect(compareBy(0, 0, -1, 1)).toBe(-1)
    expect(compareBy(0, 0)).toBe(0)
  })

  it("redacts secret-shaped text out of error messages", () => {
    const error = new TypeScriptIndexerError(
      "read_failed",
      "failed reading with token=ghp_abcdefghijklmnopqrstuvwxyz012345"
    )

    expect(error.message).not.toContain("ghp_")
    expect(error.message).toContain("[REDACTED]")
    expect(error.compatibility).toBe(false)
  })
})
