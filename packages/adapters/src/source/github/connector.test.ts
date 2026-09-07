import { describe, expect, it, vi } from "vitest"

import { EphemeralCheckoutManager } from "./checkout.ts"
import { GitHubSourceConnector } from "./connector.ts"
import { GitHubMetadataClient } from "./metadata.ts"

const baseSha = "1".repeat(40)
const headSha = "2".repeat(40)
const baseTree = "3".repeat(40)
const headTree = "4".repeat(40)

function requester(headSizeKb = 2) {
  return {
    request: vi.fn(
      async (route: string, parameters: Record<string, unknown>) => {
        if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
          return {
            data: {
              number: 1,
              state: "open",
              draft: false,
              base: {
                sha: baseSha,
                ref: "main",
                repo: { full_name: "owner/repo" },
              },
              head: {
                sha: headSha,
                ref: "feature",
                repo: { full_name: "contributor/repo" },
              },
            },
          }
        }
        if (route === "GET /repos/{owner}/{repo}") {
          return {
            data: {
              default_branch: "main",
              size: parameters["owner"] === "contributor" ? headSizeKb : 1,
              archived: false,
              disabled: false,
              private: false,
            },
          }
        }
        if (route === "GET /repos/{owner}/{repo}/commits/{ref}") {
          const head = parameters["owner"] === "contributor"
          return {
            data: {
              sha: head ? headSha : baseSha,
              commit: { tree: { sha: head ? headTree : baseTree } },
            },
          }
        }
        if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
          return {
            data: {
              sha: parameters["tree_sha"],
              truncated: false,
              tree: [
                {
                  path: "README.md",
                  mode: "100644",
                  type: "blob",
                  sha: "5".repeat(40),
                  size: 10,
                },
              ],
            },
          }
        }
        return {
          data: {
            status: "ahead",
            ahead_by: 1,
            behind_by: 0,
            merge_base_commit: { sha: baseSha },
          },
        }
      }
    ),
  }
}

describe("GitHubSourceConnector", () => {
  it("preflights both base and fork head trees before checkout", async () => {
    const transport = requester()
    const checkouts = new EphemeralCheckoutManager()
    const checkout = {
      leasePath: "worker-owned",
      snapshots: new Map(),
      dispose: vi.fn(async () => undefined),
    }
    const materialize = vi
      .spyOn(checkouts, "materialize")
      .mockResolvedValue(checkout)
    const connector = new GitHubSourceConnector({
      metadata: new GitHubMetadataClient({ requester: transport }),
      checkouts,
    })

    await expect(
      connector.resolvePullRequest("owner/repo#1")
    ).resolves.toMatchObject({
      checkout,
      ancestry: { baseIsAncestor: true },
    })
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [
          expect.objectContaining({
            label: "base",
            preflight: expect.objectContaining({ treeObjectId: baseTree }),
          }),
          expect.objectContaining({
            label: "head",
            preflight: expect.objectContaining({ treeObjectId: headTree }),
          }),
        ],
      })
    )
    expect(transport.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}",
      expect.objectContaining({ owner: "contributor" })
    )
  })

  it("rejects an oversized fork before checkout", async () => {
    const transport = requester(600_000)
    const checkouts = new EphemeralCheckoutManager()
    const materialize = vi.spyOn(checkouts, "materialize")
    const connector = new GitHubSourceConnector({
      metadata: new GitHubMetadataClient({ requester: transport }),
      checkouts,
    })

    await expect(
      connector.resolvePullRequest("owner/repo#1")
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      compatibility: true,
    })
    expect(materialize).not.toHaveBeenCalled()
  })
})
