// @vitest-environment node

import {
  coveragePageSchema,
  knowledgeOverviewSchema,
  knowledgeReviewPageSchema,
  privateArtifactExcerptSchema,
} from "@sentinel/contracts"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  createKnowledgeFixtureService,
  KNOWLEDGE_FIXTURE_APPLICATION_ID,
} from "@/lib/knowledge-fixture"

import { handleKnowledgeRequest } from "./route"

const token = "knowledge-operator-token-that-is-long-enough"
const environment = {
  NODE_ENV: "test",
  SENTINEL_OPERATOR_TOKEN: token,
}

function request(
  path: string,
  init: RequestInit = {},
  authorized = true
): Request {
  return new Request(`http://sentinel.test/api/knowledge/${path}`, {
    ...init,
    headers: {
      ...(authorized ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
}

async function body(response: Response): Promise<unknown> {
  return response.json()
}

describe("knowledge API", () => {
  it("authorizes before calling a service and returns private no-store data", async () => {
    const service = createKnowledgeFixtureService()
    const overviewSpy = vi.spyOn(service, "overview")
    const rejected = await handleKnowledgeRequest(
      request(
        `applications/${KNOWLEDGE_FIXTURE_APPLICATION_ID}/overview`,
        {},
        false
      ),
      ["applications", KNOWLEDGE_FIXTURE_APPLICATION_ID, "overview"],
      service,
      environment
    )
    expect(rejected.status).toBe(401)
    expect(overviewSpy).not.toHaveBeenCalled()

    const accepted = await handleKnowledgeRequest(
      request(`applications/${KNOWLEDGE_FIXTURE_APPLICATION_ID}/overview`),
      ["applications", KNOWLEDGE_FIXTURE_APPLICATION_ID, "overview"],
      service,
      environment
    )
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get("cache-control")).toBe("private, no-store")
    expect(
      knowledgeOverviewSchema.parse(await body(accepted)).counts
    ).toMatchObject({ requirements: 6, pendingReviews: 2 })
  })

  it("validates and bounds coverage pagination", async () => {
    const service = createKnowledgeFixtureService()
    const path = ["applications", KNOWLEDGE_FIXTURE_APPLICATION_ID, "coverage"]
    const response = await handleKnowledgeRequest(
      request(
        `applications/${KNOWLEDGE_FIXTURE_APPLICATION_ID}/coverage?status=not_observed&query=ticket&limit=2`
      ),
      path,
      service,
      environment
    )
    const page = coveragePageSchema.parse(await body(response))
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.status).toBe("not_observed")

    const invalid = await handleKnowledgeRequest(
      request(
        `applications/${KNOWLEDGE_FIXTURE_APPLICATION_ID}/coverage?limit=51`
      ),
      path,
      service,
      environment
    )
    expect(invalid.status).toBe(400)
  })

  it("records link reviews once and invalidates a changed source identity", async () => {
    const service = createKnowledgeFixtureService()
    const reviewPath = [
      "applications",
      KNOWLEDGE_FIXTURE_APPLICATION_ID,
      "reviews",
    ]
    const list = await handleKnowledgeRequest(
      request(`applications/${KNOWLEDGE_FIXTURE_APPLICATION_ID}/reviews`),
      reviewPath,
      service,
      environment
    )
    const reviews = knowledgeReviewPageSchema.parse(await body(list))
    const candidate = reviews.items.find((item) => item.kind === "link")
    expect(candidate?.kind).toBe("link")
    if (candidate?.kind !== "link") throw new Error("missing fixture candidate")
    expect(candidate.previousReviews[0]?.stale).toBe(true)

    const decisionPath = [...reviewPath, "links", candidate.id]
    const decisionBody = {
      schemaVersion: 1,
      decision: "accepted",
      reason: "The runtime request corroborates the semantic mapping.",
      sourceIdentityHash: candidate.sourceIdentityHash,
    }
    const first = await handleKnowledgeRequest(
      request(decisionPath.join("/"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://sentinel.test",
        },
        body: JSON.stringify(decisionBody),
      }),
      decisionPath,
      service,
      environment
    )
    expect(first.status).toBe(201)
    const reviewedPath = await service.evidencePath(
      KNOWLEDGE_FIXTURE_APPLICATION_ID,
      candidate.from.id
    )
    expect(
      reviewedPath.links.find((link) => link.id === candidate.id)?.reviewState
    ).toBe("accepted")
    const duplicate = await handleKnowledgeRequest(
      request(decisionPath.join("/"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decisionBody),
      }),
      decisionPath,
      service,
      environment
    )
    expect(duplicate.status).toBe(200)

    const changed = await handleKnowledgeRequest(
      request(decisionPath.join("/"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...decisionBody,
          sourceIdentityHash: `sha256:${"0".repeat(64)}`,
        }),
      }),
      decisionPath,
      service,
      environment
    )
    expect(changed.status).toBe(409)
    expect(JSON.stringify(await body(changed))).toContain(
      "source_identity_changed"
    )
  })

  it("rejects cross-origin review mutations and resumes an owned interrupt once", async () => {
    const service = createKnowledgeFixtureService()
    const reviewPath = [
      "applications",
      KNOWLEDGE_FIXTURE_APPLICATION_ID,
      "reviews",
    ]
    const list = await handleKnowledgeRequest(
      request(reviewPath.join("/")),
      reviewPath,
      service,
      environment
    )
    const reviews = knowledgeReviewPageSchema.parse(await body(list))
    const interrupt = reviews.items.find((item) => item.kind === "interrupt")
    if (interrupt?.kind !== "interrupt")
      throw new Error("missing fixture interrupt")
    const decisionPath = [
      ...reviewPath,
      "interrupts",
      interrupt.runId,
      interrupt.decisionId,
    ]
    const decisionBody = {
      schemaVersion: 1,
      decision: "accepted",
      reason: "The observed state matches the documented checkpoint.",
    }
    const rejected = await handleKnowledgeRequest(
      request(decisionPath.join("/"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://attacker.example",
        },
        body: JSON.stringify(decisionBody),
      }),
      decisionPath,
      service,
      environment
    )
    expect(rejected.status).toBe(403)

    const first = await handleKnowledgeRequest(
      request(decisionPath.join("/"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decisionBody),
      }),
      decisionPath,
      service,
      environment
    )
    const duplicate = await handleKnowledgeRequest(
      request(decisionPath.join("/"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(decisionBody),
      }),
      decisionPath,
      service,
      environment
    )
    expect(first.status).toBe(202)
    expect(duplicate.status).toBe(200)
  })

  it("isolates applications and returns only a typed private excerpt", async () => {
    const service = createKnowledgeFixtureService()
    const reviews = await service.reviews(KNOWLEDGE_FIXTURE_APPLICATION_ID, {})
    const candidate = reviews.items.find((item) => item.kind === "link")
    if (candidate?.kind !== "link") throw new Error("missing candidate")
    const path = await service.evidencePath(
      KNOWLEDGE_FIXTURE_APPLICATION_ID,
      candidate.from.id
    )
    expect(
      path.links.find((link) => link.id === candidate.id)?.reviewState
    ).toBe("pending")
    const artifactId = path.nodes[0]?.artifactId
    if (artifactId === undefined) throw new Error("missing artifact")
    const excerptPath = [
      "applications",
      KNOWLEDGE_FIXTURE_APPLICATION_ID,
      "artifacts",
      artifactId,
      "excerpt",
    ]
    const response = await handleKnowledgeRequest(
      request(excerptPath.join("/")),
      excerptPath,
      service,
      environment
    )
    expect(
      privateArtifactExcerptSchema.parse(await body(response)).excerpt
    ).toContain("Completing an order")

    const foreignId = "99999999-9999-4999-8999-999999999999"
    const isolated = await handleKnowledgeRequest(
      request(`applications/${foreignId}/overview`),
      ["applications", foreignId, "overview"],
      service,
      environment
    )
    expect(isolated.status).toBe(404)
  })
})
