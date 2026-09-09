begin;

alter table sentinel.pr_assessments
  alter column diff_hash drop not null,
  alter column baseline_status drop not null,
  add column if not exists github_installation_id text,
  add column if not exists github_repository_id text,
  add column if not exists github_pull_request_id text,
  add column if not exists provider_updated_at timestamptz,
  add column if not exists trigger_source text,
  add column if not exists trigger_action text,
  add column if not exists run_id uuid,
  add column if not exists check_run_id bigint,
  add column if not exists check_sync_token uuid,
  add column if not exists check_sync_expires_at timestamptz,
  add column if not exists check_sync_attempted_at timestamptz;

alter table sentinel.pr_assessments
  drop constraint if exists pr_assessments_analysis_pair_check,
  drop constraint if exists pr_assessments_github_installation_id_check,
  drop constraint if exists pr_assessments_github_repository_id_check,
  drop constraint if exists pr_assessments_github_pull_request_id_check,
  drop constraint if exists pr_assessments_trigger_source_check,
  drop constraint if exists pr_assessments_trigger_action_check,
  drop constraint if exists pr_assessments_run_id_fkey,
  drop constraint if exists pr_assessments_check_run_id_check,
  drop constraint if exists pr_assessments_check_sync_pair_check;

alter table sentinel.pr_assessments
  add constraint pr_assessments_analysis_pair_check check (
    (diff_hash is null) = (baseline_status is null)
  ),
  add constraint pr_assessments_github_installation_id_check check (
    github_installation_id is null
    or github_installation_id ~ '^[1-9][0-9]{0,19}$'
  ),
  add constraint pr_assessments_github_repository_id_check check (
    github_repository_id is null
    or github_repository_id ~ '^[1-9][0-9]{0,19}$'
  ),
  add constraint pr_assessments_github_pull_request_id_check check (
    github_pull_request_id is null
    or github_pull_request_id ~ '^[1-9][0-9]{0,19}$'
  ),
  add constraint pr_assessments_trigger_source_check check (
    trigger_source is null or trigger_source in ('webhook', 'manual')
  ),
  add constraint pr_assessments_trigger_action_check check (
    trigger_action is null or trigger_action in (
      'opened', 'reopened', 'synchronize', 'ready_for_review', 'manual'
    )
  ),
  add constraint pr_assessments_run_id_fkey
    foreign key (application_id, run_id)
    references sentinel.runs(application_id, id)
    on delete set null (run_id),
  add constraint pr_assessments_check_run_id_check check (check_run_id > 0),
  add constraint pr_assessments_check_sync_pair_check check (
    (check_sync_token is null) = (check_sync_expires_at is null)
  );

create unique index if not exists pr_assessments_run_idx
  on sentinel.pr_assessments (application_id, run_id)
  where run_id is not null;

create unique index if not exists pr_assessments_check_run_idx
  on sentinel.pr_assessments (
    repository_host, repository_owner, repository_name, check_run_id
  ) where check_run_id is not null;

alter table sentinel.github_webhook_deliveries
  add column if not exists assessment_id uuid;

alter table sentinel.github_webhook_deliveries
  drop constraint if exists github_webhook_deliveries_assessment_id_fkey;

alter table sentinel.github_webhook_deliveries
  add constraint github_webhook_deliveries_assessment_id_fkey
    foreign key (assessment_id)
    references sentinel.pr_assessments(id)
    on delete set null;

create or replace function sentinel.github_repository_key(p_url text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select trim(trailing '/' from pg_catalog.regexp_replace(
    pg_catalog.lower(p_url), '\.git/?$', '', 'i'
  ));
$$;

create unique index if not exists onboarding_github_installation_repository_idx
  on sentinel.onboarding_configurations (
    (configuration #>> '{repository,installationId}'),
    (sentinel.github_repository_key(configuration #>> '{repository,url}'))
  ) where configuration #>> '{repository,accessMode}' = 'github_app';

create or replace function sentinel.get_manual_github_assessment_target(
  p_operator_id uuid,
  p_application_id uuid
)
returns table (
  application_id uuid,
  installation_id text,
  repository_host text,
  repository_owner text,
  repository_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select application.id,
         onboarding.configuration #>> '{repository,installationId}',
         'github.com'::text,
         pg_catalog.lower(pg_catalog.split_part(
           pg_catalog.regexp_replace(
             onboarding.configuration #>> '{repository,url}',
             '^https://github\.com/', '', 'i'
           ), '/', 1
         )),
         pg_catalog.lower(pg_catalog.split_part(
           pg_catalog.regexp_replace(
             sentinel.github_repository_key(
               onboarding.configuration #>> '{repository,url}'
             ),
             '^https://github\.com/', '', 'i'
           ), '/', 2
         ))
  from sentinel.applications application
  join sentinel.onboarding_configurations onboarding
    on onboarding.application_id = application.id
  where onboarding.operator_id = p_operator_id
    and application.id = p_application_id
    and onboarding.configuration #>> '{repository,accessMode}' = 'github_app'
    and onboarding.configuration #>> '{repository,installationId}'
      ~ '^[1-9][0-9]{0,19}$'
    and onboarding.confirmation_fingerprint = onboarding.input_fingerprint
    and application.graph_revision > 0
    and application.indexed_commit_sha is not null
    and application.status in ('ready', 'stale', 'failed', 'assessing_pr');
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
    and head_sha = p_head_sha
  for update;

  if found then
    if not existing.is_current then
      raise exception using errcode = 'P0001', message = 'stale_assessment';
    end if;
    if (existing.diff_hash is not null and existing.diff_hash <> p_diff_hash)
       or (existing.baseline_status is not null
           and existing.baseline_status <> p_baseline_status)
       or existing.base_sha <> p_base_sha then
      raise exception using errcode = 'P0001',
        message = 'assessment_idempotency_conflict';
    end if;
    update sentinel.pr_assessments
    set diff_hash = p_diff_hash,
        baseline_status = p_baseline_status
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

create or replace function sentinel.enqueue_github_pr_assessment(
  p_source text,
  p_delivery_id text,
  p_operator_id uuid,
  p_application_id uuid,
  p_installation_id text,
  p_repository_id text,
  p_repository_owner text,
  p_repository_name text,
  p_pull_request_id text,
  p_pull_request_number integer,
  p_base_sha text,
  p_head_sha text,
  p_provider_updated_at timestamptz,
  p_action text,
  p_budget jsonb
)
returns table (
  disposition text,
  assessment_id uuid,
  run_id uuid,
  installation_id text,
  repository_host text,
  repository_owner text,
  repository_name text,
  pull_request_number integer,
  head_sha text,
  is_current boolean,
  check_run_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_application sentinel.applications;
  v_onboarding sentinel.onboarding_configurations;
  v_existing sentinel.pr_assessments;
  v_current sentinel.pr_assessments;
  v_created sentinel.pr_assessments;
  v_delivery sentinel.github_webhook_deliveries;
  v_run_id uuid;
  v_expected_repository text;
  v_request jsonb;
  v_request_fingerprint text;
begin
  if p_source not in ('webhook', 'manual')
     or p_installation_id !~ '^[1-9][0-9]{0,19}$'
     or p_repository_id !~ '^[1-9][0-9]{0,19}$'
     or p_pull_request_id !~ '^[1-9][0-9]{0,19}$'
     or p_repository_owner is null or length(p_repository_owner) not between 1 and 100
     or p_repository_name is null or length(p_repository_name) not between 1 and 100
     or p_pull_request_number <= 0
     or p_base_sha !~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
     or p_head_sha !~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
     or p_provider_updated_at is null
     or (p_source = 'webhook' and (
       p_delivery_id is null or length(p_delivery_id) not between 1 and 255
       or p_operator_id is not null or p_application_id is not null
       or p_action not in ('opened', 'reopened', 'synchronize', 'ready_for_review')
     ))
     or (p_source = 'manual' and (
       p_delivery_id is not null or p_operator_id is null
       or p_application_id is null or p_action <> 'manual'
     )) then
    raise exception using errcode = 'P0001', message = 'invalid_github_assessment';
  end if;

  v_expected_repository := 'https://github.com/' || lower(p_repository_owner)
    || '/' || lower(p_repository_name);

  if p_source = 'webhook' then
    select application.* into v_application
    from sentinel.applications application
    join sentinel.onboarding_configurations onboarding
      on onboarding.application_id = application.id
    where onboarding.configuration #>> '{repository,accessMode}' = 'github_app'
      and onboarding.configuration #>> '{repository,installationId}' = p_installation_id
      and sentinel.github_repository_key(
        onboarding.configuration #>> '{repository,url}'
      ) = v_expected_repository
    limit 1;
  else
    select application.* into v_application
    from sentinel.applications application
    join sentinel.onboarding_configurations onboarding
      on onboarding.application_id = application.id
    where application.id = p_application_id
      and onboarding.operator_id = p_operator_id
      and onboarding.configuration #>> '{repository,accessMode}' = 'github_app'
      and onboarding.configuration #>> '{repository,installationId}' = p_installation_id
      and sentinel.github_repository_key(
        onboarding.configuration #>> '{repository,url}'
      ) = v_expected_repository;
  end if;

  if v_application.id is null then
    raise exception using errcode = 'P0001', message = 'github_installation_not_found';
  end if;

  select * into v_onboarding
  from sentinel.onboarding_configurations onboarding
  where onboarding.application_id = v_application.id
    and onboarding.configuration #>> '{repository,accessMode}' = 'github_app'
    and onboarding.configuration #>> '{repository,installationId}' = p_installation_id
    and sentinel.github_repository_key(
      onboarding.configuration #>> '{repository,url}'
    ) = v_expected_repository;

  if v_onboarding.application_id is null then
    raise exception using errcode = 'P0001', message = 'github_installation_not_found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      concat_ws(':', v_application.id::text, p_repository_id,
        p_pull_request_number::text),
      0
    )
  );

  if exists (
    select 1 from sentinel.pr_assessments assessment
    where assessment.application_id = v_application.id
      and assessment.repository_host = 'github.com'
      and assessment.repository_owner = lower(p_repository_owner)
      and assessment.repository_name = lower(p_repository_name)
      and assessment.github_repository_id is not null
      and assessment.github_repository_id <> p_repository_id
  ) then
    raise exception using errcode = 'P0001', message = 'github_identity_conflict';
  end if;

  if p_delivery_id is not null then
    select * into v_delivery
    from sentinel.github_webhook_deliveries delivery
    where delivery.delivery_id = p_delivery_id;
    if found then
      if v_delivery.application_id <> v_application.id
         or v_delivery.repository_host <> 'github.com'
         or v_delivery.repository_owner <> lower(p_repository_owner)
         or v_delivery.repository_name <> lower(p_repository_name)
         or v_delivery.event_name <> 'pull_request'
         or v_delivery.action <> p_action
         or v_delivery.head_sha is distinct from p_head_sha
         or v_delivery.assessment_id is null then
        raise exception using errcode = 'P0001', message = 'delivery_idempotency_conflict';
      end if;
      select * into v_existing
      from sentinel.pr_assessments assessment
      where assessment.id = v_delivery.assessment_id;
      return query select
        case when v_existing.is_current then 'duplicate' else 'stale' end,
        v_existing.id,
        case when v_existing.is_current then v_existing.run_id else null::uuid end,
        v_existing.github_installation_id,
        v_existing.repository_host, v_existing.repository_owner,
        v_existing.repository_name, v_existing.pull_request_number,
        v_existing.head_sha, v_existing.is_current,
        v_existing.check_run_id::text;
      return;
    end if;
  end if;

  select * into v_existing
  from sentinel.pr_assessments assessment
  where assessment.application_id = v_application.id
    and assessment.repository_host = 'github.com'
    and assessment.repository_owner = lower(p_repository_owner)
    and assessment.repository_name = lower(p_repository_name)
    and assessment.pull_request_number = p_pull_request_number
    and assessment.head_sha = p_head_sha
  for update;

  if found then
    if v_existing.base_sha <> p_base_sha
       or v_existing.github_repository_id is distinct from p_repository_id
       or v_existing.github_pull_request_id is distinct from p_pull_request_id
       or v_existing.github_installation_id is distinct from p_installation_id then
      raise exception using errcode = 'P0001', message = 'assessment_idempotency_conflict';
    end if;
    update sentinel.pr_assessments
    set provider_updated_at = greatest(provider_updated_at, p_provider_updated_at),
        trigger_source = p_source,
        trigger_action = p_action
    where id = v_existing.id
    returning * into v_existing;
    if p_delivery_id is not null then
      insert into sentinel.github_webhook_deliveries (
        delivery_id, application_id, repository_host, repository_owner,
        repository_name, event_name, action, head_sha, run_id, assessment_id
      ) values (
        p_delivery_id, v_application.id, 'github.com', lower(p_repository_owner),
        lower(p_repository_name), 'pull_request', p_action, p_head_sha,
        v_existing.run_id, v_existing.id
      );
    end if;
    return query select
      case when v_existing.is_current then 'duplicate' else 'stale' end,
      v_existing.id,
      case when v_existing.is_current then v_existing.run_id else null::uuid end,
      v_existing.github_installation_id,
      v_existing.repository_host, v_existing.repository_owner,
      v_existing.repository_name, v_existing.pull_request_number,
      v_existing.head_sha, v_existing.is_current,
      v_existing.check_run_id::text;
    return;
  end if;

  select * into v_current
  from sentinel.pr_assessments assessment
  where assessment.application_id = v_application.id
    and assessment.repository_host = 'github.com'
    and assessment.repository_owner = lower(p_repository_owner)
    and assessment.repository_name = lower(p_repository_name)
    and assessment.pull_request_number = p_pull_request_number
    and assessment.is_current
  for update;

  if found and v_current.provider_updated_at is not null
     and v_current.provider_updated_at > p_provider_updated_at then
    insert into sentinel.pr_assessments (
      application_id, repository_host, repository_owner, repository_name,
      pull_request_number, base_sha, head_sha, is_current, superseded_by_id,
      github_installation_id, github_repository_id, github_pull_request_id,
      provider_updated_at, trigger_source, trigger_action
    ) values (
      v_application.id, 'github.com', lower(p_repository_owner),
      lower(p_repository_name), p_pull_request_number, p_base_sha, p_head_sha,
      false, v_current.id, p_installation_id, p_repository_id,
      p_pull_request_id, p_provider_updated_at, p_source, p_action
    ) returning * into v_created;
    if p_delivery_id is not null then
      insert into sentinel.github_webhook_deliveries (
        delivery_id, application_id, repository_host, repository_owner,
        repository_name, event_name, action, head_sha, assessment_id
      ) values (
        p_delivery_id, v_application.id, 'github.com', lower(p_repository_owner),
        lower(p_repository_name), 'pull_request', p_action, p_head_sha,
        v_created.id
      );
    end if;
    return query select 'stale'::text, v_created.id, null::uuid,
      v_created.github_installation_id, v_created.repository_host,
      v_created.repository_owner, v_created.repository_name,
      v_created.pull_request_number, v_created.head_sha, false, null::text;
    return;
  end if;

  if v_current.id is not null then
    update sentinel.runs
    set status = 'cancelled',
        cancel_requested_at = coalesce(cancel_requested_at, now()),
        finished_at = coalesce(finished_at, now()),
        lease_owner = null,
        lease_expires_at = null,
        error_category = null,
        error_code = null,
        error_retryable = null
    where id = v_current.run_id
      and run_type = 'assess_pr'
      and status in ('queued', 'running', 'interrupted', 'cancelling');

    update sentinel.applications
    set status = case
      when v_onboarding.knowledge_stale then 'stale'
      else 'ready'
    end
    where id = v_application.id and status = 'assessing_pr';

    update sentinel.pr_assessments
    set is_current = false
    where id = v_current.id;
  end if;

  v_request := pg_catalog.jsonb_build_object(
    'pullRequestNumber', p_pull_request_number,
    'baseSha', p_base_sha,
    'headSha', p_head_sha
  );
  v_request_fingerprint := 'sha256:' || encode(
    extensions.digest(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'applicationId', v_application.id,
        'budget', p_budget,
        'payload', v_request,
        'type', 'assess_pr'
      )::text,
      'UTF8'
    ), 'sha256'),
    'hex'
  );

  select (control.result).id into v_run_id
  from sentinel.enqueue_control_run(
    v_onboarding.operator_id,
    v_application.id,
    'assess_pr',
    'github:assessment:' || p_repository_id || ':'
      || p_pull_request_number::text || ':' || p_head_sha,
    p_budget,
    v_request,
    v_request_fingerprint
  ) control;

  insert into sentinel.pr_assessments (
    application_id, repository_host, repository_owner, repository_name,
    pull_request_number, base_sha, head_sha, github_installation_id,
    github_repository_id, github_pull_request_id, provider_updated_at,
    trigger_source, trigger_action, run_id
  ) values (
    v_application.id, 'github.com', lower(p_repository_owner),
    lower(p_repository_name), p_pull_request_number, p_base_sha, p_head_sha,
    p_installation_id, p_repository_id, p_pull_request_id,
    p_provider_updated_at, p_source, p_action, v_run_id
  ) returning * into v_created;

  if v_current.id is not null then
    update sentinel.pr_assessments
    set superseded_by_id = v_created.id
    where id = v_current.id;
  end if;

  if p_delivery_id is not null then
    insert into sentinel.github_webhook_deliveries (
      delivery_id, application_id, repository_host, repository_owner,
      repository_name, event_name, action, head_sha, run_id, assessment_id
    ) values (
      p_delivery_id, v_application.id, 'github.com', lower(p_repository_owner),
      lower(p_repository_name), 'pull_request', p_action, p_head_sha,
      v_run_id, v_created.id
    );
  end if;

  return query select 'created'::text, v_created.id, v_run_id,
    v_created.github_installation_id, v_created.repository_host,
    v_created.repository_owner, v_created.repository_name,
    v_created.pull_request_number, v_created.head_sha, true,
    null::text;
end;
$$;

create or replace function sentinel.claim_github_assessment_check(
  p_assessment_id uuid,
  p_head_sha text,
  p_lease_seconds integer default 30
)
returns table (
  assessment_id uuid,
  installation_id text,
  repository_host text,
  repository_owner text,
  repository_name text,
  pull_request_number integer,
  head_sha text,
  is_current boolean,
  check_run_id text,
  sync_lease_token uuid,
  recovering boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_lease_seconds not between 5 and 120 then
    raise exception using errcode = 'P0001', message = 'invalid_check_lease';
  end if;
  return query
  with candidate as (
    select assessment.id,
           assessment.check_sync_attempted_at is not null as recovering
    from sentinel.pr_assessments assessment
    where assessment.id = p_assessment_id
      and assessment.head_sha = p_head_sha
      and assessment.is_current
      and assessment.check_run_id is null
      and (
        assessment.check_sync_token is null
        or assessment.check_sync_expires_at <= now()
      )
    for update
  ), claimed as (
    update sentinel.pr_assessments assessment
    set check_sync_token = gen_random_uuid(),
        check_sync_expires_at = now()
          + pg_catalog.make_interval(secs => p_lease_seconds),
        check_sync_attempted_at = now()
    from candidate
    where assessment.id = candidate.id
    returning assessment.*, candidate.recovering
  )
  select claimed.id, claimed.github_installation_id,
         claimed.repository_host, claimed.repository_owner,
         claimed.repository_name, claimed.pull_request_number,
         claimed.head_sha, claimed.is_current, claimed.check_run_id::text,
         claimed.check_sync_token, claimed.recovering
  from claimed
  where claimed.github_installation_id is not null;
end;
$$;

create or replace function sentinel.bind_github_assessment_check(
  p_assessment_id uuid,
  p_head_sha text,
  p_sync_lease_token uuid,
  p_check_run_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_check_run_id <= 0 then
    raise exception using errcode = 'P0001', message = 'invalid_check_run_id';
  end if;
  update sentinel.pr_assessments
  set check_run_id = p_check_run_id,
      check_sync_token = null,
      check_sync_expires_at = null
  where id = p_assessment_id
    and head_sha = p_head_sha
    and is_current
    and check_run_id is null
    and check_sync_token = p_sync_lease_token
    and check_sync_expires_at > now();
  return found;
end;
$$;

create or replace function sentinel.release_github_assessment_check(
  p_assessment_id uuid,
  p_head_sha text,
  p_sync_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update sentinel.pr_assessments
  set check_sync_token = null,
      check_sync_expires_at = null
  where id = p_assessment_id
    and head_sha = p_head_sha
    and check_run_id is null
    and check_sync_token = p_sync_lease_token;
  return found;
end;
$$;

create or replace function sentinel.get_current_github_assessment_check(
  p_assessment_id uuid,
  p_head_sha text
)
returns table (
  assessment_id uuid,
  installation_id text,
  repository_host text,
  repository_owner text,
  repository_name text,
  pull_request_number integer,
  head_sha text,
  is_current boolean,
  check_run_id text,
  sync_lease_token uuid,
  recovering boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select assessment.id, assessment.github_installation_id,
         assessment.repository_host, assessment.repository_owner,
         assessment.repository_name, assessment.pull_request_number,
         assessment.head_sha, assessment.is_current,
         assessment.check_run_id::text, null::uuid, false
  from sentinel.pr_assessments assessment
  where assessment.id = p_assessment_id
    and assessment.head_sha = p_head_sha
    and assessment.is_current
    and assessment.github_installation_id is not null;
$$;

revoke all on function sentinel.github_repository_key(text) from public;
revoke all on function sentinel.get_manual_github_assessment_target(uuid, uuid)
  from public;
revoke all on function sentinel.enqueue_github_pr_assessment(
  text, text, uuid, uuid, text, text, text, text, text, integer,
  text, text, timestamptz, text, jsonb
) from public;
revoke all on function sentinel.claim_github_assessment_check(uuid, text, integer)
  from public;
revoke all on function sentinel.bind_github_assessment_check(uuid, text, uuid, bigint)
  from public;
revoke all on function sentinel.release_github_assessment_check(uuid, text, uuid)
  from public;
revoke all on function sentinel.get_current_github_assessment_check(uuid, text)
  from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function sentinel.get_manual_github_assessment_target(uuid, uuid)
      to service_role;
    grant execute on function sentinel.enqueue_github_pr_assessment(
      text, text, uuid, uuid, text, text, text, text, text, integer,
      text, text, timestamptz, text, jsonb
    ) to service_role;
    grant execute on function sentinel.claim_github_assessment_check(uuid, text, integer)
      to service_role;
    grant execute on function sentinel.bind_github_assessment_check(uuid, text, uuid, bigint)
      to service_role;
    grant execute on function sentinel.release_github_assessment_check(uuid, text, uuid)
      to service_role;
    grant execute on function sentinel.get_current_github_assessment_check(uuid, text)
      to service_role;
  end if;
end $$;

commit;
