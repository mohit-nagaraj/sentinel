import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTypeScript from "eslint-config-next/typescript"

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    settings: {
      next: { rootDir: "apps/web/" },
      react: { version: "19.2" },
    },
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["docs/**/*.{ts,tsx}"],
    rules: {
      "import/no-anonymous-default-export": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  globalIgnores([
    "**/.next/**",
    "**/coverage/**",
    "**/dist/**",
    "**/node_modules/**",
    "**/out/**",
    "**/_pagefind/**",
    ".playwright-cli/**",
    ".tmp-shadcn/**",
    ".claude/**",
    ".tasks/**",
    ".ystack/**",
    "output/**",
    "apps/web/next-env.d.ts",
    "docs/next-env.d.ts",
  ]),
])
