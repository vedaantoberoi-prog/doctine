-- Rollback of 20261123070000_ai_pilot_budget.sql: removes the pilot-account list, its two functions and the shared token
-- budget function (its counters in private.rate_limits are swept with the others). No health data involved.
drop function if exists public.ai_token_budget(text, int, int);
delete from private.rate_limits where bucket = 'assist-tokens-1d';
drop function if exists public.admin_ai_pilot(uuid, text, text, text, text);
drop function if exists public.ai_pilot_allowed(uuid);
drop table if exists private.ai_pilot_users;
