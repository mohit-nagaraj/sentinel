import {
  PrDiffAnalyzer,
  type AffectedSymbolIndexer,
  type AffectedSymbolIndexRequest,
} from "@sentinel/adapters"
import {
  applicationIdSchema,
  codeSymbolIdSchema,
  hashCanonical,
  pullRequestIdSchema,
  runIdSchema,
} from "@sentinel/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  createPrDiffRepositoryFixture,
  type PrDiffRepositoryFixture,
} from "../fixtures/pr-diff-repository.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"a".repeat(64)}`
)
const pullRequestId = pullRequestIdSchema.parse(
  `pull-request:v1:${"b".repeat(64)}`
)
const runId = runIdSchema.parse("run:123e4567-e89b-12d3-a456-426614174000")
const repository = { host: "github.com", owner: "fixture", name: "pr-diff" }

class RecordingIndexer implements AffectedSymbolIndexer {
  readonly requests: AffectedSymbolIndexRequest[] = []

  async index(request: AffectedSymbolIndexRequest) {
    this.requests.push(request)
    return {
      failures: [],
      symbols: request.paths.map((path, index) => ({
        id: codeSymbolIdSchema.parse(
          `code-symbol:v1:${hashCanonical({
            commit: request.commitSha,
            path,
          }).slice("sha256:".length)}`
        ),
        filePath: path,
        qualifiedName: `${path}#main`,
        name: "main",
        kind: "function",
        language: path.endsWith(".php")
          ? ("php" as const)
          : path.endsWith(".tsx")
            ? ("tsx" as const)
            : ("typescript" as const),
        range: { startLine: 1, endLine: 10_000 },
        parentSymbolIds: [],
        contentHash: hashCanonical({ path, index }),
      })),
    }
  }
}

describe("PR diff analyzer with local Git history", () => {
  let fixture: PrDiffRepositoryFixture

  beforeAll(async () => {
    fixture = await createPrDiffRepositoryFixture()
  })

  afterAll(async () => {
    await fixture.dispose()
  })

  function request(graphCommitSha = fixture.baseSha) {
    return {
      pullRequestId,
      applicationId,
      runId,
      repository,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      graphCommitSha,
      indexedPaths: ["src/edit.ts"],
      baseSnapshot: fixture.baseSnapshot,
      headSnapshot: fixture.headSnapshot,
    }
  }

  it("maps the complete Git matrix deterministically without returning a patch", async () => {
    const indexer = new RecordingIndexer()
    const analyzer = new PrDiffAnalyzer({ symbolIndexer: indexer })
    const first = await analyzer.analyze(request())
    const second = await analyzer.analyze(request())

    expect(second).toStrictEqual(first)
    expect(first.baseline.status).toBe("exact")
    expect(new Set(first.files.map(({ operation }) => operation))).toEqual(
      new Set(["added", "modified", "deleted", "renamed"])
    )
    expect(
      first.files.find(({ newPath }) => newPath === "image.bin")
    ).toMatchObject({
      binary: true,
      mappingStatus: "unmapped",
      unresolvedReasons: expect.arrayContaining(["binary_file"]),
    })
    expect(
      first.files.find(({ newPath }) => newPath === "dist/client.generated.ts")
    ).toMatchObject({
      classifications: expect.arrayContaining(["source", "generated"]),
      mappingStatus: "unmapped",
    })
    expect(
      first.files.find(({ newPath }) => newPath === "pnpm-lock.yaml")
    ).toMatchObject({ classifications: expect.arrayContaining(["lockfile"]) })
    expect(
      first.files.find(({ newPath }) => newPath === "no-newline.txt")
    ).toMatchObject({ noNewlineAtEnd: true })
    expect(
      first.files.find(({ newPath }) => newPath === "script.sh")
    ).toMatchObject({
      baseRanges: [],
      headRanges: [],
      unresolvedReasons: expect.arrayContaining(["no_changed_ranges"]),
    })
    expect(
      first.symbols.some(
        ({ operation, base, head }) =>
          operation === "deleted" &&
          base?.filePath === "backend/Delete.php" &&
          head === undefined
      )
    ).toBe(true)
    expect(
      first.symbols.some(
        ({ operation, base, head }) =>
          operation === "renamed" &&
          base?.filePath === "src/old-name.ts" &&
          head?.filePath === "src/new-name.ts"
      )
    ).toBe(true)
    expect(JSON.stringify(first)).not.toContain("patch")

    const selectedPaths = indexer.requests.flatMap(({ paths }) => paths)
    expect(selectedPaths).not.toContain("dist/client.generated.ts")
    expect(selectedPaths).not.toContain("image.bin")
    expect(selectedPaths).not.toContain("pnpm-lock.yaml")
    expect(selectedPaths).toContain("src/edit.ts")
    expect(selectedPaths).toContain("backend/Edit.php")
  })

  it("classifies exact, safe, stale, containing, and unrelated baselines", async () => {
    const analyzer = new PrDiffAnalyzer({
      symbolIndexer: new RecordingIndexer(),
    })
    await expect(
      analyzer.analyze(request(fixture.safeGraphSha))
    ).resolves.toMatchObject({
      baseline: { status: "safe_ancestor_warning", assessmentAllowed: true },
    })
    await expect(
      analyzer.analyze(request(fixture.staleGraphSha))
    ).resolves.toMatchObject({
      baseline: {
        status: "stale_relevant",
        assessmentAllowed: false,
        relevantInterveningPaths: ["src/edit.ts"],
      },
    })
    await expect(
      analyzer.analyze(request(fixture.headSha))
    ).resolves.toMatchObject({
      baseline: { status: "unrelated_or_unknown", assessmentAllowed: false },
    })
    await expect(
      analyzer.analyze(request(fixture.unrelatedSha))
    ).resolves.toMatchObject({
      baseline: { status: "unrelated_or_unknown", assessmentAllowed: false },
    })
  })

  it("fails closed for large diffs and non-ancestral PR heads", async () => {
    await expect(
      new PrDiffAnalyzer({
        symbolIndexer: new RecordingIndexer(),
        limits: { maxFiles: 1 },
      }).analyze(request())
    ).rejects.toMatchObject({ code: "limit_exceeded", compatibility: true })

    await expect(
      new PrDiffAnalyzer({
        symbolIndexer: new RecordingIndexer(),
        limits: { maxSymbols: 1 },
      }).analyze(request())
    ).rejects.toMatchObject({ code: "limit_exceeded", compatibility: true })

    await expect(
      new PrDiffAnalyzer({ symbolIndexer: new RecordingIndexer() }).analyze({
        ...request(),
        headSha: fixture.unrelatedSha,
        headSnapshot: fixture.unrelatedSnapshot,
      })
    ).rejects.toMatchObject({ code: "ancestry_mismatch" })
  })
})
