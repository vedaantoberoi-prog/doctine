-- Rollback of 20261125000000_guardian.sql: removes Guardian's tables and functions and the `guardian` switch, and
-- puts back the previous switch list and admin_set_flag (from 20261123070000_ai_pilot_budget). Deletes any Guardian
-- settings, contacts and incidents (there are none while the switch has never been on). No medical records involved.
do $$ declare f text; begin
  foreach f in array array['guardian_settings_get(uuid)', 'guardian_settings_save(uuid, jsonb)', 'guardian_contacts_list(uuid)', 'guardian_contact_save(uuid, jsonb)', 'guardian_contact_delete(uuid, uuid)',
    'guardian_incident_by_event(uuid, uuid)', 'guardian_incidents_open(uuid)', 'guardian_incidents_recent(uuid, int)', 'guardian_incident_get(uuid, uuid)', 'guardian_incident_for_contact(uuid, uuid)',
    'guardian_incident_insert(uuid, jsonb, text, jsonb)', 'guardian_incident_transition(uuid, uuid, text, text, jsonb, jsonb)', 'guardian_incident_evidence(uuid, uuid, jsonb, jsonb)',
    'guardian_incident_note(uuid, uuid, jsonb)', 'guardian_delivery_upsert(uuid, uuid, jsonb)', 'guardian_deliveries(uuid, uuid)', 'guardian_mark_ack(uuid, uuid, uuid)',
    'guardian_transitions(uuid, uuid)', 'guardian_status_event(uuid, jsonb)', 'guardian_purge()', 'admin_guardian_summary(uuid)',
    'guardian_contact_for_consent(uuid)', 'guardian_contact_set_consent(uuid, text, text)'] loop
    execute format('drop function if exists public.%s', f);
  end loop;
end $$;
drop function if exists private.guardian_delivery_json(private.guardian_deliveries);
drop table if exists private.guardian_deliveries, private.guardian_transitions, private.guardian_event_ids, private.guardian_status_events,
  private.guardian_incidents, private.guardian_contacts, private.guardian_settings, private.guardian_allowed_transition;
drop function if exists private.guardian_incident_json(uuid);
drop function if exists private.guardian_evidence_item(jsonb);
drop function if exists private.guardian_owns(uuid, uuid);
drop function if exists private.guardian_transitions_append_only();

delete from private.feature_flags where key = 'guardian';
alter table private.feature_flags drop constraint if exists feature_flags_key_check;
alter table private.feature_flags add constraint feature_flags_key_check
  check (key in ('registrations', 'document_upload', 'pdf_reading', 'sample_data', 'ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'maintenance'));
create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key in ('ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions') then 'ai.manage' else 'flags.manage' end);
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
