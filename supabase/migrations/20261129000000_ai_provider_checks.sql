-- Doctine · AI provider checks: the result of each check that the server could reach the AI provider with its key.
--
-- Why: the admin console's free model-list check said "responding" while every real AI request was being refused
-- (an organisation-level key without its workspace header, 26 Nov 2026). An admin can now run a real check: the
-- configured model is looked up and one tiny request ("ping", no person's data) is sent. Each result is kept here so
-- the console can show when the provider last answered.
--   * private.ai_provider_checks: what was checked, ok or not, how long it took, an error code from a fixed list. No key, no request
--     or response text, no person's data. Kept 90 days.
--   * public.ai_provider_check_add(p_row jsonb): service role only (the server records each check).
--   * public.admin_ai_provider_checks(p_actor uuid): health.view; the last success, the last failure and the last 20.
-- Rollback: supabase/rollback/20261129000000_ai_provider_checks_down.sql

create table if not exists private.ai_provider_checks (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  kind      text not null check (kind in ('model_lookup', 'test_request')),
  ok        boolean not null,
  ms        int check (ms is null or ms between 0 and 600000),
  provider  text not null check (provider ~ '^[a-z]{1,20}$'),
  model     text check (model is null or model ~ '^[a-z0-9.-]{1,60}$'),
  error     text check (error is null or error in ('not_configured', 'auth_failed', 'key_forbidden', 'model_not_found', 'insufficient_credits',
                     'rate_limited', 'provider_busy', 'timeout', 'network', 'invalid_request', 'bad_response', 'other')),
  actor     uuid
);
create index if not exists ai_provider_checks_at on private.ai_provider_checks (at desc);
alter table private.ai_provider_checks enable row level security;
alter table private.ai_provider_checks force row level security;
revoke all on private.ai_provider_checks from public, anon, authenticated;

create or replace function public.ai_provider_check_add(p_row jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog as $$
declare v_kind text := p_row->>'kind'; v_actor uuid;
begin
  if jsonb_typeof(p_row) <> 'object' or v_kind not in ('model_lookup', 'test_request') then return false; end if;
  begin v_actor := nullif(p_row->>'actor', '')::uuid; exception when others then v_actor := null; end;
  insert into private.ai_provider_checks (kind, ok, ms, provider, model, error, actor)
  values (v_kind, coalesce((p_row->>'ok')::boolean, false),
          case when (p_row->>'ms') ~ '^[0-9]{1,6}$' then least((p_row->>'ms')::int, 600000) end,
          coalesce(nullif(left(regexp_replace(lower(coalesce(p_row->>'provider', '')), '[^a-z]', '', 'g'), 20), ''), 'unknown'),
          nullif(left(regexp_replace(lower(coalesce(p_row->>'model', '')), '[^a-z0-9.-]', '', 'g'), 60), ''),
          case when coalesce(p_row->>'error', '') = '' then null
               when p_row->>'error' in ('not_configured', 'auth_failed', 'key_forbidden', 'model_not_found', 'insufficient_credits', 'rate_limited',
                                        'provider_busy', 'timeout', 'network', 'invalid_request', 'bad_response') then p_row->>'error' else 'other' end,
          v_actor);
  if random() < 0.02 then delete from private.ai_provider_checks where at < now() - interval '90 days'; end if;
  return true;
end $$;

create or replace function public.admin_ai_provider_checks(p_actor uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'health.view');
  return jsonb_build_object(
    'last_success', (select jsonb_build_object('at', at, 'kind', kind, 'ms', ms, 'model', model) from private.ai_provider_checks where ok and kind = 'test_request' order by at desc limit 1),
    'last_failure', (select jsonb_build_object('at', at, 'kind', kind, 'error', error, 'model', model) from private.ai_provider_checks where not ok order by at desc limit 1),
    'recent', coalesce((select jsonb_agg(x order by x.at desc) from (select at, kind, ok, ms, model, error from private.ai_provider_checks order by at desc limit 20) x), '[]'::jsonb));
end $$;

revoke all on function public.ai_provider_check_add(jsonb), public.admin_ai_provider_checks(uuid) from public, anon, authenticated;
grant execute on function public.ai_provider_check_add(jsonb), public.admin_ai_provider_checks(uuid) to service_role;
