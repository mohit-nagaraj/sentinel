"use client"

import dynamic from "next/dynamic"
import {
  AppWindow,
  BookOpen,
  Box,
  Braces,
  Code2,
  Focus,
  LoaderCircle,
  Monitor,
  Network,
  Search,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "next-themes"
import type { ForceGraphMethods as ForceGraph2DMethods } from "react-force-graph-2d"

import {
  knowledgeGraphNeighborhoodSchema,
  knowledgeGraphSearchResultSchema,
  type KnowledgeGraphNeighborhood,
  type KnowledgeGraphNode,
  type KnowledgeGraphRelationship,
} from "@sentinel/contracts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
})

type GraphNode = KnowledgeGraphNode & { x?: number; y?: number }
type GraphLink = KnowledgeGraphRelationship & {
  source: string | GraphNode
  target: string | GraphNode
}

const category = {
  documentation: { label: "Documentation", color: "#d97706", icon: BookOpen },
  product: { label: "Product", color: "#059669", icon: Box },
  ui: { label: "Interface", color: "#0891b2", icon: Monitor },
  api: { label: "API & data", color: "#7c3aed", icon: Braces },
  code: { label: "Code", color: "#2563eb", icon: Code2 },
  root: { label: "Application & PR", color: "#475569", icon: AppWindow },
} as const

const nodeKindsByGroup = {
  all: [],
  documentation: ["document-source", "document-page", "document-section"],
  product: [
    "requirement",
    "capability",
    "workflow",
    "flow-step",
    "coverage-assessment",
  ],
  interface: ["screen", "ui-element", "frontend-route"],
  api: ["api-endpoint", "domain-entity"],
  code: ["code-file", "code-symbol"],
} as const

const relationshipOptions = [
  ["all", "All relationships"],
  ["COVERED_BY", "Covered by"],
  ["HAS_STEP", "Has step"],
  ["ACTS_ON", "Acts on"],
  ["TRIGGERS_API", "Triggers API"],
  ["HANDLED_BY", "Handled by"],
  ["CALLS", "Calls"],
] as const

function categoryFor(kind: string): keyof typeof category {
  if (kind.startsWith("document")) return "documentation"
  if (
    [
      "requirement",
      "capability",
      "workflow",
      "flow-step",
      "coverage-assessment",
    ].includes(kind)
  )
    return "product"
  if (["screen", "ui-element", "frontend-route"].includes(kind)) return "ui"
  if (["api-endpoint", "domain-entity"].includes(kind)) return "api"
  if (["code-file", "code-symbol"].includes(kind)) return "code"
  return "root"
}

function endpointId(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value)
  if (value !== null && typeof value === "object" && "id" in value)
    return String(value.id)
  return ""
}

export function KnowledgeGraphExplorer({
  applicationId,
  initialSeedId,
}: {
  readonly applicationId: string
  readonly initialSeedId?: string | undefined
}) {
  const { resolvedTheme } = useTheme()
  const [graph, setGraph] = useState<KnowledgeGraphNeighborhood | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSeedId ?? null
  )
  const [depth, setDepth] = useState(2)
  const [nodeGroup, setNodeGroup] =
    useState<keyof typeof nodeKindsByGroup>("all")
  const [relationship, setRelationship] = useState("all")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<readonly KnowledgeGraphNode[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [size, setSize] = useState({ width: 900, height: 620 })
  const canvasRef = useRef<HTMLDivElement>(null)
  const graph2dRef = useRef<ForceGraph2DMethods | undefined>(undefined)

  useEffect(() => {
    const element = canvasRef.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({
        width: Math.max(320, Math.floor(entry.contentRect.width)),
        height: Math.max(520, Math.floor(entry.contentRect.height)),
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const loadNeighborhood = useCallback(
    async (seedId?: string, merge = true) => {
      setBusy(true)
      setError("")
      try {
        const params = new URLSearchParams({
          depth: String(depth),
          nodeLimit: "100",
          edgeLimit: "200",
        })
        if (seedId) params.set("seedId", seedId)
        for (const kind of nodeKindsByGroup[nodeGroup]) {
          params.append("kind", kind)
        }
        if (relationship !== "all") {
          params.append("relationship", relationship)
        }
        const response = await fetch(
          `/api/knowledge/applications/${encodeURIComponent(applicationId)}/graph/neighborhood?${params}`,
          { cache: "no-store", credentials: "same-origin" }
        )
        if (!response.ok) throw new Error("graph_failed")
        const next = knowledgeGraphNeighborhoodSchema.parse(
          await response.json()
        )
        setGraph((current) => {
          if (!current || !merge) return next
          const nodes = new Map(current.nodes.map((node) => [node.id, node]))
          const relationships = new Map(
            current.relationships.map((link) => [link.id, link])
          )
          next.nodes.forEach((node) => nodes.set(node.id, node))
          next.relationships.forEach((link) => relationships.set(link.id, link))
          return {
            ...next,
            nodes: [...nodes.values()].slice(0, 200),
            relationships: [...relationships.values()].slice(0, 400),
            truncated: current.truncated || next.truncated,
          }
        })
        setSelectedId(next.seedId)
      } catch {
        setError(
          "The graph could not be loaded. Coverage data remains available."
        )
      } finally {
        setBusy(false)
      }
    },
    [applicationId, depth, nodeGroup, relationship]
  )

  useEffect(() => {
    const timer = window.setTimeout(
      () => void loadNeighborhood(initialSeedId, false),
      0
    )
    return () => window.clearTimeout(timer)
  }, [initialSeedId, loadNeighborhood])

  const searchGraph = async (event: React.FormEvent) => {
    event.preventDefault()
    if (query.trim().length < 2) return
    setBusy(true)
    try {
      const params = new URLSearchParams({ query: query.trim(), limit: "20" })
      for (const kind of nodeKindsByGroup[nodeGroup]) {
        params.append("kind", kind)
      }
      const response = await fetch(
        `/api/knowledge/applications/${encodeURIComponent(applicationId)}/graph/search?${params}`,
        { cache: "no-store", credentials: "same-origin" }
      )
      if (!response.ok) throw new Error("search_failed")
      setResults(
        knowledgeGraphSearchResultSchema.parse(await response.json()).items
      )
    } catch {
      setError("Graph search is temporarily unavailable.")
    } finally {
      setBusy(false)
    }
  }

  const selected = graph?.nodes.find((node) => node.id === selectedId)
  const connectedIds = useMemo(() => {
    const ids = new Set<string>(selectedId ? [selectedId] : [])
    graph?.relationships.forEach((link) => {
      if (link.fromId === selectedId) ids.add(link.toId)
      if (link.toId === selectedId) ids.add(link.fromId)
    })
    return ids
  }, [graph?.relationships, selectedId])
  const graphData = useMemo(
    () => ({
      nodes: (graph?.nodes ?? []).map((node) => ({ ...node })),
      links: (graph?.relationships ?? []).map((link) => ({
        ...link,
        source: link.fromId,
        target: link.toId,
      })),
    }),
    [graph]
  )
  const nodeColor = (node: GraphNode) => {
    const color = category[categoryFor(node.kind)].color
    return selectedId && !connectedIds.has(node.id) ? "#94a3b8" : color
  }
  const linkColor = (link: GraphLink) => {
    const connected =
      !selectedId ||
      endpointId(link.source) === selectedId ||
      endpointId(link.target) === selectedId
    return connected ? "rgba(100,116,139,0.75)" : "rgba(148,163,184,0.18)"
  }
  const handleNode = (node: GraphNode) => void loadNeighborhood(node.id)
  const fit = () => graph2dRef.current?.zoomToFit(300, 48)
  const drawNodeLabel = (
    nodeValue: Record<string, unknown>,
    context: CanvasRenderingContext2D,
    globalScale: number
  ) => {
    const node = nodeValue as unknown as GraphNode
    if (node.x === undefined || node.y === undefined) return
    const fontSize = Math.max(3.5, 11 / globalScale)
    const label =
      node.label.length > 34 ? `${node.label.slice(0, 31)}...` : node.label
    context.font = `500 ${fontSize}px Inter, sans-serif`
    context.textAlign = "center"
    context.textBaseline = "top"
    context.fillStyle =
      selectedId && !connectedIds.has(node.id)
        ? "rgba(100,116,139,0.55)"
        : resolvedTheme === "dark"
          ? "rgba(248,250,252,0.88)"
          : "rgba(15,23,42,0.88)"
    context.fillText(label, node.x, node.y + 7 / globalScale)
  }

  return (
    <section
      aria-label="Knowledge graph explorer"
      className="min-h-[calc(100svh-9rem)] bg-background"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-6">
        <form
          onSubmit={searchGraph}
          className="relative min-w-52 flex-1 sm:max-w-sm"
        >
          <Search
            className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 rounded-md pl-9"
            placeholder="Search nodes"
            aria-label="Search knowledge graph"
          />
        </form>
        <Select
          value={String(depth)}
          onValueChange={(value) => value && setDepth(Number(value))}
        >
          <SelectTrigger aria-label="Graph depth">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1 hop</SelectItem>
            <SelectItem value="2">2 hops</SelectItem>
            <SelectItem value="3">3 hops</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={nodeGroup}
          onValueChange={(value) =>
            value && setNodeGroup(value as keyof typeof nodeKindsByGroup)
          }
        >
          <SelectTrigger aria-label="Node category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All nodes</SelectItem>
            <SelectItem value="documentation">Documentation</SelectItem>
            <SelectItem value="product">Product</SelectItem>
            <SelectItem value="interface">Interface</SelectItem>
            <SelectItem value="api">API &amp; data</SelectItem>
            <SelectItem value="code">Code</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={relationship}
          onValueChange={(value) => value && setRelationship(value)}
        >
          <SelectTrigger aria-label="Relationship filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {relationshipOptions.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="rounded-md"
          onClick={fit}
          aria-label="Fit graph"
          title="Fit graph"
        >
          <Focus />
        </Button>
      </div>
      {results.length > 0 ? (
        <div className="border-b border-border bg-muted/25 px-4 py-2 sm:px-6">
          <p className="mb-1 text-xs text-muted-foreground">Search results</p>
          <div className="flex flex-wrap gap-1">
            {results.map((node) => (
              <Button
                key={node.id}
                type="button"
                variant="outline"
                size="xs"
                className="rounded-md"
                onClick={() => {
                  setResults([])
                  void loadNeighborhood(node.id)
                }}
              >
                {node.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="border-b border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      <div className="grid min-h-[620px] xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div
          ref={canvasRef}
          className="relative min-h-[620px] overflow-hidden bg-background"
        >
          {busy && !graph ? (
            <div className="absolute inset-0 z-10 grid place-items-center bg-background/80">
              <LoaderCircle className="size-5 animate-spin text-primary" />
              <span className="sr-only">Loading graph</span>
            </div>
          ) : null}
          <ForceGraph2D
            ref={graph2dRef}
            width={size.width}
            height={size.height}
            graphData={graphData}
            nodeId="id"
            nodeLabel={(node) =>
              `${String(node["label"])} / ${String(node["kind"])}`
            }
            nodeColor={(node) => nodeColor(node as unknown as GraphNode)}
            nodeRelSize={5}
            nodeCanvasObjectMode={() => "after"}
            nodeCanvasObject={drawNodeLabel}
            linkColor={(link) => linkColor(link as unknown as GraphLink)}
            linkWidth={(link) =>
              endpointId(link.source) === selectedId ||
              endpointId(link.target) === selectedId
                ? 2
                : 1
            }
            linkDirectionalArrowLength={4}
            onNodeClick={(node) => handleNode(node as unknown as GraphNode)}
            cooldownTicks={80}
            onEngineStop={fit}
          />
          <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-2 rounded-md border border-border bg-background/95 p-2 text-[0.6875rem] shadow-sm">
            {Object.entries(category).map(([key, value]) => {
              const Icon = value.icon
              return (
                <span key={key} className="flex items-center gap-1.5">
                  <Icon className="size-3.5" style={{ color: value.color }} />
                  {value.label}
                </span>
              )
            })}
          </div>
        </div>
        <aside className="border-t border-border bg-muted/15 p-4 xl:border-t-0 xl:border-l">
          {selected ? (
            <div className="grid gap-4">
              <div className="flex items-start gap-3">
                <span className="grid size-9 place-items-center rounded-md bg-background text-primary ring-1 ring-border">
                  <Network className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {selected.kind.replaceAll("-", " ")}
                  </p>
                  <h3 className="mt-1 text-sm font-semibold break-words">
                    {selected.label}
                  </h3>
                </div>
              </div>
              {selected.detail ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  {selected.detail}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline">Tier {selected.tier}</Badge>
                <Badge variant={selected.stale ? "destructive" : "secondary"}>
                  {selected.stale
                    ? "Stale"
                    : selected.reviewState.replaceAll("_", " ")}
                </Badge>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium">Connected nodes</p>
                <div className="grid gap-1">
                  {graph?.nodes
                    .filter(
                      (node) =>
                        node.id !== selected.id && connectedIds.has(node.id)
                    )
                    .map((node) => (
                      <Button
                        key={node.id}
                        type="button"
                        variant="ghost"
                        className="h-auto justify-start rounded-md px-2 py-2 text-left text-xs whitespace-normal"
                        onClick={() => handleNode({ ...node })}
                      >
                        {node.label}
                      </Button>
                    ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="grid min-h-44 place-items-center text-center text-sm text-muted-foreground">
              Select a node to inspect its evidence and relationships.
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}
