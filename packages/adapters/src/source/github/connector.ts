import { SourceConnectorError } from "./errors.ts"
import {
  EphemeralCheckoutManager,
  type CheckoutLimits,
  type EphemeralCheckout,
} from "./checkout.ts"
import {
  GitHubMetadataClient,
  type GitHubCommitMetadata,
  type GitHubComparisonMetadata,
  type GitHubMetadataClientOptions,
  type GitHubPullRequestMetadata,
  type GitHubRepositoryMetadata,
} from "./metadata.ts"
import { parseGitHubRepository, sameRepository } from "./normalization.ts"

export interface ResolvedGitHubCommit {
  readonly repository: GitHubRepositoryMetadata
  readonly commit: GitHubCommitMetadata
  readonly checkout: EphemeralCheckout
}

export interface ResolvedGitHubPullRequest {
  readonly repository: GitHubRepositoryMetadata
  readonly pullRequest: GitHubPullRequestMetadata
  readonly ancestry: GitHubComparisonMetadata
  readonly checkout: EphemeralCheckout
}

export interface GitHubSourceConnectorOptions extends GitHubMetadataClientOptions {
  readonly metadata?: GitHubMetadataClient
  readonly checkouts?: EphemeralCheckoutManager
  readonly limits?: Partial<CheckoutLimits>
}

export interface GitHubSourceConnectorStartupOptions extends GitHubSourceConnectorOptions {
  readonly staleLeaseAgeMs?: number
}

export interface SourceConnector {
  resolveCommit(
    repository: string,
    ref: string,
    signal?: AbortSignal
  ): Promise<ResolvedGitHubCommit>
  resolvePullRequest(
    pullRequest: string,
    signal?: AbortSignal
  ): Promise<ResolvedGitHubPullRequest>
}

export class GitHubSourceConnector implements SourceConnector {
  private readonly token: string | undefined
  readonly metadata: GitHubMetadataClient
  readonly checkouts: EphemeralCheckoutManager

  constructor(options: GitHubSourceConnectorOptions = {}) {
    this.token = options.token
    this.metadata = options.metadata ?? new GitHubMetadataClient(options)
    this.checkouts =
      options.checkouts ??
      new EphemeralCheckoutManager(
        options.limits === undefined ? {} : { limits: options.limits }
      )
  }

  private assertRepositoryCompatible(
    repository: GitHubRepositoryMetadata
  ): void {
    if (repository.disabled) {
      throw new SourceConnectorError(
        "unsupported_repository",
        "GitHub repository is disabled",
        { compatibility: true }
      )
    }
    if (repository.sizeBytes > this.checkouts.limits.maxTotalBytes) {
      throw new SourceConnectorError(
        "limit_exceeded",
        `GitHub reports ${repository.sizeBytes} repository bytes; limit is ${this.checkouts.limits.maxTotalBytes}`,
        { compatibility: true }
      )
    }
  }

  async resolveCommit(
    repositoryInput: string,
    ref: string,
    signal?: AbortSignal
  ): Promise<ResolvedGitHubCommit> {
    const identity = parseGitHubRepository(repositoryInput)
    const repository = await this.metadata.getRepository(identity, signal)
    this.assertRepositoryCompatible(repository)
    const commit = await this.metadata.getCommit(identity, ref, signal)
    const tree = await this.metadata.getTreeSummary(
      identity,
      commit.treeObjectId,
      signal
    )
    const checkout = await this.checkouts.materialize({
      repository: identity,
      targets: [
        {
          label: "source",
          sha: commit.sha,
          remoteUrl: repository.cloneUrl,
          preflight: tree,
        },
      ],
      ...(this.token === undefined ? {} : { githubToken: this.token }),
      ...(signal === undefined ? {} : { signal }),
    })
    return { repository, commit, checkout }
  }

  async resolvePullRequest(
    pullRequestInput: string,
    signal?: AbortSignal
  ): Promise<ResolvedGitHubPullRequest> {
    const pullRequest = await this.metadata.getPullRequest(
      pullRequestInput,
      signal
    )
    const repositoryPromise = this.metadata.getRepository(
      pullRequest.repository,
      signal
    )
    const headRepositoryPromise = sameRepository(
      pullRequest.repository,
      pullRequest.head.repository
    )
      ? repositoryPromise
      : this.metadata.getRepository(pullRequest.head.repository, signal)
    const [repository, headRepository, baseCommit, headCommit, ancestry] =
      await Promise.all([
        repositoryPromise,
        headRepositoryPromise,
        this.metadata.getCommit(
          pullRequest.base.repository,
          pullRequest.base.sha,
          signal
        ),
        this.metadata.getCommit(
          pullRequest.head.repository,
          pullRequest.head.sha,
          signal
        ),
        this.metadata.compareCommits(
          pullRequest.repository,
          pullRequest.base.sha,
          pullRequest.head.sha,
          signal
        ),
      ])
    this.assertRepositoryCompatible(repository)
    this.assertRepositoryCompatible(headRepository)
    const [baseTree, headTree] = await Promise.all([
      this.metadata.getTreeSummary(
        pullRequest.base.repository,
        baseCommit.treeObjectId,
        signal
      ),
      this.metadata.getTreeSummary(
        pullRequest.head.repository,
        headCommit.treeObjectId,
        signal
      ),
    ])
    const checkout = await this.checkouts.materialize({
      repository: pullRequest.repository,
      targets: [
        {
          label: "base",
          sha: pullRequest.base.sha,
          remoteUrl: repository.cloneUrl,
          preflight: baseTree,
        },
        {
          label: "head",
          sha: pullRequest.head.sha,
          remoteUrl: headRepository.cloneUrl,
          preflight: headTree,
        },
      ],
      ...(this.token === undefined ? {} : { githubToken: this.token }),
      ...(signal === undefined ? {} : { signal }),
    })
    return { repository, pullRequest, ancestry, checkout }
  }
}

export async function startGitHubSourceConnector(
  options: GitHubSourceConnectorStartupOptions = {}
): Promise<GitHubSourceConnector> {
  const connector = new GitHubSourceConnector(options)
  await connector.checkouts.registry.reclaimStale(
    options.staleLeaseAgeMs ?? 24 * 60 * 60_000
  )
  return connector
}
