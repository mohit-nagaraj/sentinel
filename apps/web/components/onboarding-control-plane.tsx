"use client"

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  CheckCircle2,
  CircleDot,
  Eye,
  EyeOff,
  FileCheck2,
  FolderGit2,
  Gauge,
  Globe2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import type {
  CompatibilityEvidence,
  OnboardingActionState,
  OnboardingFormValues,
  PublicOnboardingApplication,
} from "@sentinel/contracts"

import { confirmOnboardingAction, inspectOnboardingAction } from "@/app/actions"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { useDashboardGuard } from "@/components/dashboard-shell"
import { cn } from "@/lib/utils"

const steps = [
  { label: "Sources", icon: FolderGit2 },
  { label: "Access", icon: KeyRound },
  { label: "Safety", icon: ShieldCheck },
  { label: "Review", icon: FileCheck2 },
] as const

const statusLabels: Readonly<Record<string, string>> = {
  not_configured: "Not configured",
  inspecting: "Inspecting",
  awaiting_confirmation: "Awaiting confirmation",
  initializing_knowledge: "Initializing knowledge",
  ready: "Ready",
  assessing_pr: "Assessing PR",
  verifying: "Verifying",
  refreshing: "Refreshing",
  needs_review: "Needs review",
  stale: "Stale",
  failed: "Blocked",
}

const capabilityLabels: Readonly<Record<string, string>> = {
  repository_resolved: "Repository resolved",
  application_reachable: "Application reachable",
  documentation_reachable: "Documentation reachable",
  typescript_react: "TypeScript / React",
  php_laravel: "PHP / Laravel",
  laravel_routes: "Laravel routes",
  openapi_scramble: "OpenAPI / Scramble",
  playwright_assets: "Playwright assets",
  authentication_automatable: "Authentication automatable",
  safe_action_policy: "Safe action policy",
}

const fieldClass =
  "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/15"
const textareaClass = cn(fieldClass, "h-auto min-h-24 resize-y py-2")

function newValues(): OnboardingFormValues {
  return {
    name: "",
    deploymentUrl: "",
    repositoryUrl: "",
    repositoryRef: "develop",
    repositoryAccessMode: "manual",
    githubInstallationId: "",
    documentationSources: "",
    previewUrlPattern: "",
    authenticationMethod: "none",
    authenticationAutomationConfirmed: false,
    credentialFields: [
      { key: "email", label: "Email or username" },
      { key: "password", label: "Password" },
    ],
    allowedHosts: "",
    maxActions: "40",
    maxScreens: "20",
    maxDurationSeconds: "300",
    allowFormSubmission: false,
    denyDestructiveActions: true,
    denyRealPayments: true,
    denyExternalMessaging: true,
    denyPrivilegeChanges: true,
    capabilityHints: "",
    testDataSetupReference: "",
    testDataResetReference: "",
  }
}

function valuesFromApplication(
  application: PublicOnboardingApplication
): OnboardingFormValues {
  const configuration = application.configuration
  return {
    recordId: application.id,
    name: application.name,
    deploymentUrl: application.deploymentUrl,
    repositoryUrl: configuration.repository.url,
    repositoryRef: configuration.repository.ref,
    repositoryAccessMode: configuration.repository.accessMode,
    githubInstallationId: configuration.repository.installationId ?? "",
    documentationSources: configuration.documentationSources.join("\n"),
    previewUrlPattern: configuration.previewUrlPattern ?? "",
    authenticationMethod: configuration.authentication.method,
    authenticationAutomationConfirmed:
      configuration.authentication.automationConfirmed,
    credentialFields:
      configuration.authentication.method === "credentials"
        ? configuration.authentication.configuredFields
        : [
            { key: "email", label: "Email or username" },
            { key: "password", label: "Password" },
          ],
    allowedHosts: configuration.crawl.allowedHosts.join(", "),
    maxActions: String(configuration.crawl.maxActions),
    maxScreens: String(configuration.crawl.maxScreens),
    maxDurationSeconds: String(configuration.crawl.maxDurationSeconds),
    allowFormSubmission: configuration.crawl.allowFormSubmission,
    denyDestructiveActions: configuration.crawl.denyDestructiveActions,
    denyRealPayments: configuration.crawl.denyRealPayments,
    denyExternalMessaging: configuration.crawl.denyExternalMessaging,
    denyPrivilegeChanges: configuration.crawl.denyPrivilegeChanges,
    capabilityHints: configuration.capabilityHints.join("\n"),
    testDataSetupReference: configuration.testDataSetupReference ?? "",
    testDataResetReference: configuration.testDataResetReference ?? "",
  }
}

function initialState(
  application: PublicOnboardingApplication | null
): OnboardingActionState {
  return {
    status: "idle",
    fieldErrors: {},
    values:
      application === null ? newValues() : valuesFromApplication(application),
    ...(application === null ? {} : { application }),
  }
}

function FieldError({
  errors,
  id,
}: {
  readonly errors?: readonly string[] | undefined
  readonly id: string
}) {
  if (errors === undefined || errors.length === 0) return null
  return (
    <div id={id} className="grid gap-1 text-xs text-destructive">
      {errors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </div>
  )
}

function Field({
  label,
  name,
  errors,
  children,
}: {
  readonly label: string
  readonly name: string
  readonly errors?: readonly string[] | undefined
  readonly children: React.ReactNode
}) {
  const errorId = `${name}-error`
  return (
    <Label className="grid min-w-0 gap-1.5 text-sm leading-normal font-medium select-auto">
      <span>{label}</span>
      {children}
      <FieldError errors={errors} id={errorId} />
    </Label>
  )
}

function StatusMark({ status }: { readonly status: string }) {
  if (status === "detected" || status === "ready") {
    return <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />
  }
  if (status === "blocked" || status === "failed") {
    return <XCircle className="size-4 text-destructive" aria-hidden="true" />
  }
  return <AlertTriangle className="size-4 text-amber-600" aria-hidden="true" />
}

function EvidenceRow({
  evidence,
}: {
  readonly evidence: CompatibilityEvidence
}) {
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-3 border-b border-border py-3 last:border-b-0">
      <StatusMark status={evidence.status} />
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {capabilityLabels[evidence.capability] ??
            evidence.capability.replaceAll("_", " ")}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {evidence.summary}
        </p>
      </div>
      <span className="font-mono text-[0.6875rem] text-muted-foreground uppercase">
        {evidence.source}
      </span>
    </li>
  )
}

function ApplicationRail({
  applications,
  selectedId,
  onSelect,
  onCreate,
}: {
  readonly applications: readonly PublicOnboardingApplication[]
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly onCreate: () => void
}) {
  return (
    <aside className="min-w-0 border-b border-border bg-muted/25 md:border-r md:border-b-0">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Applications</h2>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          className="rounded-md"
          onClick={onCreate}
          aria-label="New application"
          title="New application"
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <nav
        aria-label="Connected applications"
        className="flex max-w-full gap-2 overflow-x-auto p-3 md:grid md:overflow-visible"
      >
        {applications.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted-foreground">
            No connected applications
          </p>
        ) : (
          applications.map((application) => (
            <Button
              key={application.id}
              type="button"
              variant="ghost"
              onClick={() => onSelect(application.id)}
              aria-current={selectedId === application.id ? "page" : undefined}
              className={cn(
                "grid h-auto min-h-16 min-w-52 grid-cols-[minmax(0,1fr)_auto] items-start justify-normal gap-3 rounded-md border px-3 py-2.5 text-left whitespace-normal md:min-w-0",
                selectedId === application.id
                  ? "border-primary/40 bg-background hover:bg-background"
                  : "border-transparent hover:border-border hover:bg-background/75"
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {application.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {application.deploymentUrl}
                </span>
              </span>
              <CircleDot
                className={cn(
                  "mt-0.5 size-3.5",
                  application.status === "failed"
                    ? "text-destructive"
                    : application.status === "stale"
                      ? "text-amber-600"
                      : "text-primary"
                )}
                aria-label={
                  statusLabels[application.status] ?? application.status
                }
              />
            </Button>
          ))
        )}
      </nav>
    </aside>
  )
}

function StepNavigation({
  step,
  availableStep,
  onStep,
}: {
  readonly step: number
  readonly availableStep: number
  readonly onStep: (step: number) => void
}) {
  return (
    <aside
      aria-label="Onboarding progress"
      className="order-first lg:order-last"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">
          Setup progress
        </p>
        <span className="font-mono text-xs text-muted-foreground">
          {Math.min(availableStep, 4)} / 4
        </span>
      </div>
      <Progress value={Math.min(availableStep, 4) * 25} />
      <div
        role="tablist"
        aria-label="Onboarding steps"
        className="mt-4 grid grid-cols-4 gap-1 lg:grid-cols-1"
      >
        {steps.map(({ label, icon: Icon }, index) => {
          const locked = index > availableStep
          const complete = index < availableStep
          return (
            <Button
              key={label}
              type="button"
              variant="ghost"
              role="tab"
              aria-selected={step === index}
              aria-disabled={locked}
              disabled={locked}
              onClick={() => onStep(index)}
              className={cn(
                "h-auto min-h-11 min-w-0 justify-center rounded-md px-2 text-xs lg:justify-start lg:px-3",
                step === index
                  ? "bg-primary/10 text-primary hover:bg-primary/10"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              <span
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full border",
                  complete &&
                    "border-primary bg-primary text-primary-foreground",
                  step === index && !complete && "border-primary text-primary"
                )}
              >
                {complete ? (
                  <Check className="size-3.5" aria-hidden="true" />
                ) : (
                  <Icon className="size-3.5" aria-hidden="true" />
                )}
              </span>
              <span className="sr-only lg:not-sr-only lg:truncate">
                {label}
              </span>
              {locked ? (
                <LockKeyhole
                  className="ml-auto hidden size-3.5 lg:block"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          )
        })}
      </div>
    </aside>
  )
}

function Workspace({
  application,
  onApplication,
}: {
  readonly application: PublicOnboardingApplication | null
  readonly onApplication: (application: PublicOnboardingApplication) => void
}) {
  const { setDirty: setShellDirty } = useDashboardGuard()
  const seed = useMemo(() => initialState(application), [application])
  const initialAvailableStep = {
    none: 0,
    sources: 1,
    access: 2,
    safety: 3,
    review: 4,
  }[application?.completedThrough ?? "none"]
  const [step, setStep] = useState(Math.min(initialAvailableStep, 3))
  const [dirty, setDirty] = useState(false)
  const [state, setDisplayedState] = useState(seed)
  const inspectWithUpdate = useCallback(
    async (previousState: OnboardingActionState, formData: FormData) => {
      const result = await inspectOnboardingAction(previousState, formData)
      setDisplayedState(result)
      if (result.application !== undefined) {
        const nextCompleted = result.application.completedThrough
        if (nextCompleted === "sources") setStep(1)
        if (nextCompleted === "access") setStep(2)
        if (nextCompleted === "safety" || nextCompleted === "review") setStep(3)
        setDirty(false)
        setShellDirty(false)
        onApplication(result.application)
      }
      return result
    },
    [onApplication, setShellDirty]
  )
  const confirmWithUpdate = useCallback(
    async (previousState: OnboardingActionState, formData: FormData) => {
      const result = await confirmOnboardingAction(previousState, formData)
      setDisplayedState(result)
      if (result.application !== undefined) {
        setDirty(false)
        setShellDirty(false)
        onApplication(result.application)
      }
      return result
    },
    [onApplication, setShellDirty]
  )
  const [, inspectAction, inspectPending] = useActionState(
    inspectWithUpdate,
    seed
  )
  const [, confirmAction, confirmPending] = useActionState(
    confirmWithUpdate,
    seed
  )
  const currentApplication = state.application ?? application
  const completedStep = currentApplication?.completedThrough ?? "none"
  const availableStep = {
    none: 0,
    sources: 1,
    access: 2,
    safety: 3,
    review: 4,
  }[completedStep]
  const [authMethod, setAuthMethod] = useState(seed.values.authenticationMethod)
  const [accessMode, setAccessMode] = useState(seed.values.repositoryAccessMode)
  const [credentialFields, setCredentialFields] = useState(
    seed.values.credentialFields
  )
  const [showPassword, setShowPassword] = useState(false)
  const [reviewValues, setReviewValues] = useState({
    deploymentUrl: seed.values.deploymentUrl,
    repositoryRef: seed.values.repositoryRef,
  })
  const formRef = useRef<HTMLFormElement>(null)
  const radioId = useId()
  const pending = inspectPending || confirmPending

  const fieldErrors = state.fieldErrors
  const report = currentApplication?.compatibility

  useEffect(() => () => setShellDirty(false), [setShellDirty])

  const addCredentialField = () => {
    if (credentialFields.length >= 10) return
    const next = credentialFields.length + 1
    setCredentialFields([
      ...credentialFields,
      { key: `credential_${next}`, label: `Credential ${next}` },
    ])
  }

  const handleStep = (nextStep: number) => {
    if (nextStep > availableStep) return
    if (nextStep === 3 && formRef.current !== null) {
      const data = new FormData(formRef.current)
      const deploymentUrl = data.get("deploymentUrl")
      const repositoryRef = data.get("repositoryRef")
      setReviewValues({
        deploymentUrl: typeof deploymentUrl === "string" ? deploymentUrl : "",
        repositoryRef: typeof repositoryRef === "string" ? repositoryRef : "",
      })
    }
    setStep(nextStep)
  }

  return (
    <section className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <div className="mx-auto mb-5 flex w-full max-w-6xl flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted-foreground">
            {application === null
              ? "New application"
              : "Application configuration"}
          </p>
          <h2 className="truncate text-xl font-semibold">
            {currentApplication?.name || "Connect application"}
          </h2>
        </div>
        {currentApplication !== null && currentApplication !== undefined ? (
          <div className="flex items-center gap-2 text-xs">
            <StatusMark
              status={
                currentApplication.confirmed
                  ? "ready"
                  : currentApplication.status
              }
            />
            <span>
              {currentApplication.confirmed
                ? "Ready to initialize"
                : (statusLabels[currentApplication.status] ??
                  currentApplication.status)}
            </span>
            {currentApplication.confirmed ? (
              <span className="rounded-sm border border-primary/30 bg-primary/10 px-2 py-1 font-medium text-primary">
                Scope confirmed
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-start">
        <Card className="order-last min-w-0 rounded-lg lg:order-first">
          <form
            key={`${state.status}-${state.values.recordId ?? "new"}`}
            ref={formRef}
            action={inspectAction}
            className="min-w-0"
            onChange={() => {
              setDirty(true)
              setShellDirty(true)
            }}
          >
            <input
              type="hidden"
              name="completedThrough"
              value={step === 0 ? "sources" : step === 1 ? "access" : "safety"}
            />
            {state.values.recordId !== undefined ? (
              <input
                type="hidden"
                name="recordId"
                value={state.values.recordId}
              />
            ) : null}
            {report !== undefined ? (
              <input
                type="hidden"
                name="inputFingerprint"
                value={report.inputFingerprint}
              />
            ) : null}

            {state.status !== "idle" && state.message !== undefined ? (
              <div
                role={
                  state.status === "validation_error" ||
                  state.status === "error"
                    ? "alert"
                    : "status"
                }
                className={cn(
                  "flex items-start gap-2 border-b px-4 py-3 text-sm sm:px-6",
                  state.status === "validation_error" ||
                    state.status === "error"
                    ? "border-destructive/25 bg-destructive/5 text-destructive"
                    : "border-primary/20 bg-primary/5 text-foreground"
                )}
              >
                {state.status === "validation_error" ||
                state.status === "error" ? (
                  <AlertTriangle
                    className="mt-0.5 size-4 shrink-0"
                    aria-hidden="true"
                  />
                ) : (
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                )}
                <span>
                  {state.message}
                  {state.status === "validation_error" ? (
                    <span className="mt-1 block text-xs">
                      {Object.values(fieldErrors).flat().join(" ")}
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null}
            {fieldErrors["form"] ? (
              <div className="border-b border-destructive/25 bg-destructive/5 px-4 py-3 sm:px-6">
                <FieldError
                  errors={fieldErrors["form"]}
                  id="onboarding-form-error"
                />
              </div>
            ) : null}

            <div className="w-full px-4 py-6 sm:px-6 sm:py-7">
              <fieldset hidden={step !== 0} className="grid gap-6">
                <legend className="mb-1 text-base font-semibold">
                  Sources
                </legend>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Application name"
                    name="name"
                    errors={fieldErrors["name"]}
                  >
                    <Input
                      className={fieldClass}
                      name="name"
                      defaultValue={state.values.name}
                      aria-invalid={fieldErrors["name"] ? true : undefined}
                    />
                  </Field>
                  <Field
                    label="Application URL"
                    name="deploymentUrl"
                    errors={fieldErrors["deploymentUrl"]}
                  >
                    <Input
                      className={fieldClass}
                      type="url"
                      name="deploymentUrl"
                      placeholder="https://app.example.com"
                      defaultValue={state.values.deploymentUrl}
                      aria-invalid={
                        fieldErrors["deploymentUrl"] ? true : undefined
                      }
                    />
                  </Field>
                  <Field
                    label="GitHub repository"
                    name="repositoryUrl"
                    errors={fieldErrors["repositoryUrl"]}
                  >
                    <Input
                      className={fieldClass}
                      type="url"
                      name="repositoryUrl"
                      placeholder="https://github.com/owner/repository"
                      defaultValue={state.values.repositoryUrl}
                      aria-invalid={
                        fieldErrors["repositoryUrl"] ? true : undefined
                      }
                    />
                  </Field>
                  <Field
                    label="Branch or commit"
                    name="repositoryRef"
                    errors={fieldErrors["repositoryRef"]}
                  >
                    <Input
                      className={fieldClass}
                      name="repositoryRef"
                      defaultValue={state.values.repositoryRef}
                      aria-invalid={
                        fieldErrors["repositoryRef"] ? true : undefined
                      }
                    />
                  </Field>
                  <Field
                    label="Repository connection"
                    name="repositoryAccessMode"
                    errors={fieldErrors["repositoryAccessMode"]}
                  >
                    <NativeSelect
                      className="w-full [&>select]:h-10 [&>select]:rounded-md [&>select]:bg-background [&>select]:text-base"
                      name="repositoryAccessMode"
                      value={accessMode}
                      onChange={(event) =>
                        setAccessMode(
                          event.target.value as "manual" | "github_app"
                        )
                      }
                    >
                      <NativeSelectOption value="manual">
                        Manual URL
                      </NativeSelectOption>
                      <NativeSelectOption value="github_app">
                        GitHub App installation
                      </NativeSelectOption>
                    </NativeSelect>
                  </Field>
                  {accessMode === "github_app" ? (
                    <Field
                      label="GitHub installation ID"
                      name="githubInstallationId"
                      errors={fieldErrors["githubInstallationId"]}
                    >
                      <Input
                        className={fieldClass}
                        inputMode="numeric"
                        name="githubInstallationId"
                        defaultValue={state.values.githubInstallationId}
                      />
                    </Field>
                  ) : null}
                  <Field
                    label="Preview URL pattern"
                    name="previewUrlPattern"
                    errors={fieldErrors["previewUrlPattern"]}
                  >
                    <Input
                      className={fieldClass}
                      name="previewUrlPattern"
                      placeholder="https://{branch}.preview.example.com"
                      defaultValue={state.values.previewUrlPattern}
                    />
                  </Field>
                </div>
                <Field
                  label="Documentation sources"
                  name="documentationSources"
                  errors={fieldErrors["documentationSources"]}
                >
                  <Textarea
                    className={textareaClass}
                    name="documentationSources"
                    placeholder={
                      "https://docs.example.com\nrepository://README.md"
                    }
                    defaultValue={state.values.documentationSources}
                  />
                </Field>
              </fieldset>

              <fieldset hidden={step !== 1} className="grid gap-6">
                <legend className="mb-1 text-base font-semibold">
                  Authentication
                </legend>
                <div
                  role="radiogroup"
                  aria-label="Authentication method"
                  className="grid grid-cols-1 border border-border sm:grid-cols-3"
                >
                  {(
                    [
                      ["none", "No authentication", Globe2],
                      ["credentials", "Credentials", KeyRound],
                      ["storage_state", "Storage state", LockKeyhole],
                    ] as const
                  ).map(([value, label, Icon], index) => (
                    <Label
                      key={value}
                      className={cn(
                        "flex min-h-12 cursor-pointer items-center justify-center gap-2 border-b border-border px-3 text-sm leading-normal select-auto last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0",
                        authMethod === value
                          ? "bg-primary/10 text-foreground"
                          : "bg-background text-muted-foreground hover:bg-muted/50"
                      )}
                    >
                      <input
                        className="sr-only"
                        id={`${radioId}-${index}`}
                        type="radio"
                        name="authenticationMethod"
                        value={value}
                        checked={authMethod === value}
                        onChange={() => setAuthMethod(value)}
                      />
                      <Icon className="size-4" aria-hidden="true" />
                      <span>{label}</span>
                    </Label>
                  ))}
                </div>
                <FieldError
                  errors={fieldErrors["authentication"]}
                  id="authentication-error"
                />

                {authMethod !== "none" ? (
                  <Label className="flex min-h-11 items-center gap-3 border-y border-border py-3 text-sm leading-normal font-normal select-auto">
                    <input
                      className="size-4 accent-[var(--primary)]"
                      type="checkbox"
                      name="authenticationAutomationConfirmed"
                      defaultChecked={
                        state.values.authenticationAutomationConfirmed
                      }
                    />
                    Automated login works without CAPTCHA or human verification
                  </Label>
                ) : null}

                {authMethod === "credentials" ? (
                  <div className="grid gap-5 rounded-md border border-border bg-muted/15 p-4">
                    <div className="grid gap-3 sm:flex sm:items-center sm:justify-between">
                      <div>
                        <h3 className="text-sm font-semibold">
                          Sign-in credentials
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Stored securely and used only for automated sign-in.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="rounded-md"
                        onClick={addCredentialField}
                        disabled={credentialFields.length >= 10}
                      >
                        <Plus aria-hidden="true" />
                        Add custom credential
                      </Button>
                    </div>
                    {credentialFields.map((field, index) => (
                      <div
                        key={`${field.key}-${index}`}
                        className={cn(
                          "grid gap-3",
                          index >= 2 &&
                            "border-t border-border pt-4 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1.2fr)_2.5rem]"
                        )}
                      >
                        {index < 2 ? (
                          <>
                            <input
                              type="hidden"
                              name="credentialKey"
                              value={field.key}
                            />
                            <input
                              type="hidden"
                              name="credentialLabel"
                              value={field.label}
                            />
                            <div className="grid gap-1.5">
                              <div className="flex items-center justify-between gap-3">
                                <Label
                                  htmlFor={`credential-value-${index}`}
                                  className="leading-normal"
                                >
                                  {index === 0
                                    ? "Email or username"
                                    : "Password"}
                                </Label>
                                {application?.configuration.authentication.configuredFields.some(
                                  (configured) => configured.key === field.key
                                ) ? (
                                  <Badge
                                    variant="outline"
                                    className="text-primary"
                                  >
                                    Configured
                                  </Badge>
                                ) : null}
                              </div>
                              <div className="relative">
                                <Input
                                  id={`credential-value-${index}`}
                                  className={cn(
                                    fieldClass,
                                    index === 1 && "pr-11"
                                  )}
                                  type={
                                    index === 1 && !showPassword
                                      ? "password"
                                      : "text"
                                  }
                                  name="credentialValue"
                                  autoComplete={
                                    index === 0 ? "username" : "new-password"
                                  }
                                  placeholder={
                                    application === null
                                      ? index === 0
                                        ? "name@example.com"
                                        : "Enter password"
                                      : "Leave blank to keep configured value"
                                  }
                                />
                                {index === 1 ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="absolute top-1 right-1 rounded-md text-muted-foreground"
                                    onClick={() =>
                                      setShowPassword((value) => !value)
                                    }
                                    aria-label={
                                      showPassword
                                        ? "Hide password"
                                        : "Show password"
                                    }
                                    title={
                                      showPassword
                                        ? "Hide password"
                                        : "Show password"
                                    }
                                  >
                                    {showPassword ? <EyeOff /> : <Eye />}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          </>
                        ) : (
                          <>
                            <Field
                              label="Field key"
                              name={`credentialKey-${index}`}
                            >
                              <Input
                                className={fieldClass}
                                name="credentialKey"
                                value={field.key}
                                onChange={(event) =>
                                  setCredentialFields(
                                    credentialFields.map((entry, entryIndex) =>
                                      entryIndex === index
                                        ? { ...entry, key: event.target.value }
                                        : entry
                                    )
                                  )
                                }
                              />
                            </Field>
                            <Field
                              label="Field label"
                              name={`credentialLabel-${index}`}
                            >
                              <Input
                                className={fieldClass}
                                name="credentialLabel"
                                value={field.label}
                                onChange={(event) =>
                                  setCredentialFields(
                                    credentialFields.map((entry, entryIndex) =>
                                      entryIndex === index
                                        ? {
                                            ...entry,
                                            label: event.target.value,
                                          }
                                        : entry
                                    )
                                  )
                                }
                              />
                            </Field>
                            <Field
                              label={`${field.label || `Credential ${index + 1}`} secret value`}
                              name={`credentialValue-${index}`}
                            >
                              <Input
                                className={fieldClass}
                                type="password"
                                name="credentialValue"
                                autoComplete="new-password"
                                placeholder={
                                  application === null
                                    ? "Enter value"
                                    : "Leave blank to keep"
                                }
                              />
                            </Field>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="mt-6 rounded-md text-muted-foreground hover:text-destructive"
                              onClick={() =>
                                setCredentialFields(
                                  credentialFields.filter(
                                    (_, entryIndex) => entryIndex !== index
                                  )
                                )
                              }
                              aria-label={`Remove ${field.label || `credential ${index + 1}`}`}
                              title="Remove credential field"
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}

                {authMethod === "storage_state" ? (
                  <Field label="Encrypted storage state" name="storageState">
                    <Textarea
                      className={cn(
                        textareaClass,
                        "min-h-40 font-mono text-sm"
                      )}
                      name="storageState"
                      autoComplete="off"
                      placeholder={
                        application === null
                          ? '{"cookies":[],"origins":[]}'
                          : "Leave blank to keep configured state"
                      }
                    />
                  </Field>
                ) : null}
              </fieldset>

              <fieldset hidden={step !== 2} className="grid gap-6">
                <legend className="mb-1 text-base font-semibold">
                  Crawl safety
                </legend>
                <Field
                  label="Allowed hosts"
                  name="allowedHosts"
                  errors={fieldErrors["allowedHosts"]}
                >
                  <Input
                    className={fieldClass}
                    name="allowedHosts"
                    placeholder="app.example.com, api.example.com"
                    defaultValue={state.values.allowedHosts}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Maximum actions"
                    name="maxActions"
                    errors={fieldErrors["maxActions"]}
                  >
                    <Input
                      className={fieldClass}
                      type="number"
                      min="1"
                      max="500"
                      name="maxActions"
                      defaultValue={state.values.maxActions}
                    />
                  </Field>
                  <Field
                    label="Maximum screens"
                    name="maxScreens"
                    errors={fieldErrors["maxScreens"]}
                  >
                    <Input
                      className={fieldClass}
                      type="number"
                      min="1"
                      max="500"
                      name="maxScreens"
                      defaultValue={state.values.maxScreens}
                    />
                  </Field>
                  <Field
                    label="Time limit (seconds)"
                    name="maxDurationSeconds"
                    errors={fieldErrors["maxDurationSeconds"]}
                  >
                    <Input
                      className={fieldClass}
                      type="number"
                      min="10"
                      max="3600"
                      name="maxDurationSeconds"
                      defaultValue={state.values.maxDurationSeconds}
                    />
                  </Field>
                </div>
                <Label className="flex min-h-11 items-center gap-3 border-y border-border py-3 text-sm leading-normal font-normal select-auto">
                  <input
                    className="size-4 accent-[var(--primary)]"
                    type="checkbox"
                    name="allowFormSubmission"
                    defaultChecked={state.values.allowFormSubmission}
                  />
                  Allow non-destructive form submission
                </Label>
                <div
                  className="grid gap-2"
                  aria-label="Mandatory action denials"
                >
                  {[
                    ["denyDestructiveActions", "Block destructive actions"],
                    ["denyRealPayments", "Block real payments"],
                    ["denyExternalMessaging", "Block external messages"],
                    ["denyPrivilegeChanges", "Block privilege changes"],
                  ].map(([name, label]) => (
                    <Label
                      key={name}
                      className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-muted/25 px-3 text-sm leading-normal font-normal select-auto"
                    >
                      <input type="hidden" name={name} value="on" />
                      <input
                        className="size-4 accent-[var(--primary)]"
                        type="checkbox"
                        checked
                        disabled
                        readOnly
                      />
                      <LockKeyhole
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {label}
                    </Label>
                  ))}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Target setup reference"
                    name="testDataSetupReference"
                  >
                    <Textarea
                      className={textareaClass}
                      name="testDataSetupReference"
                      defaultValue={state.values.testDataSetupReference}
                    />
                  </Field>
                  <Field
                    label="Target reset reference"
                    name="testDataResetReference"
                  >
                    <Textarea
                      className={textareaClass}
                      name="testDataResetReference"
                      defaultValue={state.values.testDataResetReference}
                    />
                  </Field>
                </div>
                <Field
                  label="Capability or workflow hints"
                  name="capabilityHints"
                >
                  <Textarea
                    className={textareaClass}
                    name="capabilityHints"
                    placeholder={
                      "Attendee checkout\nOrganizer order visibility"
                    }
                    defaultValue={state.values.capabilityHints}
                  />
                </Field>
              </fieldset>

              <fieldset hidden={step !== 3} className="grid gap-7">
                <legend className="mb-1 text-base font-semibold">
                  Compatibility and scope
                </legend>
                <div className="grid gap-3 border-y border-border py-4 sm:grid-cols-3">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted-foreground">
                      Application
                    </p>
                    <p className="truncate text-sm">
                      {reviewValues.deploymentUrl || "Not set"}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted-foreground">
                      Repository ref
                    </p>
                    <p className="truncate text-sm">
                      {reviewValues.repositoryRef || "Not set"}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted-foreground">
                      Authentication
                    </p>
                    <p className="text-sm capitalize">
                      {authMethod.replace("_", " ")}
                    </p>
                  </div>
                </div>

                {report === undefined ? (
                  <div className="flex min-h-44 flex-col items-center justify-center gap-3 border-y border-border bg-muted/20 px-4 text-center">
                    <Gauge
                      className="size-6 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <p className="text-sm font-medium">
                      No compatibility inspection yet
                    </p>
                  </div>
                ) : (
                  <div className="grid gap-7 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
                    <section className="min-w-0">
                      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                        <h3 className="text-sm font-semibold">
                          Readiness evidence
                        </h3>
                        <span
                          className={cn(
                            "rounded-sm border px-2 py-1 text-xs font-medium capitalize",
                            report.status === "blocked"
                              ? "border-destructive/30 bg-destructive/5 text-destructive"
                              : report.status === "partial"
                                ? "border-amber-500/30 bg-amber-500/10 text-amber-700"
                                : "border-primary/30 bg-primary/10 text-primary"
                          )}
                        >
                          {report.status}
                        </span>
                      </div>
                      <ul>
                        {report.evidence.map((evidence) => (
                          <EvidenceRow
                            key={`${evidence.capability}-${evidence.code}`}
                            evidence={evidence}
                          />
                        ))}
                      </ul>
                    </section>
                    <div className="grid content-start gap-6">
                      <section>
                        <h3 className="border-b border-border pb-3 text-sm font-semibold">
                          Proposed scope
                        </h3>
                        <dl className="grid gap-3 py-3 text-sm">
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              Immutable commit
                            </dt>
                            <dd className="font-mono text-xs break-all">
                              {report.resolvedCommitSha ?? "Unresolved"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              Repository roots
                            </dt>
                            <dd>
                              {report.proposedScope.repositoryPaths.join(
                                ", "
                              ) || "None"}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              Application origin
                            </dt>
                            <dd className="text-xs break-all">
                              {report.proposedScope.applicationOrigins.join(
                                ", "
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              Documentation
                            </dt>
                            <dd className="text-xs break-words">
                              {report.proposedScope.documentationSources.join(
                                ", "
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              Allowed actions
                            </dt>
                            <dd className="text-xs">
                              {report.proposedScope.allowedActionCategories
                                .map((category) =>
                                  category.replaceAll("_", " ")
                                )
                                .join(", ")}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-muted-foreground">
                              Limits
                            </dt>
                            <dd>
                              {report.proposedScope.maxActions} actions ·{" "}
                              {report.proposedScope.maxScreens} screens ·{" "}
                              {report.proposedScope.maxDurationSeconds}s
                            </dd>
                          </div>
                        </dl>
                      </section>
                      {report.findings.length > 0 ? (
                        <section>
                          <h3 className="border-b border-border pb-3 text-sm font-semibold">
                            Required attention
                          </h3>
                          <ul className="grid gap-3 py-3">
                            {report.findings.map((finding) => (
                              <li
                                key={finding.code}
                                className="flex items-start gap-2 text-sm"
                              >
                                <StatusMark
                                  status={
                                    finding.severity === "blocker"
                                      ? "blocked"
                                      : "warning"
                                  }
                                />
                                <span>
                                  <span className="block font-medium">
                                    {finding.summary}
                                  </span>
                                  <span className="block text-xs leading-5 text-muted-foreground">
                                    {finding.humanAction}
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </div>
                  </div>
                )}
              </fieldset>
            </div>

            <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
              <Button
                type="button"
                variant="outline"
                className="rounded-md"
                onClick={() => handleStep(Math.max(0, step - 1))}
                disabled={step === 0 || pending}
              >
                <ArrowLeft aria-hidden="true" />
                Back
              </Button>
              <div className="flex items-center gap-2">
                {dirty && report !== undefined ? (
                  <span className="text-xs text-amber-700">
                    Reinspect before confirming changes
                  </span>
                ) : null}
                {step < steps.length - 1 ? (
                  <Button
                    type="submit"
                    className="w-full rounded-md sm:w-auto"
                    disabled={pending}
                  >
                    {inspectPending ? (
                      <LoaderCircle
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : null}
                    {step === 2 ? "Inspect and continue" : "Save and continue"}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                ) : (
                  <>
                    <Button
                      type="submit"
                      variant="outline"
                      className="rounded-md"
                      disabled={pending}
                    >
                      {inspectPending ? (
                        <LoaderCircle
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      ) : report === undefined ? (
                        <Gauge aria-hidden="true" />
                      ) : (
                        <RefreshCw aria-hidden="true" />
                      )}
                      {report === undefined
                        ? "Inspect compatibility"
                        : "Reinspect"}
                    </Button>
                    {report !== undefined &&
                    report.status !== "blocked" &&
                    !dirty &&
                    !currentApplication?.confirmed ? (
                      <Button
                        type="submit"
                        formAction={confirmAction}
                        className="rounded-md"
                        disabled={pending}
                      >
                        {confirmPending ? (
                          <LoaderCircle
                            className="animate-spin"
                            aria-hidden="true"
                          />
                        ) : (
                          <Check aria-hidden="true" />
                        )}
                        Confirm scope
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </form>
        </Card>
        <StepNavigation
          step={step}
          availableStep={availableStep}
          onStep={handleStep}
        />
      </div>
    </section>
  )
}

export function ApplicationOnboarding({
  initialApplication,
}: {
  readonly initialApplication: PublicOnboardingApplication | null
}) {
  const router = useRouter()
  const [application, setApplication] = useState(initialApplication)
  const handleApplication = useCallback(
    (next: PublicOnboardingApplication) => {
      setApplication(next)
      if (application === null) {
        router.replace(`/applications/${next.id}/onboarding`)
      }
      router.refresh()
    },
    [application, router]
  )
  return (
    <main className="min-h-full">
      <Workspace
        key={application?.id ?? "new"}
        application={application}
        onApplication={handleApplication}
      />
    </main>
  )
}

export function OnboardingControlPlane({
  initialApplications,
  configurationUnavailable = false,
}: {
  readonly initialApplications: readonly PublicOnboardingApplication[]
  readonly configurationUnavailable?: boolean
}) {
  const [applications, setApplications] = useState(initialApplications)
  const [selectedId, setSelectedId] = useState<string | null>(
    initialApplications[0]?.id ?? null
  )
  const [creating, setCreating] = useState(initialApplications.length === 0)
  const selected = creating
    ? null
    : (applications.find((application) => application.id === selectedId) ??
      null)

  const handleApplication = useCallback(
    (application: PublicOnboardingApplication) => {
      setApplications((current) => {
        const exists = current.some((entry) => entry.id === application.id)
        return exists
          ? current.map((entry) =>
              entry.id === application.id ? application : entry
            )
          : [application, ...current]
      })
      setCreating(false)
      setSelectedId(application.id)
    },
    []
  )

  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="flex min-h-14 items-center justify-between gap-4 border-b border-border px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="grid size-7 place-items-center rounded-md bg-foreground font-mono text-xs font-semibold text-background">
            S
          </span>
          <div>
            <h1 className="text-sm font-semibold">Sentinel</h1>
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              Control plane
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/knowledge"
            className="flex min-h-11 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            <BookOpenCheck className="size-4" aria-hidden="true" />
            Knowledge
          </Link>
          <Link
            href="/runs"
            className="flex min-h-11 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Activity className="size-4" aria-hidden="true" />
            Activity
          </Link>
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            Read-only target access
          </div>
        </div>
      </header>

      {configurationUnavailable ? (
        <div
          role="alert"
          className="border-b border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive sm:px-6"
        >
          Control-plane server configuration is unavailable.
        </div>
      ) : null}

      <div className="grid min-h-[calc(100svh-3.5rem)] grid-cols-1 content-start md:grid-cols-[16rem_minmax(0,1fr)] md:content-stretch">
        <ApplicationRail
          applications={applications}
          selectedId={creating ? null : selectedId}
          onSelect={(id) => {
            setSelectedId(id)
            setCreating(false)
          }}
          onCreate={() => {
            setCreating(true)
            setSelectedId(null)
          }}
        />
        <Workspace
          key={creating ? "new" : (selected?.id ?? "new")}
          application={selected}
          onApplication={handleApplication}
        />
      </div>
    </main>
  )
}
