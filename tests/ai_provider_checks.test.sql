-- Doctine · AI provider checks (20261129000000_ai_provider_checks.sql), run by run-db-tests.sh. Fictional accounts only.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.denied(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when insufficient_privilege then raise notice 'ok: %', what; return; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;

insert into auth.users (id, email) values ('c0000000-0000-0000-0000-0000000000f2', 'check-admin@example.test'), ('c0000000-0000-0000-0000-0000000000a2', 'check-person@example.test')
  on conflict do nothing;
insert into private.admin_members (user_id, role, status, permissions) values ('c0000000-0000-0000-0000-0000000000f2', 'co_founder', 'active', array['health.view'])
  on conflict (user_id) do update set role = 'co_founder', status = 'active', permissions = array['health.view'];
delete from private.ai_provider_checks;

-- the server records checks; values are cleaned, never trusted
select pg_temp.expect(public.ai_provider_check_add('{"kind":"test_request","ok":true,"ms":812,"provider":"anthropic","model":"claude-sonnet-5-5"}'::jsonb), 'a successful real check is recorded');
select pg_temp.expect(public.ai_provider_check_add('{"kind":"model_lookup","ok":false,"ms":90,"provider":"anthropic","model":"Claude Sonnet; drop table x","error":"Auth Failed! sk-ant-SECRET"}'::jsonb), 'a failure with junk values is recorded, cleaned');
select pg_temp.expect(public.ai_provider_check_add('{"kind":"something_else","ok":true}'::jsonb) = false, 'an unknown kind is refused');
select pg_temp.expect(public.ai_provider_check_add('"text"'::jsonb) = false, 'a non-object is refused');
select pg_temp.expect((select count(*) from private.ai_provider_checks) = 2, 'two rows stored');
select pg_temp.expect(not exists (select 1 from private.ai_provider_checks where concat_ws('|', provider, model, error) ~ '[^a-z0-9._|-]' or error ~* 'secret|sk' or model ~ ';| '), 'no key-like, injected or free text is stored');
select pg_temp.expect((select error from private.ai_provider_checks where not ok) = 'other', 'an error outside the fixed list is stored as "other"');
select public.ai_provider_check_add('{"kind":"test_request","ok":false,"provider":"anthropic","error":"auth_failed"}'::jsonb);
select pg_temp.expect((select error from private.ai_provider_checks order by id desc limit 1) = 'auth_failed', 'a known error code is kept');
delete from private.ai_provider_checks where error = 'auth_failed';

-- people can neither read, write nor call the admin view
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-0000000000a2","role":"authenticated"}', false);
select pg_temp.denied('select count(*) from private.ai_provider_checks', 'a signed-in person cannot read checks');
select pg_temp.denied($q$select public.ai_provider_check_add('{"kind":"test_request","ok":true,"provider":"x"}'::jsonb)$q$, 'a signed-in person cannot record checks');
select pg_temp.denied($q$select public.admin_ai_provider_checks('c0000000-0000-0000-0000-0000000000f2')$q$, 'a signed-in person cannot call the admin view, even naming an admin');
reset role;
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.denied($q$select public.ai_provider_check_add('{"kind":"test_request","ok":true,"provider":"x"}'::jsonb)$q$, 'an anonymous visitor cannot record checks');
reset role;

-- the admin view: health.view; the last success is the last REAL request that worked
select pg_temp.denied($q$select public.admin_ai_provider_checks('c0000000-0000-0000-0000-0000000000a2')$q$, 'someone who is not an admin is refused');
select pg_temp.expect(public.admin_ai_provider_checks('c0000000-0000-0000-0000-0000000000f2')->'last_success'->>'model' = 'claude-sonnet-5-5', 'the last successful real request is shown');
select pg_temp.expect(public.admin_ai_provider_checks('c0000000-0000-0000-0000-0000000000f2')->'last_failure'->>'kind' = 'model_lookup', 'the last failure is shown');
select pg_temp.expect(jsonb_array_length(public.admin_ai_provider_checks('c0000000-0000-0000-0000-0000000000f2')->'recent') = 2, 'recent checks listed');
select public.ai_provider_check_add('{"kind":"model_lookup","ok":true,"ms":50,"provider":"anthropic","model":"claude-sonnet-5-5"}'::jsonb);
select pg_temp.expect(public.admin_ai_provider_checks('c0000000-0000-0000-0000-0000000000f2')->'last_success'->>'ms' = '812', 'a free model lookup never counts as a working real request');

-- old rows are swept as new ones arrive (random; run it enough times)
insert into private.ai_provider_checks (at, kind, ok, provider) values (now() - interval '100 days', 'test_request', true, 'anthropic');
do $$ begin for i in 1..400 loop perform public.ai_provider_check_add('{"kind":"model_lookup","ok":true,"provider":"anthropic"}'::jsonb); end loop; end $$;
select pg_temp.expect(not exists (select 1 from private.ai_provider_checks where at < now() - interval '90 days'), 'checks older than 90 days are swept');
delete from private.ai_provider_checks;
\echo 'ai_provider_checks tests: all passed'
