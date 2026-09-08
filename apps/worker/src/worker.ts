import { setTimeout as delay } from "node:timers/promises"

import { createHealthReport, type HealthReport } from "@sentinel/contracts"
import {
  classifyRunExecutionError,
  type DispatchableRun,
  type GraphExecutionResult,
  type ResumeDecision,
  type RunDispatcher,
} from "@sentinel/orchestration/run-dispatch"

export interface WorkerRunStore {
  claim(owner: string, leaseSeconds: number): Promise<DispatchableRun | null>
  heartbeat(
    runId: string,
    owner: string,
    leaseSeconds: number
  ): Promise<boolean>
  controlState(
    runId: string,
    owner: string
  ): Promise<"active" | "cancelled" | "lease_lost">
  getResumeDecision(
    runId: string,
    owner: string
  ): Promise<ResumeDecision | null>
  recordInterrupt(input: {
    readonly runId: string
    readonly owner: string
    readonly decisionId: string
    readonly prompt: string
  }): Promise<unknown>
  finish(input: {
    readonly runId: string
    readonly owner: string
    readonly status: "succeeded" | "failed" | "cancelled"
    readonly errorCategory?: string
    readonly errorCode?: string
    readonly retryable?: boolean
  }): Promise<boolean>
}

export interface WorkerOptions {
  readonly owner: string
  readonly store: WorkerRunStore
  readonly dispatcher: RunDispatcher
  readonly leaseSeconds?: number
  readonly heartbeatIntervalMs?: number
  readonly monitorIntervalMs?: number
  readonly pollIntervalMs?: number
  readonly onError?: (error: unknown) => void
}

export interface WorkerProcess {
  health(): HealthReport
  runOnce(shutdownSignal?: AbortSignal): Promise<boolean>
  run(shutdownSignal?: AbortSignal): Promise<void>
}

class WorkerCancelledError extends Error {
  override name = "CancelledOrchestrationError"
}
class WorkerLeaseLostError extends Error {
  override name = "LeaseOwnershipError"
}
class WorkerShutdownError extends Error {
  override name = "WorkerShutdownError"
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ""
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new WorkerShutdownError()
}

async function runCleanups(cleanups: readonly (() => Promise<void>)[]) {
  let failure: unknown
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup()
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) throw failure
}

export function createWorker(options: WorkerOptions): WorkerProcess {
  const leaseSeconds = options.leaseSeconds ?? 60
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? Math.max(1_000, (leaseSeconds * 1_000) / 3)
  const monitorIntervalMs = options.monitorIntervalMs ?? 1_000
  const pollIntervalMs = options.pollIntervalMs ?? 1_000
  if (leaseSeconds < 5 || leaseSeconds > 3_600) {
    throw new RangeError("Worker lease must be between 5 and 3600 seconds")
  }
  if (
    heartbeatIntervalMs < 1 ||
    heartbeatIntervalMs >= leaseSeconds * 1_000 ||
    monitorIntervalMs < 1 ||
    pollIntervalMs < 1
  ) {
    throw new RangeError("Worker intervals must be positive")
  }

  const runOnce = async (shutdownSignal?: AbortSignal): Promise<boolean> => {
    if (shutdownSignal?.aborted === true) return false
    const run = await options.store.claim(options.owner, leaseSeconds)
    if (run === null) return false

    const execution = new AbortController()
    const monitor = new AbortController()
    const cleanups: (() => Promise<void>)[] = []
    const shutdown = () => execution.abort(new WorkerShutdownError())
    shutdownSignal?.addEventListener("abort", shutdown, { once: true })

    const context = {
      signal: execution.signal,
      assertActive: async () => {
        if (execution.signal.aborted) throw abortError(execution.signal)
        const state = await options.store.controlState(run.id, options.owner)
        if (state === "lease_lost") {
          execution.abort(new WorkerLeaseLostError())
          throw abortError(execution.signal)
        }
        if (state === "cancelled") {
          execution.abort(new WorkerCancelledError())
          throw abortError(execution.signal)
        }
      },
      registerCleanup: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
    }

    const monitorWork = (async () => {
      let heartbeatAt = Date.now() + heartbeatIntervalMs
      while (!monitor.signal.aborted && !execution.signal.aborted) {
        try {
          await delay(monitorIntervalMs, undefined, { signal: monitor.signal })
        } catch {
          return
        }
        if (Date.now() >= heartbeatAt) {
          const renewed = await options.store.heartbeat(
            run.id,
            options.owner,
            leaseSeconds
          )
          if (!renewed) {
            execution.abort(new WorkerLeaseLostError())
            return
          }
          heartbeatAt = Date.now() + heartbeatIntervalMs
        }
        const state = await options.store.controlState(run.id, options.owner)
        if (state === "lease_lost") {
          execution.abort(new WorkerLeaseLostError())
          return
        }
        if (state === "cancelled") {
          execution.abort(new WorkerCancelledError())
          return
        }
      }
    })()

    let result: GraphExecutionResult | undefined
    let failure: unknown
    try {
      await context.assertActive()
      const decision = await options.store.getResumeDecision(
        run.id,
        options.owner
      )
      result = await options.dispatcher.execute(run, decision, context)
    } catch (error) {
      failure = error
    } finally {
      monitor.abort()
      await monitorWork.catch((error: unknown) => {
        failure ??= error
      })
      shutdownSignal?.removeEventListener("abort", shutdown)
      try {
        await runCleanups(cleanups)
      } catch (error) {
        failure ??= error
      }
    }

    const cause = execution.signal.aborted
      ? abortError(execution.signal)
      : failure
    if (
      cause instanceof WorkerShutdownError ||
      errorName(cause) === "LeaseOwnershipError"
    ) {
      return true
    }
    if (
      errorName(cause) === "CancelledOrchestrationError" ||
      result?.status === "cancelled"
    ) {
      await options.store.finish({
        runId: run.id,
        owner: options.owner,
        status: "cancelled",
      })
      return true
    }
    if (failure !== undefined) {
      const error = classifyRunExecutionError(failure)
      await options.store.finish({
        runId: run.id,
        owner: options.owner,
        status: "failed",
        errorCategory: error.category,
        errorCode: error.code,
        retryable: error.retryable,
      })
      return true
    }
    if (result?.status === "interrupted") {
      await options.store.recordInterrupt({
        runId: run.id,
        owner: options.owner,
        decisionId: result.decisionId,
        prompt: result.prompt,
      })
      return true
    }
    await options.store.finish({
      runId: run.id,
      owner: options.owner,
      status: "succeeded",
    })
    return true
  }

  return {
    health: () => createHealthReport("worker"),
    runOnce,
    run: async (shutdownSignal) => {
      while (shutdownSignal?.aborted !== true) {
        try {
          const worked = await runOnce(shutdownSignal)
          if (!worked) {
            await delay(pollIntervalMs, undefined, {
              ...(shutdownSignal === undefined
                ? {}
                : { signal: shutdownSignal }),
            })
          }
        } catch (error) {
          if (isAborted(shutdownSignal)) return
          options.onError?.(error)
          await delay(pollIntervalMs)
        }
      }
    },
  }
}
