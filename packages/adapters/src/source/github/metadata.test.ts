import { describe, expect, it, vi } from "vitest"

import { GitHubMetadataClient } from "./metadata.ts"
import { SourceConnectorError } from "./errors.ts"

const baseSha = "1".repeat(40)
const headSha = "2".repeat(40)
const treeSha = "3".repeat(40)

describe("GitHubMetadataClient", () => {
  it("maps repository, commit, pull request, and ancestry metadata", async () => {
    const request = vi.fn(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}") {
        return {
          data: {
            default_branch: "develop",
            size: 123,
            archived: false,
            disabled: false,
            private: false,
          },
        }
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
        return { data: { sha: baseSha, commit: { tree: { sha: treeSha } } } }
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return {
          data: {
            number: 7,
            state: "open",
            draft: false,
            base: {
              sha: baseSha,
              ref: "develop",
              repo: { full_name: "Owner/Repo" },
            },
            head: {
              sha: headSha,
              ref: "feature/source",
              repo: { full_name: "Contributor/Repo" },
            },
          },
        }
      }
      return {
        data: {
          status: "ahead",
          ahead_by: 2,
          behind_by: 0,
          merge_base_commit: { sha: baseSha },
        },
      }
    })
    const client = new GitHubMetadataClient({ requester: { request } })

    await expect(client.getRepository("Owner/Repo")).resolves.toEqual({
      repository: { host: "github.com", owner: "owner", name: "repo" },
      defaultBranch: "develop",
      cloneUrl: "https://github.com/owner/repo.git",
      sizeBytes: 123 * 1_024,
      archived: false,
      disabled: false,
      private: false,
    })
    await expect(
      client.getCommit("Owner/Repo", "develop")
    ).resolves.toMatchObject({
      requestedRef: "develop",
      sha: baseSha,
      treeObjectId: treeSha,
    })
    await expect(client.getPullRequest("Owner/Repo#7")).resolves.toMatchObject({
      number: 7,
      base: { sha: baseSha, repository: { owner: "owner", name: "repo" } },
      head: {
        sha: headSha,
        repository: { owner: "contributor", name: "repo" },
      },
    })
    await expect(
      client.compareCommits("Owner/Repo", baseSha, headSha)
    ).resolves.toEqual({
      baseSha,
      headSha,
      mergeBaseSha: baseSha,
      status: "ahead",
      aheadBy: 2,
      behindBy: 0,
      baseIsAncestor: true,
    })

    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      expect.objectContaining({ basehead: `${baseSha}...${headSha}` })
    )
  })

  it("maps provider failures without leaking a token", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
    const client = new GitHubMetadataClient({
      token,
      requester: {
        request: vi.fn(async () => {
          throw Object.assign(new Error(`request failed ${token}`), {
            status: 500,
          })
        }),
      },
    })
    const error = await client
      .getRepository("owner/repo")
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(SourceConnectorError)
    expect((error as SourceConnectorError).message).not.toContain(token)
    expect((error as SourceConnectorError).cause).toBeUndefined()
  })

  it("rejects pull requests whose head repository was deleted", async () => {
    const client = new GitHubMetadataClient({
      requester: {
        request: vi.fn(async () => ({
          data: {
            number: 7,
            state: "open",
            draft: false,
            base: {
              sha: baseSha,
              ref: "main",
              repo: { full_name: "owner/repo" },
            },
            head: { sha: headSha, ref: "feature", repo: null },
          },
        })),
      },
    })
    await expect(client.getPullRequest("owner/repo#7")).rejects.toMatchObject({
      code: "unsupported_repository",
      compatibility: true,
    })
  })
})
