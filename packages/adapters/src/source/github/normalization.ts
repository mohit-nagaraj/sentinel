import {
  commitShaSchema,
  repositoryIdentitySchema,
  repositoryPathSchema,
} from "@sentinel/contracts"

import { SourceConnectorError } from "./errors.ts"

export type GitHubRepositoryIdentity = ReturnType<
  typeof repositoryIdentitySchema.parse
>

export interface GitHubPullRequestIdentity {
  readonly repository: GitHubRepositoryIdentity
  readonly number: number
}

const ownerPattern = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/
const repositoryPattern = /^[A-Za-z0-9._-]{1,100}$/
const controlCharacterPattern = /[\u0000-\u001f\u007f]/
const invalidWindowsComponentPattern = /[<>:"|?*]/
const windowsDevicePattern = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function invalidInput(message: string): never {
  throw new SourceConnectorError("invalid_input", message)
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return invalidInput("GitHub URL contains invalid percent encoding")
  }
}

function normalizeOwnerAndName(
  ownerValue: string,
  nameValue: string
): GitHubRepositoryIdentity {
  const owner = decodeSegment(ownerValue)
  const strippedName = decodeSegment(nameValue).replace(/\.git$/i, "")
  if (!ownerPattern.test(owner)) {
    return invalidInput("GitHub repository owner is invalid")
  }
  if (
    !repositoryPattern.test(strippedName) ||
    strippedName === "." ||
    strippedName === ".."
  ) {
    return invalidInput("GitHub repository name is invalid")
  }
  return repositoryIdentitySchema.parse({
    host: "github.com",
    owner,
    name: strippedName,
  })
}

function githubUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalidInput("GitHub repository URL is invalid")
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return invalidInput(
      "GitHub URLs must use credential-free HTTPS on github.com without query or fragment data"
    )
  }
  return url
}

export function parseGitHubRepository(input: string): GitHubRepositoryIdentity {
  const value = input.trim()
  if (
    value.length < 3 ||
    value.length > 512 ||
    controlCharacterPattern.test(value)
  ) {
    return invalidInput("GitHub repository identifier is invalid")
  }
  if (!value.includes("://")) {
    const segments = value.split("/")
    if (segments.length !== 2) {
      return invalidInput(
        "GitHub repository must be owner/name or an HTTPS URL"
      )
    }
    return normalizeOwnerAndName(segments[0] ?? "", segments[1] ?? "")
  }
  const segments = githubUrl(value).pathname.split("/").filter(Boolean)
  if (segments.length !== 2) {
    return invalidInput(
      "GitHub repository URL must identify exactly one repository"
    )
  }
  return normalizeOwnerAndName(segments[0] ?? "", segments[1] ?? "")
}

export function parseGitHubPullRequest(
  input: string
): GitHubPullRequestIdentity {
  const value = input.trim()
  const shorthand = /^([^/#]+\/[^/#]+)#([1-9][0-9]*)$/.exec(value)
  if (shorthand !== null) {
    const number = Number(shorthand[2])
    if (!Number.isSafeInteger(number))
      return invalidInput("Pull request number is invalid")
    return {
      repository: parseGitHubRepository(shorthand[1] ?? ""),
      number,
    }
  }
  const segments = githubUrl(value).pathname.split("/").filter(Boolean)
  if (
    segments.length !== 4 ||
    segments[2] !== "pull" ||
    !/^[1-9][0-9]*$/.test(segments[3] ?? "")
  ) {
    return invalidInput("GitHub pull request URL is invalid")
  }
  const number = Number(segments[3])
  if (!Number.isSafeInteger(number))
    return invalidInput("Pull request number is invalid")
  return {
    repository: normalizeOwnerAndName(segments[0] ?? "", segments[1] ?? ""),
    number,
  }
}

export function normalizeGitRef(input: string): string {
  const value = input.trim()
  const components = value.split("/")
  if (
    value.length < 1 ||
    value.length > 255 ||
    value !== input ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    /[\u0000-\u0020\u007f~^:?*\\[]/.test(value) ||
    components.some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".lock")
    )
  ) {
    return invalidInput("Git reference is invalid")
  }
  return /^[A-F0-9]{40}$/.test(value) ? value.toLowerCase() : value
}

export function normalizeCommitSha(input: string): string {
  const result = commitShaSchema.safeParse(input.toLowerCase())
  if (!result.success)
    return invalidInput("Commit SHA must be a full hexadecimal object ID")
  return result.data
}

export function normalizeGitObjectId(input: string): string {
  const value = input.toLowerCase()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    return invalidInput("Git object ID must be a full hexadecimal identity")
  }
  return value
}

export function normalizeRepositoryPath(input: string): string {
  if (
    input.length < 1 ||
    input.length > 2_048 ||
    input.startsWith("/") ||
    input.startsWith("\\") ||
    /^[A-Za-z]:/.test(input) ||
    input.includes("\\") ||
    controlCharacterPattern.test(input)
  ) {
    return invalidInput("Repository path must be a safe relative path")
  }
  const components = input.split("/")
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        component.endsWith(".") ||
        component.endsWith(" ") ||
        invalidWindowsComponentPattern.test(component) ||
        windowsDevicePattern.test(component)
    )
  ) {
    return invalidInput("Repository path contains an unsafe component")
  }
  const result = repositoryPathSchema.safeParse(input)
  if (!result.success) return invalidInput("Repository path is invalid")
  return result.data
}

export function githubCloneUrl(repository: GitHubRepositoryIdentity): string {
  return `https://github.com/${repository.owner}/${repository.name}.git`
}

export function sameRepository(
  left: GitHubRepositoryIdentity,
  right: GitHubRepositoryIdentity
): boolean {
  return (
    left.host === right.host &&
    left.owner === right.owner &&
    left.name === right.name
  )
}
