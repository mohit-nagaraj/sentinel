const verifiedTreePreflight = Symbol("sentinel.verified-tree-preflight")

export interface TreePreflightShape {
  readonly treeObjectId: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly maxFileBytes: number
  readonly maxDepth: number
  readonly hasSubmodules: boolean
  readonly truncated: boolean
}

type VerifiedTreePreflight = TreePreflightShape & {
  readonly [verifiedTreePreflight]: true
}

export function markTreePreflight(
  value: TreePreflightShape
): VerifiedTreePreflight {
  Object.defineProperty(value, verifiedTreePreflight, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  })
  return Object.freeze(value) as VerifiedTreePreflight
}

export function isVerifiedTreePreflight(
  value: unknown
): value is VerifiedTreePreflight {
  return (
    typeof value === "object" &&
    value !== null &&
    verifiedTreePreflight in value &&
    (value as { readonly [verifiedTreePreflight]?: unknown })[
      verifiedTreePreflight
    ] === true
  )
}
