begin;

create table if not exists sentinel.onboarding_configurations (
  application_id uuid primary key
    references sentinel.applications(id) on delete cascade,
  operator_id uuid not null,
  configuration jsonb not null check (
    jsonb_typeof(configuration) = 'object'
    and octet_length(configuration::text) <= 131072
    and not jsonb_path_exists(
      configuration,
      'lax $.**.keyvalue() ? (@.key like_regex "^(value|password|secret|storageState)$" flag "i")',
      '{}'::jsonb,
      true
    )
  ),
  input_fingerprint text not null check (
    input_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  inspected_fingerprint text check (
    inspected_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  compatibility_report jsonb check (
    compatibility_report is null or (
      jsonb_typeof(compatibility_report) = 'object'
      and octet_length(compatibility_report::text) <= 131072
    )
  ),
  confirmation_fingerprint text check (
    confirmation_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  knowledge_stale boolean not null default false,
  inspected_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, application_id),
  check (
    (inspected_fingerprint is null) = (compatibility_report is null)
  ),
  check (
    compatibility_report is null
    or compatibility_report ->> 'inputFingerprint' = inspected_fingerprint
  ),
  check (
    confirmation_fingerprint is null
    or (
      confirmation_fingerprint = input_fingerprint
      and confirmation_fingerprint = inspected_fingerprint
      and compatibility_report ->> 'status' <> 'blocked'
    )
  ),
  check ((confirmation_fingerprint is null) = (confirmed_at is null))
);

create index if not exists onboarding_configurations_operator_idx
  on sentinel.onboarding_configurations (operator_id, updated_at desc);

alter table sentinel.onboarding_configurations enable row level security;
revoke all on table sentinel.onboarding_configurations from anon;
revoke all on table sentinel.onboarding_configurations from authenticated;

drop trigger if exists onboarding_configurations_set_updated_at
  on sentinel.onboarding_configurations;
create trigger onboarding_configurations_set_updated_at
before update on sentinel.onboarding_configurations
for each row execute function sentinel.set_updated_at();

commit;
