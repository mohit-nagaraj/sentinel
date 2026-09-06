export interface HealthReport {
  readonly service: string
  readonly status: "ok"
}

export function createHealthReport(service: string): HealthReport {
  if (service.trim().length === 0) {
    throw new Error("Health report service must not be empty")
  }

  return Object.freeze({ service, status: "ok" })
}
