"use client"

import {
  Activity,
  AppWindow,
  BookOpenCheck,
  Check,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  CircleDot,
  Menu,
  Moon,
  Plus,
  Settings2,
  Sun,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useParams, usePathname, useRouter } from "next/navigation"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  useState,
} from "react"

import type { PublicOnboardingApplication } from "@sentinel/contracts"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type DashboardGuard = {
  readonly dirty: boolean
  readonly setDirty: (dirty: boolean) => void
}

const DashboardGuardContext = createContext<DashboardGuard>({
  dirty: false,
  setDirty: () => undefined,
})

export function useDashboardGuard() {
  return useContext(DashboardGuardContext)
}

function sectionFor(pathname: string) {
  if (pathname.includes("/knowledge")) return "knowledge"
  if (pathname.includes("/activity")) return "activity"
  return "onboarding"
}

function destination(applicationId: string, section: string) {
  return `/applications/${applicationId}/${section}`
}

function ThemeMenu({ collapsed }: { readonly collapsed: boolean }) {
  const { theme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  )
  const displayedTheme = mounted ? theme : "system"
  const Icon =
    displayedTheme === "dark"
      ? Moon
      : displayedTheme === "light"
        ? Sun
        : Settings2

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "h-10 w-full justify-start rounded-md text-muted-foreground",
              collapsed && "justify-center px-0"
            )}
          />
        }
      >
        <Icon aria-hidden="true" />
        {collapsed ? (
          <span className="sr-only">Theme</span>
        ) : (
          <span>Theme</span>
        )}
        {!collapsed && mounted ? (
          <span className="ml-auto text-xs capitalize">{theme}</span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-48">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={displayedTheme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">
            <Sun />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Settings2 />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ApplicationMenu({
  applications,
  selected,
  collapsed,
  onNavigate,
}: {
  readonly applications: readonly PublicOnboardingApplication[]
  readonly selected: PublicOnboardingApplication | undefined
  readonly collapsed: boolean
  readonly onNavigate: (href: string) => void
}) {
  const pathname = usePathname()
  const section = sectionFor(pathname)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={cn(
              "h-auto min-h-11 w-full justify-start rounded-md bg-background px-2.5",
              collapsed && "justify-center px-0"
            )}
          />
        }
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-foreground text-xs font-semibold text-background">
          {selected?.name.slice(0, 1).toUpperCase() ?? "+"}
        </span>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm font-medium">
                {selected?.name ?? "New application"}
              </span>
              <span className="block truncate text-[0.6875rem] text-muted-foreground">
                {selected?.confirmed ? "Connected" : "Onboarding"}
              </span>
            </span>
            <ChevronDown
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          </>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64">
        <DropdownMenuLabel>Applications</DropdownMenuLabel>
        {applications.map((application) => (
          <DropdownMenuItem
            key={application.id}
            onClick={() => onNavigate(destination(application.id, section))}
          >
            <CircleDot
              className={
                application.confirmed ? "text-primary" : "text-amber-600"
              }
            />
            <span className="min-w-0 flex-1 truncate">{application.name}</span>
            {application.id === selected?.id ? <Check /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onNavigate("/applications/new/onboarding")}
        >
          <Plus /> Add application
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ShellNavigation({
  applications,
  selected,
  applicationId,
  collapsed,
  onNavigate,
  onCollapse,
}: {
  readonly applications: readonly PublicOnboardingApplication[]
  readonly selected: PublicOnboardingApplication | undefined
  readonly applicationId?: string | undefined
  readonly collapsed: boolean
  readonly onNavigate: (href: string) => void
  readonly onCollapse?: () => void
}) {
  const pathname = usePathname()
  const section = sectionFor(pathname)
  const items = [
    { id: "onboarding", label: "Onboarding", icon: AppWindow },
    { id: "knowledge", label: "Knowledge", icon: BookOpenCheck },
    { id: "activity", label: "Activity", icon: Activity },
  ] as const

  return (
    <TooltipProvider>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-foreground font-mono text-xs font-semibold text-background">
            S
          </span>
          {!collapsed ? (
            <span className="text-sm font-semibold">Sentinel</span>
          ) : null}
          {onCollapse ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto rounded-md text-muted-foreground"
              onClick={onCollapse}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
            </Button>
          ) : null}
        </div>
        <nav aria-label="Application navigation" className="grid gap-1 p-2">
          {items.map(({ id, label, icon: Icon }) => {
            const active = section === id
            const disabled = applicationId === undefined && id !== "onboarding"
            const control = (
              <Button
                key={id}
                type="button"
                variant="ghost"
                disabled={disabled}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "h-10 w-full justify-start rounded-md px-2.5",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground",
                  collapsed && "justify-center px-0"
                )}
                onClick={() =>
                  applicationId && onNavigate(destination(applicationId, id))
                }
              >
                <Icon aria-hidden="true" />
                {collapsed ? (
                  <span className="sr-only">{label}</span>
                ) : (
                  <span>{label}</span>
                )}
                {!collapsed &&
                id === "onboarding" &&
                selected &&
                !selected.confirmed ? (
                  <Badge variant="outline" className="ml-auto">
                    Setup
                  </Badge>
                ) : null}
                {!collapsed &&
                id === "knowledge" &&
                selected?.knowledgeStale ? (
                  <span
                    className="ml-auto size-2 rounded-full bg-amber-500"
                    aria-label="Knowledge is stale"
                  />
                ) : null}
              </Button>
            )
            return collapsed ? (
              <Tooltip key={id}>
                <TooltipTrigger render={control} />
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ) : (
              control
            )
          })}
        </nav>
        <div className="mt-auto grid gap-1 border-t border-sidebar-border p-2">
          <ThemeMenu collapsed={collapsed} />
          <ApplicationMenu
            applications={applications}
            selected={selected}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </TooltipProvider>
  )
}

export function DashboardShell({
  applications,
  children,
}: {
  readonly applications: readonly PublicOnboardingApplication[]
  readonly children: React.ReactNode
}) {
  const params = useParams<{ applicationId?: string }>()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pendingHref, setPendingHref] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const selected = useMemo(
    () =>
      applications.find(
        (application) => application.id === params.applicationId
      ),
    [applications, params.applicationId]
  )

  useEffect(() => {
    if (!dirty) return
    const handleBeforeUnload = (event: BeforeUnloadEvent) =>
      event.preventDefault()
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [dirty])

  const navigate = useCallback(
    (href: string) => {
      setMobileOpen(false)
      if (dirty) setPendingHref(href)
      else router.push(href)
    },
    [dirty, router]
  )

  return (
    <DashboardGuardContext.Provider value={{ dirty, setDirty }}>
      <div className="min-h-svh bg-muted/25 text-foreground lg:grid lg:grid-cols-[auto_minmax(0,1fr)]">
        <aside
          className={cn(
            "sticky top-0 hidden h-svh border-r border-sidebar-border bg-sidebar transition-[width] duration-200 lg:block",
            collapsed ? "w-14" : "w-[15.5rem]"
          )}
        >
          <ShellNavigation
            applications={applications}
            selected={selected}
            applicationId={params.applicationId}
            collapsed={collapsed}
            onNavigate={navigate}
            onCollapse={() => setCollapsed((value) => !value)}
          />
        </aside>
        <div className="min-w-0">
          <header className="flex h-14 items-center gap-3 border-b border-border bg-background px-3 lg:hidden">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="rounded-md"
                  />
                }
              >
                <Menu />
                <span className="sr-only">Open navigation</span>
              </SheetTrigger>
              <SheetContent>
                <SheetTitle className="sr-only">Sentinel navigation</SheetTitle>
                <SheetDescription className="sr-only">
                  Choose a section or application
                </SheetDescription>
                <ShellNavigation
                  applications={applications}
                  selected={selected}
                  applicationId={params.applicationId}
                  collapsed={false}
                  onNavigate={navigate}
                />
              </SheetContent>
            </Sheet>
            <span className="text-sm font-semibold">Sentinel</span>
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              / {selected?.name ?? "New application"}
            </span>
          </header>
          <div className="min-h-[calc(100svh-3.5rem)] lg:min-h-svh">
            {children}
          </div>
        </div>
      </div>
      <AlertDialog
        open={pendingHref !== null}
        onOpenChange={(open) => !open && setPendingHref(null)}
      >
        <AlertDialogContent>
          <div className="grid gap-2">
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your completed onboarding steps are saved, but changes on this
              step have not been saved yet.
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay here</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => {
                const href = pendingHref
                setPendingHref(null)
                setDirty(false)
                if (href) router.push(href)
              }}
            >
              Discard and continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardGuardContext.Provider>
  )
}
