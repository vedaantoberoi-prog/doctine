-- Doctine · admin console follows the complete health profile (22 Nov 2026).
-- The console still sees only whether each detail is filled in (true / false) and counts, never any value.
--   1. Profile completion: "allergies" now counts as answered when the person added an allergy in the new allergy list,
--      or answered "no known allergies", "never been checked" or "prefer not to say" — not only the old free-text field.
--   2. "Has saved profile details" (adoption, activity, filters) also counts sex at birth, lifestyle, the explicit
--      history answers and any medical-history entry.
--   3. The Database overview describes the new tables (and health readings) instead of "Not described yet".
-- Functions only; no table or row changes. Rollback: supabase/rollback/20261122010000_admin_health_profile_down.sql

create or replace function private.profile_completion(h public.health_profiles, meta jsonb,
  out filled int, out total int, out pct int, out fields jsonb) language sql stable
  set search_path = public, extensions, pg_temp as $$
  with f as (select jsonb_build_object(
      'name', coalesce(nullif(trim(h.full_name), ''), private.account_name(meta)) is not null,
      'date_of_birth', h.date_of_birth is not null,
      'gender', h.gender is not null,
      'height', h.height_cm is not null,
      'weight', h.weight_kg is not null,
      'blood_group', nullif(trim(h.blood_group), '') is not null,
      'allergies', nullif(trim(h.allergies), '') is not null
        or coalesce(h.history_answers->>'allergies', '') in ('yes', 'nka', 'not_assessed', 'prefer_not')
        or exists (select 1 from public.health_records r where r.user_id = h.user_id and r.kind = 'allergy')) j)
  select (select count(*)::int from jsonb_each(j) where value = 'true'::jsonb), 7,
         round(100.0 * (select count(*) from jsonb_each(j) where value = 'true'::jsonb) / 7)::int, j from f $$;
revoke all on function private.profile_completion(public.health_profiles, jsonb) from public, anon, authenticated;

-- now looks at the history table, so it is stable rather than immutable
create or replace function private.profile_has_details(h public.health_profiles) returns boolean language sql stable
  set search_path = public, extensions, pg_temp as $$
  select coalesce(h.date_of_birth::text, h.gender, h.sex_at_birth, h.height_cm::text, h.weight_kg::text, nullif(h.blood_group, ''), nullif(h.allergies, '')) is not null
      or coalesce(h.lifestyle, '{}'::jsonb) <> '{}'::jsonb or coalesce(h.history_answers, '{}'::jsonb) <> '{}'::jsonb
      or exists (select 1 from public.health_records r where r.user_id = h.user_id) $$;
revoke all on function private.profile_has_details(public.health_profiles) from public, anon, authenticated;

create or replace function private.table_purpose(p_schema text, p_table text) returns table (area text, purpose text) language sql immutable
  set search_path = public, extensions, pg_temp as $$
  select t.area, t.purpose from (values
    ('public', 'health_profiles', 'Health data', 'Health profiles'), ('public', 'documents', 'Health data', 'Health records'),
    ('public', 'document_files', 'Health data', 'Uploaded document files (file details; the files are in storage)'),
    ('public', 'medicines', 'Health data', 'Medicines'), ('public', 'medication_schedules', 'Health data', 'Medicine schedules'),
    ('public', 'dose_events', 'Health data', 'Doses taken or skipped'), ('public', 'prescriptions', 'Health data', 'Prescriptions'),
    ('public', 'prescription_items', 'Health data', 'Prescription items'), ('public', 'lab_results', 'Health data', 'Lab results'),
    ('public', 'vital_readings', 'Health data', 'Health readings (blood pressure, glucose, weight…)'),
    ('public', 'health_records', 'Health data', 'Medical history: conditions, illnesses, surgeries, hospital stays, allergies, devices, family history'),
    ('public', 'health_record_changes', 'Health data', 'Medical-history change log (what changed and when, never the content)'),
    ('public', 'conversations', 'Health data', 'AI assistant conversations'), ('public', 'messages', 'Health data', 'AI assistant messages'),
    ('public', 'consents', 'Consent', 'Current consent choices'), ('public', 'consent_log', 'Consent', 'Consent history'),
    ('private', 'admin_members', 'Administration', 'Leadership team'), ('private', 'admin_invites', 'Administration', 'Leadership invitations'),
    ('private', 'admin_audit_log', 'Administration', 'Audit log (append-only)'), ('private', 'admin_prefs', 'Administration', 'Admin notification preferences'),
    ('private', 'feature_flags', 'Administration', 'Feature switches and maintenance'), ('private', 'announcements', 'Administration', 'Announcements'),
    ('private', 'support_notes', 'Administration', 'Internal notes on accounts'),
    ('private', 'support_requests', 'Support and product', 'Support requests'), ('private', 'support_messages', 'Support and product', 'Support conversations'),
    ('private', 'feedback', 'Support and product', 'Product feedback'), ('private', 'work_items', 'Support and product', 'Bugs, feature requests and tasks'),
    ('private', 'content_items', 'Support and product', 'Content and release notes'),
    ('private', 'analytics_events', 'Measurements', 'Opt-in product measurements'), ('private', 'error_groups', 'Operations', 'Application errors (grouped)'),
    ('private', 'error_hits', 'Operations', 'Application error occurrences'), ('private', 'uptime_checks', 'Operations', 'Health checks'),
    ('private', 'admin_alerts', 'Operations', 'Alerts'), ('private', 'incidents', 'Operations', 'Incidents'), ('private', 'incident_updates', 'Operations', 'Incident timeline'),
    ('private', 'rate_limits', 'Operations', 'Rate limiting counters'), ('private', 'activity', 'Measurements', 'Meaningful activity')
  ) t(s, n, area, purpose) where s = p_schema and n = p_table $$;
