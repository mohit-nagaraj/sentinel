import { setTimeout as delay } from "node:timers/promises"

import { createHealthReport, type HealthReport } from "@sentinel/contracts"
import type { RunTerminalPublication } from "@sentinel/contracts"
import {
  classifyRunExecutionError,
  type DispatchableRun,
  type GraphExecutionResult,
  type ResumeDecision,
  type RunDispatcher,
} from "@sentinel/orchestration/run-dispatch"

import { logWorkerError, workerLog } from "./logger.ts"

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
  ): Promise<"active" | "pause_requested" | "cancelled" | "lease_lost">
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
    readonly publication?: RunTerminalPublication
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
class WorkerPauseRequestedError extends Error {
  override name = "PauseRequestedOrchestrationError"
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

function repositoryErrorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new WorkerShutdownError()
}

async function runCleanups(cleanups: readonly (() => Promise<void>)[]) {
  let failure: unknown
  for (const cleanup of [...cleanups].reverse()) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await cleanup()
        break
      } catch (error) {
        if (attempt === 3) failure ??= error
        else await delay(25)
      }
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
    if (isAborted(shutdownSignal)) return false
    const run = await options.store.claim(options.owner, leaseSeconds)
    if (run === null) return false
    const startedAt = Date.now()
    workerLog("info", "worker_run_claimed", {
      workerId: options.owner,
      runId: run.id,
      applicationId: run.applicationId,
      runType: run.runType,
      attempt: run.attemptCount,
    })
    if (isAborted(shutdownSignal)) return true

    const execution = new AbortController()
    const monitor = new AbortController()
    const cleanups: (() => Promise<void>)[] = []
    const shutdown = () => execution.abort(new WorkerShutdownError())
    shutdownSignal?.addEventListener("abort", shutdown, { once: true })
    if (isAborted(shutdownSignal)) shutdown()

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
        if (state === "pause_requested") {
          throw new WorkerPauseRequestedError()
        }
      },
      registerCleanup: (cleanup: () => Promise<void>) => cleanups.push(cleanup),
    }

    const monitorWork = (async () => {
      try {
        let heartbeatAt = Date.now() + heartbeatIntervalMs
        while (!monitor.signal.aborted) {
          await delay(monitorIntervalMs, undefined, { signal: monitor.signal })
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
      } catch {
        if (!monitor.signal.aborted) execution.abort(new WorkerLeaseLostError())
      }
    })()

    let result: GraphExecutionResult | undefined
    let failure: unknown
    let cleanupFailure: unknown
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
      try {
        await runCleanups(cleanups)
      } catch (error) {
        cleanupFailure = error
      }
      monitor.abort()
      await monitorWork
      shutdownSignal?.removeEventListener("abort", shutdown)
    }

    const cause = execution.signal.aborted
      ? abortError(execution.signal)
      : failure
    if (cleanupFailure !== undefined) {
      logWorkerError("worker_run_cleanup_failed", cleanupFailure, {
        workerId: options.owner,
        runId: run.id,
      })
      if (
        errorName(cause) === "LeaseOwnershipError" ||
        repositoryErrorCode(cause) === "storage_unavailable" ||
        repositoryErrorCode(cause) === "lease_lost"
      ) {
        options.onError?.(
          new Error("worker_cleanup_failed", { cause: cleanupFailure })
        )
        return true
      }
      await options.store.finish({
        runId: run.id,
        owner: options.owner,
        status: "failed",
        errorCategory: "storage",
        errorCode: "cleanup_failed",
        retryable: false,
      })
      return true
    }
    if (
      cause instanceof WorkerShutdownError ||
      errorName(cause) === "LeaseOwnershipError" ||
      repositoryErrorCode(cause) === "storage_unavailable" ||
      repositoryErrorCode(cause) === "lease_lost"
    ) {
      return true
    }
    if (errorName(cause) === "PauseRequestedOrchestrationError") {
      await options.store.recordInterrupt({
        runId: run.id,
        owner: options.owner,
        decisionId: "resume_run",
        prompt: "Run paused by operator",
      })
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
      options.onError?.(failure)
      const error = classifyRunExecutionError(failure)
      logWorkerError("worker_run_failed", failure, {
        workerId: options.owner,
        runId: run.id,
        applicationId: run.applicationId,
        runType: run.runType,
        durationMs: Date.now() - startedAt,
        category: error.category,
        code: error.code,
        retryable: error.retryable,
      })
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
    try {
      await options.store.finish({
        runId: run.id,
        owner: options.owner,
        status: "succeeded",
        publication: result!.publication,
      })
      workerLog("info", "worker_run_succeeded", {
        workerId: options.owner,
        runId: run.id,
        applicationId: run.applicationId,
        runType: run.runType,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      if (repositoryErrorCode(error) !== "publication_conflict") throw error
      await options.store.finish({
        runId: run.id,
        owner: options.owner,
        status: "failed",
        errorCategory: "configuration",
        errorCode: "publication_conflict",
        retryable: false,
      })
    }
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
