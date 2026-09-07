import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20260907000200_documentation_maps.sql",
    import.meta.url
  ),
  "utf8"
)

describe("documentation map migration", () => {
  it("stores sanitized facts privately with relational link boundaries", () => {
    for (const table of [
      "document_maps",
      "document_pages",
      "document_sections",
      "document_links",
    ]) {
      expect(migration).toContain(`sentinel.${table}`)
    }
    expect(migration).toContain("sanitized_text text not null")
    expect(migration).toContain("relation = 'LINKS_TO'")
    expect(migration).toContain("enable row level security")
    expect(migration).toContain("revoke all on sentinel.%I from public")
    expect(migration).not.toMatch(/grant\s+.*\s+to\s+(?:anon|authenticated)/i)
  })
})
