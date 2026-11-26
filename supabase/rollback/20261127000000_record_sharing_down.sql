-- Rollback of 20261127000000_record_sharing.sql: removes the sharing functions and the `record_sharing` switch, and puts
-- back the switch list and admin_set_flag from 20261126000000_doctor_onboarding. The share and access-log tables and the
-- doctors' codes are KEPT (the access log is a record people were promised); drop them by hand only after deciding that.
-- Ends all access immediately: without the functions nothing can read a shared record.
do $$ declare f text; begin
  foreach f in array array['practitioner_share_code(uuid)', 'share_lookup(uuid, text)', 'share_create(uuid, text, jsonb)', 'share_list(uuid)', 'share_revoke(uuid, uuid)',
    'doctor_shares(uuid)', 'doctor_share_record(uuid, uuid, text)', 'admin_sharing_summary(uuid)'] loop
    execute format('drop function if exists public.%s', f);
  end loop;
end $$;
drop function if exists private.share_active(private.record_shares);
drop function if exists private.doctor_public(private.practitioners);
drop function if exists private.patient_display(uuid);
delete from private.feature_flags where key = 'record_sharing';
alter table private.feature_flags drop constraint if exists feature_flags_key_check;
alter table private.feature_flags add constraint feature_flags_key_check
  check (key in ('registrations', 'document_upload', 'pdf_reading', 'sample_data', 'ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian', 'doctor_onboarding', 'maintenance'));
create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key in ('ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian', 'doctor_onboarding') then 'ai.manage' else 'flags.manage' end);
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
