import {
  codeExplorerMissionSchema,
  codeExplorerToolNameSchema,
  findDefinitionInputSchema,
  findEndpointHandlerInputSchema,
  findFrontendCallersInputSchema,
  findReferencesInputSchema,
  finishCodeMissionInputSchema,
  inspectSymbolInputSchema,
  inspectTestsInputSchema,
  listRepositoryModulesInputSchema,
  searchCodeTextInputSchema,
  searchSymbolsInputSchema,
  submitCodeClaimInputSchema,
  traceCalleesInputSchema,
  traceCallersInputSchema,
  type CodeExplorerMission,
  type CodeExplorerToolName,
  type CodeToolObservation,
  type FinishCodeMissionInput,
  type SubmitCodeClaimInput,
} from "@sentinel/contracts"
import { z } from "zod"

import type { ModelToolDefinition } from "../model-gateway/contracts.ts"
import {
  CodeExplorerRepository,
  codeExplorerLanguages,
  type CodeLanguage,
  type CodeRepositoryLimits,
  type CodeRepositoryScope,
} from "./repository.ts"

type Language = CodeLanguage

export const codeExplorerLimitsSchema = z.strictObject({
  maxResultsPerTool: z.number().int().positive().max(100),
  maxTraversalHopsPerTool: z.number().int().positive().max(10),
  maxSourceLinesPerTool: z.number().int().positive().max(500),
  maxSourceCharactersPerTool: z.number().int().positive().max(32_768),
})

export type CodeExplorerLimits = z.infer<typeof codeExplorerLimitsSchema>

export const defaultCodeExplorerLimits: Readonly<CodeExplorerLimits> =
  Object.freeze({
    maxResultsPerTool: 25,
    maxTraversalHopsPerTool: 3,
    maxSourceLinesPerTool: 120,
    maxSourceCharactersPerTool: 16_384,
  })

export type CodeExplorerToolErrorCode =
  | "cancelled"
  | "invalid_arguments"
  | "result_limit_exceeded"
  | "scope_denied"
  | "tool_not_allowed"

export class CodeExplorerToolError extends Error {
  constructor(readonly code: CodeExplorerToolErrorCode) {
    super(`Code Explorer tool request rejected: ${code}`)
    this.name = "CodeExplorerToolError"
  }
}

export type CodeExplorerToolExecution =
  | {
      readonly kind: "observation"
      readonly observation: CodeToolObservation
    }
  | {
      readonly kind: "claim"
      readonly input: SubmitCodeClaimInput
    }
  | {
      readonly kind: "finish"
      readonly input: FinishCodeMissionInput
    }

const toolDefinitions: readonly ModelToolDefinition[] = Object.freeze([
  {
    name: "list_repository_modules",
    description:
      "List bounded indexed repository modules. Use it to orient architecture without reading source files.",
    parameters: listRepositoryModulesInputSchema,
  },
  {
    name: "search_symbols",
    description:
      "Find lexical symbol candidates by name under optional path and language filters. Search results are not claim evidence until structurally inspected.",
    parameters: searchSymbolsInputSchema,
  },
  {
    name: "search_code_text",
    description:
      "Search admitted indexed source text and return bounded line snippets. Matches in comments or strings are lexical only.",
    parameters: searchCodeTextInputSchema,
  },
  {
    name: "inspect_symbol",
    description:
      "Inspect one admitted symbol using bounded source slices and its indexed structural edges.",
    parameters: inspectSymbolInputSchema,
  },
  {
    name: "find_definition",
    description:
      "Find exact qualified-name definitions in the admitted language and repository scope.",
    parameters: findDefinitionInputSchema,
  },
  {
    name: "find_references",
    description:
      "Return bounded indexed references touching one admitted symbol, including explicit unresolved targets.",
    parameters: findReferencesInputSchema,
  },
  {
    name: "trace_callers",
    description:
      "Traverse callers of one admitted symbol using structural call edges under strict hop and result limits.",
    parameters: traceCallersInputSchema,
  },
  {
    name: "trace_callees",
    description:
      "Traverse callees of one admitted symbol using structural call edges under strict hop and result limits.",
    parameters: traceCalleesInputSchema,
  },
  {
    name: "find_endpoint_handler",
    description:
      "Resolve an exact normalized HTTP method and path to Laravel and OpenAPI endpoint evidence and handler candidates.",
    parameters: findEndpointHandlerInputSchema,
  },
  {
    name: "find_frontend_callers",
    description:
      "Resolve an exact normalized endpoint to structural TypeScript API client and reachable frontend component candidates.",
    parameters: findFrontendCallersInputSchema,
  },
  {
    name: "inspect_tests",
    description:
      "Return focused admitted tests related to a symbol, endpoint, or text. Test evidence is corroboration only and never runtime proof.",
    parameters: inspectTestsInputSchema,
  },
  {
    name: "submit_code_claim",
    description:
      "Propose one implementation relationship using evidence IDs returned by prior tools. The runtime rejects lexical-only or test-only support.",
    parameters: submitCodeClaimInputSchema,
  },
  {
    name: "finish_code_mission",
    description:
      "Finish or abstain with typed claim IDs, connected paths, unresolved boundaries, exclusions, follow-up missions, and a stop reason.",
    parameters: finishCodeMissionInputSchema,
  },
])

function parseArguments<Output>(
  schema: z.ZodType<Output>,
  input: unknown
): Output {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new CodeExplorerToolError("invalid_arguments")
  return parsed.data
}

function pathWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

export class CodeExplorerTools {
  readonly definitions: readonly ModelToolDefinition[]
  readonly scope: CodeRepositoryScope
  readonly limits: CodeExplorerLimits
  private readonly allowedTools: ReadonlySet<CodeExplorerToolName>

  constructor(
    private readonly repository: CodeExplorerRepository,
    missionInput: CodeExplorerMission,
    limitsInput: CodeExplorerLimits = defaultCodeExplorerLimits
  ) {
    const mission = codeExplorerMissionSchema.parse(missionInput)
    this.limits = codeExplorerLimitsSchema.parse(limitsInput)
    this.allowedTools = new Set(
      mission.scope.allowedTools.map((tool) =>
        codeExplorerToolNameSchema.parse(tool)
      )
    )
    this.scope = Object.freeze({
      repositoryPaths: Object.freeze([...mission.scope.repositoryPaths]),
      languages: Object.freeze([
        ...(mission.scope.languages ?? codeExplorerLanguages),
      ]),
    })
    this.definitions = Object.freeze(
      toolDefinitions.filter(({ name }) =>
        this.allowedTools.has(codeExplorerToolNameSchema.parse(name))
      )
    )
  }

  private repositoryLimits(
    override: Partial<CodeExplorerLimits>
  ): CodeRepositoryLimits {
    const bounded = (configured: number, requested: number | undefined) =>
      Math.max(1, Math.min(configured, requested ?? configured))
    return {
      maxResults: bounded(
        this.limits.maxResultsPerTool,
        override.maxResultsPerTool
      ),
      maxHops: bounded(
        this.limits.maxTraversalHopsPerTool,
        override.maxTraversalHopsPerTool
      ),
      maxSourceLines: bounded(
        this.limits.maxSourceLinesPerTool,
        override.maxSourceLinesPerTool
      ),
      maxSourceCharacters: bounded(
        this.limits.maxSourceCharactersPerTool,
        override.maxSourceCharactersPerTool
      ),
    }
  }

  private assertAllowed(name: CodeExplorerToolName): void {
    if (!this.allowedTools.has(name)) {
      throw new CodeExplorerToolError("tool_not_allowed")
    }
  }

  private assertFilters(input: {
    readonly pathPrefix?: string | undefined
    readonly languages?: readonly Language[] | undefined
  }): void {
    if (
      input.pathPrefix !== undefined &&
      !this.scope.repositoryPaths.some((prefix) =>
        pathWithin(input.pathPrefix!, prefix)
      )
    ) {
      throw new CodeExplorerToolError("scope_denied")
    }
    if (
      input.languages?.some(
        (language) => !this.scope.languages.includes(language)
      ) === true
    ) {
      throw new CodeExplorerToolError("scope_denied")
    }
  }

  private assertSymbol(
    symbolId: Parameters<CodeExplorerRepository["isSymbolInScope"]>[0]
  ): void {
    if (!this.repository.isSymbolInScope(symbolId, this.scope)) {
      throw new CodeExplorerToolError("scope_denied")
    }
  }

  private checked(
    observation: CodeToolObservation,
    limits: CodeRepositoryLimits
  ): CodeExplorerToolExecution {
    if (
      observation.metrics.resultItems > limits.maxResults * 20 ||
      observation.metrics.traversalHops > limits.maxHops ||
      observation.metrics.sourceLines > limits.maxSourceLines ||
      observation.metrics.contentBytes > limits.maxSourceCharacters
    ) {
      throw new CodeExplorerToolError("result_limit_exceeded")
    }
    return { kind: "observation", observation }
  }

  async execute(
    nameInput: string,
    argumentsInput: unknown,
    limitOverride: Partial<CodeExplorerLimits> = {},
    signal?: AbortSignal
  ): Promise<CodeExplorerToolExecution> {
    if (signal?.aborted) throw new CodeExplorerToolError("cancelled")
    let name: CodeExplorerToolName
    try {
      name = codeExplorerToolNameSchema.parse(nameInput)
    } catch {
      throw new CodeExplorerToolError("tool_not_allowed")
    }
    this.assertAllowed(name)
    const limits = this.repositoryLimits(limitOverride)
    const execution = await (async (): Promise<CodeExplorerToolExecution> => {
      switch (name) {
        case "list_repository_modules": {
          const input = parseArguments(
            listRepositoryModulesInputSchema,
            argumentsInput
          )
          this.assertFilters(input)
          return this.checked(
            this.repository.listModules(this.scope, input, limits),
            limits
          )
        }
        case "search_symbols": {
          const input = parseArguments(searchSymbolsInputSchema, argumentsInput)
          this.assertFilters(input)
          return this.checked(
            this.repository.searchSymbols(this.scope, input, limits),
            limits
          )
        }
        case "search_code_text": {
          const input = parseArguments(
            searchCodeTextInputSchema,
            argumentsInput
          )
          this.assertFilters(input)
          return this.checked(
            await this.repository.searchText(this.scope, input, limits),
            limits
          )
        }
        case "inspect_symbol": {
          const input = parseArguments(inspectSymbolInputSchema, argumentsInput)
          this.assertSymbol(input.symbolId)
          return this.checked(
            await this.repository.inspectSymbol(
              this.scope,
              input.symbolId,
              limits
            ),
            limits
          )
        }
        case "find_definition": {
          const input = parseArguments(
            findDefinitionInputSchema,
            argumentsInput
          )
          this.assertFilters(input)
          return this.checked(
            this.repository.findDefinition(this.scope, input, limits),
            limits
          )
        }
        case "find_references": {
          const input = parseArguments(
            findReferencesInputSchema,
            argumentsInput
          )
          this.assertSymbol(input.symbolId)
          return this.checked(
            this.repository.findReferences(
              this.scope,
              input.symbolId,
              input.limit,
              limits
            ),
            limits
          )
        }
        case "trace_callers": {
          const input = parseArguments(traceCallersInputSchema, argumentsInput)
          this.assertSymbol(input.symbolId)
          return this.checked(
            this.repository.trace("callers", this.scope, input, limits),
            limits
          )
        }
        case "trace_callees": {
          const input = parseArguments(traceCalleesInputSchema, argumentsInput)
          this.assertSymbol(input.symbolId)
          return this.checked(
            this.repository.trace("callees", this.scope, input, limits),
            limits
          )
        }
        case "find_endpoint_handler": {
          const input = parseArguments(
            findEndpointHandlerInputSchema,
            argumentsInput
          )
          return this.checked(
            this.repository.findEndpointHandler(this.scope, input, limits),
            limits
          )
        }
        case "find_frontend_callers": {
          const input = parseArguments(
            findFrontendCallersInputSchema,
            argumentsInput
          )
          return this.checked(
            this.repository.findFrontendCallers(this.scope, input, limits),
            limits
          )
        }
        case "inspect_tests": {
          const input = parseArguments(inspectTestsInputSchema, argumentsInput)
          if (input.targetKind === "symbol") this.assertSymbol(input.symbolId)
          return this.checked(
            await this.repository.inspectTests(this.scope, input, limits),
            limits
          )
        }
        case "submit_code_claim":
          return {
            kind: "claim",
            input: parseArguments(submitCodeClaimInputSchema, argumentsInput),
          }
        case "finish_code_mission":
          return {
            kind: "finish",
            input: parseArguments(finishCodeMissionInputSchema, argumentsInput),
          }
      }
    })()
    if (signal?.aborted) throw new CodeExplorerToolError("cancelled")
    return execution
  }
}

export function getCodeExplorerToolDefinitions(): readonly ModelToolDefinition[] {
  return toolDefinitions
}
