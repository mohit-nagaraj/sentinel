begin;

create table if not exists sentinel.pr_investigation_values (
  stable_key text primary key check (stable_key ~ '^sha256:[a-f0-9]{64}$'),
  kind text not null check (kind in (
    'analysis', 'preparation', 'code-result', 'graph-paths', 'overlay',
    'curator-result', 'result'
  )),
  value jsonb not null check (
    jsonb_typeof(value) in ('object', 'array')
    and octet_length(value::text) <= 16777216
  ),
  created_at timestamptz not null default now()
);

alter table sentinel.pr_assessments
  add column if not exists investigation_result_id text,
  add column if not exists investigation_result jsonb;

alter table sentinel.pr_assessments
  drop constraint if exists pr_assessments_investigation_result_pair_check,
  drop constraint if exists pr_assessments_investigation_result_id_check,
  add constraint pr_assessments_investigation_result_pair_check check (
    (investigation_result_id is null) = (investigation_result is null)
  ),
  add constraint pr_assessments_investigation_result_id_check check (
    investigation_result_id is null
    or investigation_result_id ~ '^sha256:[a-f0-9]{64}$'
  );

revoke all on table sentinel.pr_investigation_values from public;

commit;
