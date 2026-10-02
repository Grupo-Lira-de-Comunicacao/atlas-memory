begin;

-- ATLAS MEMORY v2 shadow foundation.
-- Additive only: no destructive changes and no replacement of v1/v2.0 collections.

create extension if not exists vector with schema extensions;

alter table public.atlas_memory_knowledge
  add column if not exists origin text not null default 'legacy_curated',
  add column if not exists trust_level text not null default 'trusted',
  add column if not exists source_type text,
  add column if not exists source_id text,
  add column if not exists session_id text,
  add column if not exists observed_at timestamptz,
  add column if not exists importance smallint,
  add column if not exists confidence numeric(4,3),
  add column if not exists supersedes_id uuid references public.atlas_memory_knowledge(id) on delete set null,
  add column if not exists expires_at timestamptz,
  add column if not exists safe_to_act boolean not null default false,
  add column if not exists trigger_terms text[] not null default '{}'::text[],
  add column if not exists provenance jsonb not null default '{}'::jsonb,
  add column if not exists embedding extensions.vector(384),
  add column if not exists embedding_model text,
  add column if not exists embedding_updated_at timestamptz;

alter table public.atlas_memory_knowledge
  add constraint atlas_memory_knowledge_importance_check
    check (importance is null or importance between 1 and 10),
  add constraint atlas_memory_knowledge_confidence_check
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  add constraint atlas_memory_knowledge_trust_level_check
    check (trust_level in ('authoritative','trusted','agent','untrusted','system','legacy'));

create table if not exists public.atlas_memory_episodic (
  id uuid primary key default gen_random_uuid(),
  title text,
  snippet text not null,
  project_id text,
  logical_key text,
  dedupe_key text unique,
  claim_hash text,
  source_type text,
  source_id text,
  session_id text,
  actor_id text,
  origin text not null default 'agent',
  trust_level text not null default 'agent',
  observed_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  recall_count integer not null default 0,
  daily_count integer not null default 1,
  grounded_count integer not null default 0,
  total_score double precision not null default 0,
  max_score double precision not null default 0,
  query_hashes text[] not null default '{}'::text[],
  recall_days date[] not null default '{}'::date[],
  concept_tags text[] not null default '{}'::text[],
  importance smallint,
  confidence numeric(4,3),
  light_hits integer not null default 0,
  rem_hits integer not null default 0,
  last_light_at timestamptz,
  last_rem_at timestamptz,
  status text not null default 'staged',
  promoted_knowledge_id uuid references public.atlas_memory_knowledge(id) on delete set null,
  promoted_at timestamptz,
  expires_at timestamptz,
  provenance jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(384),
  embedding_model text,
  embedding_updated_at timestamptz,
  search_document tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(snippet, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint atlas_memory_episodic_importance_check
    check (importance is null or importance between 1 and 10),
  constraint atlas_memory_episodic_confidence_check
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint atlas_memory_episodic_trust_level_check
    check (trust_level in ('authoritative','trusted','agent','untrusted','system','legacy')),
  constraint atlas_memory_episodic_status_check
    check (status in ('staged','promoted','superseded','rejected','forgotten','expired'))
);

create table if not exists public.atlas_memory_recall_events (
  id uuid primary key default gen_random_uuid(),
  episodic_id uuid references public.atlas_memory_episodic(id) on delete cascade,
  knowledge_id uuid references public.atlas_memory_knowledge(id) on delete cascade,
  project_id text,
  query_hash text not null,
  relevance double precision,
  interactive boolean not null default true,
  recalled_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint atlas_memory_recall_target_check
    check (episodic_id is not null or knowledge_id is not null),
  constraint atlas_memory_recall_relevance_check
    check (relevance is null or (relevance >= 0 and relevance <= 1))
);

create table if not exists public.atlas_memory_origins (
  id uuid primary key default gen_random_uuid(),
  memory_kind text not null,
  memory_id uuid not null,
  source_type text,
  source_id text,
  session_id text,
  actor_id text,
  origin text not null,
  trust_level text not null,
  observed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint atlas_memory_origins_kind_check
    check (memory_kind in ('knowledge','decision','episodic')),
  constraint atlas_memory_origins_trust_check
    check (trust_level in ('authoritative','trusted','agent','untrusted','system','legacy'))
);

create table if not exists public.atlas_memory_forgotten_sources (
  id uuid primary key default gen_random_uuid(),
  selector_type text not null,
  selector_value text not null,
  reason text,
  requested_by text,
  forgotten_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(selector_type, selector_value)
);

create table if not exists public.atlas_memory_consolidation_runs (
  id uuid primary key default gen_random_uuid(),
  phase text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  candidate_count integer not null default 0,
  promoted_count integer not null default 0,
  merged_count integer not null default 0,
  superseded_count integer not null default 0,
  rejected_counts jsonb not null default '{}'::jsonb,
  model text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint atlas_memory_consolidation_phase_check
    check (phase in ('light','rem','deep','manual')),
  constraint atlas_memory_consolidation_status_check
    check (status in ('running','completed','degraded','failed','cancelled'))
);

drop trigger if exists atlas_memory_episodic_touch_updated_at on public.atlas_memory_episodic;
create trigger atlas_memory_episodic_touch_updated_at
before update on public.atlas_memory_episodic
for each row execute function public.atlas_memory_touch_updated_at();

create index if not exists atlas_memory_knowledge_provenance_idx
  on public.atlas_memory_knowledge(origin, trust_level);
create index if not exists atlas_memory_knowledge_importance_idx
  on public.atlas_memory_knowledge(importance desc nulls last);
create index if not exists atlas_memory_knowledge_source_id_idx
  on public.atlas_memory_knowledge(source_type, source_id);
create index if not exists atlas_memory_knowledge_session_idx
  on public.atlas_memory_knowledge(session_id);
create index if not exists atlas_memory_knowledge_expires_idx
  on public.atlas_memory_knowledge(expires_at);
create index if not exists atlas_memory_knowledge_embedding_hnsw
  on public.atlas_memory_knowledge using hnsw (embedding vector_cosine_ops);

create index if not exists atlas_memory_episodic_search_idx
  on public.atlas_memory_episodic using gin(search_document);
create index if not exists atlas_memory_episodic_project_status_idx
  on public.atlas_memory_episodic(project_id, status, last_seen_at desc);
create index if not exists atlas_memory_episodic_logical_key_idx
  on public.atlas_memory_episodic(logical_key);
create index if not exists atlas_memory_episodic_session_idx
  on public.atlas_memory_episodic(session_id);
create index if not exists atlas_memory_episodic_embedding_hnsw
  on public.atlas_memory_episodic using hnsw (embedding vector_cosine_ops);
create index if not exists atlas_memory_recall_episode_idx
  on public.atlas_memory_recall_events(episodic_id, recalled_at desc);
create index if not exists atlas_memory_recall_knowledge_idx
  on public.atlas_memory_recall_events(knowledge_id, recalled_at desc);
create index if not exists atlas_memory_recall_query_idx
  on public.atlas_memory_recall_events(query_hash, recalled_at desc);
create index if not exists atlas_memory_origins_memory_idx
  on public.atlas_memory_origins(memory_kind, memory_id);
create index if not exists atlas_memory_origins_session_idx
  on public.atlas_memory_origins(session_id);
create index if not exists atlas_memory_origins_source_idx
  on public.atlas_memory_origins(source_type, source_id);
create index if not exists atlas_memory_consolidation_runs_started_idx
  on public.atlas_memory_consolidation_runs(started_at desc);

alter table public.atlas_memory_episodic enable row level security;
alter table public.atlas_memory_recall_events enable row level security;
alter table public.atlas_memory_origins enable row level security;
alter table public.atlas_memory_forgotten_sources enable row level security;
alter table public.atlas_memory_consolidation_runs enable row level security;

revoke all on table public.atlas_memory_episodic from anon, authenticated;
revoke all on table public.atlas_memory_recall_events from anon, authenticated;
revoke all on table public.atlas_memory_origins from anon, authenticated;
revoke all on table public.atlas_memory_forgotten_sources from anon, authenticated;
revoke all on table public.atlas_memory_consolidation_runs from anon, authenticated;

grant all on table public.atlas_memory_episodic to service_role;
grant all on table public.atlas_memory_recall_events to service_role;
grant all on table public.atlas_memory_origins to service_role;
grant all on table public.atlas_memory_forgotten_sources to service_role;
grant all on table public.atlas_memory_consolidation_runs to service_role;

create or replace function public.atlas_memory_hybrid_search(
  query_text text,
  query_embedding text default null,
  match_count integer default 20,
  filter_project_id text default null,
  include_untrusted boolean default false
)
returns table (
  id uuid,
  title text,
  content text,
  category text,
  source text,
  status text,
  project_id text,
  logical_key text,
  dedupe_key text,
  effective_date timestamptz,
  verified_at timestamptz,
  metadata jsonb,
  origin text,
  trust_level text,
  source_type text,
  source_id text,
  session_id text,
  observed_at timestamptz,
  importance smallint,
  confidence numeric,
  safe_to_act boolean,
  trigger_terms text[],
  provenance jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  score double precision,
  text_score double precision,
  vector_score double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
with eligible as (
  select k.*
  from public.atlas_memory_knowledge k
  where upper(k.status) not in ('SUPERSEDED','HISTORICAL','DELETED')
    and (k.expires_at is null or k.expires_at > now())
    and (filter_project_id is null or k.project_id = filter_project_id)
    and (
      include_untrusted
      or k.trust_level not in ('untrusted','system')
    )
),
full_text as (
  select
    e.id,
    row_number() over (
      order by ts_rank_cd(e.search_document, websearch_to_tsquery('simple', query_text)) desc,
               e.updated_at desc
    ) as rank_ix,
    ts_rank_cd(e.search_document, websearch_to_tsquery('simple', query_text))::double precision as text_score
  from eligible e
  where coalesce(query_text, '') <> ''
    and e.search_document @@ websearch_to_tsquery('simple', query_text)
  order by rank_ix
  limit least(greatest(match_count, 1), 100) * 3
),
semantic as (
  select
    e.id,
    row_number() over (
      order by e.embedding <=> (query_embedding::extensions.vector(384))
    ) as rank_ix,
    greatest(0::double precision, 1 - (e.embedding <=> (query_embedding::extensions.vector(384)))) as vector_score
  from eligible e
  where query_embedding is not null
    and e.embedding is not null
  order by rank_ix
  limit least(greatest(match_count, 1), 100) * 3
),
combined as (
  select
    coalesce(f.id, s.id) as id,
    coalesce(1.0 / (50 + f.rank_ix), 0.0) as text_rrf,
    coalesce(1.0 / (50 + s.rank_ix), 0.0) as vector_rrf,
    coalesce(f.text_score, 0.0) as text_score,
    coalesce(s.vector_score, 0.0) as vector_score
  from full_text f
  full outer join semantic s on s.id = f.id
)
select
  e.id,
  e.title,
  e.content,
  e.category,
  e.source,
  e.status,
  e.project_id,
  e.logical_key,
  e.dedupe_key,
  e.effective_date,
  e.verified_at,
  e.metadata,
  e.origin,
  e.trust_level,
  e.source_type,
  e.source_id,
  e.session_id,
  e.observed_at,
  e.importance,
  e.confidence,
  e.safe_to_act,
  e.trigger_terms,
  e.provenance,
  e.created_at,
  e.updated_at,
  (
    (c.text_rrf + c.vector_rrf)
    * (0.75 + 0.05 * coalesce(e.importance, 5))
    * (case
        when e.updated_at >= now() - interval '7 days' then 1.10
        when e.updated_at >= now() - interval '30 days' then 1.05
        else 1.00
      end)
  )::double precision as score,
  c.text_score,
  c.vector_score
from combined c
join eligible e on e.id = c.id
order by score desc, e.updated_at desc
limit least(greatest(match_count, 1), 100);
$$;

create or replace function public.atlas_memory_promotion_candidates(
  candidate_limit integer default 20,
  min_score double precision default 0.55,
  min_recall_count integer default 2,
  min_unique_queries integer default 2,
  max_age_days integer default 90
)
returns table (
  id uuid,
  title text,
  snippet text,
  project_id text,
  logical_key text,
  source_type text,
  source_id text,
  session_id text,
  origin text,
  trust_level text,
  observed_at timestamptz,
  recall_count integer,
  unique_queries integer,
  importance smallint,
  confidence numeric,
  concept_tags text[],
  score double precision,
  provenance jsonb,
  metadata jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
with scored as (
  select
    e.*,
    cardinality(e.query_hashes) as uq,
    (
      0.30 * least(1.0, case when e.recall_count > 0 then e.total_score / e.recall_count else e.max_score end)
      + 0.24 * least(1.0, e.recall_count / 5.0)
      + 0.15 * least(1.0, cardinality(e.query_hashes) / 3.0)
      + 0.15 * (1.0 / (1.0 + extract(epoch from (now() - e.last_seen_at)) / 86400.0 / 14.0))
      + 0.10 * least(1.0, e.daily_count / 3.0)
      + 0.06 * least(1.0, cardinality(e.concept_tags) / 3.0)
      + 0.02 * least(1.0, (e.light_hits + e.rem_hits) / 4.0)
    )::double precision as candidate_score
  from public.atlas_memory_episodic e
  where e.status = 'staged'
    and e.trust_level not in ('untrusted','system')
    and (e.expires_at is null or e.expires_at > now())
    and e.last_seen_at >= now() - make_interval(days => greatest(max_age_days, 1))
)
select
  s.id,
  s.title,
  s.snippet,
  s.project_id,
  s.logical_key,
  s.source_type,
  s.source_id,
  s.session_id,
  s.origin,
  s.trust_level,
  s.observed_at,
  s.recall_count,
  s.uq,
  s.importance,
  s.confidence,
  s.concept_tags,
  s.candidate_score,
  s.provenance,
  s.metadata
from scored s
where s.candidate_score >= min_score
  and s.recall_count >= min_recall_count
  and s.uq >= min_unique_queries
order by s.candidate_score desc, s.last_seen_at desc
limit least(greatest(candidate_limit, 1), 100);
$$;

comment on table public.atlas_memory_episodic is
  'ATLAS MEMORY v2 short-term/episodic candidate store inspired by OpenClaw memory-core, adapted to Supabase.';
comment on table public.atlas_memory_recall_events is
  'Recall evidence used for frequency, relevance and query-diversity promotion signals.';
comment on table public.atlas_memory_origins is
  'Lineage/provenance records supporting trust gating and future forget-by-provenance operations.';
comment on table public.atlas_memory_forgotten_sources is
  'Persistent admission blocklist for sources/sessions explicitly forgotten.';
comment on table public.atlas_memory_consolidation_runs is
  'Auditable Light/REM/Deep-style consolidation run summaries.';

commit;
