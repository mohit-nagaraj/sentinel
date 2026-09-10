begin;

create table if not exists sentinel.specialist_tool_drafts (
  application_id uuid not null,
  run_id uuid not null,
  specialist_kind text not null check (specialist_kind in ('documentation')),
  mission_id text not null check (mission_id ~ '^mission:v1:[a-f0-9]{64}$'),
  draft_id text not null check (draft_id ~ '^sha256:[a-f0-9]{64}$'),
  record_hash text not null check (record_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 5242880
  ),
  created_at timestamptz not null default now(),
  primary key (application_id, run_id, specialist_kind, mission_id, draft_id),
  foreign key (application_id, run_id)
    references sentinel.runs(application_id, id) on delete cascade
);

create table if not exists sentinel.specialist_tool_results (
  application_id uuid not null,
  run_id uuid not null,
  specialist_kind text not null check (
    specialist_kind in ('documentation', 'code')
  ),
  mission_id text not null check (mission_id ~ '^mission:v1:[a-f0-9]{64}$'),
  sequence integer not null check (sequence between 1 and 128),
  call_id text not null check (length(call_id) between 1 and 128),
  request_hash text not null check (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  record_hash text not null check (record_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 5242880
  ),
  created_at timestamptz not null default now(),
  primary key (application_id, run_id, specialist_kind, mission_id, call_id),
  unique (application_id, run_id, specialist_kind, mission_id, sequence),
  foreign key (application_id, run_id)
    references sentinel.runs(application_id, id) on delete cascade
);

create index if not exists specialist_tool_results_replay_idx
  on sentinel.specialist_tool_results (
    application_id, run_id, specialist_kind, mission_id, sequence
  );

create table if not exists sentinel.application_specialist_records (
  application_id uuid not null,
  run_id uuid not null,
  mission_id text not null check (mission_id ~ '^mission:v1:[a-f0-9]{64}$'),
  revision integer not null check (revision >= 0),
  record_hash text not null check (record_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 5242880
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (application_id, run_id, mission_id),
  foreign key (application_id, run_id)
    references sentinel.runs(application_id, id) on delete cascade
);

create trigger application_specialist_records_updated_at
before update on sentinel.application_specialist_records
for each row execute function sentinel.set_updated_at();

create table if not exists sentinel.specialist_tool_executions (
  application_id uuid not null,
  run_id uuid not null,
  mission_id text not null check (mission_id ~ '^mission:v1:[a-f0-9]{64}$'),
  call_id text not null check (length(call_id) between 1 and 128),
  request_hash text not null check (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  outcome text not null check (outcome in ('returned', 'threw')),
  result_hash text not null check (result_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 5242880
  ),
  completed_at timestamptz not null default now(),
  primary key (application_id, run_id, mission_id, call_id),
  foreign key (application_id, run_id)
    references sentinel.runs(application_id, id) on delete cascade
);

revoke all on sentinel.specialist_tool_drafts from public;
revoke all on sentinel.specialist_tool_results from public;
revoke all on sentinel.application_specialist_records from public;
revoke all on sentinel.specialist_tool_executions from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on sentinel.specialist_tool_drafts to service_role;
    grant select, insert on sentinel.specialist_tool_results to service_role;
    grant select, insert, update on sentinel.application_specialist_records
      to service_role;
    grant select, insert on sentinel.specialist_tool_executions to service_role;
  end if;
end;
$$;

commit;
