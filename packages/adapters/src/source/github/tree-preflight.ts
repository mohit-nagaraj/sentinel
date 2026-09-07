declare const verifiedTreePreflightBrand: unique symbol
const verifiedTreePreflights = new WeakSet<object>()

export interface TreePreflightShape {
  readonly treeObjectId: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly maxFileBytes: number
  readonly maxDepth: number
  readonly hasSubmodules: boolean
  readonly truncated: boolean
}

export type VerifiedTreePreflight = TreePreflightShape & {
  readonly [verifiedTreePreflightBrand]: never
}

export function markTreePreflight(
  value: TreePreflightShape
): VerifiedTreePreflight {
  verifiedTreePreflights.add(value)
  return Object.freeze(value) as VerifiedTreePreflight
}

export function isVerifiedTreePreflight(
  value: unknown
): value is VerifiedTreePreflight {
  return (
    typeof value === "object" &&
    value !== null &&
    verifiedTreePreflights.has(value)
  )
}
