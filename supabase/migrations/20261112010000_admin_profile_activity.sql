-- Doctine · admin console fix (applied after 20261112000000_admin_console.sql).
-- The app creates a health profile row (with the person's name) at sign-up, so "profile saved" counted every account and
-- made every new account look active. Now only a later edit of the profile counts as activity, and "profile filled in"
-- means at least one detail beyond the name. Re-runnable, and changes only the objects below.

create or replace function private.profile_has_details(h public.health_profiles) returns boolean language sql immutable as $$
  select coalesce(h.date_of_birth::text, h.height_cm::text, h.weight_kg::text, nullif(h.blood_group, ''), nullif(h.allergies, '')) is not null $$;

create or replace view private.activity as
  select user_id, created_at as at, 'record' as kind from public.documents
  union all select user_id, created_at, 'file' from public.document_files
  union all select user_id, recorded_at, 'dose' from public.dose_events
  union all select user_id, created_at, 'medicine' from public.medicines
  union all select user_id, updated_at, 'medicine' from public.medicines where updated_at > created_at + interval '5 seconds'
  union all select user_id, updated_at, 'profile' from public.health_profiles where updated_at > created_at + interval '5 seconds' -- the app creates the profile at sign-up, so only later edits count
  union all select user_id, created_at, 'assistant' from public.messages where role = 'user'
  union all select user_id, at, name from private.analytics_events where user_id is not null and name in ('search_performed','record_exported');

create or replace function public.admin_adoption(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'analytics.view');
  return jsonb_build_object(
    'accounts', (select count(*) from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null),
    'features', jsonb_build_array(
      jsonb_build_object('key', 'profile', 'label', 'Health profile filled in',
        'ever', (select count(*) from public.health_profiles where private.profile_has_details(health_profiles)),
        'period', (select count(*) from public.health_profiles where private.profile_has_details(health_profiles) and updated_at >= p_from and updated_at < p_to)),
      jsonb_build_object('key', 'record', 'label', 'Record added',
        'ever', (select count(distinct user_id) from public.documents), 'period', (select count(distinct user_id) from public.documents where created_at >= p_from and created_at < p_to)),
      jsonb_build_object('key', 'file', 'label', 'Document file uploaded',
        'ever', (select count(distinct user_id) from public.document_files), 'period', (select count(distinct user_id) from public.document_files where created_at >= p_from and created_at < p_to)),
      jsonb_build_object('key', 'pdf', 'label', 'PDF read into a record',
        'ever', (select count(distinct user_id) from private.analytics_events where name = 'document_processing_completed' and props->>'method' = 'pdf_text'),
        'period', (select count(distinct user_id) from private.analytics_events where name = 'document_processing_completed' and props->>'method' = 'pdf_text' and at >= p_from and at < p_to)),
      jsonb_build_object('key', 'schedule', 'label', 'Medicine schedule created',
        'ever', (select count(distinct user_id) from public.medication_schedules), 'period', (select count(distinct m.user_id) from public.medicines m join public.medication_schedules s on s.medicine_id = m.id where m.created_at >= p_from and m.created_at < p_to)),
      jsonb_build_object('key', 'dose', 'label', 'Dose marked taken or skipped',
        'ever', (select count(distinct user_id) from public.dose_events where status in ('Taken','Skipped')), 'period', (select count(distinct user_id) from public.dose_events where status in ('Taken','Skipped') and recorded_at >= p_from and recorded_at < p_to)),
      jsonb_build_object('key', 'search', 'label', 'Search used',
        'ever', (select count(distinct user_id) from private.analytics_events where name = 'search_performed'), 'period', (select count(distinct user_id) from private.analytics_events where name = 'search_performed' and at >= p_from and at < p_to)),
      jsonb_build_object('key', 'export', 'label', 'Records exported',
        'ever', (select count(distinct user_id) from private.analytics_events where name = 'record_exported'), 'period', (select count(distinct user_id) from private.analytics_events where name = 'record_exported' and at >= p_from and at < p_to))),
    'events_since', (select min(at) from private.analytics_events));
end $$;

create or replace function public.admin_user(p_actor uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare can_notes boolean;
begin
  perform private.require(p_actor, 'users.view');
  can_notes := 'users.notes' = any (private.role_perms(private.actor_role(p_actor)));
  return (select jsonb_build_object(
      'id', u.id, 'email', u.email, 'created_at', u.created_at, 'email_confirmed_at', u.email_confirmed_at,
      'last_sign_in_at', u.last_sign_in_at, 'suspended', (u.banned_until is not null and u.banned_until > now()),
      'admin_role', (select role from private.admin_members where user_id = u.id and status = 'active'),
      'usage', jsonb_build_object(
        'records', (select count(*) from public.documents where user_id = u.id),
        'records_by_source', coalesce((select jsonb_object_agg(source, n) from (select source, count(*) n from public.documents where user_id = u.id group by source) s), '{}'::jsonb),
        'files', (select count(*) from public.document_files where user_id = u.id),
        'file_bytes', (select coalesce(sum(size_bytes), 0) from public.document_files where user_id = u.id),
        'medicines', (select count(*) from public.medicines where user_id = u.id),
        'doses_recorded', (select count(*) from public.dose_events where user_id = u.id),
        'profile_saved', exists (select 1 from public.health_profiles h where h.user_id = u.id and private.profile_has_details(h)),
        'last_activity', (select max(at) from private.activity where user_id = u.id),
        'active_days_30', (select count(distinct private.day(at)) from private.activity where user_id = u.id and at >= now() - interval '30 days')),
      'uploads', jsonb_build_object(
        'failed_30d', (select count(*) from private.analytics_events where user_id = u.id and name = 'document_upload_failed' and at >= now() - interval '30 days'),
        'processing_failed_30d', (select count(*) from private.analytics_events where user_id = u.id and name = 'document_processing_failed' and at >= now() - interval '30 days')),
      'notes', case when can_notes then coalesce((select jsonb_agg(jsonb_build_object('at', n.created_at, 'body', n.body, 'author', (select email from auth.users where id = n.author)) order by n.created_at desc)
                 from private.support_notes n where n.user_id = u.id), '[]'::jsonb) end,
      'admin_actions', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'outcome', l.outcome, 'by', (select email from auth.users where id = l.actor)) order by l.at desc)
                 from (select * from private.admin_audit_log where target_type = 'user' and target_id = u.id::text order by at desc limit 20) l), '[]'::jsonb))
    from auth.users u where u.id = p_user);
end $$;
