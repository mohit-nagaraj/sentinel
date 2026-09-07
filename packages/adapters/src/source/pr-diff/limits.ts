import { z } from "zod"

import { PrDiffError } from "./errors.ts"

export const prDiffLimitsSchema = z.strictObject({
  maxPatchBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1_024 * 1_024),
  maxFiles: z.number().int().positive().max(10_000),
  maxHunksPerFile: z.number().int().positive().max(10_000),
  maxChangedLines: z.number().int().positive().max(10_000_000),
  maxSymbols: z.number().int().positive().max(1_000_000),
  maxInterveningPaths: z.number().int().positive().max(100_000),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(10 * 60_000),
})

export type PrDiffLimits = z.infer<typeof prDiffLimitsSchema>

export const defaultPrDiffLimits: PrDiffLimits = Object.freeze({
  maxPatchBytes: 16 * 1_024 * 1_024,
  maxFiles: 2_000,
  maxHunksPerFile: 2_000,
  maxChangedLines: 250_000,
  maxSymbols: 100_000,
  maxInterveningPaths: 10_000,
  timeoutMs: 120_000,
})

export function resolvePrDiffLimits(
  input: Partial<PrDiffLimits> = {}
): PrDiffLimits {
  const result = prDiffLimitsSchema.safeParse({
    ...defaultPrDiffLimits,
    ...input,
  })
  if (!result.success) {
    throw new PrDiffError("invalid_input", "PR diff limits are invalid")
  }
  return Object.freeze(result.data)
}

export function prDiffLimit(message: string): never {
  throw new PrDiffError("limit_exceeded", message, { compatibility: true })
}
