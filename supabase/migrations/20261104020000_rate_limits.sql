-- Doctine · shared rate limits for the Netlify functions (chat, scanning, account deletion, daily AI budget).
-- The counters live in a private schema the public API does not expose. Only the service role (used by the
-- Netlify functions, never by browsers) may call rate_limit_hit(). Subjects are stored as HMAC hashes, not raw
-- user ids or IP addresses.

create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.rate_limits (
  bucket       text not null check (char_length(bucket) between 1 and 64),
  subject      text not null check (char_length(subject) between 1 and 128),
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, subject, window_start)
);
create index if not exists rate_limits_window_idx on private.rate_limits (window_start);

-- Counts one request and says whether it is within the limit. Fixed windows; atomic under concurrency
-- (the upsert takes a row lock, so two requests at once both count).
create or replace function public.rate_limit_hit(p_bucket text, p_subject text, p_limit int, p_window_seconds int)
returns table (allowed boolean, hits int, reset_at timestamptz)
language plpgsql security definer set search_path = private, pg_catalog as $$
declare
  w timestamptz;
  n int;
begin
  if p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 7 * 86400
     or p_bucket is null or p_subject is null or char_length(p_bucket) > 64 or char_length(p_subject) > 128 then
    raise exception 'invalid rate limit arguments';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into private.rate_limits as r (bucket, subject, window_start, hits) values (p_bucket, p_subject, w, 1)
  on conflict (bucket, subject, window_start) do update set hits = r.hits + 1
  returning r.hits into n;
  if random() < 0.01 then delete from private.rate_limits where window_start < now() - interval '8 days'; end if;
  return query select n <= p_limit, n, w + make_interval(secs => p_window_seconds);
end $$;

revoke all on function public.rate_limit_hit(text, text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, int, int) to service_role;
