-- Doctine · stored assistant traces (20261123050000_ai_traces.sql), run by run-db-tests.sh. Fictional accounts only.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.denied(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when insufficient_privilege then raise notice 'ok: %', what; return; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;

insert into auth.users (id, email) values ('c0000000-0000-0000-0000-0000000000f1', 'trace-founder@example.test'), ('c0000000-0000-0000-0000-0000000000a1', 'trace-person@example.test')
  on conflict do nothing;
insert into private.admin_members (user_id, role, status, permissions) values ('c0000000-0000-0000-0000-0000000000f1', 'co_founder', 'active', array['health.view'])
  on conflict (user_id) do update set role = 'co_founder', status = 'active', permissions = array['health.view'];
delete from private.ai_traces;

-- the server's writer keeps codes and numbers, and drops anything else
select pg_temp.expect(public.record_ai_trace('{"state":"COMPLETED","outcome":"completed","category":"record_question","route_category":"C","model":"claude-sonnet-5-5",
  "tokens_in":1800,"tokens_out":160,"cost_usd":"0.0052","cache":"miss","ms":2140,"retries":0,"policy_version":"2026-11-23.1","release":"8944f81",
  "spans":[["RECEIVED",1],["RETRIEVING",120],["GENERATING_RESPONSE",1900]],"question":"SECRET-QUESTION","user_id":"c0000000-0000-0000-0000-0000000000a1"}'::jsonb),
  'a well-formed trace is stored');
select pg_temp.expect(public.record_ai_trace('{"state":"COMPLETED","outcome":"LDL 142 mg/dL SECRET","category":"Asha''s records","model":"Robert; drop table x","ms":10,
  "spans":[["RECEIVED",1],["my cholesterol is 142",5],"text"]}'::jsonb), 'a trace with free text is accepted but the text is not');
select pg_temp.expect(public.record_ai_trace('{"state":"NOT_A_STATE","ms":1}'::jsonb) = false, 'an unknown state is refused (returns false, never raises)');
select pg_temp.expect(public.record_ai_trace('"text"'::jsonb) = false, 'a non-object is refused');
select pg_temp.expect((select count(*) from private.ai_traces) = 2, 'two rows stored');
select pg_temp.expect(not exists (select 1 from private.ai_traces t where (to_jsonb(t) - 'id' - 'at')::text ~ 'SECRET|142|Asha|drop table|c0000000'), 'no question, value, name, id or injected text stored');
-- (the row's own id and timestamp are left out above: a random id or time containing "142" made this check flaky)
select pg_temp.expect((select spans from private.ai_traces where outcome is null) = '[["RECEIVED", 1]]'::jsonb, 'only well-formed stage spans are kept');
select pg_temp.expect(not exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'ai_traces'
  and column_name ~ 'user|person|subject|account|email|question|answer|text|title'), 'the table has no column that could identify a person or hold content');

-- signed-in people (and anonymous visitors) can neither read, write nor call the writer
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
select pg_temp.denied('select count(*) from private.ai_traces', 'a signed-in person cannot read traces');
select pg_temp.denied($q$select public.record_ai_trace('{"state":"COMPLETED","ms":1}'::jsonb)$q$, 'a signed-in person cannot write traces');
select pg_temp.denied($q$select public.admin_ai_traces('c0000000-0000-0000-0000-0000000000f1', 7)$q$, 'a signed-in person cannot call the admin summary, even naming an admin');
reset role;
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.denied($q$select public.record_ai_trace('{"state":"COMPLETED","ms":1}'::jsonb)$q$, 'an anonymous visitor cannot write traces');
reset role;

-- the admin summary: needs health.view; summaries only
select pg_temp.denied($q$select public.admin_ai_traces('c0000000-0000-0000-0000-0000000000a1', 7)$q$, 'someone who is not an admin is refused');
select pg_temp.expect((public.admin_ai_traces('c0000000-0000-0000-0000-0000000000f1', 7)->>'total')::int = 2, 'an admin with health.view sees the count');
select pg_temp.expect((public.admin_ai_traces('c0000000-0000-0000-0000-0000000000f1', 7)->'by_route'->>'C')::int = 1, 'counts by route');
select pg_temp.expect((public.admin_ai_traces('c0000000-0000-0000-0000-0000000000f1', 7)->>'cost_usd')::numeric = 0.0052, 'cost is summed only where known');
select pg_temp.expect((public.admin_ai_traces('c0000000-0000-0000-0000-0000000000f1', 7)->>'ms_p95')::int = 2140, 'p95 timing');
select pg_temp.expect(jsonb_array_length(public.admin_ai_traces('c0000000-0000-0000-0000-0000000000f1', 7)->'recent') = 2, 'recent rows listed');
select pg_temp.expect(public.admin_ai_traces('c0000000-0000-0000-0000-0000000000f1', 999)->>'days' = '30', 'the window is capped at 30 days');

-- rows older than 30 days are removed as new ones arrive (the sweep is random; run it enough times)
insert into private.ai_traces (at, route, state, ms) values (now() - interval '40 days', 'assist', 'COMPLETED', 5);
do $$ begin for i in 1..400 loop perform public.record_ai_trace('{"state":"COMPLETED","ms":1}'::jsonb); end loop; end $$;
select pg_temp.expect(not exists (select 1 from private.ai_traces where at < now() - interval '30 days'), 'old traces are swept');
delete from private.ai_traces;
\echo 'ai_traces tests: all passed'
