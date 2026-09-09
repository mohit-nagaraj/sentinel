begin;

create table if not exists sentinel.verification_records (
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  run_id uuid not null references sentinel.runs(id) on delete cascade,
  assessment_id uuid not null references sentinel.pr_assessments(id) on delete cascade,
  stable_key text not null check (stable_key ~ '^sha256:[a-f0-9]{64}$'),
  record_kind text not null check (record_kind in (
    'start_input',
    'deployment_validation',
    'setup_receipt',
    'execution_cache',
    'mission_evidence',
    'mission_result',
    'aggregate_result'
  )),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 5242880
  ),
  created_at timestamptz not null default now(),
  primary key (application_id, run_id, stable_key)
);

create index if not exists verification_records_assessment_idx
  on sentinel.verification_records (assessment_id, record_kind, created_at);

revoke all on sentinel.verification_records from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on sentinel.verification_records to service_role;
  end if;
end;
$$;

commit;
