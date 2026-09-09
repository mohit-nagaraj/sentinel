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

alter table sentinel.report_verification_enrichments
  add column if not exists targeted_result_id text,
  add column if not exists idempotency_key text;

alter table sentinel.report_verification_enrichments
  add constraint report_verification_targeted_result_check check (
    targeted_result_id is null
    or targeted_result_id ~ '^sha256:[a-f0-9]{64}$'
  ),
  add constraint report_verification_idempotency_key_check check (
    idempotency_key is null
    or idempotency_key ~ '^sha256:[a-f0-9]{64}$'
  ),
  add constraint report_verification_retry_identity_check check (
    (targeted_result_id is null) = (idempotency_key is null)
  );

create unique index if not exists report_verification_idempotency_idx
  on sentinel.report_verification_enrichments (
    assessment_id, report_id, idempotency_key
  )
  where idempotency_key is not null;

create or replace function sentinel.append_current_report_verification(
  p_assessment_id uuid,
  p_head_sha text,
  p_result_id text,
  p_idempotency_key text,
  p_verification jsonb,
  p_appended_at timestamptz
)
returns table (disposition text, version integer, report_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assessment sentinel.pr_assessments%rowtype;
  v_existing_version integer;
  v_existing_result_id text;
  v_version integer;
  v_payload jsonb;
begin
  if p_head_sha !~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
     or p_result_id !~ '^sha256:[a-f0-9]{64}$'
     or p_idempotency_key !~ '^sha256:[a-f0-9]{64}$'
     or p_appended_at is null
     or p_verification is null
     or jsonb_typeof(p_verification) <> 'object'
     or p_verification ? 'version'
     or (p_verification ->> 'status') not in (
       'passed', 'failed', 'behavior_changed', 'blocked',
       'not_run', 'verification_unavailable'
     )
     or jsonb_typeof(p_verification -> 'results') <> 'array'
     or jsonb_typeof(p_verification -> 'reason') <> 'string' then
    raise exception using errcode = 'P0001', message = 'report_verification_invalid';
  end if;

  select * into v_assessment
  from sentinel.pr_assessments assessment
  where assessment.id = p_assessment_id
  for update;

  if not found
     or v_assessment.head_sha <> p_head_sha
     or not v_assessment.is_current then
    return query select 'superseded'::text, null::integer, null::text;
    return;
  end if;
  if v_assessment.report_id is null then
    raise exception using errcode = 'P0001', message = 'report_not_found';
  end if;

  select enrichment.version, enrichment.targeted_result_id
    into v_existing_version, v_existing_result_id
  from sentinel.report_verification_enrichments enrichment
  where enrichment.assessment_id = p_assessment_id
    and enrichment.report_id = v_assessment.report_id
    and enrichment.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_result_id is distinct from p_result_id then
      raise exception using errcode = 'P0001', message = 'report_verification_idempotency_conflict';
    end if;
    return query select
      'existing'::text,
      v_existing_version,
      v_assessment.report_id;
    return;
  end if;

  select coalesce(max(enrichment.version), 0) + 1 into v_version
  from sentinel.report_verification_enrichments enrichment
  where enrichment.assessment_id = p_assessment_id
    and enrichment.report_id = v_assessment.report_id;

  v_payload := jsonb_build_object(
    'schemaVersion', 1,
    'assessmentId', p_assessment_id::text,
    'reportId', v_assessment.report_id,
    'version', v_version,
    'verification', p_verification || jsonb_build_object('version', v_version),
    'appendedAt', to_jsonb(p_appended_at)
  );

  insert into sentinel.report_verification_enrichments (
    assessment_id, report_id, version, payload, appended_at,
    targeted_result_id, idempotency_key
  ) values (
    p_assessment_id, v_assessment.report_id, v_version, v_payload, p_appended_at,
    p_result_id, p_idempotency_key
  );

  return query select
    'published'::text,
    v_version,
    v_assessment.report_id;
end;
$$;

revoke all on sentinel.verification_records from public;
revoke all on function sentinel.append_current_report_verification(
  uuid, text, text, text, jsonb, timestamptz
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on sentinel.verification_records to service_role;
    grant execute on function sentinel.append_current_report_verification(
      uuid, text, text, text, jsonb, timestamptz
    ) to service_role;
  end if;
end;
$$;

commit;
