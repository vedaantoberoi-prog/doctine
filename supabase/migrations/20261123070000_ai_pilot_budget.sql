-- Doctine · pilot accounts, a shared daily token budget and the ai_actions switch for the records assistant (23 Nov 2026).
-- Lets the Founder switch the assistant (/api/assist) on for a few named accounts (at most 10) while it stays off for
-- everyone else. Nothing about health data changes. Founder-only (ai.manage), every change audited with a reason.
-- A deleted account leaves the list automatically.
-- The token budget counts AI tokens per person per day across all servers (in private.rate_limits, keyed by an opaque
-- hash, never an account id or any content). Rollback: supabase/rollback/20261123070000_ai_pilot_budget_down.sql

create table if not exists private.ai_pilot_users (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_by uuid,
  added_at timestamptz not null default now(),
  note     text check (char_length(note) <= 120)
);
alter table private.ai_pilot_users enable row level security;
alter table private.ai_pilot_users force row level security;
revoke all on private.ai_pilot_users from public, anon, authenticated;

-- The server's question: may this signed-in account use the assistant as a pilot? (service role only)
create or replace function public.ai_pilot_allowed(p_user uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, private, public as $$
  select exists (select 1 from private.ai_pilot_users p join auth.users u on u.id = p.user_id
                 where p.user_id = p_user and (u.banned_until is null or u.banned_until < now())) $$;
revoke all on function public.ai_pilot_allowed(uuid) from public, anon, authenticated;
grant execute on function public.ai_pilot_allowed(uuid) to service_role;

-- Admin: list / add / remove pilot accounts by email. Founder-only; add and remove are audited and need a reason.
create or replace function public.admin_ai_pilot(p_actor uuid, p_action text, p_email text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; uid uuid; n int;
begin
  r := private.require(p_actor, 'ai.manage');
  if p_action not in ('list', 'add', 'remove') then raise exception 'invalid action' using errcode = '22023'; end if;
  if p_action <> 'list' then
    if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = '22023'; end if;
    select id into uid from auth.users where lower(email) = lower(trim(p_email));
    if uid is null then raise exception 'no such account' using errcode = 'P0002'; end if;
    if p_action = 'add' then
      select count(*) into n from private.ai_pilot_users;
      if n >= 10 then raise exception 'at most 10 pilot accounts' using errcode = '22023'; end if;
      insert into private.ai_pilot_users (user_id, added_by, note) values (uid, p_actor, left(trim(p_reason), 120)) on conflict (user_id) do nothing;
    else
      delete from private.ai_pilot_users where user_id = uid;
    end if;
    perform private.audit(p_actor, r, 'ai_pilot.' || p_action, 'user', uid::text, p_reason, null, jsonb_build_object('pilot', p_action = 'add'), 'ok', p_request);
  end if;
  return jsonb_build_object('pilots', coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'added_at', p.added_at, 'note', p.note) order by p.added_at)
    from private.ai_pilot_users p join auth.users u on u.id = p.user_id), '[]'::jsonb), 'max', 10);
end $$;
revoke all on function public.admin_ai_pilot(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_ai_pilot(uuid, text, text, text, text) to service_role;

-- Shared daily token budget: adds p_add tokens (0 = just read) for an opaque subject and says whether it is still within
-- p_limit. Uses the existing rate-limit table (bucket 'assist-tokens-1d'), so old rows are swept with the rest.
create or replace function public.ai_token_budget(p_subject text, p_add int, p_limit int) returns table (allowed boolean, used int)
language plpgsql security definer set search_path = private, pg_catalog as $$
declare w timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'; n int;
begin
  if p_subject is null or p_subject !~ '^[0-9a-f]{16,64}$' or p_add is null or p_add < 0 or p_add > 1000000 or p_limit is null or p_limit < 1 then
    raise exception 'invalid budget arguments';
  end if;
  insert into private.rate_limits as r (bucket, subject, window_start, hits) values ('assist-tokens-1d', p_subject, w, p_add)
  on conflict (bucket, subject, window_start) do update set hits = r.hits + p_add
  returning r.hits into n;
  return query select n <= p_limit, n;
end $$;
revoke all on function public.ai_token_budget(text, int, int) from public, anon, authenticated;
grant execute on function public.ai_token_budget(text, int, int) to service_role;

-- The ai_actions switch (off): lets the assistant PROPOSE actions (first: a reminder time for a medicine already listed),
-- which the person confirms and the app itself saves (docs/ASSISTANT_ACTIONS_DESIGN.md). Founder-only, like the other AI switches.
alter table private.feature_flags drop constraint if exists feature_flags_key_check;
alter table private.feature_flags add constraint feature_flags_key_check
  check (key in ('registrations', 'document_upload', 'pdf_reading', 'sample_data', 'ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'maintenance'));
insert into private.feature_flags (key, enabled) values ('ai_actions', false) on conflict (key) do nothing;

-- The AI switches are Founder-only; other switches need flags.manage; maintenance its own permission.
create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key in ('ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions') then 'ai.manage' else 'flags.manage' end);
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = '22023'; end if;
  select jsonb_build_object('enabled', enabled, 'value', value) into old from private.feature_flags where key = p_key for update;
  if old is null then raise exception 'no such switch' using errcode = 'P0002'; end if;
  update private.feature_flags set enabled = p_enabled, updated_at = now(), updated_by = p_actor,
    value = case when p_key = 'maintenance' then jsonb_build_object('message', left(coalesce(nullif(trim(p_message), ''), value->>'message', ''), 300)) else value end
  where key = p_key;
  perform private.audit(p_actor, r, case when p_key = 'maintenance' then 'maintenance.set' else 'flag.set' end, 'flag', p_key, p_reason, old,
    (select jsonb_build_object('enabled', enabled, 'value', value) from private.feature_flags where key = p_key), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.admin_set_flag(uuid, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_flag(uuid, text, boolean, text, text, text) to service_role;
