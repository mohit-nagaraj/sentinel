import { z } from "zod"

export interface ContractIssue {
  readonly code: string
  readonly message: string
  readonly path: string
}

export class ContractValidationError extends Error {
  readonly contract: string
  readonly issues: readonly ContractIssue[]

  constructor(contract: string, issues: readonly ContractIssue[]) {
    super(
      `Invalid ${contract}: ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`
    )
    this.name = "ContractValidationError"
    this.contract = contract
    this.issues = issues
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "$"
  }

  return path.reduce<string>((result, part) => {
    if (typeof part === "number") {
      return `${result}[${part}]`
    }

    return `${result}.${String(part)}`
  }, "$")
}

export function parseContract<T>(
  contract: string,
  schema: z.ZodType<T>,
  input: unknown
): T {
  const result = schema.safeParse(input)
  if (result.success) {
    return result.data
  }

  throw new ContractValidationError(
    contract,
    result.error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: formatPath(issue.path),
    }))
  )
}
