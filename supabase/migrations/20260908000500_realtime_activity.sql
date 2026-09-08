begin;

alter table sentinel.runs
  add column if not exists pause_requested_at timestamptz;

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
    update sentinel.runs
    set status = 'interrupted', pause_requested_at = now(),
        resume_decision_id = 'resume_run'
    where id = p_run_id;
    insert into sentinel.run_interrupts (run_id, decision_id, prompt)
    values (p_run_id, 'resume_run', 'Run paused by operator')
    on conflict (run_id, decision_id) do nothing;
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
revoke execute on function sentinel.can_receive_run_broadcast(text, uuid) from public;
revoke execute on function sentinel.broadcast_run_event_cursor() from public;

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
