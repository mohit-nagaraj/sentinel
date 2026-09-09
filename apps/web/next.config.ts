import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnvConfig } from "@next/env"
import type { NextConfig } from "next"

loadEnvConfig(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
)

const nextConfig: NextConfig = {
  devIndicators: false,
  reactStrictMode: true,
  transpilePackages: ["@sentinel/contracts"],
}

export default nextConfig
