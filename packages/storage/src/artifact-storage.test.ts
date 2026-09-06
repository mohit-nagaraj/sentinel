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

class FakeObjects implements PrivateObjectStore {
  readonly stored = new Map<string, Uint8Array>()
  readonly deleted: string[] = []
  failDelete = false

  async assertPrivateBucket() {}
  async put(key: string, body: Uint8Array) {
    this.stored.set(key, body)
  }
  async get(key: string) {
    const body = this.stored.get(key)
    if (body === undefined) throw new Error("missing")
    return body
  }
  async signedDownloadUrl(key: string, expiresInSeconds: number) {
    return `https://signed.example/${key}?expires=${expiresInSeconds}`
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error("delete failed")
    this.deleted.push(key)
    this.stored.delete(key)
  }
}

class FakeMetadata implements ArtifactMetadataStore {
  record: ArtifactMetadata | null = null
  failCreate = false
  restored = false

  async create(input: ArtifactMetadata) {
    if (this.failCreate) throw new Error("metadata failed")
    this.record = input
    return input
  }
  async find() {
    return this.record
  }
  async markDeleted() {
    if (this.record === null || this.record.referenceCount > 0) return false
    return true
  }
  async restore() {
    this.restored = true
  }
  async assertPrivateBucket(bucket: string) {
    if (bucket !== "sentinel-artifacts") throw new Error("not private")
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
      runId: null,
      artifactType: "screenshot",
      mimeType: "image/png",
      body,
      retainUntil: null,
    })

    expect(saved.objectKey).toBe(
      buildArtifactObjectKey(applicationId, saved.id)
    )
    expect(saved.contentHash).toBe(hashArtifact(body))
    expect(saved.contentHash).not.toContain("artifact fixture")
    await expect(service.signedDownloadUrl(saved.id, 901)).rejects.toThrow()
  })

  it("compensates failed metadata writes and restores failed object deletion", async () => {
    const objects = new FakeObjects()
    const metadata = new FakeMetadata()
    const service = new ArtifactService("sentinel-artifacts", objects, metadata)
    metadata.failCreate = true

    await expect(
      service.persist({
        applicationId,
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
      runId: null,
      artifactType: "trace",
      mimeType: "application/zip",
      body: new Uint8Array([1, 2, 3]),
      retainUntil: null,
    })
    objects.failDelete = true
    await expect(service.delete(saved.id)).rejects.toThrow("delete failed")
    expect(metadata.restored).toBe(true)
  })
})
