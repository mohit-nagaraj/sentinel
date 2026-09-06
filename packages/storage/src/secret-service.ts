import {
  hashCanonical,
  secretReferenceSchema,
  type SecretReference,
} from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseClient, DatabaseExecutor } from "./database.ts"

const databaseIdSchema = z.uuid()
const secretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/)
const secretValueSchema = z.string().min(1).max(16_384)

const secretMappingRowSchema = z.object({
  id: databaseIdSchema,
  application_id: databaseIdSchema,
  secret_name: secretNameSchema,
  vault_secret_id: databaseIdSchema,
  opaque_reference: secretReferenceSchema,
  rotated_at: z.coerce.date().nullable(),
})
type SecretMappingRow = z.infer<typeof secretMappingRowSchema> &
  Record<string, unknown>

export interface SecretReferenceRecord {
  readonly reference: SecretReference
  readonly name: string
  readonly rotatedAt: Date | null
}

function createOpaqueReference(
  applicationId: string,
  vaultSecretId: string
): SecretReference {
  const digest = hashCanonical({
    applicationId,
    kind: "target-secret",
    vaultSecretId,
    version: 1,
  }).slice("sha256:".length)
  return secretReferenceSchema.parse(`secret-ref:v1:${digest}`)
}

async function findMapping(
  database: DatabaseExecutor,
  applicationId: string,
  reference: SecretReference
): Promise<SecretMappingRow | null> {
  const rows = await database.query<SecretMappingRow>(
    `select id, application_id, secret_name, vault_secret_id,
            opaque_reference, rotated_at
     from sentinel.target_secrets
     where application_id = $1::uuid and opaque_reference = $2`,
    [applicationId, reference]
  )
  return rows[0] === undefined ? null : secretMappingRowSchema.parse(rows[0])
}

export class TargetSecretService {
  constructor(private readonly database: DatabaseClient) {}

  async create(input: {
    readonly applicationId: string
    readonly name: string
    readonly value: string
  }): Promise<SecretReferenceRecord> {
    const applicationId = databaseIdSchema.parse(input.applicationId)
    const name = secretNameSchema.parse(input.name)
    const value = secretValueSchema.parse(input.value)

    return this.database.transaction(async (transaction) => {
      const vaultRows = await transaction.query<{ id: string }>(
        "select vault.create_secret($1, $2, $3)::text as id",
        [
          value,
          `sentinel:${applicationId}:${name}`,
          "Sentinel target credential",
        ]
      )
      const vaultSecretId = vaultRows[0]?.id
      if (vaultSecretId === undefined) {
        throw new Error("Vault secret creation returned no identifier")
      }

      const reference = createOpaqueReference(applicationId, vaultSecretId)
      const rows = await transaction.query<SecretMappingRow>(
        `insert into sentinel.target_secrets (
           application_id, secret_name, vault_secret_id, opaque_reference
         ) values ($1::uuid, $2, $3::uuid, $4)
         returning id, application_id, secret_name, vault_secret_id,
                   opaque_reference, rotated_at`,
        [applicationId, name, vaultSecretId, reference]
      )
      const row = rows[0]
      if (row === undefined) {
        throw new Error("Secret mapping creation returned no row")
      }
      const parsed = secretMappingRowSchema.parse(row)
      return {
        reference,
        name: parsed.secret_name,
        rotatedAt: parsed.rotated_at,
      }
    })
  }

  async resolve(
    applicationIdInput: string,
    referenceInput: string
  ): Promise<string> {
    const applicationId = databaseIdSchema.parse(applicationIdInput)
    const reference = secretReferenceSchema.parse(referenceInput)
    const rows = await this.database.query<{ decrypted_secret: string }>(
      `select decrypted.decrypted_secret
       from sentinel.target_secrets as mapping
       join vault.decrypted_secrets as decrypted
         on decrypted.id = mapping.vault_secret_id
       where mapping.application_id = $1::uuid
         and mapping.opaque_reference = $2`,
      [applicationId, reference]
    )
    const value = rows[0]?.decrypted_secret
    if (value === undefined) throw new Error("Secret reference not found")
    return secretValueSchema.parse(value)
  }

  async rotate(input: {
    readonly applicationId: string
    readonly reference: string
    readonly value: string
  }): Promise<SecretReferenceRecord> {
    const applicationId = databaseIdSchema.parse(input.applicationId)
    const reference = secretReferenceSchema.parse(input.reference)
    const value = secretValueSchema.parse(input.value)

    return this.database.transaction(async (transaction) => {
      const mapping = await findMapping(transaction, applicationId, reference)
      if (mapping === null) throw new Error("Secret reference not found")

      await transaction.query("select vault.update_secret($1::uuid, $2)", [
        mapping.vault_secret_id,
        value,
      ])
      const rows = await transaction.query<SecretMappingRow>(
        `update sentinel.target_secrets
         set rotated_at = now()
         where id = $1::uuid
         returning id, application_id, secret_name, vault_secret_id,
                   opaque_reference, rotated_at`,
        [mapping.id]
      )
      const row = rows[0]
      if (row === undefined) throw new Error("Secret rotation returned no row")
      const parsed = secretMappingRowSchema.parse(row)
      return {
        reference: parsed.opaque_reference,
        name: parsed.secret_name,
        rotatedAt: parsed.rotated_at,
      }
    })
  }

  async delete(
    applicationIdInput: string,
    referenceInput: string
  ): Promise<boolean> {
    const applicationId = databaseIdSchema.parse(applicationIdInput)
    const reference = secretReferenceSchema.parse(referenceInput)

    return this.database.transaction(async (transaction) => {
      const mapping = await findMapping(transaction, applicationId, reference)
      if (mapping === null) return false
      await transaction.query(
        "delete from sentinel.target_secrets where id = $1::uuid",
        [mapping.id]
      )
      await transaction.query("delete from vault.secrets where id = $1::uuid", [
        mapping.vault_secret_id,
      ])
      return true
    })
  }
}
