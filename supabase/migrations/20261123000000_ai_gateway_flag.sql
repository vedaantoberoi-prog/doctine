-- Doctine · a switch for the Agent Execution Gateway (/api/gateway), off by default (23 Nov 2026).
-- Adds the key 'ai_gateway' to the feature switches and makes it Founder-only, like the AI assistant switch.
-- No table or row of health data changes. Rollback: supabase/rollback/20261123000000_ai_gateway_flag_down.sql
alter table private.feature_flags drop constraint if exists feature_flags_key_check;
alter table private.feature_flags add constraint feature_flags_key_check
  check (key in ('registrations', 'document_upload', 'pdf_reading', 'sample_data', 'ai_assistant', 'ai_gateway', 'maintenance'));
insert into private.feature_flags (key, enabled) values ('ai_gateway', false) on conflict (key) do nothing;

-- The AI switches are Founder-only; other switches need flags.manage; maintenance its own permission.
create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key in ('ai_assistant', 'ai_gateway') then 'ai.manage' else 'flags.manage' end);
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = '22023'; end if;
  select jsonb_build_object('enabled', enabled, 'value', value) into old from private.feature_flags where key = p_key for update;
  if old is null then raise exception 'no such switch' using errcode = 'P0002'; end if;
  update private.feature_flags set enabled = p_enabled, updated_at = now(), updated_by = p_actor,
    value = case when p_key = 'maintenance' then jsonb_build_object('message', left(coalesce(nullif(trim(p_message), ''), value->>'message', ''), 300)) else value end
  where key = p_key;
  perform private.audit(p_actor, r, case when p_key = 'maintenance' then 'maintenance.set' else 'flag.set' end, 'flag', p_key, p_reason, old,
    (select jsonb_build_object('enabled', enabled, 'value', value) from private.feature_flags where key = p_key), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.admin_set_flag(uuid, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_flag(uuid, text, boolean, text, text, text) to service_role;
