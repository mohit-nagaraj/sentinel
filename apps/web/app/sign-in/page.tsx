import type { Metadata } from "next"
import { LockKeyhole, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export const metadata: Metadata = {
  title: "Sign in | Sentinel",
  robots: { index: false, follow: false },
}

type SignInPageProps = {
  readonly searchParams: Promise<{
    readonly error?: string | string[]
    readonly next?: string | string[]
  }>
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const parameters = await searchParams
  const error =
    typeof parameters.error === "string" ? parameters.error : undefined
  const next = typeof parameters.next === "string" ? parameters.next : "/"

  return (
    <main className="grid min-h-svh place-items-center bg-muted/30 px-4 py-10 text-foreground">
      <section
        aria-labelledby="sign-in-heading"
        className="w-full max-w-sm rounded-md border border-border bg-background p-6 sm:p-8"
      >
        <header className="grid gap-4">
          <span className="grid size-10 place-items-center rounded-md border border-primary/25 bg-primary/5 text-primary">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold">Sentinel</p>
            <h1 id="sign-in-heading" className="mt-2 text-2xl font-semibold">
              Sign in
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Enter your operator token to continue.
            </p>
          </div>
        </header>

        {error === undefined ? null : (
          <div
            role="alert"
            className="mt-5 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error === "unavailable"
              ? "Operator authentication is not configured."
              : "That operator token is not valid."}
          </div>
        )}

        <form
          method="post"
          action="/api/auth/session"
          className="mt-6 grid gap-5"
        >
          <input type="hidden" name="next" value={next} />
          <div className="grid gap-2">
            <Label htmlFor="operator-token">Operator token</Label>
            <div className="relative">
              <LockKeyhole
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="operator-token"
                name="token"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                minLength={32}
                maxLength={4_096}
                className="h-11 rounded-md pl-10"
              />
            </div>
          </div>
          <Button type="submit" className="h-11 w-full rounded-md">
            Sign in
          </Button>
        </form>
      </section>
    </main>
  )
}
