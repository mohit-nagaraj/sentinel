begin;

alter table sentinel.onboarding_configurations
  add column if not exists completed_through text;

update sentinel.onboarding_configurations
set completed_through = case
  when confirmed_at is not null then 'review'
  else 'safety'
end
where completed_through is null;

alter table sentinel.onboarding_configurations
  alter column completed_through set default 'none',
  alter column completed_through set not null;

alter table sentinel.onboarding_configurations
  drop constraint if exists onboarding_configurations_completed_through_check;

alter table sentinel.onboarding_configurations
  add constraint onboarding_configurations_completed_through_check
  check (completed_through in ('none', 'sources', 'access', 'safety', 'review'));

commit;
