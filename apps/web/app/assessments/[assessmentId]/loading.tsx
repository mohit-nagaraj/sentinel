import { FileText, LoaderCircle } from "lucide-react"

export default function LoadingAssessmentReport() {
  return (
    <main className="grid min-h-svh place-items-center bg-background px-6 text-foreground">
      <div
        role="status"
        className="grid justify-items-center gap-3 text-sm text-muted-foreground"
      >
        <span className="relative grid size-10 place-items-center rounded-md border border-border">
          <FileText className="size-5" aria-hidden="true" />
          <LoaderCircle
            className="absolute -right-2 -bottom-2 size-4 animate-spin bg-background motion-reduce:animate-none"
            aria-hidden="true"
          />
        </span>
        Loading assessment report
      </div>
    </main>
  )
}
