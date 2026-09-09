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
  redactPersistedText,
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

  async findForRun(
    applicationId: string,
    runId: string,
    id: ArtifactId
  ): Promise<ArtifactMetadata | null> {
    const rows = await this.database.query<ArtifactRow>(
      `select artifact.* from sentinel.artifacts artifact
       join sentinel.run_artifacts link on link.artifact_id = artifact.id
       join sentinel.runs run on run.id = link.run_id
       where artifact.application_id = $1::uuid and run.id = $2::uuid
         and run.application_id = $1::uuid and artifact.stable_key = $3
         and artifact.deleted_at is null`,
      [
        databaseIdSchema.parse(applicationId),
        databaseIdSchema.parse(runId),
        artifactIdSchema.parse(id),
      ]
    )
    return rows[0] === undefined ? null : mapArtifact(rows[0])
  }

  async associateWithRun(
    applicationId: string,
    runId: string,
    artifactDatabaseId: string
  ): Promise<boolean> {
    const identifiers = [
      databaseIdSchema.parse(applicationId),
      databaseIdSchema.parse(runId),
      databaseIdSchema.parse(artifactDatabaseId),
    ]
    await this.database.query(
      `insert into sentinel.run_artifacts (run_id, artifact_id)
       select run.id, artifact.id
       from sentinel.runs run
       join sentinel.artifacts artifact
         on artifact.id = $3::uuid and artifact.application_id = $1::uuid
       where run.id = $2::uuid and run.application_id = $1::uuid
         and artifact.deleted_at is null
       on conflict (run_id, artifact_id) do nothing`,
      identifiers
    )
    const rows = await this.database.query<{ linked: boolean }>(
      `select exists(
         select 1 from sentinel.run_artifacts link
         join sentinel.runs run on run.id = link.run_id
         join sentinel.artifacts artifact on artifact.id = link.artifact_id
         where link.run_id = $2::uuid and link.artifact_id = $3::uuid
           and run.application_id = $1::uuid
           and artifact.application_id = $1::uuid
           and artifact.deleted_at is null
       ) as linked`,
      identifiers
    )
    return rows[0]?.linked === true
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

  async updateRetention(
    applicationIdInput: string,
    idInput: ArtifactId,
    retainUntil: Date
  ): Promise<ArtifactMetadata | null> {
    const rows = await this.database.query<ArtifactRow>(
      `update sentinel.artifacts
       set retain_until = greatest(
         coalesce(retain_until, '-infinity'::timestamptz),
         $3::timestamptz
       )
       where application_id = $1::uuid and stable_key = $2
         and deleted_at is null
       returning *`,
      [
        databaseIdSchema.parse(applicationIdInput),
        artifactIdSchema.parse(idInput),
        z.date().parse(retainUntil),
      ]
    )
    return rows[0] === undefined ? null : mapArtifact(rows[0])
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
  assertPrivateBucket(bucket: string): Promise<void>
  put(
    bucket: string,
    key: string,
    body: Uint8Array,
    mimeType: string
  ): Promise<void>
  get(bucket: string, key: string): Promise<Uint8Array>
  getRange?(
    bucket: string,
    key: string,
    maximumBytes: number
  ): Promise<Uint8Array>
  signedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number
  ): Promise<string>
  delete(bucket: string, key: string): Promise<void>
}

export interface ArtifactMetadataStore {
  create(input: ArtifactMetadata): Promise<{
    readonly artifact: ArtifactMetadata
    readonly created: boolean
  }>
  find(applicationId: string, id: ArtifactId): Promise<ArtifactMetadata | null>
  findForRun(
    applicationId: string,
    runId: string,
    id: ArtifactId
  ): Promise<ArtifactMetadata | null>
  associateWithRun(
    applicationId: string,
    runId: string,
    artifactDatabaseId: string
  ): Promise<boolean>
  markDeleted(id: string): Promise<boolean>
  restore(id: string): Promise<void>
  updateRetention?(
    applicationId: string,
    id: ArtifactId,
    retainUntil: Date
  ): Promise<ArtifactMetadata | null>
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

  async assertPrivateBucket(bucket: string): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: bucket }))
  }

  async put(
    bucket: string,
    key: string,
    body: Uint8Array,
    mimeType: string
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
      })
    )
  }

  async get(bucket: string, key: string): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    )
    if (response.Body === undefined) {
      throw new Error("Artifact download returned no body")
    }
    return response.Body.transformToByteArray()
  }

  async getRange(
    bucket: string,
    key: string,
    maximumBytes: number
  ): Promise<Uint8Array> {
    const size = z.number().int().min(1).max(262_144).parse(maximumBytes)
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${size - 1}`,
      })
    )
    if (response.Body === undefined) {
      throw new Error("Artifact excerpt returned no body")
    }
    return response.Body.transformToByteArray()
  }

  async signedDownloadUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number
  ): Promise<string> {
    const expires = z.number().int().min(1).max(900).parse(expiresInSeconds)
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: expires }
    )
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key })
    )
  }

  async deleteEmptyBucket(bucket: string): Promise<void> {
    await this.client.send(new DeleteBucketCommand({ Bucket: bucket }))
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
    await this.objects.assertPrivateBucket(this.bucket)
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
    await this.objects.put(this.bucket, objectKey, input.body, mimeType)

    let createdArtifact: ArtifactMetadata | undefined
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
      if (result.created) createdArtifact = result.artifact
      if (
        runId !== null &&
        !(await this.metadata.associateWithRun(
          applicationId,
          runId,
          result.artifact.databaseId
        ))
      ) {
        throw new Error("Run artifact association was rejected")
      }
      if (!result.created) {
        await this.objects.delete(this.bucket, objectKey)
      }
      return result.artifact
    } catch (error) {
      if (createdArtifact !== undefined) {
        await this.metadata
          .markDeleted(createdArtifact.databaseId)
          .catch(() => undefined)
      }
      await this.objects.delete(this.bucket, objectKey).catch(() => undefined)
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
    return this.objects.signedDownloadUrl(
      artifact.bucket,
      artifact.objectKey,
      expires
    )
  }

  async signedRunDownloadUrl(
    applicationIdInput: string,
    runIdInput: string,
    id: string,
    expiresInSeconds: number
  ): Promise<string | null> {
    const applicationId = databaseIdSchema.parse(applicationIdInput)
    const runId = databaseIdSchema.parse(runIdInput)
    const artifact = await this.metadata.findForRun(
      applicationId,
      runId,
      artifactIdSchema.parse(id)
    )
    if (
      artifact === null ||
      artifact.artifactType !== "screenshot" ||
      !new Set(["image/jpeg", "image/png"]).has(artifact.mimeType)
    ) {
      return null
    }
    await this.metadata.assertPrivateBucket(artifact.bucket)
    const expires = z.number().int().min(1).max(300).parse(expiresInSeconds)
    return this.objects.signedDownloadUrl(
      artifact.bucket,
      artifact.objectKey,
      expires
    )
  }

  async readTextExcerpt(
    applicationIdInput: string,
    id: string,
    maximumCharactersInput: number = 8_192
  ): Promise<{
    readonly artifactId: ArtifactId
    readonly mimeType:
      "application/json" | "text/html" | "text/markdown" | "text/plain"
    readonly excerpt: string
    readonly truncated: boolean
  } | null> {
    const applicationId = databaseIdSchema.parse(applicationIdInput)
    const artifactId = artifactIdSchema.parse(id)
    const maximumCharacters = z
      .number()
      .int()
      .min(256)
      .max(16_384)
      .parse(maximumCharactersInput)
    const artifact = await this.metadata.find(applicationId, artifactId)
    const allowedMimeTypes = new Set([
      "application/json",
      "text/html",
      "text/markdown",
      "text/plain",
    ] as const)
    if (
      artifact === null ||
      !allowedMimeTypes.has(
        artifact.mimeType as
          "application/json" | "text/html" | "text/markdown" | "text/plain"
      )
    ) {
      return null
    }
    await this.metadata.assertPrivateBucket(artifact.bucket)
    await this.objects.assertPrivateBucket(artifact.bucket)
    const maximumBytes = Math.min(maximumCharacters * 4, 262_144)
    if (
      this.objects.getRange === undefined &&
      artifact.sizeBytes > maximumBytes
    ) {
      throw new Error("Artifact store cannot provide a bounded excerpt")
    }
    const body =
      this.objects.getRange === undefined
        ? await this.objects.get(artifact.bucket, artifact.objectKey)
        : await this.objects.getRange(
            artifact.bucket,
            artifact.objectKey,
            maximumBytes
          )
    const decoded = new TextDecoder().decode(body).replaceAll("\0", "")
    const excerpt = redactPersistedText(
      decoded.slice(0, maximumCharacters)
    ).trim()
    return {
      artifactId,
      mimeType: artifact.mimeType as
        "application/json" | "text/html" | "text/markdown" | "text/plain",
      excerpt:
        excerpt.length === 0 ? "No textual excerpt is available." : excerpt,
      truncated:
        artifact.sizeBytes > body.byteLength ||
        decoded.length > maximumCharacters,
    }
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
      await this.objects.delete(artifact.bucket, artifact.objectKey)
      return true
    } catch (error) {
      await this.metadata.restore(artifact.databaseId)
      throw error
    }
  }

  async retainUntil(
    applicationIdInput: string,
    id: string,
    retainUntilInput: Date
  ): Promise<boolean> {
    const applicationId = databaseIdSchema.parse(applicationIdInput)
    const artifactId = artifactIdSchema.parse(id)
    const retainUntil = z.date().parse(retainUntilInput)
    if (this.metadata.updateRetention === undefined) {
      throw new Error("Artifact metadata store cannot update retention")
    }
    const artifact = await this.metadata.find(applicationId, artifactId)
    if (artifact === null) return false
    await this.metadata.assertPrivateBucket(artifact.bucket)
    await this.objects.assertPrivateBucket(artifact.bucket)
    return (
      (await this.metadata.updateRetention(
        applicationId,
        artifactId,
        retainUntil
      )) !== null
    )
  }
}
