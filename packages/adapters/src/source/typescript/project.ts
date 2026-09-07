import { Project, ts, type SourceFile } from "ts-morph"

import {
  TypeScriptIndexerError,
  throwIfAborted,
  type IndexWarning,
} from "./errors.ts"
import { hashSourceText, compareStrings } from "./identity.ts"
import { IndexBudget, type TypeScriptIndexLimits } from "./limits.ts"
import {
  admitEntry,
  type IndexPolicy,
  type IndexableExtension,
} from "./policy.ts"
import {
  isWithinRoot,
  normalizeIndexPath,
  normalizeRootPrefix,
  type TypeScriptSourceReader,
} from "./reader.ts"

/**
 * Compiler options Sentinel honours from a target `tsconfig.json`. Anything
 * outside this list is ignored on purpose: `plugins`, `extends`, `references`,
 * and `types`/`typeRoots` would either execute target code or pull files in from
 * outside the checkout.
 */
export const honouredCompilerOptions = Object.freeze([
  "allowImportingTsExtensions",
  "allowJs",
  "baseUrl",
  "jsx",
  "jsxImportSource",
  "paths",
  "resolveJsonModule",
] as const)

export const ignoredCompilerOptions = Object.freeze([
  "extends",
  "plugins",
  "references",
  "typeRoots",
  "types",
] as const)

const TSCONFIG_BASENAME = "tsconfig.json"

/** In-memory root the repository tree is mounted under. */
const MOUNT = "/repo"

export function toMountedPath(repositoryPath: string): string {
  return `${MOUNT}/${repositoryPath}`
}

export function toRepositoryPath(mountedPath: string): string | undefined {
  const prefix = `${MOUNT}/`
  return mountedPath.startsWith(prefix)
    ? mountedPath.slice(prefix.length)
    : undefined
}

/**
 * Resolves a module specifier the way the compiler host would.
 *
 * Route `lazy()` bodies reach their component through a dynamic `import(...)`,
 * whose specifier is a plain string literal with no `ImportDeclaration` to hang
 * ts-morph's own resolution off, so the resolver is invoked directly.
 */
export function resolveModuleSpecifier(
  project: Project,
  fromRepositoryPath: string,
  specifier: string
): string | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    toMountedPath(fromRepositoryPath),
    project.getCompilerOptions(),
    project.getModuleResolutionHost()
  ).resolvedModule?.resolvedFileName
  return resolved === undefined ? undefined : toRepositoryPath(resolved)
}

export interface DetectedProjectConfig {
  /** Repository-relative path of the `tsconfig.json` that was honoured. */
  readonly tsconfigPath: string
  /** Repository-relative directory containing the honoured config. */
  readonly configDirectory: string
  /** Fields present in the target config that Sentinel deliberately ignored. */
  readonly ignoredFields: readonly string[]
  readonly jsx: "react-jsx" | "react" | "preserve" | "none"
  readonly baseUrl: string | undefined
  readonly pathAliases: readonly {
    readonly from: string
    readonly to: readonly string[]
  }[]
}

export interface LoadedSourceFile {
  readonly path: string
  readonly extension: IndexableExtension
  readonly language: "typescript" | "tsx"
  readonly sizeBytes: number
  readonly contentHash: ReturnType<typeof hashSourceText>
  readonly sourceFile: SourceFile
}

export interface LoadedProject {
  readonly project: Project
  readonly config: DetectedProjectConfig
  readonly files: readonly LoadedSourceFile[]
  readonly warnings: readonly IndexWarning[]
  readonly budget: IndexBudget
  dispose(): void
}

export interface LoadProjectRequest {
  readonly reader: TypeScriptSourceReader
  readonly roots: readonly string[]
  readonly policy: IndexPolicy
  readonly limits: TypeScriptIndexLimits
  /** Explicit repository-relative `tsconfig.json` to honour. */
  readonly tsconfigPath?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

function depthOf(path: string): number {
  return path.length === 0 ? 0 : path.split("/").length
}

/**
 * Parses `tsconfig.json` as text. `ts.parseConfigFileTextToJson` tolerates
 * comments and trailing commas without evaluating anything, which is why the
 * target's config is never `import`ed or `require`d.
 */
function parseConfigText(
  tsconfigPath: string,
  text: string
): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(tsconfigPath, text)
  if (parsed.error !== undefined || typeof parsed.config !== "object") {
    throw new TypeScriptIndexerError(
      "unsupported_project",
      `Could not parse ${tsconfigPath} as JSON`,
      { compatibility: true }
    )
  }
  return (parsed.config ?? {}) as Record<string, unknown>
}

function readJsxSetting(raw: unknown): DetectedProjectConfig["jsx"] {
  const value = typeof raw === "string" ? raw.toLowerCase() : ""
  if (value === "react-jsx" || value === "react-jsxdev") return "react-jsx"
  if (value === "react") return "react"
  if (value === "preserve" || value === "react-native") return "preserve"
  return "react-jsx"
}

function readPathAliases(
  raw: unknown
): readonly { readonly from: string; readonly to: readonly string[] }[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) &&
        entry[1].every((value) => typeof value === "string")
    )
    .map(([from, to]) => ({ from, to: [...to] }))
    .sort((left, right) => compareStrings(left.from, right.from))
}

function selectConfigPath(
  candidates: readonly string[],
  roots: readonly string[],
  explicit: string | undefined
): string {
  if (explicit !== undefined) {
    const normalized = normalizeIndexPath(explicit)
    if (!candidates.includes(normalized)) {
      throw new TypeScriptIndexerError(
        "project_not_found",
        `No readable ${TSCONFIG_BASENAME} at the requested path`
      )
    }
    return normalized
  }
  if (candidates.length === 0) {
    throw new TypeScriptIndexerError(
      "project_not_found",
      `No ${TSCONFIG_BASENAME} was found under the requested source roots`,
      { compatibility: true }
    )
  }
  const normalizedRoots = roots.map(normalizeRootPrefix)
  // Prefer the config whose directory is the deepest ancestor of a requested
  // root, then any config inside a root, then the shallowest overall.
  const ancestors = candidates.filter((candidate) =>
    normalizedRoots.some((root) => isWithinRoot(root, directoryOf(candidate)))
  )
  const descendants = candidates.filter((candidate) =>
    normalizedRoots.some((root) => isWithinRoot(candidate, root))
  )
  const pool =
    ancestors.length > 0
      ? [...ancestors].sort(
          (left, right) =>
            depthOf(directoryOf(right)) - depthOf(directoryOf(left)) ||
            compareStrings(left, right)
        )
      : descendants.length > 0
        ? [...descendants].sort(
            (left, right) =>
              depthOf(left) - depthOf(right) || compareStrings(left, right)
          )
        : [...candidates].sort(
            (left, right) =>
              depthOf(left) - depthOf(right) || compareStrings(left, right)
          )
  const selected = pool[0]
  if (selected === undefined) {
    throw new TypeScriptIndexerError(
      "project_not_found",
      `No ${TSCONFIG_BASENAME} was found under the requested source roots`,
      { compatibility: true }
    )
  }
  return selected
}

/**
 * Discovers the target's TypeScript project and loads admitted files into an
 * in-memory compiler host.
 *
 * Nothing from the repository is executed and nothing outside the admitted file
 * set is reachable: `useInMemoryFileSystem` means the compiler host contains
 * exactly the files this function put there.
 */
export async function loadTypeScriptProject(
  request: LoadProjectRequest
): Promise<LoadedProject> {
  const { limits, policy, reader, signal } = request
  const roots =
    request.roots.length === 0 ? [""] : request.roots.map(normalizeRootPrefix)
  const warnings: IndexWarning[] = []
  const budget = new IndexBudget(limits, request.now)

  throwIfAborted(signal)

  const configCandidates = reader
    .enumerate("")
    .filter(
      (entry) =>
        entry.kind === "file" &&
        (entry.path === TSCONFIG_BASENAME ||
          entry.path.endsWith(`/${TSCONFIG_BASENAME}`)) &&
        !entry.path
          .split("/")
          .some((segment) =>
            [...policy.vendorSegments, ...policy.buildSegments].includes(
              segment
            )
          )
    )
    .map((entry) => entry.path)
    .sort(compareStrings)

  const tsconfigPath = selectConfigPath(
    configCandidates,
    roots,
    request.tsconfigPath
  )
  const configDirectory = directoryOf(tsconfigPath)
  const configText = await reader.readText(tsconfigPath, limits.maxFileBytes)
  const rawConfig = parseConfigText(tsconfigPath, configText)
  const rawOptions =
    typeof rawConfig["compilerOptions"] === "object" &&
    rawConfig["compilerOptions"] !== null
      ? (rawConfig["compilerOptions"] as Record<string, unknown>)
      : {}

  const ignoredFields = [
    ...ignoredCompilerOptions.filter(
      (field) =>
        rawConfig[field] !== undefined || rawOptions[field] !== undefined
    ),
  ].sort(compareStrings)

  const baseUrlRaw = rawOptions["baseUrl"]
  const baseUrl = typeof baseUrlRaw === "string" ? baseUrlRaw : undefined
  const config: DetectedProjectConfig = {
    tsconfigPath,
    configDirectory,
    ignoredFields,
    jsx: readJsxSetting(rawOptions["jsx"]),
    baseUrl,
    pathAliases: readPathAliases(rawOptions["paths"]),
  }

  const mountedBaseUrl =
    baseUrl === undefined
      ? undefined
      : toMountedPath(
          [configDirectory, baseUrl === "." ? "" : baseUrl]
            .filter((segment) => segment.length > 0)
            .join("/")
        ).replace(/\/$/, "")

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    // ts-morph vendors its own lib files; the target's declared `lib` is
    // deliberately not honoured so extraction cannot vary with it. Structural
    // extraction never type-checks, so the lib files are not needed at all.
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: false,
      allowImportingTsExtensions: true,
      jsx:
        config.jsx === "react"
          ? ts.JsxEmit.React
          : config.jsx === "preserve"
            ? ts.JsxEmit.Preserve
            : ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      noLib: true,
      resolveJsonModule: rawOptions["resolveJsonModule"] === true,
      target: ts.ScriptTarget.ES2022,
      ...(mountedBaseUrl === undefined ? {} : { baseUrl: mountedBaseUrl }),
      ...(config.pathAliases.length === 0
        ? {}
        : {
            paths: Object.fromEntries(
              config.pathAliases.map(({ from, to }) => [from, [...to]])
            ),
          }),
      ...(typeof rawOptions["jsxImportSource"] === "string"
        ? { jsxImportSource: rawOptions["jsxImportSource"] }
        : {}),
    },
  })

  const dispose = (): void => {
    try {
      project.getLanguageService().compilerObject.dispose?.()
    } catch {
      // Disposal is best-effort cleanup; a failure here must not mask the
      // caller's own error.
    }
  }

  const files: LoadedSourceFile[] = []
  try {
    const seen = new Set<string>()
    const candidates = roots
      .flatMap((root) => reader.enumerate(root))
      .filter((entry) => {
        if (seen.has(entry.path)) return false
        seen.add(entry.path)
        return true
      })
      .sort((left, right) => compareStrings(left.path, right.path))

    for (const entry of candidates) {
      throwIfAborted(signal)
      const admission = admitEntry(entry, roots, policy, limits.maxFileBytes)
      if (!admission.admitted) {
        warnings.push({ reason: admission.reason, path: entry.path })
        continue
      }
      if (budget.filesExhausted) {
        warnings.push({ reason: "file_budget_exhausted", path: entry.path })
        continue
      }
      if (budget.timedOut) {
        warnings.push({ reason: "time_budget_exhausted", path: entry.path })
        continue
      }
      const text = await reader.readText(entry.path, limits.maxFileBytes)
      budget.countFile(entry.sizeBytes)
      if (budget.bytesExceeded) {
        throw new TypeScriptIndexerError(
          "limit_exceeded",
          "Admitted source files exceed the total byte budget",
          { compatibility: true }
        )
      }
      const sourceFile = project.createSourceFile(
        toMountedPath(entry.path),
        text,
        { overwrite: true }
      )
      files.push({
        path: entry.path,
        extension: admission.extension,
        language: admission.extension === ".tsx" ? "tsx" : "typescript",
        sizeBytes: entry.sizeBytes,
        contentHash: hashSourceText(text),
        sourceFile,
      })
    }
  } catch (error) {
    dispose()
    throw error
  }

  return {
    project,
    config,
    files: Object.freeze(files),
    warnings: Object.freeze(warnings),
    budget,
    dispose,
  }
}
