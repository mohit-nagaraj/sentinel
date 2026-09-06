import { createHealthReport, type HealthReport } from "@sentinel/contracts"

export interface WorkerAdapter {
  initialize(): Promise<void>
}

export interface WorkerProcess {
  health(): HealthReport
  start(): Promise<HealthReport>
}

export function createWorker(adapter: WorkerAdapter): WorkerProcess {
  return {
    health: () => createHealthReport("worker"),
    start: async () => {
      await adapter.initialize()
      return createHealthReport("worker")
    },
  }
}
