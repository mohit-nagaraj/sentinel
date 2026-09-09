import { readFileSync, statSync } from "node:fs"
import { extname, resolve } from "node:path"

import { describe, expect, it } from "vitest"
import mermaid from "mermaid"

import {
  buildSampleReportView,
  renderSampleReportMarkdown,
  sampleReportSchema,
} from "../../tools/delivery/sample-report.ts"

const root = resolve(import.meta.dirname, "../..")
const requiredMarkdown = [
  "README.md",
  "DESIGN.md",
  "docs/delivery/attribution.md",
  "docs/delivery/loom-script.md",
  "docs/delivery/sample-report-hi-events-pr-1338.md",
  "docs/delivery/submission-checklist.md",
  "docs/evaluation/README.md",
  "docs/evaluation/qa-report-rubric.md",
  "docs/evaluation/snt-033-baseline.md",
  "docs/security/security-policy.md",
  "docs/security/threat-model.md",
] as const

const markdown = new Map(
  requiredMarkdown.map((path) => [path, read(path)] as const)
)

describe("assignment delivery", () => {
  it("keeps Markdown fences balanced and four required Mermaid diagrams valid", async () => {
    for (const [path, content] of markdown) {
      expect(unclosedFence(content), path).toBeNull()
    }
    const design = markdown.get("DESIGN.md")!
    const mermaidBlocks = [
      ...design.matchAll(/```mermaid\s+([\s\S]*?)```/g),
    ].map((match) => match[1]!.trim())
    expect(mermaidBlocks).toHaveLength(4)
    expect(mermaidBlocks.map((block) => block.split(/\r?\n/, 1)[0])).toEqual([
      "flowchart LR",
      "flowchart LR",
      "erDiagram",
      "sequenceDiagram",
    ])
    for (const block of mermaidBlocks) {
      expect(block).not.toMatch(/TODO|TBD|placeholder/i)
      expect(block.split(/\r?\n/).length).toBeGreaterThan(3)
      const parsed = await mermaid.parse(block, { suppressErrors: false })
      expect(parsed.diagramType).toEqual(expect.any(String))
    }
  })

  it("resolves every local Markdown link", () => {
    for (const [path, content] of markdown) {
      for (const target of localLinks(content)) {
        const withoutAnchor = decodeURIComponent(target.split("#", 1)[0]!)
        if (withoutAnchor.length === 0) continue
        const destination = resolve(
          root,
          resolve(path, "..").slice(root.length + 1),
          withoutAnchor
        )
        expect(
          () => statSync(destination),
          `${path} -> ${target}`
        ).not.toThrow()
      }
    }
  })

  it("keeps documented root commands and environment names executable", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>
    }
    const readme = markdown.get("README.md")!
    const commands = [
      ...readme.matchAll(/^pnpm ([a-z][a-z0-9:-]+)(?:\s|$)/gm),
    ].map((match) => match[1]!)
    for (const command of commands) {
      if (["dlx", "exec", "install", "vitest"].includes(command)) continue
      expect(packageJson.scripts, `pnpm ${command}`).toHaveProperty(command)
    }

    const configured = new Set(
      read(".env.example")
        .split(/\r?\n/)
        .flatMap((line) => {
          const match = /^([A-Z][A-Z0-9_]+)=/.exec(line)
          return match === null ? [] : [match[1]!]
        })
    )
    const documented = new Set(
      [
        ...[...markdown.values()]
          .join("\n")
          .matchAll(
            /\b(?:AZURE|SUPABASE|SENTINEL|NEO4J|GITHUB|RUN|RENDER|HIEVENTS)_[A-Z0-9_]+\b/g
          ),
      ]
        .map((match) => match[0])
        .filter((name) => !name.endsWith("_"))
    )
    for (const name of documented) {
      expect(configured, `${name} is missing from .env.example`).toContain(name)
    }
  })

  it("covers every required design-document question and reports honest cuts", () => {
    const design = markdown.get("DESIGN.md")!
    for (const phrase of [
      "Agent decomposition",
      "Knowledge graph schema",
      "Absence is an assessment",
      "Confidence and ambiguity",
      "Evaluation: deciding which of 100 runs are correct",
      "Scope decisions and cuts",
      "What I would build with another week",
    ]) {
      expect(design, phrase).toContain(phrase)
    }
    expect(design).toMatch(/SNT-031 targeted verification[\s\S]*implemented/i)
    expect(design).toMatch(/no trusted PR-head deployment[\s\S]*registered/i)
    expect(design).toMatch(/SNT-029 report delivery[\s\S]*implemented/i)
    expect(design).toMatch(/SNT-032 incremental refresh[\s\S]*implemented/i)
    expect(design.split(/\s+/).length).toBeGreaterThanOrEqual(3_500)
  })

  it("generates the committed real-PR report from strict source data", () => {
    const source = sampleReportSchema.parse(
      JSON.parse(read("docs/delivery/sample-report-hi-events-pr-1338.json"))
    )
    expect(source.assessment).toMatchObject({
      pullRequest: 1338,
      baseSha: "2064f88ff7590e93c738efb8becaa7d732063619",
      headSha: "f68df0dabd18d04df5e6c7e873aac2b5e5201584",
      graphRevision: 3,
      verificationStatus: "verification_unavailable",
    })
    const view = buildSampleReportView(source)
    expect(view).toMatchObject({
      pullRequestNumber: 1338,
      graphCommitSha: source.assessment.baseSha,
      graphRevision: 3,
      model: { mode: "deterministic_fallback" },
      verification: { status: "verification_unavailable" },
    })
    expect(new Set(view.findings.map(({ targetKind }) => targetKind))).toEqual(
      new Set(["screen", "ui-element", "workflow", "requirement", "unknown"])
    )
    expect(renderSampleReportMarkdown(source)).toBe(
      markdown.get("docs/delivery/sample-report-hi-events-pr-1338.md")
    )
  })

  it("keeps the Loom plan in range and fallback screenshots usable", () => {
    const loom = markdown.get("docs/delivery/loom-script.md")!
    const ranges = [...loom.matchAll(/### (\d+):(\d+)-(\d+):(\d+)/g)]
    expect(ranges).toHaveLength(8)
    const last = ranges.at(-1)!
    const endSeconds = Number(last[3]) * 60 + Number(last[4])
    expect(endSeconds).toBeGreaterThanOrEqual(5 * 60)
    expect(endSeconds).toBeLessThanOrEqual(10 * 60)

    for (const filename of [
      "onboarding.png",
      "activity.png",
      "knowledge-path.png",
      "assessment-report.png",
    ]) {
      const content = readFileSync(
        resolve(root, "docs/delivery/screenshots", filename)
      )
      expect(content.subarray(1, 4).toString("ascii"), filename).toBe("PNG")
      expect(content.readUInt32BE(16), filename).toBeGreaterThanOrEqual(1_200)
      expect(content.readUInt32BE(20), filename).toBeGreaterThanOrEqual(700)
    }
  })

  it("ships accessible standalone diagram renderings", () => {
    const diagrams = read("docs/delivery/diagrams.html")
    expect(diagrams.match(/<svg\b/g)).toHaveLength(4)
    expect(diagrams.match(/role="img"/g)).toHaveLength(4)
    expect(
      diagrams.match(/aria-labelledby="[^"]+-title [^"]+-desc"/g)
    ).toHaveLength(4)
    expect(diagrams.match(/<title id="[^"]+-title">/g)).toHaveLength(4)
    expect(diagrams.match(/<desc id="[^"]+-desc">/g)).toHaveLength(4)
    expect(diagrams).not.toContain("#eb6c36")
  })

  it("contains no unresolved authoring placeholders", () => {
    for (const [path, content] of markdown) {
      expect(content, path).not.toMatch(
        /\b(?:TODO|TBD|FIXME)\b|\[insert .+?\]/i
      )
    }
  })
})

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8")
}

function unclosedFence(content: string): string | null {
  let open: string | null = null
  for (const line of content.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker === undefined) continue
    if (open === null) open = marker[0]!
    else if (marker[0] === open[0] && marker.length >= open.length) open = null
  }
  return open
}

function localLinks(content: string): string[] {
  return [...content.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]!.trim())
    .filter(
      (target) =>
        !/^(?:https?:|mailto:|#)/i.test(target) &&
        extname(target.split("#", 1)[0]!).length > 0
    )
}
