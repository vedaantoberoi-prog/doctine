-- Doctine · medical knowledge: trusted guidance the assistant may quote, with where it came from and who approved it.
--
-- Until now Doctine had no knowledge source: every answer said "Doctine has not attached medical sources". This adds
-- the store, the search and the approval step. It adds NO content: what is loaded, and from whom, is decided by the
-- owner (licence) and a doctor (clinical review). See docs/EVIDENCE_SOURCES.md.
--
--   * private.knowledge_sources: one row per document (publisher, title, https url, licence, version, language).
--     status: draft (loaded, never used) → approved (searchable; needs who reviewed it and when) → retired.
--   * private.knowledge_chunks: the document split into passages, with a full-text index.
--   * public.knowledge_ingest(p_source jsonb, p_chunks jsonb): service role only (the ingestion tool). Always lands as
--     draft; loading the same publisher + url + version again replaces its passages and sends it back to draft.
--   * public.knowledge_search(p_query text, p_limit int): service role only (the chat server). Approved sources only.
--   * public.admin_knowledge_overview(p_actor uuid): health.view. Counts and the list of sources; no passages.
--   * public.admin_knowledge_set_status(p_actor uuid, p_source uuid, p_status text, p_reviewed_by text, p_reviewed_on date): ai.manage.
-- Nothing here holds anyone's health data.
-- Rollback: supabase/rollback/20261130000000_knowledge_down.sql

create table if not exists private.knowledge_sources (
  id           uuid primary key default gen_random_uuid(),
  publisher    text not null check (length(publisher) between 2 and 120),
  title        text not null check (length(title) between 2 and 300),
  url          text not null check (url ~ '^https://[a-z0-9.-]+\.[a-z]{2,}(/[^\s]*)?$' and length(url) <= 500),
  licence      text not null check (length(licence) between 2 and 200),
  licence_url  text check (licence_url is null or (licence_url ~ '^https://' and length(licence_url) <= 500)),
  language     text not null default 'en' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  published    date,
  version      text not null default '1' check (version ~ '^[0-9A-Za-z.+-]{1,40}$'),
  status       text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  reviewed_by  text check (reviewed_by is null or length(reviewed_by) between 2 and 120),
  reviewed_on  date,
  status_by    uuid,
  status_at    timestamptz,
  ingested_at  timestamptz not null default now(),
  passages     int not null default 0,
  unique (publisher, url, version),
  check (status <> 'approved' or (reviewed_by is not null and reviewed_on is not null))
);
create table if not exists private.knowledge_chunks (
  id         bigint generated always as identity primary key,
  source_id  uuid not null references private.knowledge_sources (id) on delete cascade,
  position   int not null check (position between 0 and 5000),
  heading    text check (heading is null or length(heading) <= 300),
  content    text not null check (length(content) between 20 and 2000),
  tsv        tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || content)) stored,
  unique (source_id, position)
);
create index if not exists knowledge_chunks_tsv on private.knowledge_chunks using gin (tsv);
alter table private.knowledge_sources enable row level security;
alter table private.knowledge_sources force row level security;
alter table private.knowledge_chunks enable row level security;
alter table private.knowledge_chunks force row level security;
revoke all on private.knowledge_sources, private.knowledge_chunks from public, anon, authenticated;

create or replace function public.knowledge_ingest(p_source jsonb, p_chunks jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private as $$
declare v_id uuid; v_n int := 0; c jsonb;
begin
  if jsonb_typeof(p_source) <> 'object' or jsonb_typeof(p_chunks) <> 'array' then raise exception 'knowledge_ingest: source object and chunk array required'; end if;
  if jsonb_array_length(p_chunks) = 0 or jsonb_array_length(p_chunks) > 2000 then raise exception 'knowledge_ingest: 1 to 2000 passages'; end if;
  insert into private.knowledge_sources (publisher, title, url, licence, licence_url, language, published, version)
  values (p_source->>'publisher', p_source->>'title', p_source->>'url', p_source->>'licence', nullif(p_source->>'licence_url', ''),
          coalesce(nullif(p_source->>'language', ''), 'en'), nullif(p_source->>'published', '')::date, coalesce(nullif(p_source->>'version', ''), '1'))
  on conflict (publisher, url, version) do update set title = excluded.title, licence = excluded.licence, licence_url = excluded.licence_url,
    language = excluded.language, published = excluded.published, status = 'draft', reviewed_by = null, reviewed_on = null,
    status_by = null, status_at = now(), ingested_at = now()
  returning id into v_id;
  delete from private.knowledge_chunks where source_id = v_id;
  for c in select * from jsonb_array_elements(p_chunks) loop
    insert into private.knowledge_chunks (source_id, position, heading, content)
    values (v_id, v_n, nullif(left(c->>'heading', 300), ''), c->>'content');
    v_n := v_n + 1;
  end loop;
  update private.knowledge_sources set passages = v_n where id = v_id;
  return jsonb_build_object('source_id', v_id, 'passages', v_n, 'status', 'draft');
end $$;

create or replace function public.knowledge_search(p_query text, p_limit int default 4) returns table (
  chunk_id bigint, source_id uuid, publisher text, title text, url text, licence text, published date, version text, heading text, content text, rank real)
language sql stable security definer set search_path = pg_catalog, private as $$
  with q as (select websearch_to_tsquery('english', left(coalesce(p_query, ''), 500)) as tq)
  select k.id, s.id, s.publisher, s.title, s.url, s.licence, s.published, s.version, k.heading, k.content, ts_rank_cd(k.tsv, q.tq)::real
  from q, private.knowledge_chunks k join private.knowledge_sources s on s.id = k.source_id
  where s.status = 'approved' and numnode(q.tq) > 0 and k.tsv @@ q.tq
  order by ts_rank_cd(k.tsv, q.tq) desc, k.id
  limit greatest(1, least(coalesce(p_limit, 4), 8))
$$;

create or replace function public.admin_knowledge_overview(p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'health.view');
  return jsonb_build_object(
    'approved', (select count(*) from private.knowledge_sources where status = 'approved'),
    'draft', (select count(*) from private.knowledge_sources where status = 'draft'),
    'retired', (select count(*) from private.knowledge_sources where status = 'retired'),
    'passages_searchable', (select coalesce(sum(passages), 0) from private.knowledge_sources where status = 'approved'),
    'last_ingest', (select max(ingested_at) from private.knowledge_sources),
    'sources', coalesce((select jsonb_agg(x order by x.ingested_at desc) from (
      select id, publisher, title, url, licence, version, language, published, status, reviewed_by, reviewed_on, passages, ingested_at
      from private.knowledge_sources order by ingested_at desc limit 100) x), '[]'::jsonb));
end $$;

create or replace function public.admin_knowledge_set_status(p_actor uuid, p_source uuid, p_status text, p_reviewed_by text default null, p_reviewed_on date default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare v_row private.knowledge_sources;
begin
  perform private.require(p_actor, 'ai.manage');
  if p_status not in ('draft', 'approved', 'retired') then raise exception 'unknown status' using errcode = '22023'; end if;
  if p_status = 'approved' and (coalesce(length(trim(p_reviewed_by)), 0) < 2 or p_reviewed_on is null or p_reviewed_on > current_date) then
    raise exception 'approving a source needs the reviewing doctor''s name and the review date' using errcode = '22023';
  end if;
  update private.knowledge_sources set status = p_status,
    reviewed_by = case when p_status = 'approved' then left(trim(p_reviewed_by), 120) else reviewed_by end,
    reviewed_on = case when p_status = 'approved' then p_reviewed_on else reviewed_on end,
    status_by = p_actor, status_at = now()
  where id = p_source returning * into v_row;
  if v_row.id is null then raise exception 'no such source' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'reviewed_by', v_row.reviewed_by, 'reviewed_on', v_row.reviewed_on);
end $$;

revoke all on function public.knowledge_ingest(jsonb, jsonb), public.knowledge_search(text, int), public.admin_knowledge_overview(uuid),
  public.admin_knowledge_set_status(uuid, uuid, text, text, date) from public, anon, authenticated;
grant execute on function public.knowledge_ingest(jsonb, jsonb), public.knowledge_search(text, int), public.admin_knowledge_overview(uuid),
  public.admin_knowledge_set_status(uuid, uuid, text, text, date) to service_role;

-- Chat activity, for the admin console: one row of METADATA per assistant reply. No message, no answer, no account id,
-- no health data: only the outcome, which safety layer acted, where the health context came from and how many items,
-- whether trusted sources were found, and timing. Kept 30 days.
create table if not exists private.ai_chat_events (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  status          int not null check (status between 100 and 599),
  error           text check (error is null or error ~ '^[a-z_]{1,40}$'),
  urgency         text check (urgency is null or urgency in ('routine', 'same_day', 'emergency')),
  safety          text check (safety is null or safety in ('rule', 'model', 'child_dose')),
  context_source  text not null default 'none' check (context_source in ('server', 'client', 'none', 'unavailable')),
  context_items   int not null default 0 check (context_items between 0 and 200),
  knowledge       text not null default 'off' check (knowledge ~ '^[a-z_]{1,20}$'),
  sources         int not null default 0 check (sources between 0 and 20),
  ms              int check (ms is null or ms between 0 and 600000),
  model           text check (model is null or model ~ '^[a-z0-9.-]{1,60}$'),
  env             text check (env is null or env ~ '^[a-z]{1,20}$')
);
create index if not exists ai_chat_events_at on private.ai_chat_events (at desc);
alter table private.ai_chat_events enable row level security;
alter table private.ai_chat_events force row level security;
revoke all on private.ai_chat_events from public, anon, authenticated;

create or replace function public.ai_chat_event_add(p_row jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if jsonb_typeof(p_row) <> 'object' then return false; end if;
  insert into private.ai_chat_events (status, error, urgency, safety, context_source, context_items, knowledge, sources, ms, model, env)
  values (case when (p_row->>'status') ~ '^[1-5][0-9]{2}$' then (p_row->>'status')::int else 500 end,
    case when (p_row->>'error') ~ '^[a-z_]{1,40}$' then p_row->>'error' end,
    case when p_row->>'urgency' in ('routine', 'same_day', 'emergency') then p_row->>'urgency' end,
    case when p_row->>'safety' in ('rule', 'model', 'child_dose') then p_row->>'safety' end,
    case when p_row->>'context_source' in ('server', 'client', 'none', 'unavailable') then p_row->>'context_source' else 'none' end,
    case when (p_row->>'context_items') ~ '^[0-9]{1,3}$' then least((p_row->>'context_items')::int, 200) else 0 end,
    case when (p_row->>'knowledge') ~ '^[a-z_]{1,20}$' then p_row->>'knowledge' else 'off' end,
    case when (p_row->>'sources') ~ '^[0-9]{1,2}$' then least((p_row->>'sources')::int, 20) else 0 end,
    case when (p_row->>'ms') ~ '^[0-9]{1,6}$' then least((p_row->>'ms')::int, 600000) end,
    nullif(left(regexp_replace(lower(coalesce(p_row->>'model', '')), '[^a-z0-9.-]', '', 'g'), 60), ''),
    nullif(left(regexp_replace(lower(coalesce(p_row->>'env', '')), '[^a-z]', '', 'g'), 20), ''));
  if random() < 0.01 then delete from private.ai_chat_events where at < now() - interval '30 days'; end if;
  return true;
end $$;

create or replace function public.admin_ai_chat_activity(p_actor uuid, p_hours int default 24) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare v_since timestamptz := now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)));
begin
  perform private.require(p_actor, 'health.view');
  return jsonb_build_object(
    'since', v_since,
    'replies', (select count(*) from private.ai_chat_events where at >= v_since and status < 400),
    'failed', (select count(*) from private.ai_chat_events where at >= v_since and status >= 400),
    'errors', coalesce((select jsonb_object_agg(error, n) from (select error, count(*) n from private.ai_chat_events where at >= v_since and error is not null group by error) e), '{}'::jsonb),
    'emergency', (select count(*) from private.ai_chat_events where at >= v_since and urgency = 'emergency'),
    'safety', coalesce((select jsonb_object_agg(safety, n) from (select safety, count(*) n from private.ai_chat_events where at >= v_since and safety is not null group by safety) s), '{}'::jsonb),
    'context', coalesce((select jsonb_object_agg(context_source, n) from (select context_source, count(*) n from private.ai_chat_events where at >= v_since group by context_source) c), '{}'::jsonb),
    'with_sources', (select count(*) from private.ai_chat_events where at >= v_since and sources > 0),
    'knowledge', coalesce((select jsonb_object_agg(knowledge, n) from (select knowledge, count(*) n from private.ai_chat_events where at >= v_since group by knowledge) k), '{}'::jsonb),
    'p50_ms', (select percentile_disc(0.5) within group (order by ms) from private.ai_chat_events where at >= v_since and ms is not null),
    'p95_ms', (select percentile_disc(0.95) within group (order by ms) from private.ai_chat_events where at >= v_since and ms is not null),
    'last_at', (select max(at) from private.ai_chat_events),
    'hourly', coalesce((select jsonb_agg(h order by h.hour) from (
      select date_trunc('hour', at) as hour, count(*) filter (where status < 400) as ok, count(*) filter (where status >= 400) as failed
      from private.ai_chat_events where at >= v_since group by 1) h), '[]'::jsonb));
end $$;

revoke all on function public.ai_chat_event_add(jsonb), public.admin_ai_chat_activity(uuid, int) from public, anon, authenticated;
grant execute on function public.ai_chat_event_add(jsonb), public.admin_ai_chat_activity(uuid, int) to service_role;
