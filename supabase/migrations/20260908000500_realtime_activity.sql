begin;

alter table sentinel.runs
  add column if not exists pause_requested_at timestamptz;

create table if not exists sentinel.run_artifacts (
  run_id uuid not null references sentinel.runs(id) on delete cascade,
  artifact_id uuid not null references sentinel.artifacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (run_id, artifact_id)
);

create index if not exists run_artifacts_artifact_idx
  on sentinel.run_artifacts (artifact_id);

insert into sentinel.run_artifacts (run_id, artifact_id)
select artifact.run_id, artifact.id
from sentinel.artifacts artifact
where artifact.run_id is not null
on conflict (run_id, artifact_id) do nothing;

alter table sentinel.run_artifacts enable row level security;
revoke all on table sentinel.run_artifacts from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table sentinel.run_artifacts from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table sentinel.run_artifacts from authenticated;
  end if;
end;
$$;

create or replace function sentinel.enforce_run_status_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = old.status then return new; end if;
  if old.status = 'queued'
     and new.status in ('running', 'interrupted', 'cancelled') then
    return new;
  end if;
  if old.status = 'running' and new.status in (
    'cancelling', 'cancelled', 'succeeded', 'failed', 'interrupted'
  ) then
    return new;
  end if;
  if old.status = 'interrupted'
     and new.status in ('queued', 'running', 'cancelled') then
    return new;
  end if;
  if old.status = 'cancelling' and new.status in ('cancelled', 'failed') then
    return new;
  end if;
  raise exception 'invalid run status transition from % to %', old.status, new.status;
end;
$$;

create or replace function sentinel.clear_run_pause_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('cancelled', 'succeeded', 'failed')
     or (old.status = 'interrupted' and new.status in ('queued', 'running')) then
    new.pause_requested_at = null;
  end if;
  return new;
end;
$$;

drop trigger if exists runs_clear_pause_request on sentinel.runs;
create trigger runs_clear_pause_request
before update of status on sentinel.runs
for each row execute function sentinel.clear_run_pause_request();

create or replace function sentinel.next_pause_decision_id(p_run_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case count(*)
    when 0 then 'resume_run'
    else 'resume_run_' || (count(*) + 1)::text
  end
  from sentinel.run_interrupts interrupt
  where interrupt.run_id = p_run_id
    and interrupt.decision_id ~ '^resume_run(_[0-9]+)?$';
$$;

create or replace function sentinel.pause_control_run(
  p_operator_id uuid,
  p_run_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application_id uuid;
  v_decision_id text;
  v_run sentinel.runs;
begin
  select run.application_id into v_application_id
  from sentinel.runs run
  join sentinel.onboarding_configurations onboarding
    on onboarding.application_id = run.application_id
   and onboarding.operator_id = p_operator_id
  where run.id = p_run_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'run_not_found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_application_id::text, 0)
  );

  select run.* into v_run
  from sentinel.runs run
  join sentinel.onboarding_configurations onboarding
    on onboarding.application_id = run.application_id
   and onboarding.operator_id = p_operator_id
  where run.id = p_run_id
  for update of run;

  if v_run.status = 'queued' then
    v_decision_id := sentinel.next_pause_decision_id(p_run_id);
    update sentinel.runs
    set status = 'interrupted', pause_requested_at = now(),
        resume_decision_id = v_decision_id
    where id = p_run_id;
    insert into sentinel.run_interrupts (run_id, decision_id, prompt)
    values (p_run_id, v_decision_id, 'Run paused by operator');
    if v_run.run_type <> 'run_eval' then
      update sentinel.applications application
      set status = 'needs_review'
      where application.id = v_application_id
        and exists (
          select 1 from sentinel.onboarding_configurations onboarding
          where onboarding.application_id = v_application_id
            and onboarding.input_fingerprint = v_run.configuration_fingerprint
        );
    end if;
    return 'interrupted';
  end if;

  if v_run.status = 'running' then
    update sentinel.runs
    set pause_requested_at = coalesce(pause_requested_at, now())
    where id = p_run_id;
    return 'running';
  end if;

  if v_run.status = 'interrupted'
     and v_run.resume_decision_id = 'resume_run' then
    return 'interrupted';
  end if;

  raise exception using errcode = 'P0001', message = 'pause_not_allowed';
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
  v_application_id uuid;
  v_decision_id text;
begin
  select application_id into v_application_id
  from sentinel.runs where id = p_run_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'lease_lost';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_application_id::text, 0)
  );

  v_decision_id := case
    when p_decision_id = 'resume_run'
      then sentinel.next_pause_decision_id(p_run_id)
    else p_decision_id
  end;
  update sentinel.runs
  set status = 'interrupted', lease_owner = null, lease_expires_at = null,
      resume_decision_id = v_decision_id
  where id = p_run_id and status = 'running' and lease_owner = p_owner
    and lease_expires_at > now();
  if not found then
    raise exception using errcode = 'P0001', message = 'lease_lost';
  end if;

  update sentinel.applications application
  set status = 'needs_review'
  from sentinel.runs run
  join sentinel.onboarding_configurations onboarding
    on onboarding.application_id = run.application_id
   and onboarding.input_fingerprint = run.configuration_fingerprint
  where run.id = p_run_id and run.run_type <> 'run_eval'
    and application.id = run.application_id;

  insert into sentinel.run_interrupts (run_id, decision_id, prompt)
  values (p_run_id, v_decision_id, p_prompt)
  returning * into v_interrupt;
  return v_interrupt;
end;
$$;

create or replace function sentinel.can_receive_run_broadcast(
  p_topic text,
  p_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_actor_id is not null
    and p_topic ~ '^run:[0-9a-f-]{36}$'
    and exists (
      select 1
      from sentinel.runs run
      join sentinel.onboarding_configurations onboarding
        on onboarding.application_id = run.application_id
      where onboarding.operator_id = p_actor_id
        and p_topic = 'run:' || run.id::text
    );
$$;

create or replace function sentinel.broadcast_run_event_cursor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform realtime.send(
      pg_catalog.jsonb_build_object(
        'runId', new.run_id,
        'sequence', new.sequence
      ),
      'run_event',
      'run:' || new.run_id::text,
      true
    );
  exception when others then
    raise warning 'run_event_broadcast_failed';
  end;
  return new;
end;
$$;

drop trigger if exists run_events_broadcast_cursor on sentinel.run_events;
create trigger run_events_broadcast_cursor
after insert on sentinel.run_events
for each row execute function sentinel.broadcast_run_event_cursor();

create or replace function sentinel.broadcast_run_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
begin
  begin
    if tg_table_name = 'runs' then
      v_run_id := new.id;
    else
      v_run_id := new.run_id;
    end if;
    perform realtime.send(
      pg_catalog.jsonb_build_object('runId', v_run_id),
      'run_state',
      'run:' || v_run_id::text,
      true
    );
  exception when others then
    raise warning 'run_state_broadcast_failed';
  end;
  return new;
end;
$$;

drop trigger if exists runs_broadcast_state on sentinel.runs;
create trigger runs_broadcast_state
after update of status, pause_requested_at, cancel_requested_at,
  resume_decision_id on sentinel.runs
for each row execute function sentinel.broadcast_run_state();

drop trigger if exists run_interrupts_broadcast_state
  on sentinel.run_interrupts;
create trigger run_interrupts_broadcast_state
after insert or update of status, responded_at on sentinel.run_interrupts
for each row execute function sentinel.broadcast_run_state();

drop policy if exists sentinel_owned_run_broadcasts on realtime.messages;
create policy sentinel_owned_run_broadcasts
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and sentinel.can_receive_run_broadcast(
    (select realtime.topic()),
    (select auth.uid())
  )
);

revoke execute on function sentinel.pause_control_run(uuid, uuid) from public;
revoke execute on function sentinel.next_pause_decision_id(uuid) from public;
revoke execute on function sentinel.can_receive_run_broadcast(text, uuid) from public;
revoke execute on function sentinel.broadcast_run_event_cursor() from public;
revoke execute on function sentinel.broadcast_run_state() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function sentinel.can_receive_run_broadcast(text, uuid)
      to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function sentinel.pause_control_run(uuid, uuid)
      to service_role;
  end if;
end;
$$;

commit;
