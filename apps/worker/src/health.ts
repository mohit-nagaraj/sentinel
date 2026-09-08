import { createHealthReport } from "@sentinel/contracts"

const report = createHealthReport("worker")
process.stdout.write(`${JSON.stringify(report)}\n`)
