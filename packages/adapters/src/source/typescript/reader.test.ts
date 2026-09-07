import { describe, expect, it } from "vitest"

import { TypeScriptIndexerError } from "./errors.ts"
import {
  createFakeSourceReader,
  isWithinRoot,
  normalizeIndexPath,
  normalizeRootPrefix,
} from "./reader.ts"

describe("indexer source reader", () => {
  it.each([
    ["src/app.ts", "src/app.ts"],
    ["src//app.ts", "src/app.ts"],
    ["src/app.ts/", "src/app.ts"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIndexPath(input)).toBe(expected)
  })

  it.each([
    ["", "must be a non-empty string"],
    ["/etc/passwd", "must be relative"],
    ["C:/Windows/system32", "must be relative"],
    ["src\\app.ts", "forward slashes"],
    ["../outside.ts", "traverse parents"],
    ["src/../../outside.ts", "traverse parents"],
    ["./src/app.ts", "already be normalized"],
    ["src/./app.ts", "already be normalized"],
    [".git/config", "Git internals"],
    ["src/.GIT/config", "Git internals"],
    ["src/app\u0000.ts", "control characters"],
  ])("rejects %s", (input, message) => {
    expect(() => normalizeIndexPath(input)).toThrow(message)
  })

  it("rejects paths above the maximum length", () => {
    expect(() => normalizeIndexPath(`src/${"a".repeat(2_100)}.ts`)).toThrow(
      "maximum length"
    )
  })

  it.each([
    ["", ""],
    [".", ""],
    ["/", ""],
    ["  frontend/src  ", "frontend/src"],
    ["frontend/src/", "frontend/src"],
  ])("normalizes root prefix %s", (input, expected) => {
    expect(normalizeRootPrefix(input)).toBe(expected)
  })

  it("treats the empty root as the whole repository", () => {
    expect(isWithinRoot("anything/at/all.ts", "")).toBe(true)
    expect(isWithinRoot("frontend/src/app.ts", "frontend/src")).toBe(true)
    expect(isWithinRoot("frontend/src", "frontend/src")).toBe(true)
    expect(isWithinRoot("frontend/srcfoo/app.ts", "frontend/src")).toBe(false)
  })

  it("enumerates sorted entries with byte sizes", () => {
    const reader = createFakeSourceReader({
      "src/b.ts": "export const b = 1\n",
      "src/a.ts": "export const a = 1\n",
      "other/c.ts": "export const c = 1\n",
    })

    expect(reader.enumerate().map((entry) => entry.path)).toStrictEqual([
      "other/c.ts",
      "src/a.ts",
      "src/b.ts",
    ])
    expect(reader.enumerate("src").map((entry) => entry.path)).toStrictEqual([
      "src/a.ts",
      "src/b.ts",
    ])
    expect(reader.enumerate("src").at(0)?.sizeBytes).toBe(19)
  })

  it("counts multi-byte characters as bytes, not code units", () => {
    const reader = createFakeSourceReader({ "src/a.ts": "// 😀\n" })

    expect(reader.enumerate().at(0)?.sizeBytes).toBe(8)
  })

  it("refuses to read paths it does not expose", async () => {
    const reader = createFakeSourceReader({
      "src/a.ts": "export const a = 1\n",
    })

    await expect(reader.readText("src/missing.ts")).rejects.toMatchObject({
      code: "unsafe_path",
    })
    await expect(reader.readText("../outside.ts")).rejects.toBeInstanceOf(
      TypeScriptIndexerError
    )
  })

  it("refuses to read symlink and explicitly unreadable entries", async () => {
    const reader = createFakeSourceReader(
      {
        "src/link.ts": "export const a = 1\n",
        "src/broken.ts": "export const b = 1\n",
      },
      { symlinkPaths: ["src/link.ts"], unreadablePaths: ["src/broken.ts"] }
    )

    await expect(reader.readText("src/link.ts")).rejects.toMatchObject({
      code: "unsafe_path",
    })
    await expect(reader.readText("src/broken.ts")).rejects.toMatchObject({
      code: "unsafe_path",
    })
  })

  it("enforces the read byte budget", async () => {
    const reader = createFakeSourceReader({
      "src/a.ts": "export const a = 1\n",
    })

    await expect(reader.readText("src/a.ts", 4)).rejects.toMatchObject({
      code: "limit_exceeded",
      compatibility: true,
    })
    await expect(reader.readText("src/a.ts", 64)).resolves.toBe(
      "export const a = 1\n"
    )
  })
})
