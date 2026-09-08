import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  entry: ["src/cli.ts", "src/health.ts"],
  format: ["esm"],
  noExternal: [
    "@sentinel/contracts",
    "@sentinel/orchestration",
    "@sentinel/storage",
  ],
  outDir: "dist",
  target: "node22",
})
