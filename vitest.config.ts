import react from "@vitejs/plugin-react"
import tsconfigPaths from "vite-tsconfig-paths"
import { defineConfig } from "vitest/config"

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  plugins: [react(), tsconfigPaths()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/**/*.test.{ts,tsx}"],
          setupFiles: ["./tests/setup/web.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "worker",
          environment: "node",
          include: ["apps/worker/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "graph",
          environment: "node",
          include: ["tests/graph/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "agent",
          environment: "node",
          include: ["tests/agent/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "security",
          environment: "node",
          include: ["tests/security/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "live",
          environment: "node",
          include: ["tests/live/**/*.test.ts"],
          setupFiles: ["./tests/setup/live.ts"],
        },
      },
    ],
  },
})
