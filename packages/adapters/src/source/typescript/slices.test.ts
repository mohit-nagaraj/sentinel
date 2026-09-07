import { describe, expect, it } from "vitest"

import { defaultTypeScriptIndexLimits, resolveIndexLimits } from "./limits.ts"
import {
  countSourceLines,
  normalizeRange,
  readSourceSlice,
  splitSourceLines,
} from "./slices.ts"

const limits = defaultTypeScriptIndexLimits

describe("bounded source slices", () => {
  it.each([
    ["", 0],
    ["a", 1],
    ["a\n", 1],
    ["a\nb", 2],
    ["a\nb\n", 2],
    ["a\r\nb\r\n", 2],
    ["a\rb\r", 2],
    ["a\n\n", 2],
  ])("counts lines in %j as %i", (text, expected) => {
    expect(countSourceLines(text)).toBe(expected)
  })

  it("recognizes CRLF, LF, and CR line endings alike", () => {
    expect(splitSourceLines("a\r\nb\nc\rd")).toStrictEqual(["a", "b", "c", "d"])
  })

  it("returns the requested range for a normal file", () => {
    expect(
      readSourceSlice(
        "one\ntwo\nthree\nfour\n",
        { startLine: 2, endLine: 3 },
        limits
      )
    ).toStrictEqual({
      startLine: 2,
      endLine: 3,
      text: "two\nthree",
      truncated: false,
    })
  })

  it("returns a single-line declaration without truncation", () => {
    expect(
      readSourceSlice(
        "export const a = 1\n",
        { startLine: 1, endLine: 1 },
        limits
      )
    ).toStrictEqual({
      startLine: 1,
      endLine: 1,
      text: "export const a = 1",
      truncated: false,
    })
  })

  it("handles a declaration on the last line with no trailing newline", () => {
    expect(
      readSourceSlice("a\nb", { startLine: 2, endLine: 2 }, limits)
    ).toStrictEqual({ startLine: 2, endLine: 2, text: "b", truncated: false })
  })

  it("clamps a range that runs past the end of the file", () => {
    expect(
      readSourceSlice("a\nb\n", { startLine: 2, endLine: 9 }, limits)
    ).toStrictEqual({ startLine: 2, endLine: 2, text: "b", truncated: true })
  })

  it("reports an empty file as a truncated empty slice", () => {
    expect(
      readSourceSlice("", { startLine: 1, endLine: 1 }, limits)
    ).toStrictEqual({
      startLine: 1,
      endLine: 1,
      text: "",
      truncated: true,
    })
  })

  it("anchors a start line beyond the end of the file at the last line", () => {
    expect(
      readSourceSlice("a\nb\n", { startLine: 40, endLine: 41 }, limits)
    ).toStrictEqual({ startLine: 2, endLine: 2, text: "", truncated: true })
  })

  it("clamps to the line budget", () => {
    const slice = readSourceSlice(
      "1\n2\n3\n4\n5\n",
      { startLine: 1, endLine: 5 },
      resolveIndexLimits({ maxSliceLines: 2 })
    )

    expect(slice).toStrictEqual({
      startLine: 1,
      endLine: 2,
      text: "1\n2",
      truncated: true,
    })
  })

  it("clamps to the byte budget", () => {
    const slice = readSourceSlice(
      "aaaa\nbbbb\ncccc\n",
      { startLine: 1, endLine: 3 },
      resolveIndexLimits({ maxSliceBytes: 12 })
    )

    expect(slice.text).toBe("aaaa\nbbbb")
    expect(slice.truncated).toBe(true)
  })

  it("always returns the anchor line even when it exceeds the byte budget", () => {
    const slice = readSourceSlice(
      `${"x".repeat(200)}\nnext\n`,
      { startLine: 1, endLine: 2 },
      resolveIndexLimits({ maxSliceBytes: 10 })
    )

    expect(slice.startLine).toBe(1)
    expect(slice.endLine).toBe(1)
    expect(slice.text).toHaveLength(200)
    expect(slice.truncated).toBe(true)
  })

  it("counts bytes rather than code units against the budget", () => {
    const slice = readSourceSlice(
      "😀😀\nnext\n",
      { startLine: 1, endLine: 2 },
      resolveIndexLimits({ maxSliceBytes: 10 })
    )

    expect(slice.text).toBe("😀😀")
    expect(slice.truncated).toBe(true)
  })

  it.each([
    [{ startLine: 0, endLine: 1 }],
    [{ startLine: -1, endLine: 1 }],
    [{ startLine: 3, endLine: 2 }],
    [{ startLine: Number.NaN, endLine: 1 }],
  ])("rejects the invalid range %j", (range) => {
    expect(() => normalizeRange(range)).toThrow()
  })

  it("truncates fractional line numbers rather than accepting them", () => {
    expect(normalizeRange({ startLine: 2.9, endLine: 4.2 })).toStrictEqual({
      startLine: 2,
      endLine: 4,
    })
  })
})
