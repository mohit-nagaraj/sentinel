import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export const phpFixtureFiles = [
  "app/Actions/CreateOrderAction.php",
  "app/Attributes/Transactional.php",
  "app/Contracts/CreatesOrders.php",
  "app/Domain/Route.php",
  "app/Handlers/CreateOrderHandler.php",
  "app/Models/Order.php",
  "app/Repositories/OrderRepository.php",
  "app/Repeated/Namespaces.php",
  "app/Requests/CreateOrderRequest.php",
  "app/Resources/OrderResource.php",
  "app/Services/OrderService.php",
  "app/Support/functions.php",
  "app/Traits/AuditsOrders.php",
  "inert-bootstrap.php",
  "malformed.php",
  "routes/api.php",
] as const

export async function phpFixtureHashes(
  rootPath: string,
  files: readonly string[] = phpFixtureFiles
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  for (const path of files) {
    const content = await readFile(join(rootPath, ...path.split("/")))
    hashes[path] =
      `sha256:${createHash("sha256").update(content).digest("hex")}`
  }
  return hashes
}
