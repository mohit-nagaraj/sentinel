begin;

alter table sentinel.pr_assessments
  add column if not exists report_id text,
  add column if not exists report_identity_hash text,
  add column if not exists report_metadata jsonb,
  add column if not exists report_view jsonb,
  add column if not exists report_generated_at timestamptz;

alter table sentinel.pr_assessments
  drop constraint if exists pr_assessments_report_id_check;
alter table sentinel.pr_assessments
  add constraint pr_assessments_report_id_check
  check (report_id is null or report_id ~ '^sha256:[a-f0-9]{64}$');

alter table sentinel.pr_assessments
  drop constraint if exists pr_assessments_report_identity_hash_check;
alter table sentinel.pr_assessments
  add constraint pr_assessments_report_identity_hash_check
  check (
    report_identity_hash is null
    or report_identity_hash ~ '^sha256:[a-f0-9]{64}$'
  );

alter table sentinel.pr_assessments
  drop constraint if exists pr_assessments_report_state_check;
alter table sentinel.pr_assessments
  add constraint pr_assessments_report_state_check check (
    num_nonnulls(
      report_id, report_identity_hash, report_metadata, report_view,
      report_generated_at
    ) in (0, 5)
    and (report_id is null or report_artifact_id is not null)
  );

create table if not exists sentinel.report_verification_enrichments (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null
    references sentinel.pr_assessments(id) on delete cascade,
  report_id text not null check (report_id ~ '^sha256:[a-f0-9]{64}$'),
  version integer not null check (version > 0),
  payload jsonb not null,
  appended_at timestamptz not null,
  unique (assessment_id, report_id, version)
);

alter table sentinel.report_verification_enrichments enable row level security;

create or replace function sentinel.finalize_assessment_report(
  p_assessment_id uuid,
  p_head_sha text,
  p_report_id text,
  p_identity_hash text,
  p_report_artifact_id uuid,
  p_metadata jsonb,
  p_view jsonb,
  p_generated_at timestamptz
)
returns table (disposition text, report_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assessment sentinel.pr_assessments%rowtype;
  v_artifact sentinel.artifacts%rowtype;
begin
  if p_head_sha !~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
     or p_report_id !~ '^sha256:[a-f0-9]{64}$'
     or p_identity_hash !~ '^sha256:[a-f0-9]{64}$'
     or p_generated_at is null
     or p_metadata is null
     or p_view is null
     or jsonb_typeof(p_metadata) <> 'object'
     or jsonb_typeof(p_view) <> 'object'
     or (p_view ->> 'id') is distinct from p_report_id
     or (p_view ->> 'assessmentId') is distinct from p_assessment_id::text
     or (p_view ->> 'headSha') is distinct from p_head_sha then
    raise exception using errcode = 'P0001', message = 'report_input_invalid';
  end if;

  select * into v_assessment
  from sentinel.pr_assessments assessment
  where assessment.id = p_assessment_id
  for update;

  if not found
     or v_assessment.head_sha <> p_head_sha
     or not v_assessment.is_current then
    return query select 'superseded'::text, null::text;
    return;
  end if;

  select artifact.* into v_artifact
  from sentinel.artifacts artifact
  join storage.buckets bucket
    on bucket.id = artifact.bucket and bucket.public = false
  where artifact.id = p_report_artifact_id
    and artifact.application_id = v_assessment.application_id
    and artifact.artifact_type = 'assessment_report_markdown'
    and artifact.mime_type = 'text/markdown'
    and artifact.size_bytes > 0
    and artifact.deleted_at is null;

  if not found then
    raise exception using errcode = 'P0001', message = 'report_artifact_invalid';
  end if;

  if v_assessment.report_id is not null then
    if v_assessment.report_id = p_report_id
       and v_assessment.report_identity_hash = p_identity_hash
       and v_assessment.report_artifact_id = p_report_artifact_id then
      return query select 'existing'::text, v_assessment.report_id;
      return;
    end if;
    raise exception using errcode = 'P0001', message = 'report_identity_conflict';
  end if;

  update sentinel.pr_assessments
  set report_id = p_report_id,
      report_identity_hash = p_identity_hash,
      report_artifact_id = p_report_artifact_id,
      report_metadata = p_metadata,
      report_view = p_view,
      report_generated_at = p_generated_at,
      completed_at = coalesce(completed_at, p_generated_at)
  where id = p_assessment_id;

  update sentinel.artifacts
  set reference_count = reference_count + 1
  where id = p_report_artifact_id;

  return query select 'published'::text, p_report_id;
end;
$$;

create or replace function sentinel.append_report_verification_enrichment(
  p_assessment_id uuid,
  p_report_id text,
  p_version integer,
  p_payload jsonb,
  p_appended_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_version integer;
begin
  if p_version < 1
     or p_appended_at is null
     or p_payload is null
     or jsonb_typeof(p_payload) <> 'object'
     or (p_payload ->> 'assessmentId') is distinct from p_assessment_id::text
     or (p_payload ->> 'reportId') is distinct from p_report_id
     or (p_payload -> 'version') is distinct from to_jsonb(p_version)
     or (p_payload #> '{verification,version}') is distinct from to_jsonb(p_version) then
    raise exception using errcode = 'P0001', message = 'report_enrichment_invalid';
  end if;

  perform 1
  from sentinel.pr_assessments assessment
  where assessment.id = p_assessment_id
    and assessment.report_id = p_report_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'report_not_found';
  end if;

  select coalesce(max(enrichment.version), 0) into v_current_version
  from sentinel.report_verification_enrichments enrichment
  where enrichment.assessment_id = p_assessment_id
    and enrichment.report_id = p_report_id;

  if p_version > v_current_version + 1 then
    raise exception using errcode = 'P0001', message = 'report_enrichment_version_gap';
  end if;

  insert into sentinel.report_verification_enrichments (
    assessment_id, report_id, version, payload, appended_at
  ) values (
    p_assessment_id, p_report_id, p_version, p_payload, p_appended_at
  ) on conflict (assessment_id, report_id, version) do update
  set payload = excluded.payload
  where sentinel.report_verification_enrichments.payload = excluded.payload
    and sentinel.report_verification_enrichments.appended_at = excluded.appended_at;

  return found;
end;
$$;

revoke all on function sentinel.finalize_assessment_report(
  uuid, text, text, text, uuid, jsonb, jsonb, timestamptz
) from public;
revoke all on function sentinel.append_report_verification_enrichment(
  uuid, text, integer, jsonb, timestamptz
) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function sentinel.finalize_assessment_report(
      uuid, text, text, text, uuid, jsonb, jsonb, timestamptz
    ) to service_role;
    grant execute on function sentinel.append_report_verification_enrichment(
      uuid, text, integer, jsonb, timestamptz
    ) to service_role;
  end if;
end $$;

commit;
