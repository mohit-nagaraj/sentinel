import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnvConfig } from "@next/env"
import type { NextConfig } from "next"

loadEnvConfig(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
)

function publicDevHostname(): string[] {
  const publicBaseUrl = process.env["SENTINEL_PUBLIC_BASE_URL"]?.trim()
  if (!publicBaseUrl) return []

  try {
    return [new URL(publicBaseUrl).hostname]
  } catch {
    return []
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: publicDevHostname(),
  devIndicators: false,
  distDir:
    process.env["SENTINEL_CONTROL_PLANE_FIXTURE"] === "1"
      ? ".next-fixture"
      : ".next",
  reactStrictMode: true,
  transpilePackages: ["@sentinel/contracts"],
}

export default nextConfig
