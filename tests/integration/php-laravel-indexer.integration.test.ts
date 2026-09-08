import { createHash } from "node:crypto"
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  PhpCodeIndex,
  PhpIndexerError,
  PhpLaravelIndexer,
  phpIndexerResponseSchema,
  phpSourceIdentitySchema,
  type CheckoutSnapshot,
  type PhpIndexerResponse,
  type PhpSymbol,
} from "@sentinel/adapters"
import { createStableKey } from "@sentinel/contracts"

import golden from "../fixtures/php-laravel/golden-expectations.json" with { type: "json" }
import { phpFixtureFiles, phpFixtureHashes } from "../fixtures/php-indexer.ts"

const fixtureRoot = resolve("tests/fixtures/php-laravel")
const markerPath = join(fixtureRoot, "executed-marker")
const fixtureSource = phpSourceIdentitySchema.parse({
  applicationId: `application:v1:${"a".repeat(64)}`,
  repository: {
    host: "github.com",
    owner: "sentinel-tests",
    name: "php-fixture",
  },
  commitSha: "b".repeat(40),
})

function symbol(
  response: PhpIndexerResponse,
  qualifiedName: string
): PhpSymbol {
  const found = response.files
    .flatMap((file) => file.symbols)
    .find((candidate) => candidate.qualifiedName === qualifiedName)
  if (found === undefined)
    throw new Error(`Missing fixture symbol ${qualifiedName}`)
  return found
}

describe("PHP and Laravel structural indexer", () => {
  let response: PhpIndexerResponse
  let expectedHashes: Record<string, string>
  const indexer = new PhpLaravelIndexer()

  beforeAll(async () => {
    await rm(markerPath, { force: true })
    expectedHashes = await phpFixtureHashes(fixtureRoot)
    response = await indexer.index({
      source: fixtureSource,
      rootPath: fixtureRoot,
      files: phpFixtureFiles,
      expectedContentHashes: expectedHashes,
    })
  })

  afterAll(async () => {
    await rm(markerPath, { force: true })
  })

  it("validates deterministic output against golden expectations", async () => {
    expect(() => phpIndexerResponseSchema.parse(response)).not.toThrow()
    expect(response.schemaVersion).toBe(golden.schemaVersion)
    expect(`${response.parser.name}@${response.parser.version}`).toBe(
      golden.parser
    )
    const route = response.files
      .flatMap((file) => file.routes)
      .find((candidate) => candidate.path === golden.route.path)
    expect(route).toMatchObject({
      methods: golden.route.methods,
      path: golden.route.path,
      action: { resolvedName: golden.route.action, dynamic: false },
      dynamic: false,
    })
    expect(
      response.files
        .flatMap((file) => file.routes)
        .find((candidate) => candidate.path === "/legacy/orders/{order}")
    ).toMatchObject({
      methods: ["PUT"],
      action: { resolvedName: golden.route.action, dynamic: false },
    })
    expect(Object.isFrozen(response)).toBe(true)
    expect(Object.isFrozen(response.files[0]?.symbols)).toBe(true)
    expect(
      response.files
        .flatMap((file) => file.routes)
        .some((candidate) => candidate.path === "/not-a-laravel-route")
    ).toBe(false)
    const explicitMissing = response.files
      .flatMap((file) => file.routes)
      .find((candidate) => candidate.path === "/explicit-missing")
    expect(explicitMissing?.action).toMatchObject({
      resolvedName: golden.route.action,
      method: "missing",
      dynamic: false,
    })
    expect(explicitMissing?.action.targetSymbolId).toBeUndefined()
    expect(
      response.files
        .flatMap((file) => file.routes)
        .find((candidate) => candidate.path === "/invalid-constant")?.action
    ).toMatchObject({ dynamic: true })
    const dynamicRoutes = response.files
      .flatMap((file) => file.routes)
      .filter((candidate) => candidate.path === null)
    expect(dynamicRoutes.length).toBeGreaterThanOrEqual(2)
    expect(dynamicRoutes.every((candidate) => candidate.dynamic)).toBe(true)
    expect(
      response.files
        .flatMap((file) => file.routes)
        .find((candidate) => candidate.path === "/computed-methods")
    ).toMatchObject({ methods: ["ANY"], dynamic: true })
    expect(
      response.files
        .flatMap((file) => file.routes)
        .find((candidate) => candidate.path === "/mixed-methods")
    ).toMatchObject({ methods: ["GET"], dynamic: true })
    const repeatedFile = response.files.find(
      (file) => file.path === "app/Repeated/Namespaces.php"
    )
    expect(
      repeatedFile?.symbols.filter(
        (candidate) => candidate.kind === "namespace"
      )
    ).toHaveLength(2)
    expect(
      repeatedFile?.symbols.filter((candidate) => candidate.kind === "import")
    ).toHaveLength(2)
    expect(
      repeatedFile?.symbols.filter((candidate) => candidate.kind === "class")
    ).toHaveLength(3)
    const repeatedNamespace = repeatedFile?.symbols.find(
      (candidate) =>
        candidate.kind === "namespace" &&
        candidate.qualifiedName === "Fixture\\Repeated"
    )
    expect(repeatedNamespace?.declarationRanges).toHaveLength(2)
    expect(
      new PhpCodeIndex(response).findSmallestEnclosingSymbol(
        "app/Repeated/Namespaces.php",
        27
      )?.id
    ).toBe(repeatedNamespace?.id)
    for (const qualifiedName of golden.symbols) {
      expect(symbol(response, qualifiedName)).toBeDefined()
    }
    const repeated = await indexer.index({
      source: fixtureSource,
      rootPath: fixtureRoot,
      files: [...phpFixtureFiles].reverse(),
      expectedContentHashes: expectedHashes,
    })
    expect(repeated).toEqual(response)
    const otherCommit = phpSourceIdentitySchema.parse({
      ...fixtureSource,
      commitSha: "c".repeat(40),
    })
    const reScoped = await indexer.index({
      source: otherCommit,
      rootPath: fixtureRoot,
      files: phpFixtureFiles,
      expectedContentHashes: expectedHashes,
    })
    expect(reScoped.source).toEqual(otherCommit)
    expect(reScoped.files[0]?.symbols[0]?.id).not.toBe(
      response.files[0]?.symbols[0]?.id
    )
  })

  it("traces route to action, handler, service, repository, and model", () => {
    const symbols = response.files.flatMap((file) => file.symbols)
    const relationships = response.files.flatMap((file) => file.relationships)
    const route = response.files
      .flatMap((file) => file.routes)
      .find((candidate) => candidate.path === "/api/v1/events/{event}/orders")
    const actionInvoke = symbol(
      response,
      "Fixture\\Actions\\CreateOrderAction::__invoke"
    )
    expect(actionInvoke.id).toBe(
      createStableKey({
        kind: "code-symbol",
        applicationId: fixtureSource.applicationId,
        repository: fixtureSource.repository,
        commitSha: fixtureSource.commitSha,
        filePath: "app/Actions/CreateOrderAction.php",
        qualifiedName: actionInvoke.qualifiedName,
        symbolKind: "method",
      })
    )
    expect(actionInvoke.range).toMatchObject({ startLine: 18, endLine: 23 })
    expect(actionInvoke.range.startFilePos).toBeGreaterThan(0)
    expect(actionInvoke.range.endFilePos).toBeGreaterThan(
      actionInvoke.range.startFilePos
    )
    expect(actionInvoke.range.endTokenPos).toBeGreaterThan(
      actionInvoke.range.startTokenPos
    )
    const actionConstructor = symbol(
      response,
      "Fixture\\Actions\\CreateOrderAction::__construct"
    )
    const handler = symbol(response, "Fixture\\Handlers\\CreateOrderHandler")
    expect(
      symbol(response, "Fixture\\Actions\\CreateOrderAction::$handler")
    ).toMatchObject({ kind: "property", visibility: "private" })
    const handlerMethod = symbol(
      response,
      "Fixture\\Handlers\\CreateOrderHandler::handle"
    )
    const serviceMethod = symbol(
      response,
      "Fixture\\Services\\OrderService::create"
    )
    const repositoryMethod = symbol(
      response,
      "Fixture\\Repositories\\OrderRepository::save"
    )
    const order = symbol(response, "Fixture\\Models\\Order")

    expect(route?.action.targetSymbolId).toBe(actionInvoke.id)
    expect(relationships).toContainEqual(
      expect.objectContaining({
        sourceSymbolId: actionConstructor.id,
        targetSymbolId: handler.id,
        kind: "constructor_dependency",
        originalTarget: "OrderHandler",
        resolvedTarget: "Fixture\\Handlers\\CreateOrderHandler",
      })
    )
    expect(relationships).toContainEqual(
      expect.objectContaining({
        sourceSymbolId: actionInvoke.id,
        targetSymbolId: handlerMethod.id,
        kind: "calls",
      })
    )
    expect(relationships).toContainEqual(
      expect.objectContaining({
        sourceSymbolId: handlerMethod.id,
        targetSymbolId: serviceMethod.id,
        kind: "calls",
      })
    )
    expect(relationships).toContainEqual(
      expect.objectContaining({
        sourceSymbolId: serviceMethod.id,
        targetSymbolId: repositoryMethod.id,
        kind: "calls",
      })
    )
    expect(relationships).toContainEqual(
      expect.objectContaining({
        sourceSymbolId: repositoryMethod.id,
        targetSymbolId: order.id,
        kind: "instantiates",
      })
    )
    expect(symbols.find((candidate) => candidate.id === handler.id)?.role).toBe(
      "handler"
    )
  })

  it("retains aliases, traits, attributes, and Laravel associations", () => {
    const relationships = response.files.flatMap((file) => file.relationships)
    expect(relationships).toContainEqual(
      expect.objectContaining({
        kind: "attribute",
        originalTarget: "Transactional",
        resolvedTarget: "Fixture\\Attributes\\Transactional",
      })
    )
    expect(relationships).toContainEqual(
      expect.objectContaining({
        kind: "uses_trait",
        originalTarget: "AuditsOrders",
        resolvedTarget: "Fixture\\Traits\\AuditsOrders",
      })
    )
    expect(
      relationships.some((relationship) => relationship.kind === "form_request")
    ).toBe(true)
    expect(
      relationships.some(
        (relationship) => relationship.kind === "json_resource"
      )
    ).toBe(true)
    expect(
      relationships.some((relationship) => relationship.kind === "implements")
    ).toBe(true)
    expect(symbol(response, "Fixture\\Requests\\CreateOrderRequest").role).toBe(
      "form_request"
    )
    expect(symbol(response, "Fixture\\Resources\\OrderResource").role).toBe(
      "json_resource"
    )
  })

  it("keeps dynamic calls unresolved and scopes malformed-file errors", () => {
    const dynamic = response.files
      .flatMap((file) => file.relationships)
      .filter((relationship) => relationship.kind === "unresolved_dynamic")
    expect(dynamic.length).toBeGreaterThanOrEqual(2)
    expect(dynamic.every((relationship) => relationship.dynamic)).toBe(true)
    expect(
      dynamic.every((relationship) => relationship.resolvedTarget === undefined)
    ).toBe(true)
    expect(
      dynamic.filter(
        (relationship) =>
          relationship.originalTarget === "dynamic-method:dispatch"
      )
    ).toHaveLength(2)
    expect(
      response.files
        .flatMap((file) => file.relationships)
        .some(
          (relationship) =>
            relationship.resolvedTarget ===
            "Fixture\\Services\\OrderService::dispatch"
        )
    ).toBe(false)
    expect(
      response.files.find((file) => file.path === "malformed.php")?.errors
    ).toEqual([expect.objectContaining({ code: "parse_error", line: 7 })])
    expect(response.summary.errorCount).toBe(1)
    expect(response.summary.symbolCount).toBeGreaterThan(40)
  })

  it("never executes top-level target code", async () => {
    await expect(access(markerPath)).rejects.toThrow()
  })

  it("finds enclosing symbols and prepares bounded source/query evidence", async () => {
    const index = new PhpCodeIndex(response)
    const enclosing = index.findSmallestEnclosingSymbol(
      "app/Actions/CreateOrderAction.php",
      18
    )
    expect(enclosing?.qualifiedName).toBe(
      "Fixture\\Actions\\CreateOrderAction::__invoke"
    )
    expect(index.searchSymbols("orderrepository", 5)).toContainEqual(
      expect.objectContaining({
        qualifiedName: "Fixture\\Repositories\\OrderRepository",
      })
    )
    const snapshot: CheckoutSnapshot = {
      path: fixtureRoot,
      metadata: {
        label: "fixture",
        commitSha: fixtureSource.commitSha,
        treeObjectId: "2".repeat(40),
        treeFingerprint: `sha256:${"3".repeat(64)}`,
        configFingerprint: `sha256:${"4".repeat(64)}`,
        fileCount: phpFixtureFiles.length,
        totalBytes: 1,
      },
      enumerate: () => [],
      readText: async (path) =>
        await readFile(join(fixtureRoot, ...path.split("/")), "utf8"),
    }
    const slice = await index.sourceSlice(snapshot, enclosing?.id ?? "", {
      contextLines: 1,
      maxLines: 20,
    })
    expect(slice.text).toContain("function __invoke")
    expect(slice.endLine - slice.startLine + 1).toBeLessThanOrEqual(20)
    const repeatedMatch = index.findSmallestEnclosingDeclaration(
      "app/Repeated/Namespaces.php",
      27
    )
    expect(repeatedMatch?.symbol.qualifiedName).toBe("Fixture\\Repeated")
    if (repeatedMatch === undefined) {
      throw new Error("Repeated namespace declaration was not indexed")
    }
    const repeatedSlice = await index.sourceSlice(snapshot, repeatedMatch, {
      contextLines: 0,
      maxLines: 20,
    })
    expect(repeatedSlice.startLine).toBe(27)
    expect(repeatedSlice.text).toContain("namespace Fixture\\Repeated")
    expect(repeatedSlice.text).not.toContain("namespace Fixture\\Other")
    await expect(
      index.sourceSlice(snapshot, repeatedMatch.symbol.id)
    ).rejects.toMatchObject({ code: "invalid_input" })
    const neighborhood = index.neighborhood(enclosing?.id ?? "", {
      maxDepth: 3,
      maxSymbols: 20,
    })
    expect(neighborhood.relationships.length).toBeGreaterThan(0)
    expect(neighborhood.symbols).toContainEqual(
      expect.objectContaining({
        qualifiedName: "Fixture\\Handlers\\CreateOrderHandler::handle",
      })
    )
    expect(
      index.neighborhood(enclosing?.id ?? "", {
        maxDepth: 2,
        maxSymbols: 20,
        maxRelationships: 1,
      })
    ).toMatchObject({ truncated: true, relationships: [expect.any(Object)] })
    await expect(
      index.sourceSlice(snapshot, enclosing?.id ?? "", {
        maxCharacters: 1,
      })
    ).rejects.toMatchObject({ code: "limit_exceeded" })
    await expect(
      index.sourceSlice(
        {
          ...snapshot,
          readText: async () => "<?php // different indexed source\n",
        },
        enclosing?.id ?? ""
      )
    ).rejects.toMatchObject({ code: "content_mismatch" })
    await expect(
      index.sourceSlice(
        {
          ...snapshot,
          metadata: { ...snapshot.metadata, commitSha: "c".repeat(40) },
        },
        enclosing?.id ?? ""
      )
    ).rejects.toMatchObject({ code: "content_mismatch" })
  })

  it("rejects source hash mismatches", async () => {
    await expect(
      indexer.index({
        source: fixtureSource,
        rootPath: fixtureRoot,
        files: ["app/Models/Order.php"],
        expectedContentHashes: {
          "app/Models/Order.php": `sha256:${"0".repeat(64)}`,
        },
      })
    ).rejects.toMatchObject({ code: "content_mismatch" })
  })

  it("normalizes a UTF-8 BOM consistently with checkout text reads", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "sentinel-php-bom-test-"))
    const path = "Bom.php"
    const source = "<?php final class Bom {}\n"
    await writeFile(
      join(temporary, path),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)])
    )
    const snapshot: CheckoutSnapshot = {
      path: temporary,
      metadata: {
        label: "bom",
        commitSha: fixtureSource.commitSha,
        treeObjectId: "2".repeat(40),
        treeFingerprint: `sha256:${"3".repeat(64)}`,
        configFingerprint: `sha256:${"4".repeat(64)}`,
        fileCount: 1,
        totalBytes: Buffer.byteLength(source) + 3,
      },
      enumerate: () => [],
      readText: async () => source,
    }
    try {
      await expect(
        indexer.indexCheckout(snapshot, [path], fixtureSource)
      ).resolves.toMatchObject({
        files: [
          {
            path,
            symbols: [
              expect.objectContaining({ qualifiedName: "Bom", kind: "class" }),
            ],
          },
        ],
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it("rejects traversal and symlink escape inputs", async () => {
    await expect(
      indexer.index({
        source: fixtureSource,
        rootPath: fixtureRoot,
        files: ["../outside.php"],
        expectedContentHashes: { "../outside.php": `sha256:${"0".repeat(64)}` },
      })
    ).rejects.toBeInstanceOf(Error)

    const temporary = await mkdtemp(join(tmpdir(), "sentinel-php-link-test-"))
    const root = join(temporary, "root")
    const outside = join(temporary, "outside")
    await mkdir(root)
    await mkdir(outside)
    const source = "<?php final class Escaped {}\n"
    await writeFile(join(outside, "Escaped.php"), source)
    await symlink(outside, join(root, "linked"), "junction")
    const rootLink = join(temporary, "root-link")
    await symlink(root, rootLink, "junction")
    try {
      await expect(
        indexer.index({
          source: fixtureSource,
          rootPath: rootLink,
          files: ["linked/Escaped.php"],
          expectedContentHashes: {
            "linked/Escaped.php": `sha256:${createHash("sha256")
              .update(source)
              .digest("hex")}`,
          },
        })
      ).rejects.toMatchObject({ code: "unsafe_path" })
      await expect(
        indexer.index({
          source: fixtureSource,
          rootPath: root,
          files: ["linked/Escaped.php"],
          expectedContentHashes: {
            "linked/Escaped.php": `sha256:${createHash("sha256")
              .update(source)
              .digest("hex")}`,
          },
        })
      ).rejects.toMatchObject({ code: "unsafe_path" })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})

describe("PHP indexer process limits", () => {
  async function temporaryCli(source: string): Promise<{
    readonly root: string
    readonly cli: string
    cleanup(): Promise<void>
  }> {
    const root = await mkdtemp(join(tmpdir(), "sentinel-php-process-test-"))
    const cli = join(root, "bin", "custom.php")
    await mkdir(join(root, "bin"))
    await writeFile(cli, source)
    await writeFile(join(root, "Input.php"), "<?php final class Input {}\n")
    return {
      root,
      cli,
      cleanup: async () => await rm(root, { recursive: true, force: true }),
    }
  }

  it.each([
    {
      label: "timeout",
      code: "timeout",
      source: "<?php usleep(500000); echo '{}';",
      options: { timeoutMs: 50 },
    },
    {
      label: "stdout limit",
      code: "limit_exceeded",
      source: "<?php echo str_repeat('x', 10000);",
      options: { maxOutputBytes: 100 },
    },
    {
      label: "malformed output",
      code: "malformed_output",
      source: "<?php echo '{bad json';",
      options: {},
    },
  ] as const)(
    "enforces the $label process boundary",
    async (testCase) => {
      const temporary = await temporaryCli(testCase.source)
      const hash = `sha256:${createHash("sha256")
        .update("<?php final class Input {}\n")
        .digest("hex")}`
      try {
        await expect(
          new PhpLaravelIndexer({
            cliPath: temporary.cli,
            limits: testCase.options,
          }).index({
            source: fixtureSource,
            rootPath: temporary.root,
            files: ["Input.php"],
            expectedContentHashes: { "Input.php": hash },
          })
        ).rejects.toMatchObject({ code: testCase.code })
      } finally {
        await temporary.cleanup()
      }
    },
    10_000
  )

  it("rejects an unavailable PHP executable", async () => {
    await expect(
      new PhpLaravelIndexer({ phpExecutable: "missing-sentinel-php" }).index({
        source: fixtureSource,
        rootPath: fixtureRoot,
        files: ["app/Models/Order.php"],
        expectedContentHashes: await phpFixtureHashes(fixtureRoot, [
          "app/Models/Order.php",
        ]),
      })
    ).rejects.toMatchObject({ code: "executable_missing" })
  }, 10_000)

  it("enforces file, fact, request, path-depth, and stderr limits", async () => {
    const hashes = await phpFixtureHashes(fixtureRoot, [
      "app/Models/Order.php",
      "app/Requests/CreateOrderRequest.php",
    ])
    const cases = [
      {
        indexer: new PhpLaravelIndexer({ limits: { maxFiles: 1 } }),
        files: ["app/Models/Order.php", "app/Requests/CreateOrderRequest.php"],
        code: "limit_exceeded",
      },
      {
        indexer: new PhpLaravelIndexer({
          limits: { maxFileBytes: 16, maxTotalBytes: 64 },
        }),
        files: ["app/Models/Order.php"],
        code: "limit_exceeded",
      },
      {
        indexer: new PhpLaravelIndexer({ limits: { maxFacts: 1 } }),
        files: ["app/Models/Order.php"],
        code: "limit_exceeded",
      },
      {
        indexer: new PhpLaravelIndexer({ limits: { maxRequestBytes: 100 } }),
        files: ["app/Models/Order.php"],
        code: "limit_exceeded",
      },
      {
        indexer: new PhpLaravelIndexer({ limits: { maxPathDepth: 2 } }),
        files: ["app/Models/Order.php"],
        code: "limit_exceeded",
      },
    ] as const
    for (const testCase of cases) {
      await expect(
        testCase.indexer.index({
          source: fixtureSource,
          rootPath: fixtureRoot,
          files: testCase.files,
          expectedContentHashes: hashes,
        })
      ).rejects.toMatchObject({ code: testCase.code })
    }

    const temporary = await temporaryCli(
      "<?php fwrite(STDERR, str_repeat('x', 10000)); exit(1);"
    )
    try {
      await expect(
        new PhpLaravelIndexer({
          cliPath: temporary.cli,
          limits: { maxStderrBytes: 100 },
        }).index({
          source: fixtureSource,
          rootPath: temporary.root,
          files: ["Input.php"],
          expectedContentHashes: await phpFixtureHashes(temporary.root, [
            "Input.php",
          ]),
        })
      ).rejects.toMatchObject({ code: "limit_exceeded" })
    } finally {
      await temporary.cleanup()
    }
  })

  it("does not expose child stderr", async () => {
    const temporary = await temporaryCli(
      "<?php fwrite(STDERR, 'password=source-secret'); exit(1);"
    )
    try {
      const error = await new PhpLaravelIndexer({ cliPath: temporary.cli })
        .index({
          source: fixtureSource,
          rootPath: temporary.root,
          files: ["Input.php"],
          expectedContentHashes: await phpFixtureHashes(temporary.root, [
            "Input.php",
          ]),
        })
        .catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(PhpIndexerError)
      expect((error as PhpIndexerError).message).not.toContain("source-secret")
    } finally {
      await temporary.cleanup()
    }
  })

  it("honors cancellation even when it races pre-spawn validation", async () => {
    const temporary = await temporaryCli("<?php usleep(500000); echo '{}';")
    const controller = new AbortController()
    try {
      const pending = new PhpLaravelIndexer({ cliPath: temporary.cli }).index({
        source: fixtureSource,
        rootPath: temporary.root,
        files: ["Input.php"],
        expectedContentHashes: await phpFixtureHashes(temporary.root, [
          "Input.php",
        ]),
        signal: controller.signal,
      })
      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: "aborted" })
    } finally {
      await temporary.cleanup()
    }
  })
})
