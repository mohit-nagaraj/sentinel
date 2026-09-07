import type { CheckoutSnapshot } from "../github/index.ts"
import { describe, expect, it } from "vitest"

import { prepareRepositoryDocumentation } from "./repository-source.ts"

const commitSha = "a".repeat(40)
const applicationId = `application:v1:${"b".repeat(64)}`

describe("repository documentation source", () => {
  it("reads only approved Markdown from an immutable checkout snapshot", async () => {
    const files = new Map([
      ["docs/index.md", "# Start\n\nRead the [API](./api.md)."],
      ["docs/api.md", "# API\n\nCreate an order."],
      ["private/secret.md", "# Secret\n\nNever index this."],
    ])
    const snapshot: CheckoutSnapshot = {
      metadata: {
        label: "base",
        commitSha,
        treeObjectId: "c".repeat(40),
        treeFingerprint: `sha256:${"d".repeat(64)}`,
        configFingerprint: `sha256:${"e".repeat(64)}`,
        fileCount: 3,
        totalBytes: 100,
      },
      path: "ignored",
      enumerate: () =>
        [...files.entries()].map(([path, body]) => ({
          path,
          kind: "file" as const,
          mode: "100644",
          objectId: "f".repeat(40),
          sizeBytes: Buffer.byteLength(body),
        })),
      readText: async (path) => {
        const value = files.get(path)
        if (value === undefined) throw new Error("missing")
        return value
      },
    }
    const map = await prepareRepositoryDocumentation({
      applicationId,
      repository: { host: "github.com", owner: "acme", name: "app" },
      snapshot,
      roots: ["docs"],
    })
    expect(map.pages).toHaveLength(2)
    expect(map.pages.every((page) => page.sourceUri.includes(commitSha))).toBe(
      true
    )
    expect(
      map.pages.every((page) => !page.fact.canonicalUri.includes(commitSha))
    ).toBe(true)
    expect(map.links).toHaveLength(1)
    expect(
      map.sections.some((section) => section.sanitizedText.includes("Never"))
    ).toBe(false)

    const nextSnapshot: CheckoutSnapshot = {
      ...snapshot,
      metadata: {
        ...snapshot.metadata,
        commitSha: "9".repeat(40),
      },
    }
    const next = await prepareRepositoryDocumentation({
      applicationId,
      repository: { host: "github.com", owner: "acme", name: "app" },
      snapshot: nextSnapshot,
      roots: ["docs"],
      previousPages: map.pages.map((record) => ({
        canonicalUri: record.fact.canonicalUri,
        contentHash: record.fact.contentHash,
      })),
    })
    expect(next.source.id).toBe(map.source.id)
    expect(next.pages.map((record) => record.change)).toEqual([
      "unchanged",
      "unchanged",
    ])
  })
})
