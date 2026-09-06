import { randomUUID } from "node:crypto"

import { loadStorageEnvironment, S3PrivateObjectStore } from "@sentinel/storage"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const enabled = process.env["RUN_SUPABASE_STORAGE_TESTS"] === "1"
const describeIntegration = enabled ? describe : describe.skip

describeIntegration("Supabase private Storage", () => {
  let store: S3PrivateObjectStore
  let publicObjectUrl: string
  const key = `integration/${randomUUID()}.txt`

  beforeAll(async () => {
    const environment = loadStorageEnvironment(process.env)
    store = new S3PrivateObjectStore(
      environment.SUPABASE_STORAGE_BUCKET,
      environment
    )
    publicObjectUrl = `${new URL(environment.SUPABASE_S3_ENDPOINT).origin}/storage/v1/object/public/${environment.SUPABASE_STORAGE_BUCKET}/${key}`
    await store.assertPrivateBucket()
  })
  afterAll(async () => {
    if (store !== undefined) await store.delete(key).catch(() => undefined)
  })

  it("uploads, signs briefly, downloads, and deletes an isolated object", async () => {
    const body = new TextEncoder().encode('{"fixture":"sentinel"}')
    await store.put(key, body, "application/json")
    await expect(store.get(key)).resolves.toEqual(body)

    const publicResponse = await fetch(publicObjectUrl)
    expect(publicResponse.ok).toBe(false)

    const signedUrl = await store.signedDownloadUrl(key, 2)
    const response = await fetch(signedUrl)
    expect(response.ok).toBe(true)
    expect(await response.text()).toBe('{"fixture":"sentinel"}')

    await new Promise((resolve) => setTimeout(resolve, 2_200))
    const expiredResponse = await fetch(signedUrl)
    expect(expiredResponse.ok).toBe(false)

    await store.delete(key)
    await expect(store.get(key)).rejects.toThrow()
  })
})
