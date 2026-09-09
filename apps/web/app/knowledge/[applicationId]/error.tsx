"use client"

import { AlertTriangle, RefreshCw } from "lucide-react"
import Link from "next/link"

import { Button } from "@/components/ui/button"

export default function KnowledgeError({
  unstable_retry,
}: {
  readonly error: Error & { readonly digest?: string }
  readonly unstable_retry: () => void
}) {
  return (
    <main className="grid min-h-svh place-items-center bg-background p-6 text-foreground">
      <div className="grid max-w-md justify-items-center gap-4 text-center">
        <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
        <div>
          <h1 className="text-base font-semibold">
            Knowledge is temporarily unavailable
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The current graph or its source summary could not be loaded.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            className="min-h-11 rounded-md"
            onClick={unstable_retry}
          >
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
          <Link
            href="/knowledge"
            className="inline-flex min-h-11 items-center rounded-md border border-border bg-input/30 px-3 text-sm font-medium hover:bg-input/50 focus-visible:outline-2 focus-visible:outline-primary"
          >
            Applications
          </Link>
        </div>
      </div>
    </main>
  )
}
