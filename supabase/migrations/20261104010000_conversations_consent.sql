-- Doctine · saved conversations, only with the person's consent.
-- Adds the 'chat_history' consent kind, and makes the DATABASE refuse to store a conversation or message
-- unless that consent is currently granted — so a bug in the app can't save chats the person didn't agree to.

alter table public.consents drop constraint if exists consents_kind_check;
alter table public.consents add constraint consents_kind_check
  check (kind in ('ai_chat', 'analytics', 'cloud_storage', 'chat_history'));

alter table public.conversations add column if not exists updated_at timestamptz not null default now();
alter table public.conversations add constraint conversations_title_len check (title is null or char_length(title) <= 120);
create index if not exists conversations_user_recent_idx on public.conversations (user_id, updated_at desc);
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);

-- true when the signed-in person has chat history switched on
create or replace function public.chat_history_allowed() returns boolean language sql stable security invoker as $$
  select coalesce((select granted from public.consents where user_id = auth.uid() and kind = 'chat_history'), false)
$$;

drop policy if exists "conversations: owner adds" on public.conversations;
create policy "conversations: owner adds with consent" on public.conversations for insert to authenticated
  with check (user_id = auth.uid() and public.chat_history_allowed());
drop policy if exists "messages: owner adds" on public.messages;
create policy "messages: owner adds with consent" on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.chat_history_allowed());
-- reading, renaming and deleting your own saved chats stays possible after switching consent off

-- a new message moves its conversation to the top of the list
create or replace function public.bump_conversation() returns trigger language plpgsql as $$
begin update public.conversations set updated_at = now() where id = new.conversation_id; return new; end $$;
drop trigger if exists messages_bump on public.messages;
create trigger messages_bump after insert on public.messages for each row execute function public.bump_conversation();
