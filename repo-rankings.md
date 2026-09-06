# Repository Rankings for the Testsigma Take-Home

Research date: 2026-09-06

## System Boundary: Repository Intake Is Part of the Product

The target repository should **not** be compiled into the agent or manually modeled in advance. Repository onboarding is part of the system being demonstrated. Hi.Events is the first reference target used to implement and evaluate that generic intake path, not a special-case implementation.

The intended lifecycle is continuous:

```text
Initial onboarding
  -> validate target compatibility
  -> discover repositories, documentation, deployment, and supported languages
  -> crawl the running application
  -> ingest and structure product requirements
  -> extract code structure and runtime API evidence
  -> build the initial versioned knowledge graph

Every new pull request
  -> parse the diff against the graph's indexed base commit
  -> identify changed files and symbols
  -> traverse code -> API -> UI -> flow -> requirement relationships
  -> produce a provisional blast-radius report

After merge and deployment
  -> incrementally re-index changed code
  -> re-crawl affected or stale workflows
  -> confirm, revise, or retire inferred relationships
  -> record newly observed UI, requirements coverage, and absences
  -> advance the graph to the deployed commit/version
```

The knowledge graph is therefore a **versioned, continuously updated model**, not a one-time database built specifically for the demonstration repository. Each node and relationship should retain its source commit, crawl run, evidence, extraction method, confidence, and validity period so the system can distinguish current knowledge from stale knowledge.

### Compatibility rules

“Works for any repository” should mean **any target that passes an explicit compatibility contract**, not literally every GitHub repository. Intake should validate these rules before indexing:

1. A reachable web application or reproducible deployment must exist.
2. Public product documentation, a README, PRD, wiki, or feature specification must exist.
3. The application must map to one or more accessible source repositories.
4. The exact deployed or locally tested commit must be identifiable.
5. A real pull request with a resolvable base and head must be available.
6. At least one repository language/framework must have a supported extraction adapter.
7. Authentication must be automatable through supplied test credentials or a stored browser state; CAPTCHA and mandatory human verification are unsupported.
8. Test data must be safely reproducible through a seed, fixture, demo tenant, or documented setup flow.
9. Required services and dependencies must be runnable or accessible; private dependencies must be declared and supplied.
10. The selected crawl scope must be bounded by allowed hosts, actions, screens, and destructive-action policies.

Targets that fail these rules should not be silently forced through the pipeline. Intake should return a structured readiness report containing blockers, unsupported technologies, missing inputs, and the human action required. Dynamic code, reflection, microservices, split repositories, and uncertain deployment/source alignment are supported as explicit ambiguity, not hidden as false certainty.

### What remains target-configurable

The onboarding system may discover much of the configuration, but it should allow a human to confirm or supply:

- application and repository URLs;
- documentation sources;
- deployment/base commit and pull request;
- authentication and seed procedure;
- allowed hosts and crawl limits;
- important workflows or business capabilities;
- repository relationships in a multi-repository application;
- approved language/framework extraction adapters.

This is configuration and evidence, not hardcoding. Hi.Events-specific graph edges, affected screens, or expected blast-radius conclusions must not be prewritten. The same intake contract should be usable for a second compatible target, although the 16-hour prototype only needs one target to be deeply implemented and evaluated.

## Decision

Use **Hi.Events** as the first reference target unless you decide that a single-language code extractor is more important than having the clearest public end-to-end business workflow. In that case, use **Formbricks**. In either case, the target enters through the onboarding contract above rather than through application-specific code.

- Best overall and best live demonstration: [Hi.Events](https://github.com/HiEventsDev/Hi.Events)
- Best graph and TypeScript AST target: [Formbricks](https://github.com/formbricks/formbricks)
- Best pure e-commerce target: [EverShop](https://github.com/evershopcommerce/evershop), but only after verifying the self-hosted fork because its advertised public demo was unavailable during testing

Hi.Events is the recommendation because its attendee journey is understandable to a reviewer in seconds, its organizer and buyer interfaces share meaningful domain behavior, its public demo works without an account, the repository contains both frontend and backend, and the official all-in-one deployment is designed around Docker Compose.

## What Was Evaluated

The broad GitHub search returned **272 unique repositories** across active self-hosted SaaS, e-commerce, CRM, and project-management queries. I manually triaged more than 100 of the relevant results, then inspected repository metadata, language composition, source trees, deployment files, seed/fixture support, documentation, and pull-request history for 20 finalists. Fourteen public endpoints were opened with Playwright.

The search intentionally excluded or penalized:

- frontend-only templates with no corresponding backend;
- headless frameworks whose public storefront lives in another repository;
- products whose hosted application does not correspond clearly to the public source;
- abandoned or archived projects;
- applications that require several paid integrations before a meaningful flow works;
- enormous platforms where a 16-hour graph would be mostly guesses;
- trivial CRUD demos without shared workflows or cross-screen consequences.

### Scoring

| Criterion | Weight | What it measures |
|---|---:|---|
| Assignment fit | 25 | Can requirements, UI, code, flows, and PR impact form one convincing graph? |
| Deployment | 20 | Can a fork be run reproducibly without extensive infrastructure work? |
| Demo and seed | 15 | Is there working data and a crawlable flow without manual preparation? |
| Product documentation | 15 | Is there public material suitable for requirement ingestion? |
| Code/AST tractability | 15 | Can UI, handlers, APIs, and services be extracted without heroic static analysis? |
| PR maturity | 10 | Are there enough real PRs and code history to support meaningful analysis? |

Scores are comparative judgments for this assignment, not general product-quality ratings.

## Ranked Shortlist

| Rank | Repository | Score | Browser status | Setup verdict | Main limitation |
|---:|---|---:|---|---|---|
| 1 | [Hi.Events](https://github.com/HiEventsDev/Hi.Events) | 93 | Full anonymous event-to-checkout flow worked | Easy/medium | React/TypeScript frontend plus PHP/Laravel backend requires two code extraction strategies |
| 2 | [Formbricks](https://github.com/formbricks/formbricks) | 92 | Cloud login worked; product requires account or local seed | Medium | Current Docker stack is larger than it first appears |
| 3 | [Ghostfolio](https://github.com/ghostfolio/ghostfolio) | 91 | Seeded live demo opened directly | Easy/medium | Market-data integrations and finance terminology add noise |
| 4 | [Vikunja](https://github.com/go-vikunja/vikunja) | 90 | `demo` / `demo` login worked with seeded projects | Easy | Go backend plus Vue/TypeScript frontend needs two parsers |
| 5 | [EverShop](https://github.com/evershopcommerce/evershop) | 88 | Advertised demo returned `403 Site Disabled` | Easy | Must self-host before trusting the crawl path |
| 6 | [Actual Budget](https://github.com/actualbudget/actual) | 87 | Anonymous seeded demo worked immediately | Very easy | Local-first behavior weakens conventional frontend-to-backend tracing |
| 7 | [Documenso](https://github.com/documenso/documenso) | 85 | Public sign-in page worked; no anonymous product demo | Medium | Complete signing needs a certificate, mail flow, and sample PDFs |
| 8 | [Twenty](https://github.com/twentyhq/twenty) | 84 | Hosted authentication page worked | Medium/hard | Very large, dynamic codebase encourages an over-broad graph |
| 9 | [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) | 82 | Public demo hit a Cloudflare `403` challenge | Easy/medium | OCR pipeline and mixed Python/TypeScript stack increase setup and mapping scope |
| 10 | [Teable](https://github.com/teableio/teable) | 80 | Hosted signup page worked | Medium/hard | Huge codebase and generic no-code abstractions make UI-to-code links less direct |

## 1. Hi.Events

Repository: [HiEventsDev/Hi.Events](https://github.com/HiEventsDev/Hi.Events)  
Live flow: [public conference demo](https://app.hi.events/event/2/hievents-conference-2030)  
Setup evidence: [README quick start](https://github.com/HiEventsDev/Hi.Events/blob/develop/README.md) and [all-in-one Docker instructions](https://github.com/HiEventsDev/Hi.Events/tree/develop/docker/all-in-one)  
Architecture evidence: [backend architecture docs](https://github.com/HiEventsDev/Hi.Events/tree/develop/backend/docs) and [E2E harness](https://github.com/HiEventsDev/Hi.Events/blob/develop/e2e/README.md)

### Why it is first

The browser test reached a real event page, selected an Early Bird ticket, revealed its eligible add-on, and continued to `Checkout - step 1 of 3`. The checkout exposed order summary, attendee details, billing address, custom registration questions, marketing consent, and payment progression. This is substantially better evidence than a marketing page or login screen.

The repository has a React 19/TypeScript frontend, Laravel backend, PostgreSQL, Redis, documented REST API, Playwright E2E suite, and an all-in-one Docker deployment. The repository has hundreds of historical PRs and clear frontend/backend boundaries.

### Recommended narrow slice

```text
Organizer creates event and ticket products
  -> buyer opens event page
  -> selects ticket and add-on
  -> applies promotion or chooses free ticket
  -> enters attendee details
  -> order is created
  -> organizer views order/attendee
  -> attendee is checked in or refunded
```

This yields shared concepts rather than isolated forms:

```text
Event -> Product -> Price -> PromoCode -> Order -> Attendee -> CheckIn
```

A pricing, capacity, attendee-question, or order-status change can affect both the buyer checkout and several organizer screens.

### Suggested graph bridge

```text
ObservedElement
  -> TRIGGERS_API -> RESTEndpoint
  -> HANDLED_BY -> LaravelController
  -> CALLS -> Service
  -> READS/WRITES -> DomainModel

ObservedElement
  -> RENDERED_BY -> ReactComponent
  -> BINDS -> Handler
  -> CALLS_API -> RESTEndpoint
```

Use TypeScript AST extraction for the selected frontend slice. For the backend, use the exported OpenAPI/route manifest plus scoped PHP AST extraction only for the controllers and services reached by those endpoints. Do not attempt to parse the entire Laravel application.

## 2. Formbricks

Repository: [formbricks/formbricks](https://github.com/formbricks/formbricks)  
Hosted app: [app.formbricks.com](https://app.formbricks.com/)  
Requirements/docs: [documentation source](https://github.com/formbricks/formbricks/tree/main/docs)  
Seed evidence: [database README](https://github.com/formbricks/formbricks/blob/main/packages/database/README.md)  
Deployment evidence: [Docker Compose](https://github.com/formbricks/formbricks/blob/main/docker/docker-compose.yml)

### Why it may be the technically safest choice

The core graph can remain TypeScript end to end. The official development seed creates an organization, workspaces, admin and manager accounts, complex surveys such as Kitchen Sink and CSAT, and roughly 50 responses. That is unusually good assignment data.

The same question and survey definitions appear in several contexts:

```text
Survey builder
  -> editor preview
  -> public survey runtime
  -> response validation
  -> response table
  -> analytics summary
```

A PR changing shared question validation, branching logic, response persistence, or display rules can therefore produce a convincing multi-screen blast radius.

### Limitation

The current production Compose file includes more infrastructure than a simple Next.js/PostgreSQL pair. Use the development path and official seed for the assignment. Do not spend assignment time deploying optional enterprise, taxonomy, AI, or external integration services.

## 3. Ghostfolio

Repository: [ghostfolio/ghostfolio](https://github.com/ghostfolio/ghostfolio)  
Live demo: [ghostfol.io/en/demo](https://ghostfol.io/en/demo)  
Setup: [official Docker Compose instructions](https://github.com/ghostfolio/ghostfolio#run-with-docker-compose)  
Seed source: [prisma/seed.mts](https://github.com/ghostfolio/ghostfolio/blob/main/prisma/seed.mts)

The Playwright check entered the live demo without credentials and navigated from Overview to Portfolio Analysis. It contained seeded accounts, holdings, performance metrics, allocation views, activities, watchlists, and reports.

This is an all-TypeScript Angular + NestJS + Prisma monorepo, which is excellent for AST extraction. A change in activity normalization or portfolio calculation can propagate to account balances, holdings, overview metrics, allocation charts, and FIRE analysis.

Use a narrow slice around adding/importing an activity and observing its consequences. Avoid depending on live market providers; use the seed and fixed symbols.

## 4. Vikunja

Repository: [go-vikunja/vikunja](https://github.com/go-vikunja/vikunja)  
Live demo: [try.vikunja.io](https://try.vikunja.io/)  
Docs: [vikunja.io/docs](https://vikunja.io/docs/)  
Fixtures: [database fixtures](https://github.com/go-vikunja/vikunja/tree/main/pkg/db/fixtures)

The public `demo` / `demo` credentials worked. The instance contained projects, tasks, labels, assignees, priorities, due dates, favorites, filters, and multiple project views.

This is particularly strong for the shared-UI problem:

```text
Task appears in Current Tasks
Task appears in project list
Task appears on Kanban board
Task appears in filters/upcoming
```

A PR changing task completion, due-date calculation, permissions, or label filtering can affect multiple screens and workflows through the same task model. Deployment can be very small because Vikunja ships the frontend with its Go service and can use SQLite for the prototype.

The trade-off is mixed Go and Vue/TypeScript extraction. Keep the code slice to task routes, services, and a few frontend components.

## 5. EverShop

Repository: [evershopcommerce/evershop](https://github.com/evershopcommerce/evershop)  
Docs: [evershop.io/docs](https://evershop.io/docs/)  
Compose: [docker-compose.yml](https://github.com/evershopcommerce/evershop/blob/dev/docker-compose.yml)  
Seed implementation: [seed package](https://github.com/evershopcommerce/evershop/tree/dev/packages/evershop/src/bin/seed)

EverShop is the best pure e-commerce architecture for this assignment: TypeScript, React, GraphQL, PostgreSQL, storefront and admin behavior, modular packages, Docker Compose, and product/category/collection/page/blog seed data.

The ideal slice is:

```text
Admin changes product variant, inventory, price, or coupon
  -> storefront category/product page changes
  -> cart calculation changes
  -> checkout validation changes
  -> admin order view changes
```

This gives the exact UI-A/shared-module/UI-B relationship the graph needs.

However, Playwright received `403 Site Disabled` from `https://demo.evershop.io/` on the research date. Select EverShop only if the fork can be deployed and seeded successfully before implementation begins. Do not build the agent around an unavailable hosted demo.

## 6. Actual Budget

Repository: [actualbudget/actual](https://github.com/actualbudget/actual)  
Instant demo: [app.actualbudget.org](https://app.actualbudget.org/)  
Docs: [Actual documentation](https://actualbudget.org/docs/)  
PR previews: [preview-build documentation](https://actualbudget.org/docs/contributing/preview-builds/)  
Compose: [docker-compose.yml](https://github.com/actualbudget/actual/blob/master/docker-compose.yml)

The anonymous `Try the demo` action opened a rich seeded Test Budget with accounts, transactions, categories, monthly budgets, schedules, rules, and reports. It is one of the easiest reproducible demonstrations in the list, and upstream PRs receive deploy-preview URLs.

An excellent slice is:

```text
Transaction/rule change
  -> account register
  -> category balance
  -> monthly budget
  -> scheduled transaction
  -> report totals
```

The penalty is architectural: Actual is local-first and much of its behavior runs in the client against local data. It is a good UI-to-domain-code graph, but a weaker conventional UI-to-HTTP-to-backend demonstration. Choose it only if the design document explains that honestly.

## 7. Documenso

Repository: [documenso/documenso](https://github.com/documenso/documenso)  
Hosted app: [app.documenso.com](https://app.documenso.com/)  
Product concepts: [documentation source](https://github.com/documenso/documenso/tree/main/apps/docs/content/docs/concepts)  
Architecture: [ARCHITECTURE.md](https://github.com/documenso/documenso/blob/main/ARCHITECTURE.md)  
Quick start: [self-hosting docs](https://github.com/documenso/documenso/blob/main/apps/docs/content/docs/self-hosting/index.mdx)

The document lifecycle creates a strong graph:

```text
Template -> Document -> Recipient -> Field -> Signing Session -> Audit Event
```

It is also all TypeScript and has unusually useful in-repository concept documentation. A field-role or signing-order change can affect the document editor, recipient signing UI, status screens, notifications, and audit trail.

The hosted application stopped at sign-in in browser testing. Local quick start is documented, but complete signing requires a signing certificate; email and sample PDF handling also need preparation. Those setup requirements are the reason it ranks below the simpler finalists.

## 8. Twenty

Repository: [twentyhq/twenty](https://github.com/twentyhq/twenty)  
Hosted app: [app.twenty.com](https://app.twenty.com/)  
Docker Compose: [official compose file](https://github.com/twentyhq/twenty/blob/main/packages/twenty-docker/docker-compose.yml)  
Docs source: [packages/twenty-docs](https://github.com/twentyhq/twenty/tree/main/packages/twenty-docs)

Twenty offers excellent domain relationships: people, companies, opportunities, activities, views, workflows, metadata, and permissions. It is predominantly TypeScript and has extensive PR history and documentation. Its development tooling also supports a pre-seeded demo workspace.

The problem is scale. The repository is much larger than the other finalists, and its dynamic metadata system makes static component-to-object mapping harder. A 16-hour implementation must select one object lifecycle, such as Person -> Company -> Opportunity -> Task, and ignore email/calendar integrations and custom-app infrastructure.

## 9. Paperless-ngx

Repository: [paperless-ngx/paperless-ngx](https://github.com/paperless-ngx/paperless-ngx)  
Docs: [docs source](https://github.com/paperless-ngx/paperless-ngx/tree/dev/docs)  
Compose variants: [docker/compose](https://github.com/paperless-ngx/paperless-ngx/tree/dev/docker/compose)

Paperless has a strong pipeline: document consumption, OCR, classification, correspondent/type/tag assignment, workflows, search, bulk editing, and permissions. Its docs include detailed feature material and screenshots, and its Compose variants are mature.

The official demo is advertised with `demo` / `demo`, but Playwright hit a Cloudflare `403 Just a moment...` challenge. Self-hosting should avoid that problem, but you must supply sample documents and wait for OCR processing. Python plus TypeScript also adds a second parser.

## 10. Teable

Repository: [teableio/teable](https://github.com/teableio/teable)  
Hosted app: [app.teable.ai](https://app.teable.ai/)  
Standalone deployment: [Docker example](https://github.com/teableio/teable/tree/develop/dockers/examples/standalone)  
Seed source: [Prisma seeds](https://github.com/teableio/teable/tree/develop/packages/db-main-prisma/src/seeds)

Teable is TypeScript across Next.js, NestJS, Prisma, and shared packages. Linked records, calculated fields, views, filters, forms, automations, and permissions can generate sophisticated cross-module impact paths.

It ranks tenth because the repository is large and highly abstract. A crawler observes generated tables and forms, while the implementation often routes through generic record/field engines rather than product-specific components. This is powerful but makes a short assignment harder to explain. The hosted application also required signup; no public seeded workspace was exposed during testing.

## Browser Verification

These checks used a real Chromium browser through Playwright. “Accessible” means the URL loaded and the stated interaction worked; it does not mean every feature was tested.

| Target | Result observed |
|---|---|
| Hi.Events conference demo | Accessible; ticket selection and navigation to checkout step 1 of 3 worked |
| Ghostfolio live demo | Accessible; opened seeded Overview and navigated to Portfolio Analysis |
| Vikunja demo | Accessible; `demo` / `demo` login worked and seeded tasks/projects rendered |
| Actual Budget | Accessible; anonymous `Try the demo` opened seeded Test Budget |
| Formbricks Cloud | Accessible login page; no anonymous seeded workspace |
| Documenso Cloud | Accessible sign-in page; no anonymous product flow |
| Twenty Cloud | Accessible welcome/authentication page; no anonymous product flow |
| Teable Cloud | Accessible signup page; no anonymous product flow |
| Solidtime Cloud | Accessible login page; no anonymous product flow |
| Plane Cloud | Accessible sign-up/sign-in page; no anonymous product flow |
| PLANKA site | Marketing site accessible; `Start demo` did not produce a usable app session in the browser test |
| EverShop demo | `403 Site Disabled` |
| Paperless-ngx demo | `403` Cloudflare challenge |
| Bagisto demo | Landing page accessible; “instant sandbox” required email, WhatsApp number, and marketing consent before launch |

The local Docker daemon was not running during research, so the finalists were not deployed locally. Setup ratings are therefore based on current first-party Compose files, seed scripts, and installation documentation, while browser ratings are hands-on observations.

## Recommended Architecture on Hi.Events

Do not graph the whole repository. Build a versioned evidence graph for the selected slice.

### Nodes

```text
Requirement
Capability
Workflow
FlowStep
Screen
ObservedElement
ReactComponent
FrontendHandler
RESTEndpoint
LaravelController
Service
DomainModel
PullRequest
ChangedSymbol
Evidence
CoverageGap
```

### Important relationships

```text
(Requirement)-[:REQUIRES]->(Capability)
(Requirement)-[:COVERED_BY]->(Workflow)
(Workflow)-[:HAS_STEP]->(FlowStep)
(FlowStep)-[:ON_SCREEN]->(Screen)
(FlowStep)-[:ACTS_ON]->(ObservedElement)
(FlowStep)-[:NEXT]->(FlowStep)
(ObservedElement)-[:RENDERED_BY]->(ReactComponent)
(ObservedElement)-[:TRIGGERS_API]->(RESTEndpoint)
(ReactComponent)-[:BINDS]->(FrontendHandler)
(FrontendHandler)-[:CALLS_API]->(RESTEndpoint)
(RESTEndpoint)-[:HANDLED_BY]->(LaravelController)
(LaravelController)-[:CALLS]->(Service)
(Service)-[:READS|WRITES]->(DomainModel)
(PullRequest)-[:CHANGES]->(ChangedSymbol)
```

Every inferred edge should carry:

```text
source_commit
extraction_method
evidence_reference
confidence
crawl_run_id
```

The same shared endpoint, service, or domain model can connect buyer UI A and organizer UI B. That is how a change to a shared price calculation can identify the event page, checkout summary, organizer order screen, sales report, and their associated workflows without hardcoding those consequences.

## Fork and PR Strategy

Your proposed fork is workable if it remains public. Use this sequence:

1. Fork the chosen repository publicly.
2. Pin one base commit and deploy that exact commit.
3. Seed a deterministic demo tenant/event/workspace.
4. Crawl only the selected base-commit workflows.
5. Build the requirements/UI/code graph against that same commit.
6. Create a focused feature or bug-fix branch that modifies shared behavior.
7. Open a real PR from the branch into the fork's base branch.
8. Give the PR URL and base/head SHAs to the analyzer.
9. Generate the blast-radius report from the base graph plus PR diff.
10. Optionally deploy the PR branch separately to verify predicted effects.

Avoid a cosmetic PR. A useful Hi.Events PR should touch behavior such as ticket quantity validation, add-on eligibility, price/fee display, attendee-question requirements, or order state transitions. A useful Formbricks PR should touch shared question validation, branching logic, survey completion, or response metadata display.

An upstream merged PR is even stronger evidence because it is unquestionably real and independently reviewed. Your own public fork PR is acceptable for a controlled demo, but the design document should state that it is a deliberately constructed evaluation fixture.

## Near Misses

| Repository | Why it did not make the top ten |
|---|---|
| [PLANKA](https://github.com/plankanban/planka) | Easy JavaScript/Docker shape, but the public demo path was not usable and licensing/product-edition boundaries deserve review |
| [Plane](https://github.com/makeplane/plane) | Rich product, but many services, mixed languages, cloud auth wall, and current self-hosting complexity are poor 16-hour trade-offs |
| [Bagisto](https://github.com/bagisto/bagisto) | Deep commerce product, but a large mixed PHP/Blade/TypeScript codebase and gated demo make EverShop simpler |
| [Solidtime](https://github.com/solidtime-io/solidtime) | Good time-tracking workflows and Compose support, but no obvious seed and mixed PHP/Vue extraction |
| [Linkwarden](https://github.com/linkwarden/linkwarden) | Small all-TypeScript deployment with a seed script, but weaker public product-spec material and less cross-screen depth |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | Excellent domain, but external channel setup, Rails/Vue extraction, and repository size add too much risk |
| [Cal.com](https://github.com/calcom/cal.diy) | Strong scheduling domain and docs, but huge repository and integration-heavy flows |
| [Saleor](https://github.com/saleor/saleor) | Excellent commerce backend, but storefront and dashboard are separate repositories |
| [Medusa](https://github.com/medusajs/medusa) | Framework and starter/storefront boundaries weaken one-deployment-to-one-repository traceability |
| [Spree](https://github.com/spree/spree) | Good commerce domain, but Rails/storefront structure and setup are less efficient than the selected commerce options |

## Final Recommendation

Start with **Hi.Events** and time-box a two-hour feasibility spike before committing:

1. Run the all-in-one stack.
2. Create one event with a free ticket, paid ticket, add-on, promo code, and attendee question.
3. Complete the buyer flow and confirm the resulting order in the organizer UI.
4. Record browser network calls for those actions.
5. Locate the React component, API endpoint, Laravel controller, service, and model for one shared behavior.

If all five work, keep Hi.Events. If the PHP mapping or local environment consumes too much time, switch immediately to **Formbricks**, run its development seed, and use the builder -> preview -> public response -> analytics slice. If the submission must visibly be an e-commerce store, use **EverShop**, but only after its local Compose and seed path pass the same feasibility spike.
