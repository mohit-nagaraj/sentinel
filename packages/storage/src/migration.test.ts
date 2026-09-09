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
    "../../../supabase/migrations/20260908000200_run_event_idempotency.sql",
    import.meta.url
  ),
  "utf8"
)
const runControlMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908000300_run_control.sql",
    import.meta.url
  ),
  "utf8"
)
const githubAppMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908000400_github_app_checks.sql",
    import.meta.url
  ),
  "utf8"
)
const realtimeActivityMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260908000500_realtime_activity.sql",
    import.meta.url
  ),
  "utf8"
)
const graphPublicationMigration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260909000100_graph_publication_summaries.sql",
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

describe("run control migration", () => {
  it("enforces idempotency, application mutation exclusion, and leases", () => {
    expect(runControlMigration).toContain("request_fingerprint")
    expect(runControlMigration).toContain("idempotency_conflict")
    expect(runControlMigration).toContain("retry_control_run")
    expect(runControlMigration).toContain("retry_not_allowed")
    expect(runControlMigration).toContain(
      "runs_active_application_mutation_idx"
    )
    expect(runControlMigration).toContain("lease_expires_at > now()")
    expect(runControlMigration).toContain("run_type <> 'run_eval'")
    expect(runControlMigration).toContain("row_number() over")
    expect(runControlMigration.match(/pg_advisory_xact_lock/g)?.length).toBe(6)
    expect(runControlMigration).toContain("terminal publication must match")
    expect(runControlMigration).toContain("configuration_fingerprint")
    expect(runControlMigration).toContain("invalid_budget")
  })

  it("authorizes through onboarding ownership and accepts interrupts once", () => {
    expect(runControlMigration).toContain(
      "onboarding.operator_id = p_operator_id"
    )
    expect(runControlMigration).toContain("sentinel.run_interrupts")
    expect(runControlMigration).toContain("response_fingerprint")
    expect(runControlMigration).toContain("interrupt_conflict")
    expect(runControlMigration).toContain("set status = 'queued'")
  })

  it("keeps request and response payloads bounded and secret-free", () => {
    expect(runControlMigration).toContain(
      "octet_length(request::text) <= 16384"
    )
    expect(runControlMigration).toContain(
      "octet_length(response::text) <= 8192"
    )
    expect(runControlMigration).toContain("storageState")
    expect(runControlMigration).toContain(
      "revoke all on table sentinel.run_interrupts from public"
    )
  })
})

describe("GitHub App assessment migration", () => {
  it("atomically links deliveries, immutable heads, runs, and checks", () => {
    expect(githubAppMigration).toContain("enqueue_github_pr_assessment")
    expect(githubAppMigration).toContain("assessment_id uuid")
    expect(githubAppMigration).toContain("github_installation_id")
    expect(githubAppMigration).toContain("github_repository_id")
    expect(githubAppMigration).toContain("github_pull_request_id")
    expect(githubAppMigration).toContain("provider_updated_at")
    expect(githubAppMigration).toContain("check_run_id")
    expect(githubAppMigration).toContain(
      "onboarding_github_installation_repository_idx"
    )
    expect(githubAppMigration).toContain("pg_advisory_xact_lock")
    expect(githubAppMigration).toContain("sentinel.enqueue_control_run")
  })

  it("guards supersession, out-of-order heads, and check synchronization", () => {
    expect(githubAppMigration).toContain(
      "v_current.provider_updated_at > p_provider_updated_at"
    )
    expect(githubAppMigration).toContain("set status = 'cancelled'")
    expect(githubAppMigration).toContain("claim_github_assessment_check")
    expect(githubAppMigration).toContain("bind_github_assessment_check")
    expect(githubAppMigration).toContain("release_github_assessment_check")
    expect(githubAppMigration).toMatch(
      /head_sha = p_head_sha[\s\S]*and assessment\.is_current/i
    )
  })

  it("keeps GitHub mutations server-only", () => {
    expect(githubAppMigration).toContain(
      "revoke all on function sentinel.enqueue_github_pr_assessment"
    )
    expect(githubAppMigration).toContain("to service_role")
    expect(githubAppMigration).not.toMatch(
      /grant execute[\s\S]*to (?:anon|authenticated)/i
    )
  })
})

describe("realtime activity migration", () => {
  it("broadcasts cursor-only run hints to private owner-authorized topics", () => {
    expect(realtimeActivityMigration).toContain("can_receive_run_broadcast")
    expect(realtimeActivityMigration).toContain("sentinel_owned_run_broadcasts")
    expect(realtimeActivityMigration).toContain(
      "realtime.messages.extension = 'broadcast'"
    )
    expect(realtimeActivityMigration).toContain("'runId', new.run_id")
    expect(realtimeActivityMigration).toContain("'sequence', new.sequence")
    expect(realtimeActivityMigration).not.toContain("new.event")
    expect(realtimeActivityMigration).toContain("run_state")
    expect(realtimeActivityMigration).toContain("runs_broadcast_state")
    expect(realtimeActivityMigration).toContain(
      "run_interrupts_broadcast_state"
    )
    expect(realtimeActivityMigration).not.toMatch(
      /for insert\s+to authenticated/i
    )
  })

  it("requests pause without aborting running work and clears it on resume", () => {
    expect(realtimeActivityMigration).toContain("pause_requested_at")
    expect(realtimeActivityMigration).toContain("pause_control_run")
    expect(realtimeActivityMigration).toContain(
      "resume_decision_id = 'resume_run'"
    )
    expect(realtimeActivityMigration).toContain("old.status = 'interrupted'")
    expect(realtimeActivityMigration).toContain("next_pause_decision_id")
    expect(realtimeActivityMigration).toContain("v_decision_id")
  })

  it("associates content-addressed artifacts with every owning run", () => {
    expect(realtimeActivityMigration).toContain("sentinel.run_artifacts")
    expect(realtimeActivityMigration).toContain(
      "primary key (run_id, artifact_id)"
    )
    expect(realtimeActivityMigration).toContain(
      "alter table sentinel.run_artifacts enable row level security"
    )
  })
})

describe("graph publication summary migration", () => {
  it("stores one compact server-only summary per application revision", () => {
    expect(graphPublicationMigration).toContain(
      "sentinel.knowledge_publications"
    )
    expect(graphPublicationMigration).toContain(
      "primary key (application_id, graph_revision)"
    )
    expect(graphPublicationMigration).toContain("unique (run_id)")
    expect(graphPublicationMigration).toContain(
      "octet_length(summary::text) <= 65536"
    )
    expect(graphPublicationMigration).toContain(
      "revoke all on sentinel.knowledge_publications from public"
    )
    expect(graphPublicationMigration).not.toMatch(
      /grant\s+(?:insert|update|delete).*\s+to\s+(?:anon|authenticated)/i
    )
  })
})
