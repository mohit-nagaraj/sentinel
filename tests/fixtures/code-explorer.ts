import { createHash } from "node:crypto"

import {
  applicationIdSchema,
  codeExplorerMissionSchema,
  codeExplorerToolNames,
  codeSymbolIdSchema,
  commitShaSchema,
  createMissionId,
  createStableKey,
  hashCanonical,
  repositoryIdentitySchema,
  runIdSchema,
  type CodeExplorerMission,
} from "@sentinel/contracts"
import {
  CodeExplorerRepository,
  CodeExplorerTools,
  PhpCodeIndex,
  createTypeScriptIndexQuery,
  defaultIndexPolicy,
  endpointFromFrontendCandidate,
  endpointsFromLaravelRoute,
  importOpenApiDocument,
  indexTypeScriptSource,
  phpIndexerResponseSchema,
  type CheckoutSnapshot,
  type PhpRelationship,
  type PhpSymbol,
} from "@sentinel/adapters"

import { openApiOrderFixture } from "./openapi.ts"

const applicationId = applicationIdSchema.parse(
  `application:v1:${"1".repeat(64)}`
)
const runId = runIdSchema.parse("run:16000000-0000-4000-8000-000000000016")
const commitSha = commitShaSchema.parse("2".repeat(40))
const repository = repositoryIdentitySchema.parse({
  host: "github.com",
  owner: "fixture",
  name: "cross-stack-orders",
})

const frontendFiles: Readonly<Record<string, string>> = Object.freeze({
  "frontend/tsconfig.json": `{
  "compilerOptions": { "jsx": "react-jsx", "baseUrl": "." },
  "include": ["src"]
}
`,
  "frontend/src/api/client.ts": `import axios from "axios"

export const api = axios.create({ baseURL: "/api/v1" })
`,
  "frontend/src/api/order.client.ts": `import { api } from "./client.ts"

export const ordersClient = {
  create: async (eventId: string, input: unknown) => {
    const response = await api.post(\`events/\${eventId}/orders\`, input)
    return response.data
  },
}
`,
  "frontend/src/mutations/useCreateOrder.ts": `import { useMutation } from "@tanstack/react-query"

import { ordersClient } from "../api/order.client.ts"

export const useCreateOrder = (eventId: string) =>
  useMutation({
    mutationFn: (input: unknown) => ordersClient.create(eventId, input),
  })
`,
  "frontend/src/components/Checkout.tsx": `import { useCreateOrder } from "../mutations/useCreateOrder.ts"

export const Checkout = ({ eventId }: { eventId: string }) => {
  const createOrder = useCreateOrder(eventId)
  const handleSubmit = () => createOrder.mutate({ quantity: 1 })

  return <button aria-label="Place order" onClick={handleSubmit}>Place order</button>
}
`,
  "frontend/src/router.tsx": `export const router = [
  {
    path: "checkout/:eventId",
    async lazy() {
      const Checkout = await import("./components/Checkout")
      return { Component: Checkout.Checkout }
    },
  },
]
`,
  "frontend/src/components/Checkout.test.tsx": `import { Checkout } from "./Checkout.tsx"

export const checkoutSubject = Checkout
`,
  "frontend/src/distractors/OrderService.ts": `// Same-name distractor and endpoint string: /events/{eventId}/orders
export const OrderService = "documentation only"
`,
})

const phpSources: Readonly<Record<string, string>> = Object.freeze({
  "backend/routes/api.php": `<?php
use Fixture\\Actions\\CreateOrderAction;
Route::prefix('api/v1')->group(function (): void {
    Route::post('events/{event}/orders', CreateOrderAction::class);
});
`,
  "backend/app/Actions/CreateOrderAction.php": `<?php
namespace Fixture\\Actions;
final class CreateOrderAction
{
    public function __invoke(): void
    {
        $this->handler->handle();
    }

    public function unresolved(object $container, string $handler): void
    {
        $container->make($handler)->run();
    }
}
`,
  "backend/app/Handlers/CreateOrderHandler.php": `<?php
namespace Fixture\\Handlers;
final class CreateOrderHandler
{
    public function handle(): void
    {
        $this->service->create();
    }
}
`,
  "backend/app/Services/OrderService.php": `<?php
namespace Fixture\\Services;
final class OrderService
{
    public function create(): void
    {
        $this->orders->save();
    }
}
`,
  "backend/app/Repositories/OrderRepository.php": `<?php
namespace Fixture\\Repositories;
final class OrderRepository
{
    public function save(): void
    {
        $order = new \\Fixture\\Models\\Order();
    }
}
`,
  "backend/app/Models/Order.php": `<?php
namespace Fixture\\Models;
final class Order {}
`,
  "backend/app/Distractors/OrderService.php": `<?php
namespace Fixture\\Distractors;
// Same-name class that is never connected by a structural edge.
final class OrderService {}
`,
})

const allFiles = Object.freeze({ ...frontendFiles, ...phpSources })

function sourceHash(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

function lineRange(
  source: string,
  startLine: number,
  endLine: number
): {
  startLine: number
  endLine: number
  startFilePos: number
  endFilePos: number
  startTokenPos: number
  endTokenPos: number
} {
  const lines = source.split(/\r\n|\n|\r/)
  const startFilePos = lines
    .slice(0, startLine - 1)
    .reduce((total, line) => total + line.length + 1, 0)
  const endFilePos =
    startFilePos +
    lines
      .slice(startLine - 1, endLine)
      .reduce((total, line) => total + line.length + 1, 0) -
    1
  return {
    startLine,
    endLine,
    startFilePos,
    endFilePos,
    startTokenPos: startFilePos,
    endTokenPos: endFilePos,
  }
}

function symbolId(filePath: string, qualifiedName: string, symbolKind: string) {
  return codeSymbolIdSchema.parse(
    createStableKey({
      kind: "code-symbol",
      applicationId,
      repository,
      commitSha,
      filePath,
      qualifiedName,
      symbolKind,
    })
  )
}

interface SymbolInput {
  readonly path: string
  readonly name: string
  readonly qualifiedName: string
  readonly kind: PhpSymbol["kind"]
  readonly role: PhpSymbol["role"]
  readonly startLine: number
  readonly endLine: number
  readonly containerSymbolId?: PhpSymbol["containerSymbolId"]
}

function phpSymbol(input: SymbolInput): PhpSymbol {
  const range = lineRange(
    phpSources[input.path]!,
    input.startLine,
    input.endLine
  )
  return {
    id: symbolId(input.path, input.qualifiedName, input.kind),
    kind: input.kind,
    role: input.role,
    name: input.name,
    qualifiedName: input.qualifiedName,
    originalName: input.name,
    ...(input.containerSymbolId === undefined
      ? {}
      : { containerSymbolId: input.containerSymbolId }),
    ...(input.kind === "method" ? { visibility: "public" as const } : {}),
    static: false,
    abstract: false,
    final: input.kind === "class",
    attributes: [],
    range,
    declarationRanges: [range],
  }
}

const actionClass = phpSymbol({
  path: "backend/app/Actions/CreateOrderAction.php",
  name: "CreateOrderAction",
  qualifiedName: "Fixture\\Actions\\CreateOrderAction",
  kind: "class",
  role: "action",
  startLine: 3,
  endLine: 15,
})
const actionMethod = phpSymbol({
  path: "backend/app/Actions/CreateOrderAction.php",
  name: "__invoke",
  qualifiedName: "Fixture\\Actions\\CreateOrderAction::__invoke",
  kind: "method",
  role: "action",
  startLine: 5,
  endLine: 8,
  containerSymbolId: actionClass.id,
})
const unresolvedMethod = phpSymbol({
  path: "backend/app/Actions/CreateOrderAction.php",
  name: "unresolved",
  qualifiedName: "Fixture\\Actions\\CreateOrderAction::unresolved",
  kind: "method",
  role: "action",
  startLine: 10,
  endLine: 13,
  containerSymbolId: actionClass.id,
})
const handlerClass = phpSymbol({
  path: "backend/app/Handlers/CreateOrderHandler.php",
  name: "CreateOrderHandler",
  qualifiedName: "Fixture\\Handlers\\CreateOrderHandler",
  kind: "class",
  role: "handler",
  startLine: 3,
  endLine: 9,
})
const handlerMethod = phpSymbol({
  path: "backend/app/Handlers/CreateOrderHandler.php",
  name: "handle",
  qualifiedName: "Fixture\\Handlers\\CreateOrderHandler::handle",
  kind: "method",
  role: "handler",
  startLine: 5,
  endLine: 8,
  containerSymbolId: handlerClass.id,
})
const serviceClass = phpSymbol({
  path: "backend/app/Services/OrderService.php",
  name: "OrderService",
  qualifiedName: "Fixture\\Services\\OrderService",
  kind: "class",
  role: "service",
  startLine: 3,
  endLine: 9,
})
const serviceMethod = phpSymbol({
  path: "backend/app/Services/OrderService.php",
  name: "create",
  qualifiedName: "Fixture\\Services\\OrderService::create",
  kind: "method",
  role: "service",
  startLine: 5,
  endLine: 8,
  containerSymbolId: serviceClass.id,
})
const repositoryClass = phpSymbol({
  path: "backend/app/Repositories/OrderRepository.php",
  name: "OrderRepository",
  qualifiedName: "Fixture\\Repositories\\OrderRepository",
  kind: "class",
  role: "repository",
  startLine: 3,
  endLine: 9,
})
const repositoryMethod = phpSymbol({
  path: "backend/app/Repositories/OrderRepository.php",
  name: "save",
  qualifiedName: "Fixture\\Repositories\\OrderRepository::save",
  kind: "method",
  role: "repository",
  startLine: 5,
  endLine: 8,
  containerSymbolId: repositoryClass.id,
})
const orderModel = phpSymbol({
  path: "backend/app/Models/Order.php",
  name: "Order",
  qualifiedName: "Fixture\\Models\\Order",
  kind: "class",
  role: "model",
  startLine: 3,
  endLine: 3,
})
const distractorService = phpSymbol({
  path: "backend/app/Distractors/OrderService.php",
  name: "OrderService",
  qualifiedName: "Fixture\\Distractors\\OrderService",
  kind: "class",
  role: "service",
  startLine: 4,
  endLine: 4,
})

function relationship(input: {
  readonly kind: PhpRelationship["kind"]
  readonly source: PhpSymbol
  readonly target?: PhpSymbol
  readonly originalTarget: string
  readonly path: string
  readonly line: number
  readonly dynamic?: boolean
}): PhpRelationship {
  const dynamic = input.dynamic === true
  return {
    id: `php-relationship:v1:${hashCanonical({
      kind: input.kind,
      source: input.source.id,
      target: input.target?.id ?? input.originalTarget,
    }).slice("sha256:".length)}`,
    kind: input.kind,
    sourceSymbolId: input.source.id,
    ...(input.target === undefined ? {} : { targetSymbolId: input.target.id }),
    originalTarget: input.originalTarget,
    ...(dynamic
      ? {}
      : {
          resolvedTarget: input.target?.qualifiedName ?? input.originalTarget,
        }),
    dynamic,
    range: lineRange(phpSources[input.path]!, input.line, input.line),
  }
}

const actionRelationships: readonly PhpRelationship[] = [
  relationship({
    kind: "calls",
    source: actionMethod,
    target: handlerMethod,
    originalTarget: "$this->handler->handle",
    path: "backend/app/Actions/CreateOrderAction.php",
    line: 7,
  }),
  relationship({
    kind: "unresolved_dynamic",
    source: unresolvedMethod,
    originalTarget: "$container->make($handler)->run",
    path: "backend/app/Actions/CreateOrderAction.php",
    line: 12,
    dynamic: true,
  }),
]
const handlerRelationships = [
  relationship({
    kind: "calls",
    source: handlerMethod,
    target: serviceMethod,
    originalTarget: "$this->service->create",
    path: "backend/app/Handlers/CreateOrderHandler.php",
    line: 7,
  }),
]
const serviceRelationships = [
  relationship({
    kind: "calls",
    source: serviceMethod,
    target: repositoryMethod,
    originalTarget: "$this->orders->save",
    path: "backend/app/Services/OrderService.php",
    line: 7,
  }),
]
const repositoryRelationships = [
  relationship({
    kind: "domain_reference",
    source: repositoryMethod,
    target: orderModel,
    originalTarget: "Fixture\\Models\\Order",
    path: "backend/app/Repositories/OrderRepository.php",
    line: 7,
  }),
]

const routeRange = lineRange(phpSources["backend/routes/api.php"]!, 4, 4)
const route = {
  id: `php-route:v1:${hashCanonical("create-order-route").slice("sha256:".length)}`,
  methods: ["POST" as const],
  path: "/api/v1/events/{event}/orders",
  middleware: [],
  action: {
    originalName: "CreateOrderAction::class",
    resolvedName: actionClass.qualifiedName,
    method: "__invoke",
    dynamic: false,
    targetSymbolId: actionMethod.id,
  },
  dynamic: false,
  range: routeRange,
}

const phpResponse = phpIndexerResponseSchema.parse({
  schemaVersion: 1,
  source: { applicationId, repository, commitSha },
  parser: { name: "nikic/php-parser", version: "5.8.0" },
  files: [
    {
      path: "backend/routes/api.php",
      contentHash: sourceHash(phpSources["backend/routes/api.php"]!),
      symbols: [],
      relationships: [],
      routes: [route],
      errors: [],
    },
    {
      path: "backend/app/Actions/CreateOrderAction.php",
      contentHash: sourceHash(
        phpSources["backend/app/Actions/CreateOrderAction.php"]!
      ),
      symbols: [actionClass, actionMethod, unresolvedMethod],
      relationships: actionRelationships,
      routes: [],
      errors: [],
    },
    {
      path: "backend/app/Handlers/CreateOrderHandler.php",
      contentHash: sourceHash(
        phpSources["backend/app/Handlers/CreateOrderHandler.php"]!
      ),
      symbols: [handlerClass, handlerMethod],
      relationships: handlerRelationships,
      routes: [],
      errors: [],
    },
    {
      path: "backend/app/Services/OrderService.php",
      contentHash: sourceHash(
        phpSources["backend/app/Services/OrderService.php"]!
      ),
      symbols: [serviceClass, serviceMethod],
      relationships: serviceRelationships,
      routes: [],
      errors: [],
    },
    {
      path: "backend/app/Repositories/OrderRepository.php",
      contentHash: sourceHash(
        phpSources["backend/app/Repositories/OrderRepository.php"]!
      ),
      symbols: [repositoryClass, repositoryMethod],
      relationships: repositoryRelationships,
      routes: [],
      errors: [],
    },
    {
      path: "backend/app/Models/Order.php",
      contentHash: sourceHash(phpSources["backend/app/Models/Order.php"]!),
      symbols: [orderModel],
      relationships: [],
      routes: [],
      errors: [],
    },
    {
      path: "backend/app/Distractors/OrderService.php",
      contentHash: sourceHash(
        phpSources["backend/app/Distractors/OrderService.php"]!
      ),
      symbols: [distractorService],
      relationships: [],
      routes: [],
      errors: [],
    },
  ],
  summary: {
    fileCount: 7,
    symbolCount: 11,
    relationshipCount: 5,
    routeCount: 1,
    errorCount: 0,
  },
})

function snapshot(): CheckoutSnapshot {
  const entries = Object.entries(allFiles)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([path, source], index) => ({
      path,
      kind: "file" as const,
      mode: "100644",
      objectId: (index + 1).toString(16).padStart(40, "0"),
      sizeBytes: Buffer.byteLength(source, "utf8"),
    }))
  return {
    metadata: {
      label: "cross-stack",
      commitSha,
      treeObjectId: "3".repeat(40),
      treeFingerprint: hashCanonical(entries),
      configFingerprint: hashCanonical("cross-stack-config"),
      fileCount: entries.length,
      totalBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
    },
    path: "cross-stack",
    enumerate: (prefix = "") =>
      entries.filter(
        ({ path }) =>
          prefix.length === 0 ||
          path === prefix ||
          path.startsWith(`${prefix}/`)
      ),
    readText: async (path) => {
      const source = allFiles[path]
      if (source === undefined) throw new Error("Fixture path is not admitted")
      return source
    },
  }
}

function sourceReader(checkout: CheckoutSnapshot) {
  return {
    enumerate: (prefix = "") => checkout.enumerate(prefix),
    readText: (path: string, maxBytes?: number) =>
      checkout.readText(path, maxBytes),
  }
}

export const codeExplorerFixtureIds = Object.freeze({
  actionMethod: actionMethod.id,
  handlerMethod: handlerMethod.id,
  serviceMethod: serviceMethod.id,
  repositoryMethod: repositoryMethod.id,
  orderModel: orderModel.id,
  distractorService: distractorService.id,
  unresolvedMethod: unresolvedMethod.id,
})

export interface CodeExplorerGoldenFixture {
  readonly tools: CodeExplorerTools
  readonly mission: CodeExplorerMission
  readonly endpointId: string
  readonly ids: typeof codeExplorerFixtureIds & {
    readonly checkout: string
    readonly useCreateOrder: string
    readonly ordersClientCreate: string
  }
}

export async function createCodeExplorerGoldenFixture(
  input: {
    readonly mode?: CodeExplorerMission["mode"]
    readonly allowedTools?: readonly string[]
  } = {}
): Promise<CodeExplorerGoldenFixture> {
  const checkout = snapshot()
  const typescriptIndex = await indexTypeScriptSource({
    reader: sourceReader(checkout),
    applicationId,
    runId,
    repository,
    commitSha,
    roots: ["frontend/src"],
    policy: { ...defaultIndexPolicy, includeTests: true },
  })
  const query = createTypeScriptIndexQuery(
    typescriptIndex,
    sourceReader(checkout)
  )
  const apiCandidate = typescriptIndex.apiCallCandidates.find(
    ({ method, pathTemplate }) =>
      method === "POST" && pathTemplate === "/events/{param}/orders"
  )
  if (apiCandidate === undefined) {
    throw new Error("Golden fixture API call did not normalize as expected")
  }
  const apiFile = typescriptIndex.files.find(
    ({ path }) => path === apiCandidate.filePath
  )!
  const frontendEndpoint = endpointFromFrontendCandidate({
    applicationId,
    repository,
    commitSha,
    indexerVersion: typescriptIndex.indexerVersion,
    contentHash: apiFile.contentHash,
    candidate: apiCandidate,
  })
  const routeFile = phpResponse.files.find(
    ({ path }) => path === "backend/routes/api.php"
  )!
  const laravelEndpoint = endpointsFromLaravelRoute({
    response: phpResponse,
    file: routeFile,
    route: routeFile.routes[0]!,
    stripPrefixes: ["/api/v1"],
  })
  const openapi = importOpenApiDocument({
    applicationId,
    sourceUri: "repository://fixture/openapi.yaml",
    commitSha,
    document: openApiOrderFixture,
    stripPrefixes: ["/api/v1"],
  })
  const repositoryIndex = new CodeExplorerRepository({
    applicationId,
    runId,
    typescript: { index: typescriptIndex, query },
    php: { index: new PhpCodeIndex(phpResponse), snapshot: checkout },
    endpoints: [
      ...frontendEndpoint.endpoints,
      ...laravelEndpoint.endpoints,
      ...openapi.endpoints,
    ],
  })
  const allowedTools = input.allowedTools ?? codeExplorerToolNames
  const mode = input.mode ?? "implementation_trace"
  const mission = codeExplorerMissionSchema.parse({
    schemaVersion: 1,
    id: createMissionId({
      applicationId,
      runId,
      agent: "code",
      mode,
      ordinal: 0,
    }),
    runId,
    applicationId,
    agent: "code",
    mode,
    goal: "Trace order creation across the React and Laravel implementation.",
    seedEvidenceIds: [],
    questions: [
      "Which frontend symbol calls order creation?",
      "Which backend action, handler, service, repository, and model are connected?",
    ],
    scope: {
      repositoryPaths: ["frontend/src", "backend/app", "backend/routes"],
      languages: ["typescript", "tsx", "php"],
      sourceUris: [],
      allowedHosts: [],
      allowedTools,
    },
    budget: {
      toolCalls: 40,
      contentBytes: 500_000,
      documentBytes: 0,
      documentPages: 0,
      documentSections: 0,
      sourceLines: 1_000,
      repositoryBytes: 250_000,
      repositoryFiles: 50,
      browserActions: 0,
      modelCalls: 40,
      modelInputTokens: 100_000,
      modelOutputTokens: 20_000,
      reconciliationRounds: 0,
      elapsedMs: 120_000,
    },
    successCriteria: [
      "A frontend-to-backend implementation path has structural source evidence.",
      "Dynamic boundaries and distractors remain unresolved or excluded.",
    ],
  })
  const checkoutSymbol = typescriptIndex.symbols.find(
    ({ name }) => name === "Checkout"
  )!
  const useCreateOrder = typescriptIndex.symbols.find(
    ({ name }) => name === "useCreateOrder"
  )!
  const ordersClientCreate = typescriptIndex.symbols.find(({ qualifiedName }) =>
    qualifiedName.endsWith("#ordersClient.create")
  )!
  return {
    tools: new CodeExplorerTools(repositoryIndex, mission, {
      maxResultsPerTool: 25,
      maxTraversalHopsPerTool: 4,
      maxSourceLinesPerTool: 120,
      maxSourceCharactersPerTool: 16_384,
    }),
    mission,
    endpointId: laravelEndpoint.endpoints[0]!.endpoint.id,
    ids: {
      ...codeExplorerFixtureIds,
      checkout: checkoutSymbol.id,
      useCreateOrder: useCreateOrder.id,
      ordersClientCreate: ordersClientCreate.id,
    },
  }
}
