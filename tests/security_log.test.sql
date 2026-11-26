-- Doctine · security request log (20261128000000_security_log.sql), run by run-db-tests.sh. Fictional values only.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.raises(sql text, state text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then if sqlstate = state then raise notice 'ok: %', what; return; end if; raise exception 'FAILED: % (got %: %)', what, sqlstate, sqlerrm; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;

-- the server (service role) records lines; values are cleaned
set role service_role;
select pg_temp.expect(public.security_log_add('[{"route":"account","method":"delete","status":401,"ms":12,"ip":"203.0.113.9","ua_hash":"0123456789abcdef","claimed_uid":"f6000000-0000-0000-0000-000000000001","host":"App.Doctine.COM","env":"production","release":"9e323c9"},
  {"route":"no<script>pe","method":"BREW","status":99999,"ms":"lots","ip":"not-an-ip","ua_hash":"XYZ","claimed_uid":"nope","host":"evil host/<x>"}]'::jsonb) = 2, 'the server records lines');
reset role;
select pg_temp.expect((select count(*) from private.security_log) = 2, 'two lines stored');
select pg_temp.expect(exists (select 1 from private.security_log where route = 'account' and method = 'DELETE' and status = 401 and ip = '203.0.113.9'::inet and claimed_uid = 'f6000000-0000-0000-0000-000000000001' and host = 'app.doctine.com'), 'a normal line is kept as sent (method upper-cased, host lower-cased)');
select pg_temp.expect(exists (select 1 from private.security_log where route = 'noscriptpe' and method = 'OTHER' and status = 999 and ms is null and ip is null and ua_hash is null and claimed_uid is null and host = 'evilhostx'), 'junk is cleaned, never rejected');
select pg_temp.raises($q$select public.security_log_add((select jsonb_agg('{}'::jsonb) from generate_series(1, 51)))$q$, '22023', 'at most 50 lines per call');

-- nobody but the server may write or read
set role authenticated;
select pg_temp.raises($q$select public.security_log_add('[]'::jsonb)$q$, '42501', 'signed-in people cannot write the log');
select pg_temp.raises($q$select count(*) from private.security_log$q$, '42501', 'signed-in people cannot read the log');
select pg_temp.raises($q$select public.security_log_purge()$q$, '42501', 'signed-in people cannot purge');
reset role;
set role anon;
select pg_temp.raises($q$select public.security_log_add('[]'::jsonb)$q$, '42501', 'visitors cannot write the log');
reset role;

-- append-only; only the retention purge removes lines, and only lines older than 370 days
select pg_temp.raises($q$update private.security_log set status = 200$q$, '42501', 'lines cannot be changed');
select pg_temp.raises($q$delete from private.security_log$q$, '42501', 'lines cannot be deleted directly');
select pg_temp.raises($q$truncate private.security_log$q$, '42501', 'the log cannot be truncated');
insert into private.security_log (at, route, method, status) values (now() - interval '371 days', 'old', 'GET', 200), (now() - interval '369 days', 'recent', 'GET', 200);
select pg_temp.expect(public.security_log_purge() = 1, 'the purge removes exactly the line older than 370 days');
select pg_temp.expect(exists (select 1 from private.security_log where route = 'recent') and not exists (select 1 from private.security_log where route = 'old'), 'a 369-day-old line is kept');
select pg_temp.raises($q$select set_config('doctine.security_log_purge', 'on', false); delete from private.security_log where route = 'recent'$q$, '42501', 'even with the purge flag, lines younger than 370 days stay');
select set_config('doctine.security_log_purge', '', false);
select pg_temp.expect(not exists (select 1 from information_schema.role_table_grants where table_schema = 'private' and table_name = 'security_log' and grantee in ('anon', 'authenticated', 'PUBLIC')), 'no grants on the table to people');
select 'security log tests PASSED';
