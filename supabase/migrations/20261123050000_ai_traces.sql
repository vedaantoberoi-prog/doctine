-- Doctine · stored traces for the records assistant (/api/assist), 23 Nov 2026.
-- One row per request: states, timings, outcome, route, model, tokens and cost. No person, account, question, answer,
-- document or value is stored: there is no column that could hold one, and every text column is a short code checked
-- against a pattern. Rows older than 30 days are removed as new ones arrive.
-- Written only by the server (service role, record_ai_trace); read only as summaries in the admin console
-- (admin_ai_traces, health.view). Rollback: supabase/rollback/20261123050000_ai_traces_down.sql

create table if not exists private.ai_traces (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  route          text not null check (route in ('assist')),
  state          text not null check (state in ('COMPLETED', 'FAILED', 'ABORTED', 'ESCALATED', 'AWAITING_CONFIRMATION')),
  outcome        text check (outcome ~ '^[a-z_]{1,40}$'),
  category       text check (category ~ '^[a-z_]{1,40}$'),
  route_category text check (route_category in ('A', 'B', 'C', 'D')),
  model          text check (model ~ '^[a-z0-9.-]{1,60}$'),
  degraded       text check (degraded ~ '^[a-z_]{1,40}$'),
  tokens_in      int not null default 0 check (tokens_in between 0 and 10000000),
  tokens_out     int not null default 0 check (tokens_out between 0 and 10000000),
  cost_usd       numeric(12, 6) check (cost_usd >= 0),
  cache          text check (cache in ('hit', 'miss', 'none')),
  ms             int not null check (ms between 0 and 600000),
  retries        int not null default 0 check (retries between 0 and 20),
  policy_version text check (policy_version ~ '^[0-9a-z.+-]{1,40}$'),
  release        text check (release ~ '^[0-9a-f]{1,40}$'),
  spans          jsonb not null default '[]'::jsonb check (jsonb_typeof(spans) = 'array' and jsonb_array_length(spans) <= 20)
);
create index if not exists ai_traces_at_idx on private.ai_traces (at desc);
alter table private.ai_traces enable row level security;
alter table private.ai_traces force row level security;
revoke all on private.ai_traces from public, anon, authenticated;

-- The server's writer. Unknown or malformed fields are dropped, never stored; spans keep only [stage name, ms].
create or replace function public.record_ai_trace(p jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare code text := '^[a-z_]{1,40}$'; sp jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' then return false; end if;
  select coalesce(jsonb_agg(jsonb_build_array(e->>0, least(greatest((e->>1)::int, 0), 600000))), '[]'::jsonb) into sp
  from (select value e from jsonb_array_elements(case when jsonb_typeof(p->'spans') = 'array' then p->'spans' else '[]'::jsonb end) limit 20) x
  where jsonb_typeof(e) = 'array' and (e->>0) ~ '^[A-Z_]{1,30}$' and (e->>1) ~ '^[0-9]{1,6}$';
  insert into private.ai_traces (route, state, outcome, category, route_category, model, degraded, tokens_in, tokens_out, cost_usd, cache, ms, retries, policy_version, release, spans)
  values ('assist', p->>'state',
    case when (p->>'outcome') ~ code then p->>'outcome' end, case when (p->>'category') ~ code then p->>'category' end,
    case when (p->>'route_category') in ('A', 'B', 'C', 'D') then p->>'route_category' end,
    case when (p->>'model') ~ '^[a-z0-9.-]{1,60}$' then p->>'model' end, case when (p->>'degraded') ~ code then p->>'degraded' end,
    least(greatest(coalesce((p->>'tokens_in')::int, 0), 0), 10000000), least(greatest(coalesce((p->>'tokens_out')::int, 0), 0), 10000000),
    case when (p->>'cost_usd') ~ '^[0-9]+(\.[0-9]+)?$' then (p->>'cost_usd')::numeric end,
    case when (p->>'cache') in ('hit', 'miss', 'none') then p->>'cache' end,
    least(greatest(coalesce((p->>'ms')::int, 0), 0), 600000), least(greatest(coalesce((p->>'retries')::int, 0), 0), 20),
    case when (p->>'policy_version') ~ '^[0-9a-z.+-]{1,40}$' then p->>'policy_version' end,
    case when (p->>'release') ~ '^[0-9a-f]{1,40}$' then p->>'release' end, sp);
  if random() < 0.02 then delete from private.ai_traces where at < now() - interval '30 days'; end if;
  return true;
exception when others then return false;   -- a trace must never break a request
end $$;
revoke all on function public.record_ai_trace(jsonb) from public, anon, authenticated;
grant execute on function public.record_ai_trace(jsonb) to service_role;

-- Admin summary (health.view): counts, timings, tokens and cost over the last p_days, plus the latest 30 rows.
create or replace function public.admin_ai_traces(p_actor uuid, p_days int default 7) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare d int := least(greatest(coalesce(p_days, 7), 1), 30);
begin
  perform private.require(p_actor, 'health.view');
  return (with w as (select * from private.ai_traces where at >= now() - make_interval(days => d))
    select jsonb_build_object(
      'days', d, 'total', (select count(*) from w),
      'by_state', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from w group by state) x), '{}'::jsonb),
      'by_outcome', coalesce((select jsonb_object_agg(coalesce(outcome, 'unknown'), n) from (select outcome, count(*) n from w group by outcome) x), '{}'::jsonb),
      'by_route', coalesce((select jsonb_object_agg(coalesce(route_category, '-'), n) from (select route_category, count(*) n from w group by route_category) x), '{}'::jsonb),
      'degraded', coalesce((select jsonb_object_agg(degraded, n) from (select degraded, count(*) n from w where degraded is not null group by degraded) x), '{}'::jsonb),
      'ms_p50', (select percentile_disc(0.5) within group (order by ms) from w),
      'ms_p95', (select percentile_disc(0.95) within group (order by ms) from w),
      'tokens_in', (select coalesce(sum(tokens_in), 0) from w), 'tokens_out', (select coalesce(sum(tokens_out), 0) from w),
      'cost_usd', (select sum(cost_usd) from w), 'rows_without_price', (select count(*) from w where tokens_in > 0 and cost_usd is null),
      'cache_hits', (select count(*) from w where cache = 'hit'),
      'per_day', coalesce((select jsonb_agg(jsonb_build_object('day', dd, 'n', n, 'ms_p95', p95) order by dd) from
          (select (at at time zone 'Asia/Kolkata')::date as dd, count(*) as n, percentile_disc(0.95) within group (order by ms) as p95 from w group by 1) x), '[]'::jsonb),
      'recent', coalesce((select jsonb_agg(to_jsonb(r) - 'id' order by r.at desc) from (select * from w order by at desc limit 30) r), '[]'::jsonb)));
end $$;
revoke all on function public.admin_ai_traces(uuid, int) from public, anon, authenticated;
grant execute on function public.admin_ai_traces(uuid, int) to service_role;
