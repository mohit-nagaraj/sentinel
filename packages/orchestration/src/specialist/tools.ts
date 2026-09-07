import {
  contentHashSchema,
  executionBudgetSchema,
  missionIdSchema,
  reasonCodeSchema,
  type DiscoveryMission,
  type MissionBudget,
} from "@sentinel/contracts"
import { createHash } from "node:crypto"
import { z } from "zod"

import {
  EMPTY_BUDGET_USAGE,
  assertSafeSpecialistValue,
  compactObservationSchema,
  compactToolArgumentsSchema,
  completedToolCallSchema,
  parseSpecialistState,
  pendingToolCallSchema,
  specialistAgentSchema,
  specialistCallIdSchema,
  specialistDecisionSchema,
  validateSpecialistUpdate,
  type CompactObservation,
  type CompactToolValue,
  type CompletedToolCall,
  type PendingToolCall,
  type SpecialistDecision,
  type SpecialistStateUpdate,
  type SpecialistStateValue,
} from "./state.ts"

type SpecialistAgent = z.infer<typeof specialistAgentSchema>

const specialistToolOutputBaseSchema = compactObservationSchema.pick({
  outcome: true,
  summary: true,
  evidenceIds: true,
  references: true,
})

export const specialistToolOutputSchema = specialistToolOutputBaseSchema.extend(
  {
    usage: executionBudgetSchema,
  }
)

export const specialistToolRequestSchema = z.strictObject({
  callId: specialistCallIdSchema,
  decisionId: specialistCallIdSchema,
  missionId: missionIdSchema,
  agent: specialistAgentSchema,
  toolName: reasonCodeSchema,
  arguments: compactToolArgumentsSchema,
})

export type SpecialistToolArguments = Readonly<Record<string, CompactToolValue>>
export type SpecialistToolOutput = z.infer<typeof specialistToolOutputSchema>
export type SpecialistToolRequest = z.infer<typeof specialistToolRequestSchema>

export interface SpecialistToolContext {
  readonly state: SpecialistStateValue
  readonly mission: DiscoveryMission
  readonly callId: string
  readonly decisionId: string
  readonly requestHash: string
  readonly signal: AbortSignal
}

interface SpecialistToolDefinitionConfig<
  TArgumentsSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
> {
  readonly name: string
  readonly agents: readonly SpecialistAgent[]
  readonly modes: readonly DiscoveryMission["mode"][]
  readonly argumentsSchema: TArgumentsSchema
  readonly outputSchema: TOutputSchema
  readonly validateScope: (
    arguments_: z.output<TArgumentsSchema>,
    context: SpecialistToolContext
  ) => boolean | string | void
  readonly estimate: (
    arguments_: z.output<TArgumentsSchema>,
    context: SpecialistToolContext
  ) => Partial<MissionBudget>
  readonly execute: (
    arguments_: z.output<TArgumentsSchema>,
    context: SpecialistToolContext
  ) => Promise<z.input<TOutputSchema>> | z.input<TOutputSchema>
}

export interface SpecialistToolDefinition {
  readonly name: string
  readonly agents: readonly SpecialistAgent[]
  readonly modes: readonly DiscoveryMission["mode"][]
  readonly argumentsSchema: z.ZodType
  readonly outputSchema: z.ZodType
  parseArguments(input: unknown): SpecialistToolArguments
  validateScope(
    arguments_: SpecialistToolArguments,
    context: SpecialistToolContext
  ): boolean | string | void
  estimate(
    arguments_: SpecialistToolArguments,
    context: SpecialistToolContext
  ): Partial<MissionBudget>
  execute(
    arguments_: SpecialistToolArguments,
    context: SpecialistToolContext
  ): Promise<unknown>
  parseOutput(input: unknown): SpecialistToolOutput
}

export type SpecialistToolDenialCode =
  | "agent_denied"
  | "budget_denied"
  | "duplicate_call"
  | "mission_denied"
  | "mode_denied"
  | "output_denied"
  | "schema_denied"
  | "scope_denied"
  | "state_denied"
  | "tool_denied"

export class SpecialistToolDeniedError extends Error {
  constructor(
    readonly code: SpecialistToolDenialCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "SpecialistToolDeniedError"
  }
}

export interface SpecialistToolExecutionIdentity {
  readonly missionId: string
  readonly callId: string
  readonly requestHash: string
}

export type CoordinatedSpecialistToolExecution =
  | { readonly kind: "returned"; readonly value: unknown }
  | { readonly kind: "threw" }

// Implementations may bind this port to the run lease or another durable
// idempotency ledger. The default only coordinates one registry lifetime.
export interface SpecialistToolExecutionCoordinator {
  executeOnce(
    identity: SpecialistToolExecutionIdentity,
    execute: () => Promise<unknown>
  ): Promise<CoordinatedSpecialistToolExecution>
}

export class InMemorySpecialistToolExecutionCoordinator implements SpecialistToolExecutionCoordinator {
  readonly #executions = new Map<
    string,
    {
      readonly requestHash: string
      readonly result: Promise<CoordinatedSpecialistToolExecution>
    }
  >()

  executeOnce(
    identity: SpecialistToolExecutionIdentity,
    execute: () => Promise<unknown>
  ): Promise<CoordinatedSpecialistToolExecution> {
    const key = canonicalStringify([identity.missionId, identity.callId])
    const existing = this.#executions.get(key)
    if (existing !== undefined) {
      if (existing.requestHash !== identity.requestHash) {
        deny(
          "duplicate_call",
          `Tool call ${identity.callId} conflicts with an in-flight or completed execution`
        )
      }
      return existing.result
    }

    const result = (async (): Promise<CoordinatedSpecialistToolExecution> => {
      try {
        return { kind: "returned", value: await execute() }
      } catch {
        return { kind: "threw" }
      }
    })()
    this.#executions.set(key, { requestHash: identity.requestHash, result })
    return result
  }
}

export class SpecialistToolRegistry {
  readonly #tools: ReadonlyMap<string, SpecialistToolDefinition>
  readonly #executionCoordinator: SpecialistToolExecutionCoordinator

  constructor(
    definitions: readonly SpecialistToolDefinition[],
    executionCoordinator: SpecialistToolExecutionCoordinator = new InMemorySpecialistToolExecutionCoordinator()
  ) {
    const tools = new Map<string, SpecialistToolDefinition>()
    for (const candidate of definitions) {
      const name = reasonCodeSchema.parse(candidate.name)
      if (tools.has(name)) {
        deny("tool_denied", `Duplicate specialist tool definition ${name}`)
      }
      if (candidate.agents.length === 0 || candidate.modes.length === 0) {
        deny(
          "tool_denied",
          `Specialist tool ${name} requires fixed agent and mode permissions`
        )
      }
      const agents = Object.freeze(
        [
          ...new Set(
            candidate.agents.map((agent) => specialistAgentSchema.parse(agent))
          ),
        ].sort(compareStrings)
      )
      const modes = Object.freeze(
        [...new Set(candidate.modes)].sort(compareStrings)
      )
      tools.set(
        name,
        Object.freeze({
          ...candidate,
          name,
          agents,
          modes,
        })
      )
    }
    this.#tools = tools
    this.#executionCoordinator = executionCoordinator
  }

  get(name: string): SpecialistToolDefinition | undefined {
    return this.#tools.get(name)
  }

  names(): readonly string[] {
    return Object.freeze([...this.#tools.keys()].sort(compareStrings))
  }

  executeOnce(
    identity: SpecialistToolExecutionIdentity,
    execute: () => Promise<unknown>
  ): Promise<CoordinatedSpecialistToolExecution> {
    return this.#executionCoordinator.executeOnce(identity, execute)
  }
}

export function defineSpecialistTool<
  TArgumentsSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  config: SpecialistToolDefinitionConfig<TArgumentsSchema, TOutputSchema>
): SpecialistToolDefinition {
  return {
    name: config.name,
    agents: config.agents,
    modes: config.modes,
    argumentsSchema: config.argumentsSchema,
    outputSchema: config.outputSchema,
    parseArguments(input) {
      const parsed = parseExactSchema(
        config.argumentsSchema,
        input,
        "Tool arguments"
      )
      return parseCompactArguments(parsed)
    },
    validateScope(arguments_, context) {
      return config.validateScope(
        config.argumentsSchema.parse(arguments_),
        context
      )
    },
    estimate(arguments_, context) {
      return config.estimate(config.argumentsSchema.parse(arguments_), context)
    },
    async execute(arguments_, context) {
      return await config.execute(
        config.argumentsSchema.parse(arguments_),
        context
      )
    },
    parseOutput(input) {
      const common = parseExactSchema(
        specialistToolOutputSchema,
        input,
        "Tool output"
      )
      const parsed = parseExactSchema(
        config.outputSchema,
        common,
        "Tool output"
      )
      assertSafeSpecialistValue(parsed)
      return specialistToolOutputSchema.parse(parsed)
    },
  }
}

export type SpecialistToolAuthorization =
  | {
      readonly kind: "authorized"
      readonly pendingCall: PendingToolCall
      readonly requestHash: string
    }
  | {
      readonly kind: "pending"
      readonly pendingCall: PendingToolCall
      readonly requestHash: string
    }
  | {
      readonly kind: "completed"
      readonly completedCall: CompletedToolCall
      readonly observation: CompactObservation
      readonly requestHash: string
    }

export interface AuthorizeSpecialistToolCallInput {
  readonly registry: SpecialistToolRegistry
  readonly state: SpecialistStateValue
  readonly decision: SpecialistDecision
  readonly request: SpecialistToolRequest
  readonly signal?: AbortSignal
}

export function authorizeSpecialistToolCall({
  registry,
  state: stateInput,
  decision: decisionInput,
  request: requestInput,
  signal,
}: AuthorizeSpecialistToolCallInput): SpecialistToolAuthorization {
  const state = parseSpecialistState(stateInput)
  const decision = specialistDecisionSchema.parse(decisionInput)
  const requestResult = specialistToolRequestSchema.safeParse(requestInput)
  if (!requestResult.success) {
    deny("schema_denied", "Specialist tool request schema is invalid", {
      cause: requestResult.error,
    })
  }
  const request = requestResult.data
  assertRequestIdentity(state, decision, request)
  const definition = registry.get(request.toolName)
  if (definition === undefined) {
    deny("tool_denied", `Specialist tool ${request.toolName} is not registered`)
  }
  assertToolPermission(definition, state)

  let arguments_: SpecialistToolArguments
  try {
    arguments_ = definition.parseArguments(request.arguments)
  } catch (error) {
    deny("schema_denied", "Specialist tool arguments are invalid", {
      cause: error,
    })
  }

  const requestHash = hashSpecialistToolRequest({
    ...request,
    arguments: arguments_,
  })
  const context: SpecialistToolContext = {
    state,
    mission: state.mission,
    callId: request.callId,
    decisionId: request.decisionId,
    requestHash,
    signal: signal ?? new AbortController().signal,
  }
  assertScope(definition, arguments_, context)

  const preflightUsage = estimateUsage(definition, arguments_, context)
  const matchingDecision = state.decisions.find(
    (candidate) => candidate.decisionId === decision.decisionId
  )
  if (
    matchingDecision !== undefined &&
    canonicalStringify(matchingDecision) !== canonicalStringify(decision)
  ) {
    deny(
      "duplicate_call",
      `Decision ${decision.decisionId} conflicts with state`
    )
  }
  const owner = state.decisions.find(
    (candidate) =>
      candidate.kind === "tool_calls" &&
      candidate.callIds.includes(request.callId)
  )
  if (owner !== undefined && owner.decisionId !== request.decisionId) {
    deny(
      "duplicate_call",
      `Tool call ${request.callId} belongs to another decision`
    )
  }

  const completed = state.completedCalls.find(
    (call) => call.callId === request.callId
  )
  if (completed !== undefined) {
    assertStoredCallMatches(completed, request, requestHash, preflightUsage)
    const observation = state.observations.find(
      (candidate) => candidate.callId === completed.callId
    )
    if (observation === undefined) {
      deny("state_denied", "Completed tool call has no durable observation")
    }
    return {
      kind: "completed",
      completedCall: completed,
      observation,
      requestHash,
    }
  }

  const pending = state.pendingToolCalls.find(
    (call) => call.callId === request.callId
  )
  if (pending !== undefined) {
    assertStoredCallMatches(pending, request, requestHash, preflightUsage)
    return { kind: "pending", pendingCall: pending, requestHash }
  }

  assertActiveState(state)
  assertBudgetWithin(
    preflightUsage,
    remainingBudget(state, request.callId),
    "Tool preflight estimate exceeds the remaining mission budget"
  )
  return {
    kind: "authorized",
    requestHash,
    pendingCall: pendingToolCallSchema.parse({
      callId: request.callId,
      decisionId: request.decisionId,
      missionId: request.missionId,
      agent: request.agent,
      toolName: request.toolName,
      requestHash,
      arguments: arguments_,
      preflightUsage,
    }),
  }
}

export type SpecialistToolExecution =
  | {
      readonly kind: "executed"
      readonly observation: CompactObservation
      readonly completedCall: CompletedToolCall
      readonly update: SpecialistStateUpdate
    }
  | {
      readonly kind: "replayed"
      readonly observation: CompactObservation
      readonly completedCall: CompletedToolCall
    }

export interface ExecuteSpecialistToolCallInput {
  readonly registry: SpecialistToolRegistry
  readonly state: SpecialistStateValue
  readonly call: PendingToolCall
  readonly signal?: AbortSignal
}

export async function executeSpecialistToolCall({
  registry,
  state: stateInput,
  call: callInput,
  signal,
}: ExecuteSpecialistToolCallInput): Promise<SpecialistToolExecution> {
  const state = parseSpecialistState(stateInput)
  const call = pendingToolCallSchema.parse(callInput)
  assertCallIdentity(state, call)

  const completed = state.completedCalls.find(
    (candidate) => candidate.callId === call.callId
  )
  if (completed !== undefined) {
    assertStoredCallMatches(
      completed,
      call,
      call.requestHash,
      call.preflightUsage
    )
    const observation = state.observations.find(
      (candidate) => candidate.callId === call.callId
    )
    if (observation === undefined) {
      deny("state_denied", "Completed tool call has no durable observation")
    }
    return { kind: "replayed", observation, completedCall: completed }
  }

  assertActiveState(state)
  const durableCall = state.pendingToolCalls.find(
    (candidate) => candidate.callId === call.callId
  )
  if (durableCall === undefined) {
    deny("state_denied", `Tool call ${call.callId} is not pending in state`)
  }
  if (canonicalStringify(durableCall) !== canonicalStringify(call)) {
    deny("duplicate_call", `Tool call ${call.callId} conflicts with state`)
  }
  const definition = registry.get(call.toolName)
  if (definition === undefined) {
    deny("tool_denied", `Specialist tool ${call.toolName} is not registered`)
  }
  assertToolPermission(definition, state)
  const arguments_ = definition.parseArguments(call.arguments)
  const context: SpecialistToolContext = {
    state,
    mission: state.mission,
    callId: call.callId,
    decisionId: call.decisionId,
    requestHash: call.requestHash,
    signal: signal ?? new AbortController().signal,
  }
  assertScope(definition, arguments_, context)
  const estimate = estimateUsage(definition, arguments_, context)
  if (
    canonicalStringify(estimate) !== canonicalStringify(call.preflightUsage)
  ) {
    deny(
      "duplicate_call",
      "Tool preflight estimate changed after authorization"
    )
  }
  const remaining = remainingBudget(state, call.callId)
  assertBudgetWithin(
    call.preflightUsage,
    remaining,
    "Authorized tool estimate no longer fits the remaining mission budget"
  )

  const failedExecution = settlePendingSpecialistToolCall(state, call)
  const coordinated = await registry.executeOnce(
    {
      missionId: call.missionId,
      callId: call.callId,
      requestHash: call.requestHash,
    },
    () => definition.execute(arguments_, context)
  )
  if (coordinated.kind === "threw") {
    return failedExecution
  }

  try {
    const result = definition.parseOutput(coordinated.value)
    if (result.usage.toolCalls !== 1) {
      deny(
        "budget_denied",
        "Actual tool usage must contain exactly one tool call"
      )
    }
    assertBudgetWithin(
      result.usage,
      call.preflightUsage,
      "Actual tool usage exceeds its preflight estimate"
    )
    assertBudgetWithin(
      result.usage,
      remaining,
      "Actual tool usage exceeds the remaining mission budget"
    )
    return buildSpecialistToolExecution(state, call, result)
  } catch {
    return failedExecution
  }
}

export function settlePendingSpecialistToolCall(
  stateInput: SpecialistStateValue,
  callInput: PendingToolCall
): Extract<SpecialistToolExecution, { kind: "executed" }> {
  const state = parseSpecialistState(stateInput)
  const call = pendingToolCallSchema.parse(callInput)
  assertCallIdentity(state, call)
  const durableCall = state.pendingToolCalls.find(
    (candidate) => candidate.callId === call.callId
  )
  if (durableCall === undefined) {
    deny("state_denied", `Tool call ${call.callId} is not pending in state`)
  }
  if (canonicalStringify(durableCall) !== canonicalStringify(call)) {
    deny("duplicate_call", `Tool call ${call.callId} conflicts with state`)
  }
  return buildSpecialistToolExecution(
    state,
    call,
    specialistToolOutputSchema.parse({
      outcome: "failed",
      summary:
        "Tool execution failed after authorization; side-effect status is uncertain.",
      evidenceIds: [],
      references: [],
      usage: call.preflightUsage,
    })
  )
}

function buildSpecialistToolExecution(
  state: SpecialistStateValue,
  call: PendingToolCall,
  result: SpecialistToolOutput
): Extract<SpecialistToolExecution, { kind: "executed" }> {
  const resultHash = hashCanonicalValue(result)
  const observation = compactObservationSchema.parse({
    callId: call.callId,
    decisionId: call.decisionId,
    missionId: call.missionId,
    agent: call.agent,
    toolName: call.toolName,
    requestHash: call.requestHash,
    resultHash,
    outcome: result.outcome,
    summary: result.summary,
    evidenceIds: result.evidenceIds,
    references: result.references,
  })
  const completedCall = completedToolCallSchema.parse({
    callId: call.callId,
    decisionId: call.decisionId,
    missionId: call.missionId,
    agent: call.agent,
    toolName: call.toolName,
    requestHash: call.requestHash,
    resultHash,
    outcome: result.outcome,
    preflightUsage: call.preflightUsage,
    usage: result.usage,
  })
  const update = validateSpecialistUpdate(state, {
    pendingToolCalls: { upsert: [], removeCallIds: [call.callId] },
    observations: observation,
    completedCalls: completedCall,
    budgetLedger: {
      kind: "tool_call",
      decisionId: call.decisionId,
      callId: call.callId,
      missionId: call.missionId,
      agent: call.agent,
      usage: result.usage,
    },
  })
  return { kind: "executed", observation, completedCall, update }
}

export function hashSpecialistToolRequest(
  requestInput: SpecialistToolRequest
): string {
  const request = specialistToolRequestSchema.parse(requestInput)
  return hashCanonicalValue(request)
}

export function getRemainingSpecialistBudget(
  stateInput: SpecialistStateValue
): MissionBudget {
  return remainingBudget(parseSpecialistState(stateInput))
}

function assertRequestIdentity(
  state: SpecialistStateValue,
  decision: SpecialistDecision,
  request: SpecialistToolRequest
): void {
  if (
    request.missionId !== state.mission.id ||
    request.agent !== state.agent ||
    decision.missionId !== state.mission.id ||
    decision.agent !== state.agent
  ) {
    deny("mission_denied", "Tool request crosses specialist mission identity")
  }
  if (
    decision.kind !== "tool_calls" ||
    decision.decisionId !== request.decisionId ||
    !decision.callIds.includes(request.callId)
  ) {
    deny("state_denied", "Tool request is not correlated with its decision")
  }
}

function assertCallIdentity(
  state: SpecialistStateValue,
  call: PendingToolCall
): void {
  if (call.missionId !== state.mission.id) {
    deny("mission_denied", "Tool call crosses specialist mission identity")
  }
  if (call.agent !== state.agent) {
    deny("agent_denied", "Tool call crosses specialist agent identity")
  }
}

function assertActiveState(state: SpecialistStateValue): void {
  if (state.terminalResult !== null) {
    deny("state_denied", "A terminal specialist mission cannot start a tool")
  }
  if (state.humanInterrupt?.status === "pending") {
    deny(
      "state_denied",
      "A specialist mission awaiting human input cannot start a tool"
    )
  }
}

function assertToolPermission(
  definition: SpecialistToolDefinition,
  state: SpecialistStateValue
): void {
  if (!definition.agents.includes(state.agent)) {
    deny(
      "agent_denied",
      `Tool ${definition.name} is not allowed for ${state.agent}`
    )
  }
  if (!definition.modes.includes(state.mission.mode)) {
    deny(
      "mode_denied",
      `Tool ${definition.name} is not allowed in ${state.mission.mode} mode`
    )
  }
  if (!state.mission.scope.allowedTools.includes(definition.name)) {
    deny(
      "tool_denied",
      `Mission does not allow specialist tool ${definition.name}`
    )
  }
}

function assertScope(
  definition: SpecialistToolDefinition,
  arguments_: SpecialistToolArguments,
  context: SpecialistToolContext
): void {
  let result: boolean | string | void
  try {
    result = definition.validateScope(arguments_, context)
  } catch (error) {
    deny("scope_denied", "Specialist tool scope validation failed", {
      cause: error,
    })
  }
  if (result === false || typeof result === "string") {
    deny(
      "scope_denied",
      typeof result === "string"
        ? result
        : "Specialist tool request is out of scope"
    )
  }
}

function estimateUsage(
  definition: SpecialistToolDefinition,
  arguments_: SpecialistToolArguments,
  context: SpecialistToolContext
): MissionBudget {
  let estimate: Partial<MissionBudget>
  try {
    estimate = definition.estimate(arguments_, context)
  } catch (error) {
    deny("budget_denied", "Specialist tool budget estimation failed", {
      cause: error,
    })
  }
  const result = executionBudgetSchema.safeParse({
    ...EMPTY_BUDGET_USAGE,
    ...estimate,
  })
  if (!result.success || result.data.toolCalls !== 1) {
    deny(
      "budget_denied",
      "Specialist tool estimate must be a valid budget with exactly one tool call",
      { cause: result.success ? undefined : result.error }
    )
  }
  return result.data
}

function remainingBudget(
  state: SpecialistStateValue,
  excludedPendingCallId?: string
): MissionBudget {
  const reservations = state.pendingToolCalls
    .filter((call) => call.callId !== excludedPendingCallId)
    .reduce<MissionBudget>(addBudget, EMPTY_BUDGET_USAGE)
  return executionBudgetSchema.parse(
    Object.fromEntries(
      budgetKeys.map((key) => {
        const remaining =
          state.mission.budget[key] -
          state.budgetLedger.total[key] -
          reservations[key]
        if (remaining < 0) {
          deny("budget_denied", `Specialist budget ${key} is overcommitted`)
        }
        return [key, remaining]
      })
    )
  )
}

function addBudget(
  current: MissionBudget,
  call: PendingToolCall
): MissionBudget {
  return executionBudgetSchema.parse(
    Object.fromEntries(
      budgetKeys.map((key) => [key, current[key] + call.preflightUsage[key]])
    )
  )
}

function assertBudgetWithin(
  usage: MissionBudget,
  ceiling: MissionBudget,
  message: string
): void {
  const exceeded = budgetKeys.find((key) => usage[key] > ceiling[key])
  if (exceeded !== undefined) {
    deny("budget_denied", `${message}: ${exceeded}`)
  }
}

function assertStoredCallMatches(
  stored: PendingToolCall | CompletedToolCall,
  request: Pick<
    SpecialistToolRequest | PendingToolCall,
    "callId" | "decisionId" | "missionId" | "agent" | "toolName"
  >,
  requestHash: string,
  preflightUsage: MissionBudget
): void {
  if (
    stored.callId !== request.callId ||
    stored.decisionId !== request.decisionId ||
    stored.missionId !== request.missionId ||
    stored.agent !== request.agent ||
    stored.toolName !== request.toolName ||
    stored.requestHash !== requestHash ||
    ("preflightUsage" in stored &&
      stored.preflightUsage !== undefined &&
      canonicalStringify(stored.preflightUsage) !==
        canonicalStringify(preflightUsage))
  ) {
    deny(
      "duplicate_call",
      `Tool call ${request.callId} conflicts with durable state`
    )
  }
}

function parseCompactArguments(input: unknown): SpecialistToolArguments {
  const parsed = compactToolArgumentsSchema.parse(input)
  if (canonicalStringify(parsed) !== canonicalStringify(input)) {
    deny(
      "schema_denied",
      "Tool argument schema cannot strip or transform fields"
    )
  }
  return parsed
}

function parseExactSchema<T>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string
): T {
  const parsed = schema.parse(input)
  if (canonicalStringify(parsed) !== canonicalStringify(input)) {
    throw new Error(`${label} schema cannot strip or transform fields`)
  }
  return parsed
}

function hashCanonicalValue(value: unknown): string {
  return contentHashSchema.parse(
    `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`
  )
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(
        ([key, child]) => `${JSON.stringify(key)}:${canonicalStringify(child)}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

const budgetKeys = Object.keys(EMPTY_BUDGET_USAGE) as (keyof MissionBudget)[]

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function deny(
  code: SpecialistToolDenialCode,
  message: string,
  options?: ErrorOptions
): never {
  throw new SpecialistToolDeniedError(code, message, options)
}
