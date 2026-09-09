"use client"

import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { X } from "lucide-react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"

function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}
function SheetTrigger(props: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}
function SheetClose(props: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}
function SheetContent({
  className,
  children,
  ...props
}: SheetPrimitive.Popup.Props) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[min(20rem,88vw)] flex-col border-r border-border bg-sidebar outline-none data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left",
          className
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3 rounded-md"
            />
          }
        >
          <X aria-hidden="true" />
          <span className="sr-only">Close navigation</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  )
}
function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      className={cn("text-sm font-semibold", className)}
      {...props}
    />
  )
}
function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
}
