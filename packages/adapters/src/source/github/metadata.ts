import { Octokit } from "@octokit/rest"
import { z } from "zod"

import { connectorError, SourceConnectorError } from "./errors.ts"
import {
  githubCloneUrl,
  normalizeCommitSha,
  normalizeGitRef,
  normalizeGitObjectId,
  normalizeRepositoryPath,
  parseGitHubPullRequest,
  parseGitHubRepository,
  sameRepository,
  type GitHubRepositoryIdentity,
} from "./normalization.ts"
import { markTreePreflight, type TreePreflightShape } from "./tree-preflight.ts"

interface GitHubRequester {
  request(
    route: string,
    parameters: Record<string, unknown>
  ): Promise<{ readonly data: unknown }>
}

const repositoryResponseSchema = z.looseObject({
  default_branch: z.string().min(1),
  size: z.number().int().nonnegative(),
  archived: z.boolean(),
  disabled: z.boolean(),
  private: z.boolean(),
})

const commitResponseSchema = z.looseObject({
  sha: z.string(),
  commit: z.looseObject({
    tree: z.looseObject({ sha: z.string().min(1) }),
  }),
})

const repositoryReferenceSchema = z.looseObject({
  full_name: z.string().min(3),
})

const pullRequestResponseSchema = z.looseObject({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullable(),
  base: z.looseObject({
    sha: z.string(),
    ref: z.string().min(1),
    repo: repositoryReferenceSchema,
  }),
  head: z.looseObject({
    sha: z.string(),
    ref: z.string().min(1),
    repo: repositoryReferenceSchema.nullable(),
  }),
})

const comparisonResponseSchema = z.looseObject({
  status: z.enum(["ahead", "behind", "diverged", "identical"]),
  ahead_by: z.number().int().nonnegative(),
  behind_by: z.number().int().nonnegative(),
  merge_base_commit: z.looseObject({ sha: z.string() }),
})

const treeResponseSchema = z.looseObject({
  sha: z.string(),
  truncated: z.boolean(),
  tree: z.array(
    z.looseObject({
      path: z.string().min(1),
      mode: z.string().min(1),
      type: z.enum(["blob", "tree", "commit"]),
      sha: z.string(),
      size: z.number().int().nonnegative().optional(),
    })
  ),
})

export interface GitHubRepositoryMetadata {
  readonly repository: GitHubRepositoryIdentity
  readonly defaultBranch: string
  readonly cloneUrl: string
  readonly sizeBytes: number
  readonly archived: boolean
  readonly disabled: boolean
  readonly private: boolean
}

export interface GitHubCommitMetadata {
  readonly repository: GitHubRepositoryIdentity
  readonly requestedRef: string
  readonly sha: string
  readonly treeObjectId: string
}

export interface GitHubPullRequestMetadata {
  readonly repository: GitHubRepositoryIdentity
  readonly number: number
  readonly state: "open" | "closed"
  readonly draft: boolean
  readonly base: {
    readonly repository: GitHubRepositoryIdentity
    readonly ref: string
    readonly sha: string
  }
  readonly head: {
    readonly repository: GitHubRepositoryIdentity
    readonly ref: string
    readonly sha: string
  }
}

export interface GitHubComparisonMetadata {
  readonly baseSha: string
  readonly headSha: string
  readonly mergeBaseSha: string
  readonly status: "ahead" | "behind" | "diverged" | "identical"
  readonly aheadBy: number
  readonly behindBy: number
  readonly baseIsAncestor: boolean
}

export type GitHubTreeSummary = TreePreflightShape

export interface GitHubMetadataClientOptions {
  readonly token?: string
  readonly timeoutMs?: number
  readonly userAgent?: string
  readonly requester?: GitHubRequester
}

function malformedResponse(): SourceConnectorError {
  return new SourceConnectorError(
    "provider_unavailable",
    "GitHub returned malformed source metadata",
    { retryable: true }
  )
}

function parseFullName(value: string): GitHubRepositoryIdentity {
  return parseGitHubRepository(value)
}

function parseProviderObjectId(value: string): string {
  try {
    return normalizeGitObjectId(value)
  } catch {
    throw malformedResponse()
  }
}

export class GitHubMetadataClient {
  private readonly requester: GitHubRequester
  private readonly token: string | undefined
  private readonly timeoutMs: number

  constructor(options: GitHubMetadataClientOptions = {}) {
    if (
      options.token !== undefined &&
      (options.token.length < 1 || options.token.length > 2_048)
    ) {
      throw new SourceConnectorError("invalid_input", "GitHub token is invalid")
    }
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.requester =
      options.requester ??
      new Octokit({
        ...(options.token === undefined ? {} : { auth: options.token }),
        userAgent: options.userAgent ?? "sentinel-source-connector/0.0.1",
        request: { timeout: this.timeoutMs },
      })
  }

  private async request(
    route: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    try {
      const response = await this.requester.request(route, {
        ...parameters,
        request: {
          timeout: this.timeoutMs,
          ...(signal === undefined ? {} : { signal }),
        },
      })
      return response.data
    } catch (error) {
      throw connectorError(
        error,
        "provider_unavailable",
        this.token === undefined ? [] : [this.token]
      )
    }
  }

  async getRepository(
    input: string | GitHubRepositoryIdentity,
    signal?: AbortSignal
  ): Promise<GitHubRepositoryMetadata> {
    const repository =
      typeof input === "string"
        ? parseGitHubRepository(input)
        : parseGitHubRepository(`${input.owner}/${input.name}`)
    const response = repositoryResponseSchema.safeParse(
      await this.request(
        "GET /repos/{owner}/{repo}",
        { owner: repository.owner, repo: repository.name },
        signal
      )
    )
    if (!response.success) throw malformedResponse()
    return {
      repository,
      defaultBranch: normalizeGitRef(response.data.default_branch),
      cloneUrl: githubCloneUrl(repository),
      sizeBytes: response.data.size * 1_024,
      archived: response.data.archived,
      disabled: response.data.disabled,
      private: response.data.private,
    }
  }

  async getCommit(
    repositoryInput: string | GitHubRepositoryIdentity,
    refInput: string,
    signal?: AbortSignal
  ): Promise<GitHubCommitMetadata> {
    const repository =
      typeof repositoryInput === "string"
        ? parseGitHubRepository(repositoryInput)
        : parseGitHubRepository(
            `${repositoryInput.owner}/${repositoryInput.name}`
          )
    const requestedRef = normalizeGitRef(refInput)
    const response = commitResponseSchema.safeParse(
      await this.request(
        "GET /repos/{owner}/{repo}/commits/{ref}",
        { owner: repository.owner, repo: repository.name, ref: requestedRef },
        signal
      )
    )
    if (!response.success) throw malformedResponse()
    return {
      repository,
      requestedRef,
      sha: normalizeCommitSha(response.data.sha),
      treeObjectId: parseProviderObjectId(response.data.commit.tree.sha),
    }
  }

  async getTreeSummary(
    repositoryInput: string | GitHubRepositoryIdentity,
    treeInput: string,
    signal?: AbortSignal
  ): Promise<GitHubTreeSummary> {
    const repository =
      typeof repositoryInput === "string"
        ? parseGitHubRepository(repositoryInput)
        : parseGitHubRepository(
            `${repositoryInput.owner}/${repositoryInput.name}`
          )
    const treeObjectId = normalizeGitObjectId(treeInput)
    const response = treeResponseSchema.safeParse(
      await this.request(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        {
          owner: repository.owner,
          repo: repository.name,
          tree_sha: treeObjectId,
          recursive: "1",
        },
        signal
      )
    )
    if (!response.success) throw malformedResponse()
    if (parseProviderObjectId(response.data.sha) !== treeObjectId) {
      throw malformedResponse()
    }
    let fileCount = 0
    let totalBytes = 0
    let maxFileBytes = 0
    let maxDepth = 0
    let hasSubmodules = false
    for (const entry of response.data.tree) {
      let path: string
      try {
        path = normalizeRepositoryPath(entry.path)
      } catch {
        throw new SourceConnectorError(
          "unsupported_repository",
          "GitHub tree contains a non-portable repository path",
          { compatibility: true }
        )
      }
      maxDepth = Math.max(maxDepth, path.split("/").length)
      if (entry.type === "tree") continue
      fileCount += 1
      if (entry.type === "commit" || entry.mode === "160000") {
        hasSubmodules = true
        continue
      }
      if (entry.size === undefined || entry.type !== "blob") {
        throw malformedResponse()
      }
      if (entry.size > Number.MAX_SAFE_INTEGER - totalBytes) {
        throw malformedResponse()
      }
      totalBytes += entry.size
      maxFileBytes = Math.max(maxFileBytes, entry.size)
    }
    return markTreePreflight({
      treeObjectId,
      fileCount,
      totalBytes,
      maxFileBytes,
      maxDepth,
      hasSubmodules,
      truncated: response.data.truncated,
    })
  }

  async getPullRequest(
    input: string,
    signal?: AbortSignal
  ): Promise<GitHubPullRequestMetadata> {
    const identity = parseGitHubPullRequest(input)
    const response = pullRequestResponseSchema.safeParse(
      await this.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: identity.repository.owner,
          repo: identity.repository.name,
          pull_number: identity.number,
        },
        signal
      )
    )
    if (!response.success) throw malformedResponse()
    if (response.data.head.repo === null) {
      throw new SourceConnectorError(
        "unsupported_repository",
        "Pull request head repository is no longer available",
        { compatibility: true }
      )
    }
    const baseRepository = parseFullName(response.data.base.repo.full_name)
    if (!sameRepository(identity.repository, baseRepository)) {
      throw new SourceConnectorError(
        "provider_unavailable",
        "GitHub pull request base repository did not match the request"
      )
    }
    return {
      repository: identity.repository,
      number: response.data.number,
      state: response.data.state,
      draft: response.data.draft ?? false,
      base: {
        repository: baseRepository,
        ref: normalizeGitRef(response.data.base.ref),
        sha: normalizeCommitSha(response.data.base.sha),
      },
      head: {
        repository: parseFullName(response.data.head.repo.full_name),
        ref: normalizeGitRef(response.data.head.ref),
        sha: normalizeCommitSha(response.data.head.sha),
      },
    }
  }

  async compareCommits(
    repositoryInput: string | GitHubRepositoryIdentity,
    baseInput: string,
    headInput: string,
    signal?: AbortSignal
  ): Promise<GitHubComparisonMetadata> {
    const repository =
      typeof repositoryInput === "string"
        ? parseGitHubRepository(repositoryInput)
        : parseGitHubRepository(
            `${repositoryInput.owner}/${repositoryInput.name}`
          )
    const baseSha = normalizeCommitSha(baseInput)
    const headSha = normalizeCommitSha(headInput)
    const response = comparisonResponseSchema.safeParse(
      await this.request(
        "GET /repos/{owner}/{repo}/compare/{basehead}",
        {
          owner: repository.owner,
          repo: repository.name,
          basehead: `${baseSha}...${headSha}`,
        },
        signal
      )
    )
    if (!response.success) throw malformedResponse()
    return {
      baseSha,
      headSha,
      mergeBaseSha: normalizeCommitSha(response.data.merge_base_commit.sha),
      status: response.data.status,
      aheadBy: response.data.ahead_by,
      behindBy: response.data.behind_by,
      baseIsAncestor:
        response.data.status === "ahead" ||
        response.data.status === "identical",
    }
  }
}
