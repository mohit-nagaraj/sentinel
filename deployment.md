# Hi.Events demo deployment (Railway + Supabase)

Last verified: 2026-09-10 (Asia/Kolkata). Operator runbook for the **live** Hi.Events demo used with Sentinel. This is not Sentinel’s own hosting.

Sentinel SNT-030 still attests **Render**. [`decisions.md`](./decisions.md) still records Render Blueprint previews as the assignment baseline. Railway is the current operator demo so blast-radius / PR-head checks can hit a **source-built** commit of [`mohit-nagaraj/Hi.Events`](https://github.com/mohit-nagaraj/Hi.Events) `@ develop`, not the upstream `daveearley/hi.events-all-in-one` image.

Do **not** commit secrets (`APP_KEY`, `JWT_SECRET`, `DATABASE_URL`, Railway tokens, Stripe keys, Supabase DB password, S3 keys). Demo login below is intentional.

A fork-local copy may also exist at `D:\github projects\Hi.Events\deployment.md` (not necessarily pushed).

---

## Takeover in 30 seconds

1. App: https://hi-events-production.up.railway.app — `sentinel-demo@example.com` / `DemoPass123!`
2. Railway **Free** in Southeast Asia, sleep-on-idle on. Services: **Hi-Events + Redis only**.
3. Postgres and images are **Supabase** (project ref `grooqxlnawjuuvmhrtvy`, Singapore). All four demo events are LIVE with covers on the public bucket.
4. PR environments are enabled and **share** that same DB + S3. They clone Redis and get their own host via `${{RAILWAY_PUBLIC_DOMAIN}}`. `SEED_DEMO=false`.
5. Operate Railway from `D:\github projects\Hi.Events` with `RAILWAY_API_TOKEN` = account token named `sentinel-account-cli`.
6. Do not re-add Railway Postgres. Do not flip `SEED_DEMO=true` on the 0.5 GB replica.

---

## Live URLs

| What | Value |
|---|---|
| Public app | https://hi-events-production.up.railway.app |
| Health | `GET /up` → `{"status":"ok"}` (**nginx static**; does not prove PHP, Node, or DB) |
| Login UI | https://hi-events-production.up.railway.app/auth/login |
| Login API | `POST /api/auth/login` JSON `{ "email", "password" }` |
| Nightclub | `/event/1/subterra-004-nite-kernel-anima-basil-wren` |
| Conference | `/event/2/runtime-26-two-days-on-the-systems-behind-the-systems` |
| Yoga | `/event/9/stillroom-morning-practice-weekend-specials` |
| Festival | `/event/10/tideline-three-days-on-the-beara-peninsula` |
| Nightclub cover | `https://grooqxlnawjuuvmhrtvy.supabase.co/storage/v1/object/public/hi-events-public/event_cover/nightclub-4QIGY.jpg` |
| Conference cover | `https://grooqxlnawjuuvmhrtvy.supabase.co/storage/v1/object/public/hi-events-public/event_cover/conference-ZthJo.jpg` |
| Yoga cover | `https://grooqxlnawjuuvmhrtvy.supabase.co/storage/v1/object/public/hi-events-public/event_cover/yoga-oazG8.jpg` |
| Festival cover | `https://grooqxlnawjuuvmhrtvy.supabase.co/storage/v1/object/public/hi-events-public/event_cover/festival-6s8f7.jpg` |

Sleep-on-idle is **on**. First request after idle can be slow.

---

## Railway

| Item | Value |
|---|---|
| Account | Mohit Nagaraj (`mohitnagaraj20@gmail.com`) |
| Workspace | Mohit Nagaraj's Projects `81849d54-13e9-4a1e-9c52-6c3169c01db9` |
| Plan | **Free**. Hobby was offered; not upgraded. |
| CLI | `@railway/cli` ~5.49.6, linked from `D:\github projects\Hi.Events` |
| Auth | Account token **name** `sentinel-account-cli`. Env `RAILWAY_API_TOKEN`. |
| Project | **hi-events** `6629457c-5a2e-4d6b-8f81-1f5bbea6e00e` |
| Environment | **production** `767f3f82-97eb-4320-9d68-813313e1186d` |
| Region | Southeast Asia Metal `asia-southeast1-eqsg3a` |
| Domain | `hi-events-production.up.railway.app` port **80** |
| PR deploys | `prDeploys: true`, focused **off**, base = production |

| Service | ID | Source | Notes |
|---|---|---|---|
| Hi-Events | `5d0be1f9-3fe4-4dde-af86-982d62cc38a5` | GitHub `mohit-nagaraj/Hi.Events` `@ develop` | `Dockerfile.all-in-one`, no volume |
| Redis | `015cc35c-0786-472b-81d3-b28a74c91af3` | `redis:7-alpine` | PR previews clone this |
| Postgres | **deleted** | — | Do **not** re-add |

Hi-Events health `/up` timeout 600s, `sleepApplication: true` (required on Free). Live git SHA at last app deploy: `1c47bced`. Latest known deploy id: `d29e8c51`.

Private DNS: Redis `redis.railway.internal:6379`. There is **no** `postgres.railway.internal`.

### Volume grace

The old `postgres-volume` (`005c2fc4-b7f4-478b-9cba-c6626dc2ca15`) is in Railway’s **48h soft-delete**. `volumeDelete` returns success but the volume stays until **2026-09-11 17:27 UTC**. There is **no** self-service force-delete (API and dashboard both retain for 48h). Used size was ~0 MB, so credit burn is negligible; it still occupies the Free **1 volume / project** slot until then. Do not restore it from the email Railway sent.

---

## Supabase (shared by production and PR previews)

| Item | Value |
|---|---|
| Project | **hi-events** ref `grooqxlnawjuuvmhrtvy` |
| Region | `ap-southeast-1` |
| API | `https://grooqxlnawjuuvmhrtvy.supabase.co` |
| DB | **Session pooler** `:5432` + `sslmode=require`. Direct `db.*` is IPv6-only; do not use transaction pooler `:6543`. |
| Buckets | `hi-events-public` (public), `hi-events-private` (private) |
| S3 endpoint | `https://grooqxlnawjuuvmhrtvy.storage.supabase.co/storage/v1/s3` |
| S3 region | `ap-southeast-1` |
| CDN prefix | `https://grooqxlnawjuuvmhrtvy.supabase.co/storage/v1/object/public/hi-events-public` |

Password, S3 keys, and Stripe secrets live in Railway only.

---

## Runtime env (shape only)

CLI `variable list` **resolves** templates. Unrendered production values:

| Key | Notes |
|---|---|
| `DATABASE_URL` | Literal Supabase session pooler (not `${{Postgres.DATABASE_URL}}`) |
| `PGSSLMODE` | `require` |
| `PGSSLCERT` / `PGSSLKEY` | Dummy paths so www-data does not read `/root/.postgresql/postgresql.crt` |
| `FILESYSTEM_PUBLIC_DISK` / `PRIVATE` | `s3-public` / `s3-private` |
| `APP_CDN_URL` / `AWS_URL` | Supabase public bucket URL (shared with PR previews) |
| `APP_FRONTEND_URL` / `VITE_FRONTEND_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `VITE_API_URL_CLIENT` | `https://${{RAILWAY_PUBLIC_DOMAIN}}/api` |
| `VITE_API_URL_SERVER` | `http://localhost:80/api` |
| `REDIS_HOST` | `${{Redis.RAILWAY_PRIVATE_DOMAIN}}` |
| `SEED_DEMO` | **`false`** |
| `MAIL_MAILER` | `log` |
| Stripe | Test keys + webhook secret. Webhook URL is the **production** host. Account may show paused capabilities. |

SSR copies `VITE_*` from process env into `window.hievents` per request (`frontend/server.js`), so PR hostnames work at runtime.

**Restart does not apply new variables.** Use **redeploy**.

---

## PR previews

Intentional for this demo: **one Supabase database and one image bucket**.

1. Keep **Focused PR Environments off**.
2. Do not add Railway Postgres — previews must inherit the literal `DATABASE_URL`.
3. Redis is cloned per PR.
4. Frontend URLs use `${{RAILWAY_PUBLIC_DOMAIN}}`; CDN stays on Supabase.
5. `SEED_DEMO=false` so a PR replica does not spend RAM on `demo:seed`.
6. `CORS_ALLOWED_ORIGINS=*`.

Not proven with a real GitHub PR after Postgres removal.

---

## Demo seed

Production `SEED_DEMO=false`. The Free replica OOMs on yoga (~18 weeks of occurrences). Seed **from a local machine** against the same Supabase DB and S3.

Needs PHP 8.3+ with `pdo_pgsql`, Composer, and the Railway CLI linked to the Hi.Events project.

```text
cd "D:\github projects\Hi.Events\backend"
composer install --no-interaction --prefer-dist

cd "D:\github projects\Hi.Events"
railway run --service Hi-Events --environment production --no-local -- cmd /c "cd /d backend && set QUEUE_CONNECTION=sync&& set CACHE_DRIVER=array&& set SESSION_DRIVER=array&& php artisan demo:seed --confirm --skip-if-exists --email=sentinel-demo@example.com --only=yoga --only=festival"
```

`--skip-if-exists` is per event title. Nightclub + conference already exist and are skipped. Override `QUEUE_CONNECTION=sync` (and cache/session to `array`) so the command does not need Railway Redis (`redis.railway.internal` is not reachable from a laptop). Imagick is optional (cover LQIP only).

Windows PHP often has no `php.ini` / CA bundle. Scoop PHP then fails S3 `HeadObject` with curl error 60. Run artisan with `-d curl.cainfo=` and `-d openssl.cafile=` pointing at a Mozilla `cacert.pem` (use a path **without spaces**). Also set `AWS_CA_BUNDLE`. Do not disable TLS verification.

Keep `SEED_DEMO=false` on Railway after a local seed.

Yoga (event 9, 186 occurrences) and festival (event 10) were seeded this way on 2026-09-10. Nightclub and conference were seeded earlier on the Railway replica before `SEED_DEMO` was turned off.

---

## Known issues — do not rediscover

- Free: 0.5 GB RAM, 1 volume (pending-delete volumes still count ~48h), sleep required, in-region peak 08:00–20:00 for from-source deploys.
- Direct Supabase Postgres is IPv6-only; use session pooler `:5432`.
- libpq tried `/root/.postgresql/postgresql.crt` as www-data → permission denied. Fixed with `PGSSLCERT`/`PGSSLKEY`.
- Queue/scheduler can race migrate; `/up` can pass during bootstrap.
- Yoga/festival must not run on the live 0.5 GB box.
- PowerShell interpolates `$` in GraphQL — put queries in a file.
- `railway ssh`: no keys. Windows: do not `railway config plan/apply`.
- IaC `.railway/railway.ts` in the fork is a stub (Hi-Events + Redis only) and was never applied.

---

## Operator commands

```text
cd "D:\github projects\Hi.Events"
railway whoami
railway status
railway service list --json
railway logs --service Hi-Events --lines 80
railway deployment list --service Hi-Events --limit 5 --json
railway variable set --service Hi-Events --skip-deploys KEY=value
railway service redeploy --service Hi-Events --yes
```

Do not `railway add postgres`. Do not put production payments or Sentinel secrets on this Railway project.

---

## Sentinel leftover

- `packages/contracts/src/deployment-verification.ts` — `z.literal("render")`.
- Verification policy: do not run full `pnpm test` / `pnpm build` locally (`AGENTS.md` / `CLAUDE.md`).
