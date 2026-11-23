-- Doctine · pilot accounts and shared token budget (20261123070000_ai_pilot_budget.sql), run by run-db-tests.sh. Fictional accounts only.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.raises(sql text, state text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then if sqlstate = state then raise notice 'ok: %', what; return; end if; raise exception 'FAILED: % (got %: %)', what, sqlstate, sqlerrm; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;

-- the Founder from admin.test.sql, a Co-Founder without ai.manage, and three ordinary fictional accounts
select pg_temp.expect(exists (select 1 from private.admin_members where role = 'founder' and status = 'active'), 'a Founder exists (from admin.test.sql)');
create temp table t_ids as select (select user_id from private.admin_members where role = 'founder' and status = 'active' limit 1) as founder;
select founder from t_ids \gset
insert into auth.users (id, email) values ('d0000000-0000-0000-0000-0000000000c1', 'pilot-cofounder@example.test'), ('d0000000-0000-0000-0000-0000000000a1', 'pilot-a@example.test'),
  ('d0000000-0000-0000-0000-0000000000b1', 'pilot-b@example.test') on conflict do nothing;
insert into private.admin_members (user_id, role, status, permissions) values ('d0000000-0000-0000-0000-0000000000c1', 'co_founder', 'active', private.perm_preset('admin'))
  on conflict (user_id) do update set role = 'co_founder', status = 'active', permissions = private.perm_preset('admin');

select pg_temp.raises($q$select public.admin_ai_pilot('d0000000-0000-0000-0000-0000000000c1', 'list', null, null, null)$q$, '42501', 'a Co-Founder without ai.manage cannot even list pilots');
select pg_temp.raises(format($q$select public.admin_ai_pilot(%L, 'add', 'pilot-a@example.test', '', null)$q$, (select founder from t_ids)), '22023', 'adding needs a reason');
select pg_temp.raises(format($q$select public.admin_ai_pilot(%L, 'add', 'nobody@example.test', 'test', null)$q$, (select founder from t_ids)), 'P0002', 'an unknown email is refused');
select pg_temp.expect(public.ai_pilot_allowed('d0000000-0000-0000-0000-0000000000a1') = false, 'nobody is a pilot at first');
select pg_temp.expect(jsonb_array_length(public.admin_ai_pilot((select founder from t_ids), 'add', 'Pilot-A@Example.test', 'fictional pilot test', 'req-1')->'pilots') = 1, 'the Founder adds a pilot (email case ignored)');
select pg_temp.expect(public.ai_pilot_allowed('d0000000-0000-0000-0000-0000000000a1'), 'the pilot is allowed');
select pg_temp.expect(public.ai_pilot_allowed('d0000000-0000-0000-0000-0000000000b1') = false, 'another account is not');
select pg_temp.expect(exists (select 1 from private.admin_audit_log where action = 'ai_pilot.add' and target_id = 'd0000000-0000-0000-0000-0000000000a1' and reason = 'fictional pilot test'), 'the addition is audited with its reason');
update auth.users set banned_until = now() + interval '1 day' where id = 'd0000000-0000-0000-0000-0000000000a1';
select pg_temp.expect(public.ai_pilot_allowed('d0000000-0000-0000-0000-0000000000a1') = false, 'a suspended pilot account is not allowed');
update auth.users set banned_until = null where id = 'd0000000-0000-0000-0000-0000000000a1';
select pg_temp.expect(jsonb_array_length(public.admin_ai_pilot((select founder from t_ids), 'remove', 'pilot-a@example.test', 'done', 'req-2')->'pilots') = 0, 'the Founder removes the pilot');
select pg_temp.expect(public.ai_pilot_allowed('d0000000-0000-0000-0000-0000000000a1') = false, 'removed means not allowed');
-- at most 10
do $$ begin for i in 1..10 loop
  insert into auth.users (id, email) values (('d0000000-0000-0000-0000-0000000001' || lpad(i::text, 2, '0'))::uuid, 'pilot-many-' || i || '@example.test') on conflict do nothing;
  perform public.admin_ai_pilot((select founder from t_ids), 'add', 'pilot-many-' || i || '@example.test', 'limit test', null);
end loop; end $$;
select pg_temp.raises(format($q$select public.admin_ai_pilot(%L, 'add', 'pilot-b@example.test', 'one too many', null)$q$, (select founder from t_ids)), '22023', 'at most 10 pilot accounts');
delete from auth.users where email like 'pilot-many-%';
select pg_temp.expect((select count(*) from private.ai_pilot_users) = 0, 'deleting an account removes it from the pilot list');

-- signed-in people can't read or change the list, or ask about anyone
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
select pg_temp.raises('select count(*) from private.ai_pilot_users', '42501', 'a signed-in person cannot read the pilot list');
select pg_temp.raises($q$select public.ai_pilot_allowed('d0000000-0000-0000-0000-0000000000a1')$q$, '42501', 'a signed-in person cannot call the pilot check');
select pg_temp.raises(format($q$select public.admin_ai_pilot(%L, 'add', 'pilot-a@example.test', 'x', null)$q$, :'founder'), '42501', 'a signed-in person cannot add pilots, even naming the Founder');
select pg_temp.raises($q$select * from public.ai_token_budget('aaaaaaaaaaaaaaaa', 1, 10)$q$, '42501', 'a signed-in person cannot touch the token budget');
select set_config('request.jwt.claims', '', false);
reset role;

-- shared token budget
select pg_temp.expect((select used from public.ai_token_budget('aaaaaaaaaaaaaaaa', 0, 1000)) = 0, 'a new subject starts at 0');
select pg_temp.expect((select allowed from public.ai_token_budget('aaaaaaaaaaaaaaaa', 900, 1000)), 'within the budget');
select pg_temp.expect((select not allowed and used = 1100 from public.ai_token_budget('aaaaaaaaaaaaaaaa', 200, 1000)), 'over the budget after 1100 tokens');
select pg_temp.expect((select used from public.ai_token_budget('bbbbbbbbbbbbbbbb', 0, 1000)) = 0, 'each subject has its own budget');
select pg_temp.raises($q$select * from public.ai_token_budget('not-a-hash', 1, 10)$q$, 'P0001', 'only an opaque hash is accepted as the subject');
select pg_temp.raises($q$select * from public.ai_token_budget('aaaaaaaaaaaaaaaa', -5, 10)$q$, 'P0001', 'negative amounts are refused');
delete from private.rate_limits where bucket = 'assist-tokens-1d';
\echo 'ai_pilot tests: all passed'
