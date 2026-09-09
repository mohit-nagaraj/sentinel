import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

describe("targeted verification migration", () => {
  it("scopes private content-addressed records to application, run, and assessment", async () => {
    const sql = await readFile(
      new URL(
        "../../../supabase/migrations/20260909000300_targeted_verification.sql",
        import.meta.url
      ),
      "utf8"
    )
    expect(sql).toContain(
      "create table if not exists sentinel.verification_records"
    )
    expect(sql).toContain("references sentinel.applications(id)")
    expect(sql).toContain("references sentinel.runs(id)")
    expect(sql).toContain("references sentinel.pr_assessments(id)")
    expect(sql).toContain("primary key (application_id, run_id, stable_key)")
    expect(sql).toContain("octet_length(payload::text) <= 5242880")
    expect(sql).toContain("'execution_cache'")
    expect(sql).toContain(
      "revoke all on sentinel.verification_records from public"
    )
    expect(sql).toContain(
      "grant select, insert on sentinel.verification_records to service_role"
    )
  })
})
