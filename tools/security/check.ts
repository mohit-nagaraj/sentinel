import {
  checkSensitiveIgnores,
  checkTrackedSecrets,
  findDependencyViolations,
  findLicenseViolations,
  loadSecurityPolicy,
  readPnpmJson,
} from "./policy.ts"

const root = process.cwd()
const policy = loadSecurityPolicy(root)
const today = new Date().toISOString().slice(0, 10)
const command = process.argv[2]

if (command === "secrets") {
  checkSensitiveIgnores(root)
  const result = checkTrackedSecrets(root, policy, today)
  console.log(
    `Secret and ignored-file policy passed (${result.scannedFiles} text files, ${result.exceptions} exact test exceptions).`
  )
} else if (command === "dependencies") {
  const violations = findDependencyViolations(
    readPnpmJson(root, ["audit", "--prod", "--json"]),
    policy,
    today
  )
  if (violations.length > 0) {
    throw new Error(
      `Unapproved dependency advisories:\n${violations.join("\n")}`
    )
  }
  console.log(
    `Dependency policy passed (${policy.dependencyExceptions.length} bounded exception).`
  )
} else if (command === "licenses") {
  const violations = findLicenseViolations(
    readPnpmJson(root, ["licenses", "list", "--prod", "--json"]),
    policy,
    today
  )
  if (violations.length > 0) {
    throw new Error(`Unapproved production licenses:\n${violations.join("\n")}`)
  }
  console.log(
    `License policy passed (${policy.licenseExceptions.length} exact metadata exceptions).`
  )
} else {
  throw new Error("Expected one of: secrets, dependencies, licenses")
}
