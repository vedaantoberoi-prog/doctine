-- Doctine · security request log, kept 370 days in the production database (Supabase, ap-south-1 Mumbai).
--
-- Why: CERT-In's Directions of 28 Apr 2022 ask for ICT logs kept 180 days within India, and the DPDP Rules 2025 (rule 6,
-- from 13 May 2027) ask for logs kept at least one year. Hosting logs (Cloudflare, Supabase Free) last hours to days.
-- So the server records one line per /api request here: when, which route and method, the result, how long it took, the
-- visitor's IP and a hash of the browser's user agent, and the account id the request CLAIMED (read from the token
-- without trusting it; the handlers verify tokens themselves). Never bodies, health data, names, emails or tokens.
--   * private.security_log: insert-only for the server (append-only trigger); no one else can read or write it.
--   * public.security_log_add(p_rows jsonb): service role only; up to 50 lines per call; values cleaned and clipped;
--     about 1 call in 200 also deletes lines older than 370 days.
--   * public.security_log_purge(): service role only; the same deletion on demand.
-- Lines are not removed when an account is deleted: they are kept for the legal retention period, then deleted.
-- Rollback: supabase/rollback/20261128000000_security_log_down.sql

create table if not exists private.security_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  route       text not null check (char_length(route) <= 40),
  method      text not null check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'OTHER')),
  status      int  not null check (status between 0 and 999),
  ms          int  check (ms is null or ms between 0 and 600000),
  ip          inet,
  ua_hash     text check (ua_hash is null or ua_hash ~ '^[0-9a-f]{16}$'),
  claimed_uid uuid,
  host        text check (host is null or char_length(host) <= 120),
  env         text check (env is null or char_length(env) <= 20),
  release     text check (release is null or char_length(release) <= 12)
);
create index if not exists security_log_at on private.security_log (at);
create index if not exists security_log_ip on private.security_log (ip, at);
create index if not exists security_log_uid on private.security_log (claimed_uid, at) where claimed_uid is not null;
alter table private.security_log enable row level security;
alter table private.security_log force row level security;
revoke all on private.security_log from public, anon, authenticated;

-- Append-only: lines can't be changed, and only the retention purge (which sets a flag for its own transaction) may delete.
create or replace function private.security_log_guard() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'UPDATE' then raise exception 'security_log is append-only' using errcode = '42501'; end if;
  if tg_op = 'DELETE' and coalesce(current_setting('doctine.security_log_purge', true), '') <> 'on' then
    raise exception 'security_log lines are removed only by the retention purge' using errcode = '42501'; end if;
  if tg_op = 'DELETE' and old.at > now() - interval '370 days' then
    raise exception 'security_log lines are kept 370 days' using errcode = '42501'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists security_log_no_change on private.security_log;
create trigger security_log_no_change before update or delete on private.security_log for each row execute function private.security_log_guard();
drop trigger if exists security_log_no_truncate on private.security_log;
create trigger security_log_no_truncate before truncate on private.security_log for each statement execute function private.audit_is_append_only();

create or replace function public.security_log_purge() returns int
language plpgsql security definer set search_path = pg_catalog as $$
declare n int;
begin
  perform set_config('doctine.security_log_purge', 'on', true);
  delete from private.security_log where at < now() - interval '370 days';
  get diagnostics n = row_count;
  perform set_config('doctine.security_log_purge', '', true);
  return n;
end $$;

create or replace function public.security_log_add(p_rows jsonb) returns int
language plpgsql security definer set search_path = pg_catalog as $$
declare r jsonb; n int := 0; v_ip inet; v_uid uuid; v_method text;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 50 then raise exception 'invalid rows' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    begin v_ip := nullif(r->>'ip', '')::inet; exception when others then v_ip := null; end;
    begin v_uid := nullif(r->>'claimed_uid', '')::uuid; exception when others then v_uid := null; end;
    v_method := upper(coalesce(r->>'method', ''));
    if v_method not in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD') then v_method := 'OTHER'; end if;
    insert into private.security_log (route, method, status, ms, ip, ua_hash, claimed_uid, host, env, release)
    values (left(regexp_replace(coalesce(r->>'route', ''), '[^a-z0-9_:/.-]', '', 'g'), 40), v_method,
            least(greatest(coalesce((r->>'status')::int, 0), 0), 999),
            case when (r->>'ms') ~ '^[0-9]{1,6}$' then least((r->>'ms')::int, 600000) end,
            v_ip,
            case when (r->>'ua_hash') ~ '^[0-9a-f]{16}$' then r->>'ua_hash' end,
            v_uid,
            nullif(left(lower(regexp_replace(coalesce(r->>'host', ''), '[^A-Za-z0-9.:-]', '', 'g')), 120), ''),
            nullif(left(coalesce(r->>'env', ''), 20), ''),
            nullif(left(regexp_replace(coalesce(r->>'release', ''), '[^0-9a-f]', '', 'g'), 12), ''));
    n := n + 1;
  end loop;
  if random() < 0.005 then perform public.security_log_purge(); end if;
  return n;
end $$;

revoke all on function public.security_log_add(jsonb), public.security_log_purge(), private.security_log_guard() from public, anon, authenticated;
grant execute on function public.security_log_add(jsonb), public.security_log_purge() to service_role;
