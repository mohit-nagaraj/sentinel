import { LoaderCircle } from "lucide-react"

export default function LoadingKnowledge() {
  return (
    <main className="grid min-h-svh place-items-center bg-background text-foreground">
      <div
        role="status"
        className="grid justify-items-center gap-3 text-sm text-muted-foreground"
      >
        <LoaderCircle
          className="size-5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        Loading current knowledge
      </div>
    </main>
  )
}
