# SNT-003 — Supabase operational state, secrets, and artifact storage

| Field | Value |
|---|---|
| Milestone | M1 — Foundation and durable execution |
| Status | `not-started` |
| Depends on | SNT-001, SNT-002 |
| Blocks | Run orchestration, onboarding, GitHub, artifacts, UI |
| PRD references | §11.1, §11.4–11.6, §18.3, FR-017, NFR-004/NFR-005 |

## Background

Supabase is Sentinel's operational and durable-artifact platform. Postgres stores current configuration, runs, events, assessments, references, reviews, and eval summaries; private Storage retains only evidence worth keeping; Vault or application-level envelope encryption stores target credential secrets. None of these duplicate Neo4j knowledge.

## Scope

- Version-controlled SQL migrations for the conceptual tables in PRD §11.5.
- Server-only typed repository layer and transactions.
- Run queue leases with atomic `FOR UPDATE SKIP LOCKED` claiming, heartbeat, expiry, cancellation, and idempotency.
- Ordered append-only run events.
- Application-level active commit/graph revision and freshness metadata.
- Assessment supersession by PR head SHA.
- Artifact metadata referencing private Storage objects.
- Review/eval records.
- Private `sentinel-artifacts` (or configured equivalent) bucket, signed/server downloads, upload metadata, and retention/reference seam.
- Restricted credential-secret references backed by Supabase Vault where available or application-level envelope encryption; no plaintext in ordinary tables.
- RLS/grants that do not expose privileged writes, object data, decrypted secrets, or checkpoint internals to browsers.
- Separate internal schema reserved for LangGraph checkpoints; its tables are created by SNT-006.

## Implementation tasks

- [ ] Add migrations, constraints, indexes, timestamps, and foreign keys.
- [ ] Make webhook delivery ID and assessment `(repository, PR, head SHA)` idempotency explicit.
- [ ] Implement atomic run creation/claim/lease/heartbeat/finish/cancel functions.
- [ ] Implement monotonic per-run event sequence allocation.
- [ ] Add repository methods with transaction injection and typed row mapping.
- [ ] Define service-role-only writes and safe read views/API responses for the frontend.
- [ ] Add private bucket bootstrap/check, server upload/download/delete, short-lived signed URL, content hash, MIME/size, reference counting, and retention fields.
- [ ] Add target-secret create/read/rotate/delete service returning opaque references only; prohibit decrypted secret access in browser APIs.
- [ ] Add seed factories for isolated tests, never production demo content.
- [ ] Document direct versus pooler connection expectations for long-lived worker/serverless contexts.

## Acceptance criteria

- Two workers racing to claim a queued run cannot both own it.
- Duplicate enqueue requests with the same idempotency identity produce one active logical run.
- Lease expiry permits safe recovery and preserves prior events.
- Events retain deterministic order and can rebuild a UI timeline after reload.
- Graph knowledge and large payloads are not stored in operational rows.
- Durable artifacts are private, hash-addressed in metadata, and accessible only server-side or through short-lived authorized signed URLs.
- Browser clients cannot read/decrypt secrets or mutate privileged state under RLS/grants.
- Secret rotation changes the resolved value without copying it into application/run rows.
- Migrations/bootstrap are repeatable on an empty disposable Supabase/Postgres project or faithful local test environment.

## Required tests

- Migration-up integration test on disposable Postgres.
- Concurrency test for queue claims and leases.
- Idempotent run/assessment creation tests.
- Foreign-key, uniqueness, state-transition, and cancellation tests.
- RLS/authorization tests using anon/authenticated/server roles where available.
- Repository transaction rollback tests.
- Private Storage upload/signed-download/expiry/authorization/delete tests using isolated objects.
- Credential secret reference/rotation/access-denial/redaction tests.

## Out of scope

LangGraph checkpoint tables, final authentication UI, Realtime broadcast trigger, artifact retention scheduler, and Neo4j data.

## Implementation notes

Never run schema tests against the user's production Supabase project by default. Require an explicitly named disposable test connection/schema and fail closed if it is absent.