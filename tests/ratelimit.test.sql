-- Doctine · shared rate-limit tests (run by run-db-tests.sh)
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;

set role service_role;
select pg_temp.expect((select allowed from rate_limit_hit('chat-user-10m', 'subj-1', 3, 600)), 'first request is allowed');
select rate_limit_hit('chat-user-10m', 'subj-1', 3, 600); select rate_limit_hit('chat-user-10m', 'subj-1', 3, 600);
select pg_temp.expect(not (select allowed from rate_limit_hit('chat-user-10m', 'subj-1', 3, 600)), 'the 4th request over a limit of 3 is refused');
select pg_temp.expect((select allowed from rate_limit_hit('chat-user-10m', 'subj-2', 3, 600)), 'another subject has its own count');
select pg_temp.expect((select allowed from rate_limit_hit('scan-user-1h', 'subj-1', 3, 3600)), 'another bucket has its own count');
select pg_temp.expect((select reset_at > now() from rate_limit_hit('chat-user-10m', 'subj-3', 3, 600)), 'the reply says when the window resets');
do $$ begin
  begin perform rate_limit_hit('x', 's', 0, 60); raise exception 'FAILED: accepted a zero limit';
  exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; raise notice 'ok: invalid arguments are refused'; end;
end $$;
reset role;

set role authenticated;
do $$ begin
  begin perform rate_limit_hit('chat-user-10m', 'subj-1', 1000, 600); raise exception 'FAILED: a signed-in browser could reset or use the limiter';
  exception when insufficient_privilege then raise notice 'ok: signed-in browsers cannot call the limiter'; end;
  begin perform 1 from private.rate_limits; raise exception 'FAILED: browsers can read the counters';
  exception when insufficient_privilege then raise notice 'ok: browsers cannot read the counters'; end;
end $$;
reset role;
set role anon;
do $$ begin
  begin perform rate_limit_hit('a', 'b', 1, 60); raise exception 'FAILED: anon called the limiter';
  exception when insufficient_privilege then raise notice 'ok: signed-out visitors cannot call the limiter'; end;
end $$;
reset role;
\echo ALL RATE LIMIT TESTS PASSED
