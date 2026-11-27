-- Doctine · knowledge store and chat activity (20261130000000_knowledge.sql), run by run-db-tests.sh.
-- The source below is FICTIONAL test text, never real guidance.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.denied(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when insufficient_privilege then raise notice 'ok: %', what; return; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;
create or replace function pg_temp.fails(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then raise notice 'ok: %', what; return; end;
  raise exception 'FAILED: % (succeeded)', what;
end $$;

insert into auth.users (id, email) values ('c0000000-0000-0000-0000-0000000000f3', 'kb-admin@example.test'), ('c0000000-0000-0000-0000-0000000000f4', 'kb-viewer@example.test'),
  ('c0000000-0000-0000-0000-0000000000a3', 'kb-person@example.test') on conflict do nothing;
insert into private.admin_members (user_id, role, status, permissions) values
  ('c0000000-0000-0000-0000-0000000000f4', 'co_founder', 'active', array['health.view'])
  on conflict (user_id) do update set status = 'active', permissions = excluded.permissions, role = excluded.role;
-- ai.manage belongs to the founder only (it can't be granted to anyone else): use the founder, or make the test account it
do $$ begin
  if not exists (select 1 from private.admin_members where role = 'founder') then
    insert into private.admin_members (user_id, role, status, permissions) values ('c0000000-0000-0000-0000-0000000000f3', 'founder', 'active', array[]::text[]);
  end if;
end $$;
create temp table approver as select m.user_id as id from private.admin_members m join auth.users u on u.id = m.user_id where m.role = 'founder' and m.status = 'active' limit 1;
grant select on approver to public;
delete from private.knowledge_sources where publisher = 'Fictional Test Publisher';

-- ingestion lands as draft; drafts are never searchable
create temp table ing as select public.knowledge_ingest(
  '{"publisher":"Fictional Test Publisher","title":"Zorblax fever (test)","url":"https://example.org/zorblax","licence":"Test fixture, not real guidance","version":"1"}'::jsonb,
  '[{"heading":"About","content":"Zorblax fever is a fictional illness used only to test Doctine search."},{"heading":"Care","content":"Rest and fluids help people recover from zorblax fever in this made-up example."}]'::jsonb) r;
select pg_temp.expect((select r->>'status' from ing) = 'draft', 'a new source is a draft');
select pg_temp.expect((select (r->>'passages')::int from ing) = 2, 'passages stored');
select pg_temp.expect(not exists (select 1 from public.knowledge_search('zorblax fever', 4)), 'a draft is never searched');

-- approving needs ai.manage, a reviewer and a date
select pg_temp.denied(format($q$select public.admin_knowledge_set_status('c0000000-0000-0000-0000-0000000000f4', %L, 'approved', 'Dr Test', current_date)$q$, (select r->>'source_id' from ing)), 'health.view alone cannot approve a source');
select pg_temp.fails(format($q$select public.admin_knowledge_set_status(%L, %L, 'approved', '', current_date)$q$, (select id from approver), (select r->>'source_id' from ing)), 'approval without a reviewer is refused');
select pg_temp.fails(format($q$select public.admin_knowledge_set_status(%L, %L, 'approved', 'Dr Test', null)$q$, (select id from approver), (select r->>'source_id' from ing)), 'approval without a review date is refused');
select public.admin_knowledge_set_status((select id from approver), (select (r->>'source_id')::uuid from ing), 'approved', 'Dr Test Reviewer', current_date);
select pg_temp.expect((select count(*) from public.knowledge_search('zorblax fever', 4)) = 2, 'an approved source is searchable');
select pg_temp.expect((select publisher from public.knowledge_search('recover zorblax', 1)) = 'Fictional Test Publisher', 'results carry the publisher');
select pg_temp.expect((select licence from public.knowledge_search('recover zorblax', 1)) is not null, 'results carry the licence');
select pg_temp.expect(not exists (select 1 from public.knowledge_search('', 4)), 'an empty query finds nothing');
select pg_temp.expect(not exists (select 1 from public.knowledge_search('quantum spaceship', 4)), 'an unrelated query finds nothing');
select pg_temp.expect((select count(*) from public.knowledge_search($$'); drop table private.knowledge_chunks; --$$, 4)) >= 0, 'hostile query text is just text');
select pg_temp.expect(to_regclass('private.knowledge_chunks') is not null, 'tables survive hostile query text');

-- reloading the same version sends it back to draft; retiring hides it
select public.knowledge_ingest('{"publisher":"Fictional Test Publisher","title":"Zorblax fever (test)","url":"https://example.org/zorblax","licence":"Test fixture","version":"1"}'::jsonb,
  '[{"heading":"About","content":"Zorblax fever is a fictional illness, reloaded for the test."}]'::jsonb);
select pg_temp.expect((select status from private.knowledge_sources where url = 'https://example.org/zorblax') = 'draft', 'a reloaded source must be approved again');
select pg_temp.expect((select reviewed_by from private.knowledge_sources where url = 'https://example.org/zorblax') is null, 'reloading clears the old review');
select pg_temp.fails($q$select public.knowledge_ingest('{"publisher":"X Test","title":"No https","url":"http://example.org/x","licence":"Test"}'::jsonb, '[{"content":"Some fictional passage text for testing."}]'::jsonb)$q$, 'a source without https is refused');
select pg_temp.fails($q$select public.knowledge_ingest('{"publisher":"X Test","title":"No licence","url":"https://example.org/x"}'::jsonb, '[{"content":"Some fictional passage text for testing."}]'::jsonb)$q$, 'a source without a licence is refused');

-- people and visitors can't read, load or search
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-0000000000a3","role":"authenticated"}', false);
select pg_temp.denied('select count(*) from private.knowledge_sources', 'a signed-in person cannot read sources directly');
select pg_temp.denied($q$select * from public.knowledge_search('zorblax', 4)$q$, 'a signed-in person cannot call search directly');
select pg_temp.denied($q$select public.knowledge_ingest('{}'::jsonb, '[]'::jsonb)$q$, 'a signed-in person cannot load sources');
select pg_temp.denied($q$select public.ai_chat_event_add('{"status":200}'::jsonb)$q$, 'a signed-in person cannot write chat events');
select pg_temp.denied($q$select public.admin_ai_chat_activity('c0000000-0000-0000-0000-0000000000f3', 24)$q$, 'a signed-in person cannot read chat activity, even naming an admin');
reset role;
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.denied($q$select * from public.knowledge_search('zorblax', 4)$q$, 'an anonymous visitor cannot search');
reset role;

-- overview for the console
select pg_temp.expect((public.admin_knowledge_overview('c0000000-0000-0000-0000-0000000000f4')->>'draft')::int >= 1, 'the overview counts drafts');
select pg_temp.denied($q$select public.admin_knowledge_overview('c0000000-0000-0000-0000-0000000000a3')$q$, 'someone who is not an admin cannot see the overview');
delete from private.knowledge_sources where publisher = 'Fictional Test Publisher';

-- chat activity: metadata only, values cleaned
delete from private.ai_chat_events;
select pg_temp.expect(public.ai_chat_event_add('{"status":200,"urgency":"routine","context_source":"server","context_items":7,"knowledge":"none","sources":0,"ms":2300,"model":"claude-sonnet-5-5","env":"staging"}'::jsonb), 'a reply is recorded');
select pg_temp.expect(public.ai_chat_event_add('{"status":502,"error":"ai_error","context_source":"evil; drop","model":"Claude Sonnet; x","knowledge":"DROP TABLE"}'::jsonb), 'a failure with junk values is recorded, cleaned');
select pg_temp.expect((select context_source from private.ai_chat_events where status = 502) = 'none', 'an unknown context source is stored as none');
select pg_temp.expect((select knowledge from private.ai_chat_events where status = 502) = 'off', 'unknown knowledge status is stored as off');
select pg_temp.expect(not exists (select 1 from private.ai_chat_events where model ~ '[^a-z0-9.-]'), 'model names are cleaned');
select pg_temp.expect((public.admin_ai_chat_activity('c0000000-0000-0000-0000-0000000000f4', 24)->>'replies')::int = 1, 'activity counts replies');
select pg_temp.expect((public.admin_ai_chat_activity('c0000000-0000-0000-0000-0000000000f4', 24)->>'failed')::int = 1, 'activity counts failures');
select pg_temp.expect((public.admin_ai_chat_activity('c0000000-0000-0000-0000-0000000000f4', 24)->'context'->>'server')::int = 1, 'activity shows where context came from');
select pg_temp.denied($q$select public.admin_ai_chat_activity('c0000000-0000-0000-0000-0000000000a3', 24)$q$, 'someone who is not an admin cannot see activity');
delete from private.ai_chat_events;
\echo 'knowledge tests: all passed'
