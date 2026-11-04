-- Doctine · saved-conversation tests (run after rls.test.sql in the same scratch database; see run-db-tests.sh)
\set ON_ERROR_STOP on
insert into auth.users values ('cccccccc-0000-0000-0000-000000000003'), ('dddddddd-0000-0000-0000-000000000004') on conflict do nothing;
create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;

select pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
do $$ begin
  begin insert into conversations (title) values ('Headache'); raise exception 'FAILED: saved a chat without consent';
  exception when insufficient_privilege then raise notice 'ok: a chat cannot be saved before chat history is switched on'; end;
end $$;
insert into consents (kind, granted) values ('chat_history', true);
insert into conversations (title) values ('Headache');
insert into messages (conversation_id, role, content) select id, 'user', 'I have a headache' from conversations;
insert into messages (conversation_id, role, content, payload) select id, 'assistant', 'How long?', '{"urgency":"routine"}' from conversations;
select pg_temp.expect((select count(*) from messages) = 2, 'with consent, messages are saved');
update consents set granted = false where kind = 'chat_history';
do $$ begin
  begin insert into messages (conversation_id, role, content) select id, 'user', 'more' from conversations; raise exception 'FAILED: saved after consent was withdrawn';
  exception when insufficient_privilege then raise notice 'ok: nothing more is saved once chat history is switched off'; end;
end $$;
select pg_temp.expect((select count(*) from messages) = 2, 'earlier saved messages are still readable after switching off');
reset role;

select pg_temp.as_user('dddddddd-0000-0000-0000-000000000004');
insert into consents (kind, granted) values ('chat_history', true);
select pg_temp.expect((select count(*) from conversations) + (select count(*) from messages) = 0, 'another person sees none of these chats');
do $$ declare c uuid; begin
  reset role; select id into c from conversations where user_id = 'cccccccc-0000-0000-0000-000000000003'; set role authenticated;
  begin insert into messages (conversation_id, role, content) values (c, 'user', 'planted'); raise exception 'FAILED: added a message to someone else''s chat';
  exception when foreign_key_violation then raise notice 'ok: cannot add messages to another person''s chat, even knowing its id'; end;
end $$;
with d as (delete from conversations returning 1) select pg_temp.expect((select count(*) from d) = 0, 'another person cannot delete these chats');
reset role;

select pg_temp.as_user('cccccccc-0000-0000-0000-000000000003');
delete from conversations;
select pg_temp.expect((select count(*) from messages) = 0, 'deleting a chat deletes its messages');
update consents set granted = true where kind = 'chat_history';
insert into conversations (title) values ('Kept until account deletion');
insert into messages (conversation_id, role, content) select id, 'user', 'hello' from conversations;
reset role;
delete from auth.users where id = 'cccccccc-0000-0000-0000-000000000003';
select pg_temp.expect((select count(*) from conversations where user_id = 'cccccccc-0000-0000-0000-000000000003') + (select count(*) from messages where user_id = 'cccccccc-0000-0000-0000-000000000003')
  + (select count(*) from consents where user_id = 'cccccccc-0000-0000-0000-000000000003') + (select count(*) from consent_log where user_id = 'cccccccc-0000-0000-0000-000000000003') = 0,
  'deleting an account removes their chats, messages, consents and consent history');
\echo ALL CONVERSATION TESTS PASSED
