begin;

create table if not exists sentinel.knowledge_publications (
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  graph_revision bigint not null check (graph_revision > 0),
  run_id uuid not null references sentinel.runs(id) on delete restrict,
  publication_hash text not null check (
    publication_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  indexed_commit_sha text not null check (
    indexed_commit_sha ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'
  ),
  summary jsonb not null check (
    jsonb_typeof(summary) = 'object'
    and octet_length(summary::text) <= 65536
  ),
  created_at timestamptz not null default now(),
  primary key (application_id, graph_revision),
  unique (run_id)
);

create index if not exists knowledge_publications_current_idx
  on sentinel.knowledge_publications (application_id, graph_revision desc);

revoke all on sentinel.knowledge_publications from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on sentinel.knowledge_publications to service_role;
  end if;
end;
$$;

commit;
