import { readFile, writeFile } from "node:fs/promises"

import {
  renderSampleReportMarkdown,
  sampleReportSchema,
} from "./sample-report.ts"

const source = new URL(
  "../../docs/delivery/sample-report-hi-events-pr-1338.json",
  import.meta.url
)
const output = new URL(
  "../../docs/delivery/sample-report-hi-events-pr-1338.md",
  import.meta.url
)
const report = sampleReportSchema.parse(
  JSON.parse(await readFile(source, "utf8"))
)
await writeFile(output, renderSampleReportMarkdown(report), "utf8")
