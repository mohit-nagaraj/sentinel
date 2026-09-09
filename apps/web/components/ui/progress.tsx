"use client"

import { Progress as ProgressPrimitive } from "@base-ui/react/progress"
import { cn } from "cn"

function Progress({
  className,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn("w-full", className)}
      {...props}
    >
      <ProgressPrimitive.Track className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <ProgressPrimitive.Indicator className="h-full bg-primary transition-transform" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  )
}

export { Progress }
