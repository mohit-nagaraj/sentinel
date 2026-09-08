begin;

alter table sentinel.runs
  add column if not exists request jsonb not null default '{}'::jsonb,
  add column if not exists request_fingerprint text default (
    'sha256:' || repeat('0', 64)
  ),
  add column if not exists retry_of uuid,
  add column if not exists resume_decision_id text,
  add column if not exists error_retryable boolean,
  add column if not exists application_status_before text;

update sentinel.runs
set request_fingerprint = 'sha256:' || encode(
  extensions.digest((run_type || ':' || id::text)::bytea, 'sha256'),
  'hex'
)
where request_fingerprint is null;

update sentinel.runs
set error_retryable = false
where status = 'failed' and error_retryable is null;

alter table sentinel.runs
  drop constraint if exists runs_request_shape_check,
  drop constraint if exists runs_request_fingerprint_check,
  drop constraint if exists runs_resume_decision_check,
  drop constraint if exists runs_application_status_before_check,
  drop constraint if exists runs_failure_retryability_check,
  drop constraint if exists runs_retry_of_fkey;

alter table sentinel.runs
  alter column request_fingerprint set not null,
  add constraint runs_request_shape_check check (
    jsonb_typeof(request) = 'object'
    and octet_length(request::text) <= 16384
    and not jsonb_path_exists(
      request,
      'lax $.**.keyvalue() ? (@.key like_regex "^(authorization|cookie|password|secret|storageState|token)$" flag "i")',
      '{}'::jsonb,
      true
    )
  ),
  add constraint runs_request_fingerprint_check check (
    request_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  add constraint runs_resume_decision_check check (
    resume_decision_id is null
    or resume_decision_id ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  ),
  add constraint runs_application_status_before_check check (
    application_status_before is null or application_status_before in (
      'not_configured', 'inspecting', 'awaiting_confirmation',
      'initializing_knowledge', 'ready', 'assessing_pr', 'verifying',
      'refreshing', 'needs_review', 'stale', 'failed'
    )
  ),
  add constraint runs_failure_retryability_check check (
    (status = 'failed' and error_retryable is not null)
    or (status <> 'failed' and error_retryable is null)
  ),
  add constraint runs_retry_of_fkey foreign key (application_id, retry_of)
    references sentinel.runs(application_id, id) on delete set null (retry_of);

create unique index if not exists runs_active_application_mutation_idx
  on sentinel.runs (application_id)
  where run_type in (
    'inspect_application', 'initialize_knowledge', 'refresh_knowledge'
  ) and status in ('queued', 'running', 'interrupted', 'cancelling');

create table if not exists sentinel.run_interrupts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references sentinel.runs(id) on delete cascade,
  decision_id text not null check (
    decision_id ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
  ),
  prompt text not null check (length(prompt) between 1 and 4096),
  status text not null default 'pending' check (
    status in ('pending', 'responded')
  ),
  response jsonb,
  response_fingerprint text check (
    response_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  responded_by uuid,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (run_id, decision_id),
  check (
    (status = 'pending' and response is null and response_fingerprint is null
      and responded_by is null and responded_at is null)
    or
    (status = 'responded' and jsonb_typeof(response) = 'object'
      and octet_length(response::text) <= 8192
      and response_fingerprint is not null and responded_by is not null
      and responded_at is not null)
  ),
  check (
    response is null or not jsonb_path_exists(
      response,
      'lax $.**.keyvalue() ? (@.key like_regex "^(authorization|cookie|password|secret|storageState|token)$" flag "i")',
      '{}'::jsonb,
      true
    )
  )
);

create index if not exists run_interrupts_pending_idx
  on sentinel.run_interrupts (run_id, created_at)
  where status = 'pending';

alter table sentinel.run_interrupts enable row level security;
revoke all on table sentinel.run_interrupts from public;

create or replace function sentinel.enqueue_control_run(
  p_operator_id uuid,
  p_application_id uuid,
  p_run_type text,
  p_idempotency_key text,
  p_budget jsonb,
  p_request jsonb,
  p_request_fingerprint text
)
returns table (result sentinel.runs, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing sentinel.runs;
  v_onboarding sentinel.onboarding_configurations;
  v_application sentinel.applications;
begin
  select run.* into v_existing
  from sentinel.runs run
  join sentinel.onboarding_configurations onboarding
    on onboarding.application_id = run.application_id
   and onboarding.operator_id = p_operator_id
  where run.application_id = p_application_id
    and run.run_type = p_run_type
    and run.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    result := v_existing;
    created := false;
    return next;
    return;
  end if;

  select onboarding.* into v_onboarding
  from sentinel.onboarding_configurations onboarding
  join sentinel.applications application on application.id = onboarding.application_id
  where onboarding.application_id = p_application_id
    and onboarding.operator_id = p_operator_id
  for update of onboarding, application;

  if not found then
    raise exception using errcode = 'P0001', message = 'application_not_found';
  end if;

  select application.* into v_application
  from sentinel.applications application
  where application.id = p_application_id;

  if p_run_type <> 'inspect_application' and (
    v_onboarding.confirmation_fingerprint is null
    or v_onboarding.confirmation_fingerprint <> v_onboarding.input_fingerprint
  ) then
    raise exception using errcode = 'P0001', message = 'onboarding_not_confirmed';
  end if;
  if p_run_type in ('assess_pr', 'verify_pr', 'refresh_knowledge', 'run_eval')
     and v_application.status not in ('ready', 'stale', 'needs_review', 'failed') then
    raise exception using errcode = 'P0001', message = 'knowledge_not_ready';
  end if;

  begin
    insert into sentinel.runs (
      application_id, run_type, idempotency_key, budget, request,
      request_fingerprint, application_status_before
    ) values (
      p_application_id, p_run_type, p_idempotency_key, p_budget, p_request,
      p_request_fingerprint, v_application.status
    ) returning * into v_existing;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'active_run_conflict';
  end;

  update sentinel.applications
  set status = case p_run_type
    when 'inspect_application' then 'inspecting'
    when 'initialize_knowledge' then 'initializing_knowledge'
    when 'assess_pr' then 'assessing_pr'
    when 'verify_pr' then 'verifying'
    when 'refresh_knowledge' then 'refreshing'
    else status
  end
  where id = p_application_id;

  result := v_existing;
  created := true;
  return next;
end;
$$;

create or replace function sentinel.cancel_control_run(
  p_operator_id uuid,
  p_run_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_application_id uuid;
  v_status_before text;
begin
  update sentinel.runs run
  set status = case
        when run.status in ('queued', 'interrupted') then 'cancelled'
        else 'cancelling'
      end,
      cancel_requested_at = coalesce(run.cancel_requested_at, now()),
      finished_at = case
        when run.status in ('queued', 'interrupted') then coalesce(run.finished_at, now())
        else run.finished_at
      end,
      lease_owner = case
        when run.status in ('queued', 'interrupted') then null
        else run.lease_owner
      end,
      lease_expires_at = case
        when run.status in ('queued', 'interrupted') then null
        else run.lease_expires_at
      end
  from sentinel.onboarding_configurations onboarding
  where run.id = p_run_id
    and onboarding.application_id = run.application_id
    and onboarding.operator_id = p_operator_id
    and run.status in ('queued', 'running', 'interrupted')
  returning run.status, run.application_id, run.application_status_before
  into v_status, v_application_id, v_status_before;

  if v_status = 'cancelled' then
    update sentinel.applications
    set status = coalesce(v_status_before, status)
    where id = v_application_id;
  end if;

  if v_status is null then
    select run.status into v_status
    from sentinel.runs run
    join sentinel.onboarding_configurations onboarding
      on onboarding.application_id = run.application_id
     and onboarding.operator_id = p_operator_id
    where run.id = p_run_id and run.status in ('cancelling', 'cancelled');
  end if;
  return v_status;
end;
$$;

create or replace function sentinel.mark_run_interrupted(
  p_run_id uuid,
  p_owner text,
  p_decision_id text,
  p_prompt text
)
returns sentinel.run_interrupts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interrupt sentinel.run_interrupts;
begin
  update sentinel.runs
  set status = 'interrupted', lease_owner = null, lease_expires_at = null,
      resume_decision_id = p_decision_id
  where id = p_run_id and status = 'running' and lease_owner = p_owner
    and lease_expires_at > now();
  if not found then
    raise exception using errcode = 'P0001', message = 'lease_lost';
  end if;

  update sentinel.applications application
  set status = 'needs_review'
  from sentinel.runs run
  where run.id = p_run_id and application.id = run.application_id;

  insert into sentinel.run_interrupts (run_id, decision_id, prompt)
  values (p_run_id, p_decision_id, p_prompt)
  on conflict (run_id, decision_id) do update set prompt = excluded.prompt
  where sentinel.run_interrupts.status = 'pending'
  returning * into v_interrupt;
  if v_interrupt.id is null then
    raise exception using errcode = 'P0001', message = 'interrupt_conflict';
  end if;
  return v_interrupt;
end;
$$;

create or replace function sentinel.respond_run_interrupt(
  p_operator_id uuid,
  p_run_id uuid,
  p_decision_id text,
  p_response jsonb,
  p_response_fingerprint text
)
returns table (result sentinel.run_interrupts, idempotent boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_interrupt sentinel.run_interrupts;
begin
  select interrupt.* into v_interrupt
  from sentinel.run_interrupts interrupt
  join sentinel.runs run on run.id = interrupt.run_id
  join sentinel.onboarding_configurations onboarding
    on onboarding.application_id = run.application_id
   and onboarding.operator_id = p_operator_id
  where interrupt.run_id = p_run_id and interrupt.decision_id = p_decision_id
  for update of interrupt, run;
  if not found then
    raise exception using errcode = 'P0001', message = 'interrupt_not_found';
  end if;
  if v_interrupt.status = 'responded' then
    if v_interrupt.response_fingerprint <> p_response_fingerprint then
      raise exception using errcode = 'P0001', message = 'interrupt_conflict';
    end if;
    result := v_interrupt;
    idempotent := true;
    return next;
    return;
  end if;

  update sentinel.run_interrupts
  set status = 'responded', response = p_response,
      response_fingerprint = p_response_fingerprint,
      responded_by = p_operator_id, responded_at = now()
  where id = v_interrupt.id returning * into v_interrupt;
  update sentinel.runs
  set status = 'queued', lease_owner = null, lease_expires_at = null
  where id = p_run_id and status = 'interrupted'
    and resume_decision_id = p_decision_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'interrupt_conflict';
  end if;
  update sentinel.applications application
  set status = case run.run_type
    when 'inspect_application' then 'inspecting'
    when 'initialize_knowledge' then 'initializing_knowledge'
    when 'assess_pr' then 'assessing_pr'
    when 'verify_pr' then 'verifying'
    when 'refresh_knowledge' then 'refreshing'
    else application.status
  end
  from sentinel.runs run
  where run.id = p_run_id and application.id = run.application_id;
  result := v_interrupt;
  idempotent := false;
  return next;
end;
$$;

create or replace function sentinel.retry_control_run(
  p_operator_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
returns table (result sentinel.runs, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous sentinel.runs;
  v_next sentinel.runs;
  v_created boolean;
  v_control record;
begin
  select run.* into v_previous
  from sentinel.runs run
  join sentinel.onboarding_configurations onboarding
    on onboarding.application_id = run.application_id
   and onboarding.operator_id = p_operator_id
  where run.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'run_not_found';
  end if;
  if v_previous.status <> 'failed' or v_previous.error_retryable is not true then
    raise exception using errcode = 'P0001', message = 'retry_not_allowed';
  end if;

  select control.result, control.created into v_control
  from sentinel.enqueue_control_run(
    p_operator_id,
    v_previous.application_id,
    v_previous.run_type,
    p_idempotency_key,
    v_previous.budget,
    v_previous.request,
    v_previous.request_fingerprint
  ) control;
  v_next := v_control.result;
  v_created := v_control.created;

  if not v_created and v_next.retry_of is distinct from p_run_id then
    raise exception using errcode = 'P0001', message = 'idempotency_conflict';
  end if;
  if v_created then
    update sentinel.runs set retry_of = p_run_id
    where id = v_next.id returning * into v_next;
  end if;
  result := v_next;
  created := v_created;
  return next;
end;
$$;

create or replace function sentinel.finish_control_run(
  p_run_id uuid,
  p_owner text,
  p_status text,
  p_error_category text default null,
  p_error_code text default null,
  p_error_retryable boolean default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed integer;
  v_application_id uuid;
  v_run_type text;
  v_status_before text;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'invalid terminal run status';
  end if;
  if (p_status = 'failed') <> (
    p_error_category is not null and p_error_code is not null
    and p_error_retryable is not null
  ) then
    raise exception 'failure fields must match failed status';
  end if;
  update sentinel.runs
  set status = p_status, lease_owner = null, lease_expires_at = null,
      error_category = p_error_category, error_code = p_error_code,
      error_retryable = p_error_retryable, finished_at = now()
  where id = p_run_id and lease_owner = p_owner and lease_expires_at > now()
    and status in ('running', 'cancelling')
    and (status = 'running' or p_status in ('cancelled', 'failed'))
  returning application_id, run_type, application_status_before
  into v_application_id, v_run_type, v_status_before;
  get diagnostics v_changed = row_count;
  if v_changed = 1 and v_run_type <> 'run_eval' then
    update sentinel.applications
    set status = case
      when p_status = 'cancelled' then coalesce(v_status_before, 'failed')
      when p_status = 'failed' then 'failed'
      when v_run_type = 'inspect_application' then 'awaiting_confirmation'
      else 'ready'
    end
    where id = v_application_id;
  end if;
  return v_changed = 1;
end;
$$;

revoke execute on all functions in schema sentinel from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on sentinel.run_interrupts to service_role;
    grant execute on all functions in schema sentinel to service_role;
  end if;
end;
$$;

commit;
