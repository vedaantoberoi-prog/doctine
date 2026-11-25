-- Rollback of 20261126000000_doctor_onboarding.sql: removes the doctor-application functions, the `doctor_onboarding`
-- switch and the doctors.* permissions, and puts back the previous switch list, admin_set_flag (from 20261125000000_guardian)
-- and permission catalogue (from 20261112050000). The tables, their rows and the credentials bucket are KEPT (credential
-- evidence and the verification history are records); drop them by hand only after deciding what happens to that evidence.
do $$ declare f text; begin
  foreach f in array array['practitioner_get(uuid)', 'practitioner_save(uuid, jsonb)', 'practitioner_document_add(uuid, jsonb)', 'practitioner_document_remove(uuid, uuid)',
    'practitioner_submit(uuid)', 'admin_practitioners(uuid, text)', 'admin_practitioner(uuid, uuid, text)', 'admin_practitioner_document(uuid, uuid, uuid, text)',
    'admin_practitioner_transition(uuid, uuid, text, text, jsonb, text)'] loop
    execute format('drop function if exists public.%s', f);
  end loop;
end $$;
drop function if exists private.practitioner_json(private.practitioners, boolean);
drop function if exists private.practitioner_expire();
drop function if exists private.practitioner_move(uuid, text, text, text, uuid, text, jsonb);
drop function if exists private.practitioner_missing(private.practitioners);
drop function if exists private.practitioner_editable(text);
-- Co-Founders keep no doctors.* permission once the catalogue no longer lists it.
update private.admin_members set permissions = array(select p from unnest(permissions) p where p not like 'doctors.%') where permissions && array['doctors.view', 'doctors.verify'];

delete from private.feature_flags where key = 'doctor_onboarding';
alter table private.feature_flags drop constraint if exists feature_flags_key_check;
alter table private.feature_flags add constraint feature_flags_key_check
  check (key in ('registrations', 'document_upload', 'pdf_reading', 'sample_data', 'ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian', 'maintenance'));
create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key in ('ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian') then 'ai.manage' else 'flags.manage' end);
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

create or replace function private.perm_catalog() returns table (key text, grp text, label text, founder_only boolean, standard boolean)
language sql immutable set search_path = pg_catalog as $$
  values
    ('dashboard.view', 'Overview', 'Dashboard (aggregate figures)', false, true),
    ('analytics.view', 'Overview', 'Analytics and charts', false, true),
    ('reports.export', 'Overview', 'Reports and exports (CSV, PDF)', false, false),
    ('users.view', 'Accounts', 'Account list and basic account details', false, true),
    ('users.notes', 'Accounts', 'Internal notes on accounts', false, false),
    ('users.reset_password', 'Accounts', 'Send password-reset emails', false, false),
    ('users.suspend', 'Accounts', 'Suspend and restore accounts', false, false),
    ('documents.view', 'Operations', 'Document and storage statistics', false, true),
    ('health.view', 'Operations', 'Platform health, errors, incidents and alerts (view)', false, true),
    ('incidents.manage', 'Operations', 'Open and update incidents', false, false),
    ('alerts.manage', 'Operations', 'Acknowledge alerts, resolve errors', false, false),
    ('support.view', 'Support', 'View support requests', false, false),
    ('support.assign', 'Support', 'Assign and prioritise support requests', false, false),
    ('support.respond', 'Support', 'Reply, add internal notes, change status', false, false),
    ('feedback.view', 'Product', 'View product feedback and feature requests', false, true),
    ('feedback.manage', 'Product', 'Triage feedback, manage feature requests and tasks', false, true),
    ('bugs.view', 'Product', 'View bugs', false, true),
    ('bugs.manage', 'Product', 'Create, categorise and update bugs', false, true),
    ('content.view', 'Content', 'View content and drafts', false, true),
    ('content.edit', 'Content', 'Draft announcements, release notes and content', false, true),
    ('content.publish', 'Content', 'Publish announcements and content', false, false),
    ('content.clinical_review', 'Content', 'Record clinical review of medical content', false, false),
    ('releases.view', 'Content', 'View release notes', false, true),
    ('releases.manage', 'Content', 'Publish release notes', false, false),
    ('data.view', 'Operations', 'Database overview: tables, row counts, sizes and security (never contents)', false, false),
    ('flags.view', 'Platform control', 'View feature switches', false, false),
    ('flags.manage', 'Platform control', 'Change feature switches (not the AI switch)', false, false),
    ('maintenance.manage', 'Platform control', 'Maintenance mode and windows', false, false),
    ('team.view', 'Governance', 'See the leadership team', false, false),
    ('audit.view', 'Governance', 'Read the audit log', false, false),
    ('security.view', 'Governance', 'Security events', false, false),
    ('team.manage', 'Founder only', 'Invite, remove and set permissions of Co-Founders', true, false),
    ('security.manage', 'Founder only', 'Security policy and leadership sessions', true, false),
    ('ai.manage', 'Founder only', 'The AI assistant switch', true, false) $$;
