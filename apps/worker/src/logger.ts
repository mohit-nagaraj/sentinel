type LogLevel = "debug" | "info" | "warn" | "error"

type LogFields = Readonly<Record<string, unknown>>

function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { errorType: typeof error }
  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined
  return {
    errorName: error.name,
    errorMessage: error.message,
    ...(code === undefined ? {} : { errorCode: code }),
    ...(error.stack === undefined ? {} : { errorStack: error.stack }),
  }
}

export function workerLog(
  level: LogLevel,
  event: string,
  fields: LogFields = {}
): void {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  })
  const output =
    level === "error" || level === "warn" ? process.stderr : process.stdout
  output.write(`${record}\n`)
}

export function logWorkerError(
  event: string,
  error: unknown,
  fields: LogFields = {}
): void {
  workerLog("error", event, { ...fields, ...errorFields(error) })
}
