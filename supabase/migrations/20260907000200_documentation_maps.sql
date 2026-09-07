begin;

create table if not exists sentinel.document_maps (
  application_id uuid not null references sentinel.applications(id) on delete cascade,
  source_stable_key text not null check (
    source_stable_key ~ '^document-source:v1:[a-f0-9]{64}$'
  ),
  root_uri text not null check (length(root_uri) between 1 and 4096),
  map_hash text not null check (map_hash ~ '^sha256:[a-f0-9]{64}$'),
  status text not null check (status in ('ready', 'warning', 'blocked')),
  coverage jsonb not null check (
    jsonb_typeof(coverage) = 'object' and octet_length(coverage::text) <= 16384
  ),
  warnings jsonb not null check (
    jsonb_typeof(warnings) = 'array' and octet_length(warnings::text) <= 32768
  ),
  updated_at timestamptz not null default now(),
  primary key (application_id, source_stable_key)
);

create table if not exists sentinel.document_pages (
  application_id uuid not null,
  source_stable_key text not null,
  stable_key text not null check (
    stable_key ~ '^document-page:v1:[a-f0-9]{64}$'
  ),
  canonical_uri text not null check (length(canonical_uri) between 1 and 4096),
  source_uri text not null check (length(source_uri) between 1 and 4096),
  title text not null check (length(title) between 1 and 512),
  media_type text not null check (media_type in ('text/html', 'text/markdown')),
  content_hash text not null check (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  sanitized_text text not null check (octet_length(sanitized_text) between 1 and 2097152),
  change_status text not null check (
    change_status in ('added', 'changed', 'unchanged')
  ),
  primary key (application_id, source_stable_key, stable_key),
  unique (application_id, source_stable_key, canonical_uri),
  foreign key (application_id, source_stable_key)
    references sentinel.document_maps(application_id, source_stable_key)
    on delete cascade
);

create table if not exists sentinel.document_sections (
  application_id uuid not null,
  source_stable_key text not null,
  page_stable_key text not null,
  stable_key text not null check (
    stable_key ~ '^document-section:v1:[a-f0-9]{64}$'
  ),
  source_uri text not null check (length(source_uri) between 1 and 4096),
  heading_path jsonb not null check (
    jsonb_typeof(heading_path) = 'array' and octet_length(heading_path::text) <= 16384
  ),
  excerpt text not null check (length(excerpt) between 1 and 4096),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  content_hash text not null check (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  primary key (application_id, source_stable_key, stable_key),
  foreign key (application_id, source_stable_key, page_stable_key)
    references sentinel.document_pages(application_id, source_stable_key, stable_key)
    on delete cascade
);

create index if not exists document_sections_page_idx
  on sentinel.document_sections (application_id, source_stable_key, page_stable_key, start_offset);

create table if not exists sentinel.document_links (
  application_id uuid not null,
  source_stable_key text not null,
  from_page_stable_key text not null,
  to_page_stable_key text not null,
  relation text not null default 'LINKS_TO' check (relation = 'LINKS_TO'),
  primary key (
    application_id, source_stable_key, from_page_stable_key, to_page_stable_key
  ),
  foreign key (application_id, source_stable_key, from_page_stable_key)
    references sentinel.document_pages(application_id, source_stable_key, stable_key)
    on delete cascade,
  foreign key (application_id, source_stable_key, to_page_stable_key)
    references sentinel.document_pages(application_id, source_stable_key, stable_key)
    on delete cascade
);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'document_maps', 'document_pages', 'document_sections', 'document_links'
  ] loop
    execute format('alter table sentinel.%I enable row level security', table_name);
    execute format('revoke all on sentinel.%I from public', table_name);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on sentinel.%I from anon', table_name);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on sentinel.%I from authenticated', table_name);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format(
        'grant select, insert, update, delete on sentinel.%I to service_role',
        table_name
      );
    end if;
  end loop;
end;
$$;

commit;
