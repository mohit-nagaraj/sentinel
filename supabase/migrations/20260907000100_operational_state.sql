begin;

create extension if not exists pgcrypto;

create schema if not exists sentinel;
create schema if not exists langgraph_checkpoint;

revoke all on schema sentinel from public;
revoke all on schema langgraph_checkpoint from public;

create or replace function sentinel.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists sentinel.applications (
  id uuid primary key default gen_random_uuid(),
  stable_key text not null unique check (
    stable_key ~ '^application:v1:[a-f0-9]{64}$'
  ),
  name text not null check (length(name) between 1 and 512),
  deployment_url text not null,
  status text not null check (status in (
    'not_configured', 'inspecting', 'awaiting_confirmation',
    'initializing_knowledge', 'ready', 'assessing_pr', 'verifying',
    'refreshing', 'needs_review', 'stale', 'failed'
  )),
  indexed_commit_sha text check (indexed_commit_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  graph_revision bigint not null default 0 check (graph_revision >= 0),
  refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sentinel.sources (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  stable_key text not null check (
    stable_key ~ '^(application|document-source|document-page|document-section|requirement|capability|workflow|flow-step|screen|ui-element|frontend-route|code-file|code-symbol|api-endpoint|domain-entity|coverage-assessment|pull-request):v1:[a-f0-9]{64}$'
  ),
  kind text not null check (kind in ('repository', 'documentation', 'application')),
  uri text not null,
  status text not null check (status in ('pending', 'ready', 'warning', 'blocked', 'failed')),
  content_hash text check (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  secret_reference text,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (application_id, stable_key)
);

create table if not exists sentinel.runs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  run_type text not null check (run_type in (
    'inspect_application', 'initialize_knowledge', 'assess_pr',
    'verify_pr', 'refresh_knowledge', 'run_eval'
  )),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'interrupted', 'cancelling', 'cancelled',
    'succeeded', 'failed'
  )),
  idempotency_key text not null,
  budget jsonb not null check (
    jsonb_typeof(budget) = 'object' and octet_length(budget::text) <= 8192
  ),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_event_sequence bigint not null default 0 check (next_event_sequence >= 0),
  cancel_requested_at timestamptz,
  error_category text check (error_category in (
    'validation', 'configuration', 'authorization', 'rate_limit', 'timeout',
    'provider', 'storage', 'cancelled', 'unknown'
  )),
  error_code text check (error_code ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (application_id, id),
  unique (application_id, run_type, idempotency_key),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check ((error_category is null) = (error_code is null)),
  check (finished_at is null or status in ('cancelled', 'succeeded', 'failed'))
);

create index if not exists runs_claim_idx
  on sentinel.runs (status, lease_expires_at, created_at)
  where status in ('queued', 'running');

create table if not exists sentinel.run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references sentinel.runs(id) on delete cascade,
  sequence bigint not null check (sequence > 0),
  event_kind text not null,
  event jsonb not null check (
    jsonb_typeof(event) = 'object' and octet_length(event::text) <= 32768
  ),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);

create index if not exists run_events_replay_idx
  on sentinel.run_events (run_id, sequence);

create table if not exists sentinel.github_webhook_deliveries (
  delivery_id text primary key check (length(delivery_id) between 1 and 255),
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  repository_host text not null,
  repository_owner text not null,
  repository_name text not null,
  event_name text not null,
  action text not null,
  head_sha text check (head_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  run_id uuid,
  received_at timestamptz not null default now(),
  unique (application_id, delivery_id),
  foreign key (application_id, run_id)
    references sentinel.runs(application_id, id)
    on delete set null (run_id)
);

create table if not exists sentinel.pr_assessments (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  repository_host text not null,
  repository_owner text not null,
  repository_name text not null,
  pull_request_number integer not null check (pull_request_number > 0),
  base_sha text not null check (base_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  head_sha text not null check (head_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  diff_hash text not null check (diff_hash ~ '^sha256:[a-f0-9]{64}$'),
  baseline_status text not null check (baseline_status in ('compatible', 'warning', 'refresh_required', 'blocked')),
  report_artifact_id uuid,
  is_current boolean not null default true,
  superseded_by_id uuid references sentinel.pr_assessments(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (
    application_id, repository_host, repository_owner, repository_name,
    pull_request_number, head_sha
  )
);

create unique index if not exists pr_assessment_current_idx
  on sentinel.pr_assessments (
    application_id, repository_host, repository_owner, repository_name,
    pull_request_number
  ) where is_current;

create table if not exists sentinel.assessment_findings (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references sentinel.pr_assessments(id) on delete cascade,
  stable_key text not null,
  risk text not null check (risk in ('high', 'medium', 'low', 'unknown')),
  evidence_strength text not null check (evidence_strength in ('A', 'B', 'C', 'D')),
  title text not null check (length(title) between 1 and 512),
  summary text not null check (length(summary) between 1 and 4096),
  verification_status text not null check (verification_status in (
    'passed', 'failed', 'behavior_changed', 'blocked', 'not_run',
    'verification_unavailable'
  )),
  evidence_path_count integer not null check (evidence_path_count > 0),
  created_at timestamptz not null default now(),
  unique (assessment_id, stable_key)
);

create table if not exists sentinel.artifacts (
  id uuid primary key default gen_random_uuid(),
  stable_key text not null unique check (stable_key ~ '^artifact:v1:[a-f0-9]{64}$'),
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  run_id uuid,
  artifact_type text not null,
  bucket text not null,
  object_key text not null unique,
  content_hash text not null check (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  reference_count integer not null default 0 check (reference_count >= 0),
  retain_until timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (application_id, id)
);

alter table sentinel.pr_assessments
  drop constraint if exists pr_assessments_report_artifact_id_fkey;
alter table sentinel.pr_assessments
  add constraint pr_assessments_report_artifact_id_fkey
  foreign key (application_id, report_artifact_id)
  references sentinel.artifacts(application_id, id)
  on delete set null (report_artifact_id);

alter table sentinel.artifacts
  drop constraint if exists artifacts_run_id_fkey;
alter table sentinel.artifacts
  add constraint artifacts_run_id_fkey
  foreign key (application_id, run_id)
  references sentinel.runs(application_id, id)
  on delete set null (run_id);

create table if not exists sentinel.link_reviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  link_stable_key text not null,
  source_identity_hash text not null check (source_identity_hash ~ '^sha256:[a-f0-9]{64}$'),
  decision text not null check (decision in ('accepted', 'rejected')),
  reason text not null check (length(reason) between 1 and 4096),
  decided_by uuid not null,
  decided_at timestamptz not null default now(),
  unique (application_id, link_stable_key, source_identity_hash)
);

create table if not exists sentinel.eval_results (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  run_id uuid,
  fixture_key text not null,
  metric_key text not null,
  outcome text not null check (outcome in ('passed', 'failed', 'blocked')),
  value numeric,
  details jsonb not null default '{}'::jsonb check (octet_length(details::text) <= 16384),
  created_at timestamptz not null default now(),
  unique nulls not distinct (application_id, run_id, fixture_key, metric_key),
  foreign key (application_id, run_id)
    references sentinel.runs(application_id, id)
    on delete cascade
);

create table if not exists sentinel.target_secrets (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  secret_name text not null,
  vault_secret_id uuid not null unique,
  opaque_reference text not null unique check (opaque_reference ~ '^secret-ref:v1:[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (application_id, opaque_reference),
  unique (application_id, secret_name)
);

alter table sentinel.sources
  drop constraint if exists sources_secret_reference_fkey;
alter table sentinel.sources
  add constraint sources_secret_reference_fkey
  foreign key (application_id, secret_reference)
  references sentinel.target_secrets(application_id, opaque_reference)
  on delete set null (secret_reference);

drop trigger if exists applications_set_updated_at on sentinel.applications;
create trigger applications_set_updated_at
before update on sentinel.applications
for each row execute function sentinel.set_updated_at();

drop trigger if exists sources_set_updated_at on sentinel.sources;
create trigger sources_set_updated_at
before update on sentinel.sources
for each row execute function sentinel.set_updated_at();

drop trigger if exists runs_set_updated_at on sentinel.runs;
create trigger runs_set_updated_at
before update on sentinel.runs
for each row execute function sentinel.set_updated_at();

create or replace function sentinel.enforce_run_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if old.status = 'queued' and new.status in ('running', 'cancelled') then
    return new;
  end if;
  if old.status = 'running' and new.status in (
    'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted'
  ) then
    return new;
  end if;
  if old.status = 'interrupted' and new.status in ('queued', 'running', 'cancelled') then
    return new;
  end if;
  if old.status = 'cancelling' and new.status in ('cancelled', 'failed') then
    return new;
  end if;
  raise exception 'invalid run status transition from % to %', old.status, new.status;
end;
$$;

drop trigger if exists runs_enforce_status_transition on sentinel.runs;
create trigger runs_enforce_status_transition
before update of status on sentinel.runs
for each row execute function sentinel.enforce_run_status_transition();

create or replace function sentinel.delete_vault_secret_mapping()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

drop trigger if exists target_secrets_delete_vault_secret
  on sentinel.target_secrets;
create trigger target_secrets_delete_vault_secret
after delete on sentinel.target_secrets
for each row execute function sentinel.delete_vault_secret_mapping();

create or replace function sentinel.enqueue_run(
  p_application_id uuid,
  p_run_type text,
  p_idempotency_key text,
  p_budget jsonb
)
returns sentinel.runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  result sentinel.runs;
begin
  insert into sentinel.runs (
    application_id, run_type, idempotency_key, budget
  ) values (
    p_application_id, p_run_type, p_idempotency_key, p_budget
  )
  on conflict (application_id, run_type, idempotency_key)
  do update set idempotency_key = excluded.idempotency_key
  returning * into result;
  return result;
end;
$$;

create or replace function sentinel.claim_run(
  p_owner text,
  p_lease_seconds integer default 60
)
returns setof sentinel.runs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(trim(p_owner), '') is null then
    raise exception 'lease owner is required';
  end if;
  if p_lease_seconds < 5 or p_lease_seconds > 3600 then
    raise exception 'lease seconds must be between 5 and 3600';
  end if;

  return query
  with candidate as (
    select id
    from sentinel.runs
    where (status = 'queued' and cancel_requested_at is null)
       or (status in ('running', 'cancelling') and lease_expires_at < now())
    order by created_at, id
    for update skip locked
    limit 1
  )
  update sentinel.runs as run
  set status = case
        when run.cancel_requested_at is null then 'running'
        else 'cancelling'
      end,
      lease_owner = p_owner,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = run.attempt_count + 1,
      started_at = coalesce(run.started_at, now())
  from candidate
  where run.id = candidate.id
  returning run.*;
end;
$$;

create or replace function sentinel.heartbeat_run(
  p_run_id uuid,
  p_owner text,
  p_lease_seconds integer default 60
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update sentinel.runs
    set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    where id = p_run_id
      and status in ('running', 'cancelling')
      and lease_owner = p_owner
      and lease_expires_at > now()
      and p_lease_seconds between 5 and 3600
    returning 1
  )
  select exists(select 1 from updated);
$$;

create or replace function sentinel.finish_run(
  p_run_id uuid,
  p_owner text,
  p_status text,
  p_error_category text default null,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'invalid terminal run status';
  end if;
  if p_status = 'failed' and (p_error_category is null or p_error_code is null) then
    raise exception 'failed runs require an error category and code';
  end if;
  if p_status <> 'failed' and (p_error_category is not null or p_error_code is not null) then
    raise exception 'non-failed runs cannot persist error fields';
  end if;

  update sentinel.runs
  set status = p_status,
      lease_owner = null,
      lease_expires_at = null,
      error_category = p_error_category,
      error_code = p_error_code,
      finished_at = now()
  where id = p_run_id
    and lease_owner = p_owner
    and lease_expires_at > now()
    and status in ('running', 'cancelling')
    and (status = 'running' or p_status in ('cancelled', 'failed'));
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create or replace function sentinel.request_run_cancellation(p_run_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  resulting_status text;
begin
  update sentinel.runs
  set status = case
        when status in ('queued', 'interrupted') then 'cancelled'
        else 'cancelling'
      end,
      cancel_requested_at = now(),
      finished_at = case
        when status in ('queued', 'interrupted') then now()
        else finished_at
      end,
      lease_owner = case
        when status in ('queued', 'interrupted') then null
        else lease_owner
      end,
      lease_expires_at = case
        when status in ('queued', 'interrupted') then null
        else lease_expires_at
      end
  where id = p_run_id
    and status in ('queued', 'running', 'interrupted')
  returning status into resulting_status;

  if resulting_status is null then
    select status into resulting_status
    from sentinel.runs
    where id = p_run_id and status in ('cancelling', 'cancelled');
  end if;
  return resulting_status;
end;
$$;

create or replace function sentinel.append_run_event(
  p_run_id uuid,
  p_event_kind text,
  p_event jsonb,
  p_occurred_at timestamptz
)
returns sentinel.run_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocated_sequence bigint;
  allocated_event_id text;
  result sentinel.run_events;
begin
  update sentinel.runs
  set next_event_sequence = next_event_sequence + 1
  where id = p_run_id
  returning next_event_sequence into allocated_sequence;

  if allocated_sequence is null then
    raise exception 'run not found';
  end if;

  allocated_event_id := 'event:v1:' || encode(
    extensions.digest(
      convert_to(
        format(
          '{"kind":"event","runId":"run:%s","sequence":%s,"version":1}',
          p_run_id,
          allocated_sequence
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into sentinel.run_events (
    run_id, sequence, event_kind, event, occurred_at
  ) values (
    p_run_id, allocated_sequence, p_event_kind,
    p_event || jsonb_build_object(
      'id', allocated_event_id,
      'runId', 'run:' || p_run_id::text,
      'sequence', allocated_sequence
    ),
    p_occurred_at
  ) returning * into result;
  return result;
end;
$$;

create or replace function sentinel.create_pr_assessment(
  p_application_id uuid,
  p_repository_host text,
  p_repository_owner text,
  p_repository_name text,
  p_pull_request_number integer,
  p_base_sha text,
  p_head_sha text,
  p_diff_hash text,
  p_baseline_status text
)
returns sentinel.pr_assessments
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing sentinel.pr_assessments;
  created sentinel.pr_assessments;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      concat_ws(':', p_application_id::text, lower(p_repository_host),
        lower(p_repository_owner), lower(p_repository_name),
        p_pull_request_number::text),
      0
    )
  );

  select * into existing
  from sentinel.pr_assessments
  where application_id = p_application_id
    and repository_host = lower(p_repository_host)
    and repository_owner = lower(p_repository_owner)
    and repository_name = lower(p_repository_name)
    and pull_request_number = p_pull_request_number
    and head_sha = p_head_sha;

  if found and (
    existing.base_sha <> p_base_sha
    or existing.diff_hash <> p_diff_hash
    or existing.baseline_status <> p_baseline_status
  ) then
    raise exception 'assessment idempotency conflict for existing PR head';
  end if;

  if found and existing.is_current then
    return existing;
  end if;

  if found then
    update sentinel.pr_assessments
    set is_current = false,
        superseded_by_id = existing.id
    where application_id = p_application_id
      and repository_host = lower(p_repository_host)
      and repository_owner = lower(p_repository_owner)
      and repository_name = lower(p_repository_name)
      and pull_request_number = p_pull_request_number
      and is_current;

    update sentinel.pr_assessments
    set is_current = true,
        superseded_by_id = null
    where id = existing.id
    returning * into existing;
    return existing;
  end if;

  update sentinel.pr_assessments
  set is_current = false
  where application_id = p_application_id
    and repository_host = lower(p_repository_host)
    and repository_owner = lower(p_repository_owner)
    and repository_name = lower(p_repository_name)
    and pull_request_number = p_pull_request_number
    and is_current;

  insert into sentinel.pr_assessments (
    application_id, repository_host, repository_owner, repository_name,
    pull_request_number, base_sha, head_sha, diff_hash, baseline_status
  ) values (
    p_application_id, lower(p_repository_host), lower(p_repository_owner),
    lower(p_repository_name), p_pull_request_number, p_base_sha, p_head_sha,
    p_diff_hash, p_baseline_status
  ) returning * into created;

  update sentinel.pr_assessments
  set superseded_by_id = created.id
  where application_id = p_application_id
    and repository_host = lower(p_repository_host)
    and repository_owner = lower(p_repository_owner)
    and repository_name = lower(p_repository_name)
    and pull_request_number = p_pull_request_number
    and id <> created.id
    and superseded_by_id is null;

  return created;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'applications', 'sources', 'runs', 'run_events',
    'github_webhook_deliveries', 'pr_assessments', 'assessment_findings',
    'artifacts', 'link_reviews', 'eval_results', 'target_secrets'
  ] loop
    execute format('alter table sentinel.%I enable row level security', table_name);
    execute format('revoke all on sentinel.%I from public', table_name);
  end loop;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema sentinel from anon';
    execute 'revoke all on schema langgraph_checkpoint from anon';
    foreach table_name in array array[
      'applications', 'sources', 'runs', 'run_events',
      'github_webhook_deliveries', 'pr_assessments', 'assessment_findings',
      'artifacts', 'link_reviews', 'eval_results', 'target_secrets'
    ] loop
      execute format('revoke all on sentinel.%I from anon', table_name);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema sentinel from authenticated';
    execute 'revoke all on schema langgraph_checkpoint from authenticated';
    foreach table_name in array array[
      'applications', 'sources', 'runs', 'run_events',
      'github_webhook_deliveries', 'pr_assessments', 'assessment_findings',
      'artifacts', 'link_reviews', 'eval_results', 'target_secrets'
    ] loop
      execute format('revoke all on sentinel.%I from authenticated', table_name);
    end loop;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema sentinel to service_role';
    execute 'grant select, insert, update, delete on all tables in schema sentinel to service_role';
    execute 'grant execute on all functions in schema sentinel to service_role';
  end if;
end;
$$;

create or replace view sentinel.application_summaries
with (security_invoker = true)
as
select id, stable_key, name, deployment_url, status, indexed_commit_sha,
       graph_revision, refreshed_at, created_at, updated_at
from sentinel.applications;

create or replace view sentinel.run_timeline
with (security_invoker = true)
as
select id, run_id, sequence, event_kind, event, occurred_at
from sentinel.run_events;

revoke all on sentinel.application_summaries from public;
revoke all on sentinel.run_timeline from public;
revoke execute on all functions in schema sentinel from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on sentinel.application_summaries to service_role';
    execute 'grant select on sentinel.run_timeline to service_role';
  end if;
end;
$$;

do $$
declare
  bucket_name text := coalesce(
    nullif(current_setting('app.settings.sentinel_artifact_bucket', true), ''),
    'sentinel-artifacts'
  );
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (
      id, name, public, file_size_limit, allowed_mime_types
    ) values (
      bucket_name,
      bucket_name,
      false,
      52428800,
      array[
        'application/json', 'application/pdf', 'application/zip',
        'image/jpeg', 'image/png', 'text/html', 'text/markdown', 'text/plain'
      ]::text[]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

commit;
