import { createWorker } from "./worker.ts"

const worker = createWorker({
  initialize: async () => Promise.resolve(),
})

const report = await worker.start()
process.stdout.write(`${JSON.stringify(report)}\n`)
