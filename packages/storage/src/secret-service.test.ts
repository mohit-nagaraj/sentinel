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
})
