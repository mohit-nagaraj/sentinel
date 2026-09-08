import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260907000100_operational_state.sql",
    import.meta.url
  ),
  "utf8"
)
const eventIdempotencyMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908000100_run_event_idempotency.sql",
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

  it("deduplicates committed run events before allocating a sequence", () => {
    expect(eventIdempotencyMigration).toContain("run_events_idempotency_idx")
    expect(eventIdempotencyMigration).toContain("p_idempotency_key text")
    expect(eventIdempotencyMigration).toContain(
      "run event idempotency conflict"
    )
    expect(eventIdempotencyMigration).toMatch(
      /select \* into result[\s\S]*idempotency_key = p_idempotency_key[\s\S]*for update/i
    )
    expect(eventIdempotencyMigration).toContain(
      "drop function if exists sentinel.append_run_event(uuid, text, jsonb, timestamptz)"
    )
  })
})
