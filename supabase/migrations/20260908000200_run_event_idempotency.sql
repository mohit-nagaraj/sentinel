alter table sentinel.run_events
  add column if not exists idempotency_key text;

update sentinel.run_events
set idempotency_key = event ->> 'id'
where idempotency_key is null;

alter table sentinel.run_events
  alter column idempotency_key set not null;

alter table sentinel.run_events
  drop constraint if exists run_events_idempotency_key_check;

alter table sentinel.run_events
  add constraint run_events_idempotency_key_check
  check (
    length(idempotency_key) between 1 and 128
    and idempotency_key ~ '^[A-Za-z0-9:._-]+$'
  );

create unique index if not exists run_events_idempotency_idx
  on sentinel.run_events (run_id, idempotency_key);

drop function if exists sentinel.append_run_event(uuid, text, jsonb, timestamptz);

create or replace function sentinel.append_run_event(
  p_run_id uuid,
  p_event_kind text,
  p_event jsonb,
  p_occurred_at timestamptz,
  p_idempotency_key text
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
  if p_idempotency_key is null
    or length(p_idempotency_key) not between 1 and 128
    or p_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
  then
    raise exception 'invalid run event idempotency key';
  end if;

  select * into result
  from sentinel.run_events
  where run_id = p_run_id
    and idempotency_key = p_idempotency_key;
  if found then
    if result.event_kind <> p_event_kind
      or (result.event - 'id' - 'sequence' - 'occurredAt')
        <> (p_event - 'id' - 'sequence' - 'occurredAt')
    then
      raise exception 'run event idempotency conflict';
    end if;
    return result;
  end if;

  select next_event_sequence into allocated_sequence
  from sentinel.runs
  where id = p_run_id
  for update;

  if allocated_sequence is null then
    raise exception 'run not found';
  end if;

  select * into result
  from sentinel.run_events
  where run_id = p_run_id
    and idempotency_key = p_idempotency_key;
  if found then
    if result.event_kind <> p_event_kind
      or (result.event - 'id' - 'sequence' - 'occurredAt')
        <> (p_event - 'id' - 'sequence' - 'occurredAt')
    then
      raise exception 'run event idempotency conflict';
    end if;
    return result;
  end if;

  allocated_sequence := allocated_sequence + 1;
  update sentinel.runs
  set next_event_sequence = allocated_sequence
  where id = p_run_id;

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
    run_id, sequence, event_kind, event, occurred_at, idempotency_key
  ) values (
    p_run_id, allocated_sequence, p_event_kind,
    p_event || jsonb_build_object(
      'id', allocated_event_id,
      'runId', 'run:' || p_run_id::text,
      'sequence', allocated_sequence
    ),
    p_occurred_at,
    p_idempotency_key
  ) returning * into result;
  return result;
end;
$$;

revoke all on function sentinel.append_run_event(uuid, text, jsonb, timestamptz, text)
  from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function sentinel.append_run_event(uuid, text, jsonb, timestamptz, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function sentinel.append_run_event(uuid, text, jsonb, timestamptz, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function sentinel.append_run_event(uuid, text, jsonb, timestamptz, text) to service_role';
  end if;
end;
$$;
