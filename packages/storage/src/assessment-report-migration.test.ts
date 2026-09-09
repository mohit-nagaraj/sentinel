import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const migrationPath = fileURLToPath(
  new URL(
    "../../../supabase/migrations/20260909000200_assessment_reports.sql",
    import.meta.url
  )
)

describe("assessment report migration", () => {
  it("finalizes only current matching heads and immutable private artifacts", async () => {
    const sql = await readFile(migrationPath, "utf8")

    expect(sql).toContain(
      "create or replace function sentinel.finalize_assessment_report"
    )
    expect(sql).toContain("v_assessment.head_sha <> p_head_sha")
    expect(sql).toContain("not v_assessment.is_current")
    expect(sql).toContain(
      "artifact.artifact_type = 'assessment_report_markdown'"
    )
    expect(sql).toContain("bucket.public = false")
    expect(sql).toContain("message = 'report_identity_conflict'")
    expect(sql).toContain("reference_count = reference_count + 1")
    expect(sql).toContain("(p_view ->> 'id') is distinct from p_report_id")
    expect(sql).toContain("(p_view ->> 'headSha') is distinct from p_head_sha")
    expect(sql).toContain("artifact.size_bytes > 0")
    expect(sql).toContain("pr_assessments_report_state_check")
    expect(sql).not.toContain(
      "foreign key (report_artifact_id) references sentinel.artifacts(id)"
    )
  })

  it("stores verification as contiguous append-only enrichment", async () => {
    const sql = await readFile(migrationPath, "utf8")

    expect(sql).toContain(
      "create table if not exists sentinel.report_verification_enrichments"
    )
    expect(sql).toContain("unique (assessment_id, report_id, version)")
    expect(sql).toContain("p_version > v_current_version + 1")
    expect(sql).toContain(
      "(p_payload -> 'version') is distinct from to_jsonb(p_version)"
    )
    expect(sql).toContain(
      "(p_payload #> '{verification,version}') is distinct from to_jsonb(p_version)"
    )
    expect(sql).toContain(
      "alter table sentinel.report_verification_enrichments enable row level security"
    )
    expect(sql).not.toContain(
      "update sentinel.pr_assessments\n  set report_view"
    )
  })

  it("revokes report functions from public execution", async () => {
    const sql = await readFile(migrationPath, "utf8")
    expect(sql).toContain(
      "revoke all on function sentinel.finalize_assessment_report"
    )
    expect(sql).toContain(
      "revoke all on function sentinel.append_report_verification_enrichment"
    )
    expect(sql).toContain(
      "grant execute on function sentinel.finalize_assessment_report"
    )
    expect(sql).toContain(
      "grant execute on function sentinel.append_report_verification_enrichment"
    )
    expect(sql.trimEnd().endsWith("commit;")).toBe(true)
  })
})
