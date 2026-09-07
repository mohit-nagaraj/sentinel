import { describe, expect, it } from "vitest"

import { SourceConnectorError } from "./errors.ts"
import {
  githubCloneUrl,
  normalizeCommitSha,
  normalizeGitObjectId,
  normalizeGitRef,
  normalizeRepositoryPath,
  parseGitHubPullRequest,
  parseGitHubRepository,
} from "./normalization.ts"

const sha = "a".repeat(40)

describe("GitHub source normalization", () => {
  it.each([
    "HiEventsDev/Hi.Events",
    "https://github.com/HiEventsDev/Hi.Events",
    "https://github.com/HiEventsDev/Hi.Events.git",
  ])("normalizes repository identity from %s", (input) => {
    const repository = parseGitHubRepository(input)
    expect(repository).toEqual({
      host: "github.com",
      owner: "hieventsdev",
      name: "hi.events",
    })
    expect(githubCloneUrl(repository)).toBe(
      "https://github.com/hieventsdev/hi.events.git"
    )
  })

  it.each([
    "http://github.com/owner/repo",
    "https://user:secret@github.com/owner/repo",
    "https://github.com/owner/repo?token=secret",
    "https://github.example/owner/repo",
    "https://github.com/owner/repo/issues",
    "-owner/repo",
    "owner/..",
    "git@github.com:owner/repo.git",
  ])("rejects unsafe repository input %s", (input) => {
    expect(() => parseGitHubRepository(input)).toThrow(SourceConnectorError)
  })

  it.each([
    ["HiEventsDev/Hi.Events#1338", 1338],
    ["https://github.com/HiEventsDev/Hi.Events/pull/1338", 1338],
  ])("normalizes pull request input %s", (input, number) => {
    expect(parseGitHubPullRequest(input)).toEqual({
      repository: {
        host: "github.com",
        owner: "hieventsdev",
        name: "hi.events",
      },
      number,
    })
  })

  it.each([
    "https://github.com/owner/repo/pulls/1",
    "https://github.com/owner/repo/pull/0",
    "owner/repo#01",
    "owner/repo#-1",
  ])("rejects invalid pull request input %s", (input) => {
    expect(() => parseGitHubPullRequest(input)).toThrow(SourceConnectorError)
  })

  it.each(["main", "feature/source-connector", "release-1.2", sha])(
    "accepts safe Git ref %s",
    (ref) => {
      expect(normalizeGitRef(ref)).toBe(ref)
    }
  )

  it.each([
    "-branch",
    " branch",
    "branch ",
    "feature//branch",
    "feature/../main",
    "refs/heads/main.lock",
    "main^{commit}",
    "main~1",
    "main@{1}",
    "@",
    "main\\other",
  ])("rejects unsafe Git ref %s", (ref) => {
    expect(() => normalizeGitRef(ref)).toThrow(SourceConnectorError)
  })

  it("requires a full commit SHA", () => {
    expect(normalizeCommitSha(sha.toUpperCase())).toBe(sha)
    expect(() => normalizeCommitSha("abc123")).toThrow(SourceConnectorError)
  })

  it("normalizes Git object identities", () => {
    expect(normalizeGitObjectId(sha.toUpperCase())).toBe(sha)
    expect(() => normalizeGitObjectId("tree-object")).toThrow(
      SourceConnectorError
    )
  })

  it.each([
    "src/index.ts",
    "apps/web/app/page.test.tsx",
    "packages/@scope/name+file.ts",
  ])("accepts portable repository path %s", (path) => {
    expect(normalizeRepositoryPath(path)).toBe(path)
  })

  it.each([
    "../secret",
    "src/../../secret",
    "/etc/passwd",
    "C:/Windows/system.ini",
    "src\\index.ts",
    "src//index.ts",
    "src/./index.ts",
    "src/con/file.ts",
    "src/trailing. ",
  ])("rejects unsafe repository path %s", (path) => {
    expect(() => normalizeRepositoryPath(path)).toThrow(SourceConnectorError)
  })
})
