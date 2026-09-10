import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  entry: ["src/cli.ts", "src/graphs.ts", "src/health.ts"],
  format: ["esm"],
  noExternal: [
    "@sentinel/adapters",
    "@sentinel/contracts",
    "@sentinel/orchestration",
    "@sentinel/storage",
  ],
  outDir: "dist",
  target: "node22",
})
