import { artifactIdSchema } from "@sentinel/contracts"
import { describe, expect, it } from "vitest"

import {
  ArtifactService,
  buildArtifactObjectKey,
  hashArtifact,
  type ArtifactMetadata,
  type ArtifactMetadataStore,
  type PrivateObjectStore,
} from "./artifact-storage.ts"

const applicationId = "11111111-1111-4111-8111-111111111111"
const applicationStableId =
  "application:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

class FakeObjects implements PrivateObjectStore {
  readonly stored = new Map<string, Uint8Array>()
  readonly deleted: string[] = []
  readonly deletedBuckets: string[] = []
  readonly signed: string[] = []
  failDelete = false

  async assertPrivateBucket() {}
  async put(_bucket: string, key: string, body: Uint8Array) {
    this.stored.set(key, body)
  }
  async get(_bucket: string, key: string) {
    const body = this.stored.get(key)
    if (body === undefined) throw new Error("missing")
    return body
  }
  async getRange(_bucket: string, key: string, maximumBytes: number) {
    return (await this.get(_bucket, key)).slice(0, maximumBytes)
  }
  async signedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number
  ) {
    this.signed.push(key)
    return `https://signed.example/${bucket}/${key}?expires=${expiresInSeconds}`
  }
  async delete(bucket: string, key: string) {
    if (this.failDelete) throw new Error("delete failed")
    this.deletedBuckets.push(bucket)
    this.deleted.push(key)
    this.stored.delete(key)
  }
}

class FakeMetadata implements ArtifactMetadataStore {
  record: ArtifactMetadata | null = null
  failCreate = false
  restored = false
  privateBucket = true
  readonly runLinks = new Set<string>()

  async create(input: ArtifactMetadata) {
    if (this.failCreate) throw new Error("metadata failed")
    if (this.record?.id === input.id) {
      return { artifact: this.record, created: false }
    }
    this.record = input
    return { artifact: input, created: true }
  }
  async find() {
    return this.record
  }
  async findForRun(_applicationId: string, runId: string) {
    return this.record !== null &&
      this.runLinks.has(`${runId}:${this.record.databaseId}`)
      ? this.record
      : null
  }
  async associateWithRun(
    _applicationId: string,
    runId: string,
    artifactDatabaseId: string
  ) {
    this.runLinks.add(`${runId}:${artifactDatabaseId}`)
    return true
  }
  async markDeleted() {
    if (this.record === null || this.record.referenceCount > 0) return false
    return true
  }
  async restore() {
    this.restored = true
  }
  async assertPrivateBucket(bucket: string) {
    if (!this.privateBucket || bucket !== "sentinel-artifacts") {
      throw new Error("not private")
    }
  }
  async ensurePrivateBucket() {}
  async assertApplicationIdentity(
    _applicationId: string,
    candidateStableId: string
  ) {
    if (candidateStableId !== applicationStableId) throw new Error("mismatch")
  }
}

describe("artifact service", () => {
  it("hashes content and stores only namespaced object keys", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("sentinel-artifacts", objects, metadata)
    const body = new TextEncoder().encode("artifact fixture")

    await service.initialize()
    const saved = await service.persist({
      applicationId,
      applicationStableId,
      runId: null,
      artifactType: "screenshot",
      mimeType: "image/png",
      body,
      retainUntil: null,
    })

    expect(saved.objectKey).toBe(
      buildArtifactObjectKey(applicationId, saved.databaseId)
    )
    expect(artifactIdSchema.parse(saved.id)).toBe(saved.id)
    expect(saved.contentHash).toBe(hashArtifact(body))
    expect(saved.contentHash).not.toContain("artifact fixture")
    await expect(
      service.signedDownloadUrl(applicationId, saved.id, 901)
    ).rejects.toThrow()

    const duplicate = await service.persist({
      applicationId,
      applicationStableId,
      runId: null,
      artifactType: "screenshot",
      mimeType: "image/png",
      body,
      retainUntil: null,
    })
    expect(duplicate.id).toBe(saved.id)
    expect(objects.stored.size).toBe(1)
    expect(objects.deleted).toHaveLength(1)

    metadata.record = { ...saved, bucket: "legacy-artifacts" }
    await expect(
      service.signedDownloadUrl(applicationId, saved.id, 30)
    ).resolves.toContain("/legacy-artifacts/")
    await expect(service.delete(applicationId, saved.id)).resolves.toBe(true)
    expect(objects.deletedBuckets.at(-1)).toBe("legacy-artifacts")
  })

  it("compensates failed metadata writes and restores failed object deletion", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("sentinel-artifacts", objects, metadata)
    metadata.failCreate = true

    await expect(
      service.persist({
        applicationId,
        applicationStableId,
        runId: null,
        artifactType: "trace",
        mimeType: "application/zip",
        body: new Uint8Array([1, 2, 3]),
        retainUntil: null,
      })
    ).rejects.toThrow("metadata failed")
    expect(objects.deleted).toHaveLength(1)
    expect(objects.deleted[0]).toMatch(
      new RegExp(`^applications/${applicationId}/artifacts/`)
    )

    metadata.failCreate = false
    const saved = await service.persist({
      applicationId,
      applicationStableId,
      runId: null,
      artifactType: "trace",
      mimeType: "application/zip",
      body: new Uint8Array([1, 2, 3]),
      retainUntil: null,
    })
    objects.failDelete = true
    await expect(service.delete(applicationId, saved.id)).rejects.toThrow(
      "delete failed"
    )
    expect(metadata.restored).toBe(true)
  })

  it("signs screenshots only when they belong to the requested run", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("sentinel-artifacts", objects, metadata)
    const runId = "22222222-2222-4222-8222-222222222222"
    const saved = await service.persist({
      applicationId,
      applicationStableId,
      runId,
      artifactType: "screenshot",
      mimeType: "image/png",
      body: new Uint8Array([1, 2, 3]),
      retainUntil: null,
    })
    await expect(
      service.signedRunDownloadUrl(applicationId, runId, saved.id, 300)
    ).resolves.toContain("expires=300")
    await expect(
      service.signedRunDownloadUrl(
        applicationId,
        "33333333-3333-4333-8333-333333333333",
        saved.id,
        300
      )
    ).resolves.toBeNull()
  })

  it("signs only private Markdown assessment reports for at most five minutes", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("sentinel-artifacts", objects, metadata)
    const saved = await service.persist({
      applicationId,
      applicationStableId,
      runId: null,
      artifactType: "assessment_report_markdown",
      mimeType: "text/markdown",
      body: new TextEncoder().encode("# Assessment report"),
      retainUntil: null,
    })

    await expect(
      service.signedReportDownloadUrl(applicationId, saved.id, 300)
    ).resolves.toContain("https://signed.example/")
    expect(objects.signed).toEqual([saved.objectKey])
    await expect(
      service.signedReportDownloadUrl(applicationId, saved.id, 301)
    ).rejects.toThrow()
    metadata.privateBucket = false
    await expect(
      service.signedReportDownloadUrl(applicationId, saved.id, 300)
    ).rejects.toThrow("not private")
  })

  it("does not sign non-screenshot run artifacts", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("private-artifacts", objects, metadata)
    const runId = "22222222-2222-4222-8222-222222222222"
    const saved = await service.persist({
      applicationId,
      applicationStableId,
      runId,
      artifactType: "browser_trace",
      mimeType: "application/zip",
      body: new Uint8Array([1, 2, 3]),
      retainUntil: null,
    })

    await expect(
      service.signedRunDownloadUrl(applicationId, runId, saved.id, 300)
    ).resolves.toBeNull()
    expect(objects.signed).toHaveLength(0)
  })

  it("keeps identical screenshots associated with every capturing run", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("sentinel-artifacts", objects, metadata)
    const firstRun = "22222222-2222-4222-8222-222222222222"
    const secondRun = "33333333-3333-4333-8333-333333333333"
    const input = {
      applicationId,
      applicationStableId,
      artifactType: "screenshot",
      mimeType: "image/png",
      body: new Uint8Array([1, 2, 3]),
      retainUntil: null,
    } as const
    const first = await service.persist({ ...input, runId: firstRun })
    const duplicate = await service.persist({ ...input, runId: secondRun })

    expect(duplicate.id).toBe(first.id)
    await expect(
      service.signedRunDownloadUrl(applicationId, firstRun, first.id, 300)
    ).resolves.toContain("expires=300")
    await expect(
      service.signedRunDownloadUrl(applicationId, secondRun, first.id, 300)
    ).resolves.toContain("expires=300")
  })

  it("refuses to sign a screenshot when its persisted bucket is public", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("sentinel-artifacts", objects, metadata)
    const runId = "22222222-2222-4222-8222-222222222222"
    const saved = await service.persist({
      applicationId,
      applicationStableId,
      runId,
      artifactType: "screenshot",
      mimeType: "image/png",
      body: new Uint8Array([1, 2, 3]),
      retainUntil: null,
    })
    metadata.privateBucket = false

    await expect(
      service.signedRunDownloadUrl(applicationId, runId, saved.id, 300)
    ).rejects.toThrow("not private")
    expect(objects.signed).toHaveLength(0)
  })

  it("returns only a bounded, redacted excerpt from a private text artifact", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("sentinel-artifacts", objects, metadata)
    const saved = await service.persist({
      applicationId,
      applicationStableId,
      runId: null,
      artifactType: "source_excerpt",
      mimeType: "text/plain",
      body: new TextEncoder().encode(
        `authorization: Bearer must-not-leak\n${"bounded evidence ".repeat(30)}`
      ),
      retainUntil: null,
    })

    const excerpt = await service.readTextExcerpt(applicationId, saved.id, 256)
    expect(excerpt).toMatchObject({
      artifactId: saved.id,
      mimeType: "text/plain",
      truncated: true,
    })
    expect(excerpt?.excerpt).toContain("[REDACTED]")
    expect(excerpt?.excerpt).not.toContain("must-not-leak")
    expect(excerpt?.excerpt.length).toBeLessThanOrEqual(256)

    metadata.record = { ...saved, mimeType: "application/zip" }
    await expect(
      service.readTextExcerpt(applicationId, saved.id)
    ).resolves.toBeNull()
  })
})
