import { createHash, randomUUID } from "node:crypto"

import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import {
  applicationIdSchema,
  artifactIdSchema,
  contentHashSchema,
  createArtifactId,
  reasonCodeSchema,
  type ArtifactId,
  type ContentHash,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"
import type { StorageEnvironment } from "./environment.ts"

const databaseIdSchema = z.uuid()
const mimeTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i)

export interface ArtifactMetadata {
  readonly id: ArtifactId
  readonly databaseId: string
  readonly applicationId: string
  readonly runId: string | null
  readonly artifactType: string
  readonly bucket: string
  readonly objectKey: string
  readonly contentHash: ContentHash
  readonly mimeType: string
  readonly sizeBytes: number
  readonly referenceCount: number
  readonly retainUntil: Date | null
}

const artifactRowSchema = z.object({
  id: databaseIdSchema,
  stable_key: artifactIdSchema,
  application_id: databaseIdSchema,
  run_id: databaseIdSchema.nullable(),
  artifact_type: z.string().min(1),
  bucket: z.string().min(1),
  object_key: z.string().min(1),
  content_hash: contentHashSchema,
  mime_type: mimeTypeSchema,
  size_bytes: z.coerce.number().int().nonnegative(),
  reference_count: z.number().int().nonnegative(),
  retain_until: z.coerce.date().nullable(),
})
type ArtifactRow = z.infer<typeof artifactRowSchema> & Record<string, unknown>

function mapArtifact(row: ArtifactRow): ArtifactMetadata {
  const parsed = artifactRowSchema.parse(row)
  return {
    id: parsed.stable_key,
    databaseId: parsed.id,
    applicationId: parsed.application_id,
    runId: parsed.run_id,
    artifactType: parsed.artifact_type,
    bucket: parsed.bucket,
    objectKey: parsed.object_key,
    contentHash: parsed.content_hash,
    mimeType: parsed.mime_type,
    sizeBytes: parsed.size_bytes,
    referenceCount: parsed.reference_count,
    retainUntil: parsed.retain_until,
  }
}

export class ArtifactMetadataRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async create(input: ArtifactMetadata): Promise<{
    readonly artifact: ArtifactMetadata
    readonly created: boolean
  }> {
    const rows = await this.database.query<ArtifactRow>(
      `insert into sentinel.artifacts (
         id, stable_key, application_id, run_id, artifact_type, bucket, object_key,
         content_hash, mime_type, size_bytes, reference_count, retain_until
       ) values ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (stable_key) do update
       set run_id = excluded.run_id,
           artifact_type = excluded.artifact_type,
           bucket = excluded.bucket,
           object_key = excluded.object_key,
           content_hash = excluded.content_hash,
           mime_type = excluded.mime_type,
           size_bytes = excluded.size_bytes,
           reference_count = 0,
           retain_until = excluded.retain_until,
           deleted_at = null
       where sentinel.artifacts.deleted_at is not null
       returning *`,
      [
        input.databaseId,
        input.id,
        input.applicationId,
        input.runId,
        input.artifactType,
        input.bucket,
        input.objectKey,
        input.contentHash,
        input.mimeType,
        input.sizeBytes,
        input.referenceCount,
        input.retainUntil,
      ]
    )
    const row = rows[0]
    if (row !== undefined) {
      return { artifact: mapArtifact(row), created: true }
    }
    const existing = await this.find(input.applicationId, input.id)
    if (existing === null) {
      throw new Error("Artifact metadata conflict returned no existing row")
    }
    return { artifact: existing, created: false }
  }

  async find(
    applicationId: string,
    id: ArtifactId
  ): Promise<ArtifactMetadata | null> {
    const rows = await this.database.query<ArtifactRow>(
      `select * from sentinel.artifacts
       where application_id = $1::uuid and stable_key = $2 and deleted_at is null`,
      [applicationId, id]
    )
    return rows[0] === undefined ? null : mapArtifact(rows[0])
  }

  async markDeleted(id: string): Promise<boolean> {
    const rows = await this.database.query<{ id: string }>(
      `update sentinel.artifacts set deleted_at = now()
       where id = $1::uuid and deleted_at is null and reference_count = 0
       returning id`,
      [id]
    )
    return rows.length === 1
  }

  async restore(id: string): Promise<void> {
    await this.database.query(
      "update sentinel.artifacts set deleted_at = null where id = $1::uuid",
      [id]
    )
  }

  async changeReferenceCount(
    id: string,
    delta: 1 | -1
  ): Promise<ArtifactMetadata> {
    const rows = await this.database.query<ArtifactRow>(
      `update sentinel.artifacts
       set reference_count = reference_count + $2
       where id = $1::uuid
         and deleted_at is null
         and reference_count + $2 >= 0
       returning *`,
      [id, delta]
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error("Artifact reference update was rejected")
    }
    return mapArtifact(row)
  }

  async assertPrivateBucket(bucket: string): Promise<void> {
    const rows = await this.database.query<{ is_private: boolean }>(
      `select exists(
         select 1 from storage.buckets where id = $1 and public = false
       ) as is_private`,
      [bucket]
    )
    if (rows[0]?.is_private !== true) {
      throw new Error("Configured artifact bucket is missing or not private")
    }
  }

  async ensurePrivateBucket(bucket: string): Promise<void> {
    await this.database.query(
      `insert into storage.buckets (
         id, name, public, file_size_limit, allowed_mime_types
       ) values (
         $1, $1, false, 52428800,
         array[
           'application/json', 'application/pdf', 'application/zip',
           'image/jpeg', 'image/png', 'text/html', 'text/markdown', 'text/plain'
         ]::text[]
       )
       on conflict (id) do update
       set public = false,
           file_size_limit = excluded.file_size_limit,
           allowed_mime_types = excluded.allowed_mime_types`,
      [bucket]
    )
  }

  async assertApplicationIdentity(
    applicationId: string,
    applicationStableId: string
  ): Promise<void> {
    const rows = await this.database.query<{ matches: boolean }>(
      `select exists(
         select 1 from sentinel.applications where id = $1::uuid and stable_key = $2
       ) as matches`,
      [applicationId, applicationStableId]
    )
    if (rows[0]?.matches !== true) {
      throw new Error("Application identity does not match operational record")
    }
  }
}

export interface PrivateObjectStore {
  assertPrivateBucket(): Promise<void>
  put(key: string, body: Uint8Array, mimeType: string): Promise<void>
  get(key: string): Promise<Uint8Array>
  signedDownloadUrl(key: string, expiresInSeconds: number): Promise<string>
  delete(key: string): Promise<void>
}

export interface ArtifactMetadataStore {
  create(input: ArtifactMetadata): Promise<{
    readonly artifact: ArtifactMetadata
    readonly created: boolean
  }>
  find(applicationId: string, id: ArtifactId): Promise<ArtifactMetadata | null>
  markDeleted(id: string): Promise<boolean>
  restore(id: string): Promise<void>
  assertPrivateBucket(bucket: string): Promise<void>
  ensurePrivateBucket(bucket: string): Promise<void>
  assertApplicationIdentity(
    applicationId: string,
    applicationStableId: string
  ): Promise<void>
}

export class S3PrivateObjectStore implements PrivateObjectStore {
  private readonly client: S3Client

  constructor(
    private readonly bucket: string,
    environment: Pick<
      StorageEnvironment,
      | "SUPABASE_S3_ENDPOINT"
      | "SUPABASE_S3_REGION"
      | "SUPABASE_S3_ACCESS_KEY_ID"
      | "SUPABASE_S3_SECRET_ACCESS_KEY"
    >
  ) {
    this.client = new S3Client({
      endpoint: environment.SUPABASE_S3_ENDPOINT,
      region: environment.SUPABASE_S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: environment.SUPABASE_S3_ACCESS_KEY_ID,
        secretAccessKey: environment.SUPABASE_S3_SECRET_ACCESS_KEY,
      },
    })
  }

  async assertPrivateBucket(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }))
  }

  async put(key: string, body: Uint8Array, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
      })
    )
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    )
    if (response.Body === undefined) {
      throw new Error("Artifact download returned no body")
    }
    return response.Body.transformToByteArray()
  }

  async signedDownloadUrl(
    key: string,
    expiresInSeconds: number
  ): Promise<string> {
    const expires = z.number().int().min(1).max(900).parse(expiresInSeconds)
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expires }
    )
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    )
  }

  async deleteEmptyBucket(): Promise<void> {
    await this.client.send(new DeleteBucketCommand({ Bucket: this.bucket }))
  }
}

export function hashArtifact(body: Uint8Array): ContentHash {
  return contentHashSchema.parse(
    `sha256:${createHash("sha256").update(body).digest("hex")}`
  )
}

export function buildArtifactObjectKey(
  applicationId: string,
  artifactId: string
): string {
  const application = databaseIdSchema.parse(applicationId)
  const artifact = databaseIdSchema.parse(artifactId)
  return `applications/${application}/artifacts/${artifact}`
}

export class ArtifactService {
  constructor(
    private readonly bucket: string,
    private readonly objects: PrivateObjectStore,
    private readonly metadata: ArtifactMetadataStore
  ) {}

  async initialize(): Promise<void> {
    await this.metadata.ensurePrivateBucket(this.bucket)
    await this.objects.assertPrivateBucket()
    await this.metadata.assertPrivateBucket(this.bucket)
  }

  async persist(input: {
    readonly applicationId: string
    readonly applicationStableId: string
    readonly runId: string | null
    readonly artifactType: string
    readonly mimeType: string
    readonly body: Uint8Array
    readonly retainUntil: Date | null
  }): Promise<ArtifactMetadata> {
    const applicationId = databaseIdSchema.parse(input.applicationId)
    const applicationStableId = applicationIdSchema.parse(
      input.applicationStableId
    )
    const runId =
      input.runId === null ? null : databaseIdSchema.parse(input.runId)
    const artifactType = reasonCodeSchema.parse(input.artifactType)
    const mimeType = mimeTypeSchema.parse(input.mimeType)
    const contentHash = hashArtifact(input.body)
    const stableId = createArtifactId({
      applicationId: applicationStableId,
      contentHash,
      kind: artifactType,
    })

    const databaseId = randomUUID()
    const objectKey = buildArtifactObjectKey(applicationId, databaseId)
    await this.metadata.assertApplicationIdentity(
      applicationId,
      applicationStableId
    )
    await this.objects.put(objectKey, input.body, mimeType)

    try {
      const result = await this.metadata.create({
        id: stableId,
        databaseId,
        applicationId,
        runId,
        artifactType,
        bucket: this.bucket,
        objectKey,
        contentHash,
        mimeType,
        sizeBytes: input.body.byteLength,
        referenceCount: 0,
        retainUntil: input.retainUntil,
      })
      if (!result.created) {
        await this.objects.delete(objectKey)
      }
      return result.artifact
    } catch (error) {
      await this.objects.delete(objectKey).catch(() => undefined)
      throw error
    }
  }

  async signedDownloadUrl(
    applicationIdInput: string,
    id: string,
    expiresInSeconds: number
  ): Promise<string> {
    const applicationId = databaseIdSchema.parse(applicationIdInput)
    const artifact = await this.metadata.find(
      applicationId,
      artifactIdSchema.parse(id)
    )
    if (artifact === null) throw new Error("Artifact not found")
    const expires = z.number().int().min(1).max(900).parse(expiresInSeconds)
    return this.objects.signedDownloadUrl(artifact.objectKey, expires)
  }

  async delete(applicationIdInput: string, id: string): Promise<boolean> {
    const applicationId = databaseIdSchema.parse(applicationIdInput)
    const artifact = await this.metadata.find(
      applicationId,
      artifactIdSchema.parse(id)
    )
    if (artifact === null || artifact.referenceCount > 0) return false
    if (!(await this.metadata.markDeleted(artifact.databaseId))) return false
    try {
      await this.objects.delete(artifact.objectKey)
      return true
    } catch (error) {
      await this.metadata.restore(artifact.databaseId)
      throw error
    }
  }
}
