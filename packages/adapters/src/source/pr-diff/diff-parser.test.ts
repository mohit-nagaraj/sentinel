import { describe, expect, it } from "vitest"

import { parseGitDiff, parseGitHubPullFiles } from "./diff-parser.ts"

describe("PR diff parser", () => {
  it("parses additions, deletions, edits, renames, and no-newline markers", () => {
    const parsed = parseGitDiff(
      [
        "diff --git a/src/edit.ts b/src/edit.ts",
        "index 1111111..2222222 100644",
        "--- a/src/edit.ts",
        "+++ b/src/edit.ts",
        "@@ -2,2 +2,3 @@",
        "-old one",
        "-old two",
        "+new one",
        "+new two",
        "+new three",
        "diff --git a/src/new.php b/src/new.php",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/new.php",
        "@@ -0,0 +1 @@",
        "+<?php",
        "\\ No newline at end of file",
        "diff --git a/src/gone.ts b/src/gone.ts",
        "deleted file mode 100644",
        "--- a/src/gone.ts",
        "+++ /dev/null",
        "@@ -8 +0,0 @@",
        "-gone()",
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 88%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "@@ -4 +4 @@",
        "-before",
        "+after",
      ].join("\n")
    )

    expect(parsed.files.map(({ operation }) => operation)).toStrictEqual([
      "modified",
      "deleted",
      "added",
      "renamed",
    ])
    expect(parsed.files[0]?.baseRanges).toStrictEqual([
      { startLine: 2, endLine: 3 },
    ])
    expect(parsed.files[0]?.headRanges).toStrictEqual([
      { startLine: 2, endLine: 4 },
    ])
    expect(parsed.files[2]).toMatchObject({
      oldPath: undefined,
      newPath: "src/new.php",
      noNewlineAtEnd: true,
      language: "php",
    })
    expect(parsed.files[3]).toMatchObject({
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      similarity: 88,
    })
  })

  it("classifies binary, generated, lockfile, configuration, and schema files", () => {
    const parsed = parseGitDiff(
      [
        "diff --git a/image.png b/image.png",
        "GIT binary patch",
        "literal 4",
        "LcmeAS@N?(olHy`uVBq!ia0vp^",
        "diff --git a/dist/client.generated.ts b/dist/client.generated.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/composer.json b/composer.json",
        "@@ -1 +1 @@",
        "-{}",
        '+{"require":{}}',
        "diff --git a/src/types.d.ts b/src/types.d.ts",
        "@@ -1 +1 @@",
        "-declare const old: string",
        "+declare const next: string",
        "diff --git a/database/migrations/001.sql b/database/migrations/001.sql",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n")
    )

    expect(parsed.files[0]?.classifications).toContain("configuration")
    expect(parsed.files[1]?.classifications).toContain("schema")
    expect(parsed.files[2]?.classifications).toContain("source")
    expect(parsed.files[2]?.classifications).toContain("generated")
    expect(parsed.files[3]?.classifications).toContain("binary")
    expect(parsed.files[4]?.classifications).toContain("lockfile")
    expect(parsed.files[4]?.classifications).toContain("configuration")
    expect(parsed.files[5]?.classifications).toContain("generated")
  })

  it("normalizes GitHub patch records and preserves unavailable patches", () => {
    const parsed = parseGitHubPullFiles([
      {
        filename: "src/new name.ts",
        previousFilename: "src/old name.ts",
        status: "renamed",
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      { filename: "assets/blob.bin", status: "modified" },
      {
        filename: "src/copied.ts",
        previousFilename: "src/source.ts",
        status: "copied",
        patch: "@@ -0,0 +1 @@\n+copy",
      },
    ])

    expect(parsed.files[0]?.unresolvedReasons).toContain("patch_unavailable")
    expect(parsed.files[1]).toMatchObject({
      operation: "added",
      oldPath: undefined,
      newPath: "src/copied.ts",
    })
    expect(parsed.files[1]?.unresolvedReasons).toContain("copied_file")
    expect(parsed.files[2]).toMatchObject({
      operation: "renamed",
      oldPath: "src/old name.ts",
      newPath: "src/new name.ts",
    })
  })

  it("maps a metadata-only rename without inventing a missing-range warning", () => {
    const git = parseGitDiff(
      "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n"
    )
    const github = parseGitHubPullFiles([
      {
        filename: "src/new.ts",
        previousFilename: "src/old.ts",
        status: "renamed",
      },
    ])

    expect(git.files[0]).toMatchObject({
      operation: "renamed",
      unresolvedReasons: [],
    })
    expect(github.files[0]).toMatchObject({
      operation: "renamed",
      patchAvailable: true,
      unresolvedReasons: [],
    })
  })

  it("produces stable ordering and a content-sensitive normalized hash", () => {
    const left = parseGitDiff(
      "diff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n"
    )
    const repeated = parseGitDiff(
      "diff --git a/b.ts b/b.ts\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\ndiff --git a/a.ts b/a.ts\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n"
    )
    const changed = parseGitDiff(
      "diff --git a/b.ts b/b.ts\n@@ -1 +1 @@\n-old\n+different\ndiff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n"
    )

    expect(left.files.map(({ newPath }) => newPath)).toStrictEqual([
      "a.ts",
      "b.ts",
    ])
    expect(repeated.diffHash).toBe(left.diffHash)
    expect(changed.diffHash).not.toBe(left.diffHash)
  })

  it("handles quoted Git paths", () => {
    const parsed = parseGitDiff(
      'diff --git "a/src/name with space.ts" "b/src/name with space.ts"\n@@ -1 +1 @@\n-old\n+new\n'
    )
    expect(parsed.files[0]?.newPath).toBe("src/name with space.ts")
  })

  it("fails closed on malformed hunks and configured limits", () => {
    expect(() =>
      parseGitDiff("diff --git a/a.ts b/a.ts\n@@ -1,2 +1 @@\n-old\n+new")
    ).toThrow("declared line counts")
    expect(() =>
      parseGitDiff("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new", {
        maxChangedLines: 1,
      })
    ).toThrow("changed-line limit")
    expect(() => parseGitDiff("x".repeat(50), { maxPatchBytes: 10 })).toThrow(
      "byte limit"
    )
    expect(() =>
      parseGitDiff(
        "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d",
        { maxHunksPerFile: 1 }
      )
    ).toThrow("hunk limit")
  })
})
