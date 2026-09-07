import {
  applicationIdSchema,
  commitShaSchema,
  parsePrDiffAnalysis,
  pullRequestIdSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
  runIdSchema,
  type ApplicationId,
  type BaselineCompatibility,
  type CommitSha,
  type PrDiffAnalysis,
  type PullRequestId,
  type RunId,
} from "@sentinel/contracts"

import type { CheckoutSnapshot } from "../github/checkout.ts"
import { GitProcessRunner, type GitRunner } from "../github/git-runner.ts"
import type { GitHubRepositoryIdentity } from "../github/normalization.ts"
import {
  DefaultAffectedSymbolIndexer,
  type AffectedSymbolIndexer,
} from "./affected-indexer.ts"
import { parseGitDiff, type ParsedDiffFile } from "./diff-parser.ts"
import { PrDiffError } from "./errors.ts"
import { resolvePrDiffLimits, type PrDiffLimits } from "./limits.ts"
import { mapDiffSymbols } from "./symbol-mapper.ts"

export interface PrDiffAnalyzerOptions {
  readonly runner?: GitRunner
  readonly symbolIndexer?: AffectedSymbolIndexer
  readonly limits?: Partial<PrDiffLimits>
}

export interface AnalyzePrDiffRequest {
  readonly pullRequestId: PullRequestId
  readonly applicationId: ApplicationId
  readonly runId: RunId
  readonly repository: GitHubRepositoryIdentity
  readonly baseSha: CommitSha
  readonly headSha: CommitSha
  readonly graphCommitSha: CommitSha
  readonly indexedPaths: readonly string[]
  readonly baseSnapshot: CheckoutSnapshot
  readonly headSnapshot: CheckoutSnapshot
  readonly signal?: AbortSignal
}

function compareStrings(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function decodeUtf8(output: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output)
  } catch {
    throw new PrDiffError(
      "git_failed",
      `Git ${label} output is not valid UTF-8`
    )
  }
}

function sourcePaths(
  files: readonly ParsedDiffFile[],
  side: "base" | "head"
): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        files.flatMap((file) => {
          if (
            file.language === undefined ||
            file.binary ||
            file.classifications.includes("generated") ||
            file.classifications.includes("lockfile")
          ) {
            return []
          }
          const path = side === "base" ? file.oldPath : file.newPath
          return path === undefined ? [] : [path]
        })
      ),
    ].sort(compareStrings)
  )
}

export class PrDiffAnalyzer {
  private readonly runner: GitRunner
  private readonly symbolIndexer: AffectedSymbolIndexer
  private readonly limits: PrDiffLimits

  constructor(options: PrDiffAnalyzerOptions = {}) {
    this.runner = options.runner ?? new GitProcessRunner()
    this.symbolIndexer =
      options.symbolIndexer ?? new DefaultAffectedSymbolIndexer()
    this.limits = resolvePrDiffLimits(options.limits)
  }

  private async git(
    args: readonly string[],
    snapshot: CheckoutSnapshot,
    request: AnalyzePrDiffRequest,
    maxOutputBytes: number
  ): Promise<Buffer> {
    try {
      return await this.runner.run(args, {
        cwd: snapshot.path,
        timeoutMs: this.limits.timeoutMs,
        maxOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "limit_exceeded"
      ) {
        throw new PrDiffError(
          "limit_exceeded",
          "Git PR diff output exceeded its configured limit",
          { compatibility: true, cause: error }
        )
      }
      throw new PrDiffError("git_failed", "Git PR diff operation failed", {
        cause: error,
      })
    }
  }

  private async verifiedCommit(
    sha: CommitSha,
    snapshot: CheckoutSnapshot,
    request: AnalyzePrDiffRequest
  ): Promise<CommitSha> {
    const output = decodeUtf8(
      await this.git(
        ["rev-parse", "--verify", `${sha}^{commit}`],
        snapshot,
        request,
        256
      ),
      "commit identity"
    ).trim()
    const result = commitShaSchema.safeParse(output)
    if (!result.success || result.data !== sha) {
      throw new PrDiffError(
        "content_mismatch",
        "Git resolved a different immutable commit identity"
      )
    }
    return result.data
  }

  private async mergeBase(
    left: CommitSha,
    right: CommitSha,
    snapshot: CheckoutSnapshot,
    request: AnalyzePrDiffRequest
  ): Promise<CommitSha> {
    const output = decodeUtf8(
      await this.git(["merge-base", left, right], snapshot, request, 256),
      "merge-base"
    ).trim()
    const result = commitShaSchema.safeParse(output)
    if (!result.success) {
      throw new PrDiffError("git_failed", "Git returned an invalid merge base")
    }
    return result.data
  }

  private async baselineCompatibility(
    request: AnalyzePrDiffRequest
  ): Promise<BaselineCompatibility> {
    if (request.graphCommitSha === request.baseSha) {
      return {
        status: "exact",
        assessmentAllowed: true,
        graphCommitSha: request.graphCommitSha,
        baseSha: request.baseSha,
        reason: "graph_matches_pr_base",
        relevantInterveningPaths: [],
      }
    }
    try {
      await this.verifiedCommit(
        request.graphCommitSha,
        request.baseSnapshot,
        request
      )
      const common = await this.mergeBase(
        request.graphCommitSha,
        request.baseSha,
        request.baseSnapshot,
        request
      )
      if (common !== request.graphCommitSha) {
        return {
          status: "unrelated_or_unknown",
          assessmentAllowed: false,
          graphCommitSha: request.graphCommitSha,
          baseSha: request.baseSha,
          reason: "baseline_not_ancestor_of_pr_base",
          relevantInterveningPaths: [],
        }
      }
      const output = await this.git(
        [
          "diff",
          "--name-only",
          "-z",
          "--no-renames",
          request.graphCommitSha,
          request.baseSha,
          "--",
        ],
        request.baseSnapshot,
        request,
        Math.min(this.limits.maxPatchBytes, 8 * 1_024 * 1_024)
      )
      const paths = decodeUtf8(output, "intervening-path")
        .split("\0")
        .filter((path) => path.length > 0)
      if (paths.length > this.limits.maxInterveningPaths) {
        throw new PrDiffError(
          "limit_exceeded",
          "Baseline intervening path limit exceeded",
          { compatibility: true }
        )
      }
      const indexed = new Set(request.indexedPaths)
      const relevant = [
        ...new Set(paths.filter((path) => indexed.has(path))),
      ].sort(compareStrings)
      return relevant.length === 0
        ? {
            status: "safe_ancestor_warning",
            assessmentAllowed: true,
            graphCommitSha: request.graphCommitSha,
            baseSha: request.baseSha,
            reason: "ancestor_without_relevant_changes",
            relevantInterveningPaths: [],
          }
        : {
            status: "stale_relevant",
            assessmentAllowed: false,
            graphCommitSha: request.graphCommitSha,
            baseSha: request.baseSha,
            reason: "ancestor_with_relevant_changes",
            relevantInterveningPaths: relevant,
          }
    } catch (error) {
      if (error instanceof PrDiffError && error.code === "limit_exceeded") {
        throw error
      }
      return {
        status: "unrelated_or_unknown",
        assessmentAllowed: false,
        graphCommitSha: request.graphCommitSha,
        baseSha: request.baseSha,
        reason: "ancestry_unavailable",
        relevantInterveningPaths: [],
      }
    }
  }

  async analyze(input: AnalyzePrDiffRequest): Promise<PrDiffAnalysis> {
    const pullRequestId = pullRequestIdSchema.parse(input.pullRequestId)
    const applicationId = applicationIdSchema.parse(input.applicationId)
    const runId = runIdSchema.parse(input.runId)
    const repository = repositoryIdentitySchema.parse(input.repository)
    const baseSha = commitShaSchema.parse(input.baseSha)
    const headSha = commitShaSchema.parse(input.headSha)
    const graphCommitSha = commitShaSchema.parse(input.graphCommitSha)
    if (input.indexedPaths.length > this.limits.maxInterveningPaths) {
      throw new PrDiffError(
        "limit_exceeded",
        "Indexed baseline path limit exceeded",
        { compatibility: true }
      )
    }
    const indexedPaths = [
      ...new Set(
        input.indexedPaths.map((path) => repositoryPathSchema.parse(path))
      ),
    ].sort(compareStrings)
    const request = {
      ...input,
      pullRequestId,
      applicationId,
      runId,
      repository,
      baseSha,
      headSha,
      graphCommitSha,
      indexedPaths,
    }
    if (
      request.baseSnapshot.metadata.commitSha !== baseSha ||
      request.headSnapshot.metadata.commitSha !== headSha
    ) {
      throw new PrDiffError(
        "content_mismatch",
        "Checkout snapshots do not match the requested PR commits"
      )
    }
    await Promise.all([
      this.verifiedCommit(baseSha, request.baseSnapshot, request),
      this.verifiedCommit(headSha, request.headSnapshot, request),
    ])
    const common = await this.mergeBase(
      baseSha,
      headSha,
      request.baseSnapshot,
      request
    )
    if (common !== baseSha) {
      throw new PrDiffError(
        "ancestry_mismatch",
        "PR base commit is not an ancestor of its head"
      )
    }
    const patch = decodeUtf8(
      await this.git(
        [
          "diff",
          "--patch",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--find-renames=50%",
          "--unified=0",
          "--no-indent-heuristic",
          "--ignore-submodules=none",
          baseSha,
          headSha,
          "--",
        ],
        request.baseSnapshot,
        request,
        this.limits.maxPatchBytes
      ),
      "diff"
    )
    const parsed = parseGitDiff(patch, this.limits)
    const basePaths = sourcePaths(parsed.files, "base")
    const headPaths = sourcePaths(parsed.files, "head")
    const [baseline, baseIndex, headIndex] = await Promise.all([
      this.baselineCompatibility(request),
      this.symbolIndexer.index({
        snapshot: request.baseSnapshot,
        applicationId,
        runId,
        repository,
        commitSha: baseSha,
        paths: basePaths,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
      this.symbolIndexer.index({
        snapshot: request.headSnapshot,
        applicationId,
        runId,
        repository,
        commitSha: headSha,
        paths: headPaths,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
    ])
    if (
      baseIndex.symbols.length + headIndex.symbols.length >
      this.limits.maxSymbols
    ) {
      throw new PrDiffError("limit_exceeded", "PR diff symbol limit exceeded", {
        compatibility: true,
      })
    }
    const provenance = {
      pullRequestId,
      baseSha,
      headSha,
      diffHash: parsed.diffHash,
    }
    const mapped = mapDiffSymbols(
      parsed.files,
      baseIndex,
      headIndex,
      provenance
    )
    return parsePrDiffAnalysis({
      schemaVersion: 1,
      pullRequestId,
      repository,
      baseSha,
      headSha,
      diffHash: parsed.diffHash,
      ancestry: "base_is_ancestor",
      baseline,
      files: mapped.files,
      symbols: mapped.symbols,
      summary: {
        fileCount: mapped.files.length,
        symbolCount: mapped.symbols.length,
        mappedFileCount: mapped.files.filter(
          ({ mappingStatus }) => mappingStatus === "mapped"
        ).length,
        unmappedFileCount: mapped.files.filter(
          ({ mappingStatus }) => mappingStatus === "unmapped"
        ).length,
      },
    })
  }
}
