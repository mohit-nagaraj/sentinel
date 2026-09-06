import { commitShaSchema, repositoryIdentitySchema } from "@sentinel/contracts"
import { z } from "zod"

import type { DatabaseExecutor } from "./database.ts"

export class WebhookDeliveryRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async record(input: {
    readonly deliveryId: string
    readonly applicationId: string
    readonly repository: {
      readonly host: string
      readonly owner: string
      readonly name: string
    }
    readonly eventName: string
    readonly action: string
    readonly headSha: string | null
  }): Promise<boolean> {
    const deliveryId = z.string().trim().min(1).max(255).parse(input.deliveryId)
    const applicationId = z.uuid().parse(input.applicationId)
    const repository = repositoryIdentitySchema.parse(input.repository)
    const eventName = z.string().trim().min(1).max(128).parse(input.eventName)
    const action = z.string().trim().min(1).max(128).parse(input.action)
    const headSha =
      input.headSha === null ? null : commitShaSchema.parse(input.headSha)
    const rows = await this.database.query<{ delivery_id: string }>(
      `insert into sentinel.github_webhook_deliveries (
         delivery_id, application_id, repository_host, repository_owner,
         repository_name, event_name, action, head_sha
       ) values ($1, $2::uuid, $3, $4, $5, $6, $7, $8)
       on conflict (delivery_id) do nothing
       returning delivery_id`,
      [
        deliveryId,
        applicationId,
        repository.host,
        repository.owner,
        repository.name,
        eventName,
        action,
        headSha,
      ]
    )
    return rows.length === 1
  }
}
