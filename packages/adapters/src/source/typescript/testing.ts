import {
  applicationIdSchema,
  commitShaSchema,
  repositoryIdentitySchema,
  runIdSchema,
} from "@sentinel/contracts"

import type { CommitScope } from "./identity.ts"
import { resolveIndexLimits, type TypeScriptIndexLimits } from "./limits.ts"
import { defaultIndexPolicy, type IndexPolicy } from "./policy.ts"
import { loadTypeScriptProject, type LoadedProject } from "./project.ts"
import { createFakeSourceReader } from "./reader.ts"

/**
 * Deterministic scope used by fixtures and tests so emitted IDs are reproducible
 * without needing a real application, run, or checkout.
 */
export const fixtureCommitScope: CommitScope = {
  applicationId: applicationIdSchema.parse(`application:v1:${"a".repeat(64)}`),
  repository: repositoryIdentitySchema.parse({
    host: "github.com",
    owner: "HiEventsDev",
    name: "Hi.Events",
  }),
  commitSha: commitShaSchema.parse("2064f88ff7590e93c738efb8becaa7d732063619"),
}

export const fixtureRunId = runIdSchema.parse(
  "run:6f1d1b64-6f2a-4b6f-9f2e-2a1c3d4e5f60"
)

export interface LoadFixtureProjectOptions {
  readonly roots?: readonly string[]
  readonly policy?: IndexPolicy
  readonly limits?: Partial<TypeScriptIndexLimits>
  readonly tsconfigPath?: string
}

/**
 * Loads an in-memory fixture tree through the same code path production uses,
 * so fixture-backed tests exercise the real reader port, policy, and compiler
 * host rather than a shortcut.
 */
export async function loadFixtureProject(
  files: Readonly<Record<string, string>>,
  options: LoadFixtureProjectOptions = {}
): Promise<LoadedProject> {
  return await loadTypeScriptProject({
    reader: createFakeSourceReader(files),
    roots: options.roots ?? [""],
    policy: options.policy ?? defaultIndexPolicy,
    limits: resolveIndexLimits(options.limits ?? {}),
    ...(options.tsconfigPath === undefined
      ? {}
      : { tsconfigPath: options.tsconfigPath }),
  })
}
