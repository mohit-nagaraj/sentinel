import { readFileSync } from "node:fs"

import {
  assertModelSafeValue,
  canonicalizeDocumentationUrl,
  classifyBrowserAction,
  createBrowserPolicy,
  DocumentationUrlPolicy,
  parseHtmlDocument,
  verifyGithubWebhookSignature,
  type ActionClassificationInput,
} from "@sentinel/adapters"
import { repositoryPathSchema } from "@sentinel/contracts"
import { defineSpecialistTool } from "@sentinel/orchestration"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const corpusSchema = z.strictObject({
  documentationUrls: z.array(z.string()).min(1),
  repositoryPaths: z.array(z.string()).min(1),
  html: z.string().min(1),
  forbiddenSanitizedFragments: z.array(z.string()).min(1),
  toolArguments: z.array(z.record(z.string(), z.string())).min(1),
  modelValues: z.array(z.record(z.string(), z.unknown())).min(1),
  browserActions: z
    .array(
      z.strictObject({
        kind: z.enum(["click", "navigate"]),
        name: z.string(),
        targetUrl: z.string().optional(),
        submit: z.boolean().optional(),
      })
    )
    .min(1),
})

const corpus = corpusSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../fixtures/security/malicious-inputs.json", import.meta.url),
      "utf8"
    )
  )
)

describe("malicious input boundary matrix", () => {
  it("keeps prompt injection as inert evidence while stripping active DOM content", () => {
    const parsed = parseHtmlDocument(
      corpus.html,
      "https://docs.example.test/guide/attribution"
    )

    expect(parsed.sanitizedText).toContain("Ignore previous instructions")
    for (const fragment of corpus.forbiddenSanitizedFragments) {
      expect(parsed.sanitizedText.toLowerCase()).not.toContain(
        fragment.toLowerCase()
      )
      expect(parsed.links.join(" ").toLowerCase()).not.toContain(
        fragment.toLowerCase()
      )
    }
  })

  it("rejects SSRF, credential, traversal, and non-HTTP documentation URLs", () => {
    for (const url of corpus.documentationUrls) {
      let canonical: string
      try {
        canonical = canonicalizeDocumentationUrl(url)
      } catch {
        continue
      }
      const policy = new DocumentationUrlPolicy({
        roots: [canonical],
        allowHttp: true,
      })
      expect(() => policy.assertNetworkTarget(canonical), url).toThrow()
    }
  })

  it("rejects absolute, drive-qualified, parent, and backslash source paths", () => {
    for (const path of corpus.repositoryPaths) {
      expect(repositoryPathSchema.safeParse(path).success, path).toBe(false)
    }
  })

  it("rejects secret-bearing model structures before provider calls", () => {
    for (const value of corpus.modelValues) {
      expect(() => assertModelSafeValue(value)).toThrow(
        /Model gateway request failed/
      )
    }
  })

  it("cannot smuggle URLs, selectors, graph edges, or out-of-scope IDs through strict tools", () => {
    const tool = defineSpecialistTool({
      name: "read_symbol",
      description: "Read one symbol fixed by the mission scope.",
      agents: ["code"],
      modes: ["implementation_trace"],
      argumentsSchema: z.strictObject({
        symbolId: z.literal("symbol:approved"),
      }),
      outputSchema: z.unknown(),
      validateScope: ({ symbolId }) => symbolId === "symbol:approved",
      estimate: () => ({ toolCalls: 1 }),
      execute: () => ({}),
    })

    expect(tool.parseArguments({ symbolId: "symbol:approved" })).toEqual({
      symbolId: "symbol:approved",
    })
    for (const arguments_ of corpus.toolArguments) {
      expect(() => tool.parseArguments(arguments_)).toThrow()
    }
  })

  it("blocks destructive, payment, messaging, cross-host, and unknown submissions", () => {
    const policy = createBrowserPolicy({
      allowedOrigins: ["https://app.example.test"],
    })
    for (const action of corpus.browserActions) {
      const classification = classifyBrowserAction(
        action satisfies ActionClassificationInput,
        policy
      )
      expect(classification.allowed, action.name).toBe(false)
      expect(classification.replaySafe, action.name).toBe(false)
    }
  })

  it("authenticates exact webhook bytes and rejects tampering", () => {
    const secret = "It's a Secret to Everybody"
    const body = new TextEncoder().encode("Hello, World!")
    const signature =
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"

    expect(verifyGithubWebhookSignature(body, signature, secret)).toBe(true)
    expect(
      verifyGithubWebhookSignature(
        new TextEncoder().encode("Hello, World?"),
        signature,
        secret
      )
    ).toBe(false)
  })
})
