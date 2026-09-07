import { describe, expect, it } from "vitest"

import type { DatabaseClient, DatabaseExecutor } from "./database.ts"
import { TargetSecretService } from "./secret-service.ts"

const applicationId = "11111111-1111-4111-8111-111111111111"
const vaultSecretId = "22222222-2222-4222-8222-222222222222"
const mappingId = "33333333-3333-4333-8333-333333333333"

class ScriptedDatabase implements DatabaseClient {
  readonly calls: Array<{
    statement: string
    parameters: readonly unknown[]
  }> = []
  transactionCalls = 0

  constructor(private readonly responses: unknown[][]) {}

  async query<Row extends Record<string, unknown>>(
    statement: string,
    parameters: readonly unknown[] = []
  ): Promise<readonly Row[]> {
    this.calls.push({ statement, parameters })
    return (this.responses.shift() ?? []) as Row[]
  }

  async transaction<T>(
    work: (executor: DatabaseExecutor) => Promise<T>
  ): Promise<T> {
    this.transactionCalls += 1
    return work(this)
  }

  async close() {}
}

describe("target secret service", () => {
  it("returns an opaque reference and keeps plaintext out of mapping rows", async () => {
    const database = new ScriptedDatabase([
      [{ id: vaultSecretId }],
      [
        {
          id: mappingId,
          application_id: applicationId,
          secret_name: "organizer_password",
          vault_secret_id: vaultSecretId,
          opaque_reference:
            "secret-ref:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          rotated_at: null,
        },
      ],
    ])
    const service = new TargetSecretService(database)

    const result = await service.create({
      applicationId,
      name: "organizer_password",
      value: "plaintext-value",
    })

    expect(result.reference).toMatch(/^secret-ref:v1:[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain("plaintext-value")
    expect(database.transactionCalls).toBe(1)
    expect(database.calls[0]?.parameters[0]).toBe("plaintext-value")
    expect(database.calls[1]?.parameters).not.toContain("plaintext-value")
  })

  it("resolves plaintext only through the server-side Vault join", async () => {
    const reference =
      "secret-ref:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const database = new ScriptedDatabase([
      [{ decrypted_secret: "resolved-value" }],
    ])
    const service = new TargetSecretService(database)

    await expect(service.resolve(applicationId, reference)).resolves.toBe(
      "resolved-value"
    )
    expect(database.calls[0]?.statement).toContain("vault.decrypted_secrets")
    expect(database.calls[0]?.statement).not.toContain("resolved-value")
  })

  it("rotates a Vault value without changing or exposing its opaque reference", async () => {
    const reference =
      "secret-ref:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const mapping = {
      id: mappingId,
      application_id: applicationId,
      secret_name: "organizer_password",
      vault_secret_id: vaultSecretId,
      opaque_reference: reference,
      rotated_at: null,
    }
    const database = new ScriptedDatabase([
      [mapping],
      [],
      [{ ...mapping, rotated_at: "2026-09-08T00:00:00.000Z" }],
    ])
    const service = new TargetSecretService(database)

    const result = await service.rotate({
      applicationId,
      reference,
      value: "replacement-value",
    })

    expect(result).toMatchObject({ reference, name: "organizer_password" })
    expect(result.rotatedAt?.toISOString()).toBe("2026-09-08T00:00:00.000Z")
    expect(database.calls[1]?.statement).toContain("vault.update_secret")
    expect(database.calls[1]?.parameters).toEqual([
      vaultSecretId,
      "replacement-value",
    ])
    expect(JSON.stringify(result)).not.toContain("replacement-value")
  })

  it("deletes the mapping that triggers deletion of its encrypted Vault value", async () => {
    const reference =
      "secret-ref:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const database = new ScriptedDatabase([
      [
        {
          id: mappingId,
          application_id: applicationId,
          secret_name: "organizer_password",
          vault_secret_id: vaultSecretId,
          opaque_reference: reference,
          rotated_at: null,
        },
      ],
      [],
    ])
    const service = new TargetSecretService(database)

    await expect(service.delete(applicationId, reference)).resolves.toBe(true)
    expect(database.calls[1]?.statement).toContain(
      "delete from sentinel.target_secrets"
    )
    expect(database.calls[1]?.parameters).toEqual([mappingId])
  })

  it("treats deletion of an unknown reference as idempotent", async () => {
    const database = new ScriptedDatabase([[]])
    const service = new TargetSecretService(database)

    await expect(
      service.delete(
        applicationId,
        "secret-ref:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      )
    ).resolves.toBe(false)
    expect(database.calls).toHaveLength(1)
  })
})
