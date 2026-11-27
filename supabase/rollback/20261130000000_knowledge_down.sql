-- Rollback for 20261130000000_knowledge.sql. Removes the knowledge store (public guidance, no person's data) and the chat
-- activity record (metadata only). Loaded sources are lost: re-run tools/knowledge-ingest.mjs afterwards if needed.
-- Production needs the owner's approval like any schema change.
drop function if exists public.admin_ai_chat_activity(uuid, int);
drop function if exists public.ai_chat_event_add(jsonb);
drop table if exists private.ai_chat_events;
drop function if exists public.admin_knowledge_set_status(uuid, uuid, text, text, date);
drop function if exists public.admin_knowledge_overview(uuid);
drop function if exists public.knowledge_search(text, int);
drop function if exists public.knowledge_ingest(jsonb, jsonb);
drop table if exists private.knowledge_chunks;
drop table if exists private.knowledge_sources;
