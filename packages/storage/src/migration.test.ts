import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260907000100_operational_state.sql",
    import.meta.url
  ),
  "utf8"
)

describe("operational migration", () => {
  it("defines every compact operational table and private checkpoint schema", () => {
    for (const table of [
      "applications",
      "sources",
      "runs",
      "run_events",
      "github_webhook_deliveries",
      "pr_assessments",
      "assessment_findings",
      "artifacts",
      "link_reviews",
      "eval_results",
      "target_secrets",
    ]) {
      expect(migration).toContain(`sentinel.${table}`)
    }
    expect(migration).toContain(
      "create schema if not exists langgraph_checkpoint"
    )
    expect(migration).toContain(
      "revoke all on schema langgraph_checkpoint from public"
    )
  })

  it("uses atomic queue claims, ordered events, RLS, and no browser grants", () => {
    expect(migration).toContain("for update skip locked")
    expect(migration).toContain(
      "set next_event_sequence = next_event_sequence + 1"
    )
    expect(migration).toContain("enable row level security")
    expect(migration).toContain("revoke all on schema sentinel from anon")
    expect(migration).toContain(
      "revoke all on schema sentinel from authenticated"
    )
    expect(migration).not.toMatch(
      /grant\s+(?:insert|update|delete).*\s+to\s+(?:anon|authenticated)/i
    )
  })

  it("keeps artifacts private and ordinary tables free of secret values", () => {
    expect(migration).toContain("'app.settings.sentinel_artifact_bucket'")
    expect(migration).toContain(
      "allowed_mime_types = excluded.allowed_mime_types"
    )
    const targetSecretsDefinition = migration.match(
      /create table if not exists sentinel\.target_secrets \(([\s\S]*?)\n\);/i
    )?.[1]
    expect(targetSecretsDefinition).toBeDefined()
    expect(targetSecretsDefinition).not.toMatch(/\bsecret_value\b/i)
    expect(targetSecretsDefinition).not.toMatch(/\bdecrypted_secret\b/i)
    expect(targetSecretsDefinition).toContain("vault_secret_id uuid")
    expect(targetSecretsDefinition).toContain("opaque_reference text")
  })
})
