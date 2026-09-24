begin;

create extension if not exists pgcrypto;

create or replace function public.atlas_memory_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.atlas_memory_knowledge (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  category text not null,
  source text,
  status text not null default 'approved',
  project_id text,
  logical_key text,
  dedupe_key text unique,
  effective_date timestamptz,
  verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  search_document tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_memory_decisions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  decision text not null,
  rationale text,
  status text not null default 'active',
  approved_by text,
  approved_at timestamptz,
  effective_at timestamptz,
  supersedes_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_memory_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  entity_type text,
  entity_id text,
  source text,
  occurred_at timestamptz not null default now(),
  dedupe_key text unique,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

drop trigger if exists atlas_memory_knowledge_touch_updated_at on public.atlas_memory_knowledge;
create trigger atlas_memory_knowledge_touch_updated_at
before update on public.atlas_memory_knowledge
for each row execute function public.atlas_memory_touch_updated_at();

drop trigger if exists atlas_memory_decisions_touch_updated_at on public.atlas_memory_decisions;
create trigger atlas_memory_decisions_touch_updated_at
before update on public.atlas_memory_decisions
for each row execute function public.atlas_memory_touch_updated_at();

create index if not exists atlas_memory_knowledge_search_idx
  on public.atlas_memory_knowledge using gin(search_document);
create index if not exists atlas_memory_knowledge_category_status_idx
  on public.atlas_memory_knowledge(category, status);
create index if not exists atlas_memory_knowledge_project_idx
  on public.atlas_memory_knowledge(project_id);
create index if not exists atlas_memory_knowledge_logical_key_idx
  on public.atlas_memory_knowledge(logical_key);
create index if not exists atlas_memory_knowledge_drive_file_idx
  on public.atlas_memory_knowledge((metadata->>'drive_file_id'));
create index if not exists atlas_memory_knowledge_updated_idx
  on public.atlas_memory_knowledge(updated_at desc);

create index if not exists atlas_memory_decisions_status_idx
  on public.atlas_memory_decisions(status, approved_at desc);
create index if not exists atlas_memory_events_occurred_idx
  on public.atlas_memory_events(occurred_at desc);
create index if not exists atlas_memory_events_entity_idx
  on public.atlas_memory_events(entity_type, entity_id, occurred_at desc);
create index if not exists atlas_memory_events_type_idx
  on public.atlas_memory_events(event_type, occurred_at desc);

alter table public.atlas_memory_knowledge enable row level security;
alter table public.atlas_memory_decisions enable row level security;
alter table public.atlas_memory_events enable row level security;

revoke all on table public.atlas_memory_knowledge from anon, authenticated;
revoke all on table public.atlas_memory_decisions from anon, authenticated;
revoke all on table public.atlas_memory_events from anon, authenticated;

grant all on table public.atlas_memory_knowledge to service_role;
grant all on table public.atlas_memory_decisions to service_role;
grant all on table public.atlas_memory_events to service_role;

comment on table public.atlas_memory_knowledge is
  'Structured current/historical knowledge for ATLAS organizational memory. Documents remain in Drive.';
comment on table public.atlas_memory_decisions is
  'Canonical structured decisions. A Knowledge category named decision does not replace this collection.';
comment on table public.atlas_memory_events is
  'Append-oriented event/timeline records for ATLAS organizational memory.';

commit;
