-- Doctine · profile completion in the admin console.
-- For each account: how many of the six profile details are added (name, date of birth, height, weight, blood group,
-- allergies), as a count and a percentage, with a filter and sort in the Users list. The account panel lists which details
-- are added or missing. Only true/false per detail leaves the database: never a value (no date, number, blood group or
-- allergy text).
-- Safety: no table, column or row is changed or deleted; functions only. Executable by service_role only, as before.
-- Rollback: re-run the admin_users and admin_user definitions from 20261112050000_names_and_database_overview.sql, then
--   drop function private.profile_completion(public.health_profiles, jsonb);

create or replace function private.profile_completion(h public.health_profiles, meta jsonb,
  out filled int, out total int, out pct int, out fields jsonb) language sql stable as $$
  with f as (select jsonb_build_object(
      'name', coalesce(nullif(trim(h.full_name), ''), private.account_name(meta)) is not null,
      'date_of_birth', h.date_of_birth is not null,
      'height', h.height_cm is not null,
      'weight', h.weight_kg is not null,
      'blood_group', nullif(trim(h.blood_group), '') is not null,
      'allergies', nullif(trim(h.allergies), '') is not null) j)
  select (select count(*)::int from jsonb_each(j) where value = 'true'::jsonb), 6,
         round(100.0 * (select count(*) from jsonb_each(j) where value = 'true'::jsonb) / 6)::int, j from f $$;
revoke all on function private.profile_completion(public.health_profiles, jsonb) from public, anon, authenticated;

create or replace function public.admin_users(p_actor uuid, p_q text, p_status text, p_sort text, p_page int, p_size int, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 25), 1), 100); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 25), 1), 100);
        q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform private.require(p_actor, 'users.view');
  return (with base as (
      select u.id, u.email, private.account_name(u.raw_user_meta_data) as name, u.created_at, u.email_confirmed_at, u.last_sign_in_at,
             (u.banned_until is not null and u.banned_until > now()) as suspended, m.role as admin_role,
             pc.filled as profile_filled, pc.pct as profile_pct
      from auth.users u left join private.admin_members m on m.user_id = u.id and m.status = 'active'
        left join public.health_profiles h on h.user_id = u.id
        cross join lateral private.profile_completion(h, u.raw_user_meta_data) pc
      where coalesce(u.is_anonymous, false) = false and u.deleted_at is null
        and (q is null or u.email ilike '%' || private.like_literal(q) || '%' or u.id::text = q
             or private.account_name(u.raw_user_meta_data) ilike '%' || private.like_literal(q) || '%')
        and (p_from is null or u.created_at >= p_from) and (p_to is null or u.created_at < p_to)
        and (p_status is null or p_status = '' or (p_status = 'suspended' and u.banned_until > now()) or (p_status = 'active' and (u.banned_until is null or u.banned_until <= now()))
             or (p_status = 'unverified' and u.email_confirmed_at is null) or (p_status = 'verified' and u.email_confirmed_at is not null)
             or (p_status = 'admins' and m.role is not null)
             or (p_status = 'profile_complete' and pc.pct = 100) or (p_status = 'profile_incomplete' and pc.pct < 100))),
    act as (select user_id, max(at) last_activity from private.activity where user_id in (select id from base) group by user_id),
    docs as (select user_id, count(*) n from public.documents where user_id in (select id from base) group by user_id),
    files as (select user_id, count(*) n from public.document_files where user_id in (select id from base) group by user_id),
    full_rows as (select b.*, act.last_activity, coalesce(docs.n, 0) records, coalesce(files.n, 0) files
      from base b left join act on act.user_id = b.id left join docs on docs.user_id = b.id left join files on files.user_id = b.id)
    select jsonb_build_object('total', (select count(*) from base), 'page', greatest(coalesce(p_page, 1), 1), 'size', size,
      'rows', coalesce((select jsonb_agg(to_jsonb(r)) from (select * from full_rows order by
          case when p_sort = 'created_asc' then extract(epoch from created_at) end asc nulls last,
          case when p_sort = 'activity_desc' then extract(epoch from last_activity) end desc nulls last,
          case when p_sort = 'activity_asc' then extract(epoch from last_activity) end asc nulls last,
          case when p_sort = 'email' then email end asc,
          case when p_sort = 'name' then lower(name) end asc nulls last,
          case when p_sort = 'records_desc' then records end desc,
          case when p_sort = 'profile_desc' then profile_pct end desc,
          case when p_sort = 'profile_asc' then profile_pct end asc,
          created_at desc limit size offset off) r), '[]'::jsonb)));
end $$;

create or replace function public.admin_user(p_actor uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare can_notes boolean;
begin
  perform private.require(p_actor, 'users.view');
  can_notes := private.can(p_actor, 'users.notes');
  return (select jsonb_build_object(
      'id', u.id, 'email', u.email, 'name', private.account_name(u.raw_user_meta_data), 'created_at', u.created_at, 'email_confirmed_at', u.email_confirmed_at,
      'last_sign_in_at', u.last_sign_in_at, 'suspended', (u.banned_until is not null and u.banned_until > now()),
      'admin_role', (select role from private.admin_members where user_id = u.id and status = 'active'),
      'sign_in_methods', coalesce((select jsonb_agg(distinct provider) from auth.identities i where i.user_id = u.id), '[]'::jsonb),
      'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified'),
      'profile', (select jsonb_build_object('pct', pc.pct, 'filled', pc.filled, 'total', pc.total, 'fields', pc.fields, 'updated_at', h.updated_at)
                  from (select 1) one left join public.health_profiles h on h.user_id = u.id cross join lateral private.profile_completion(h, u.raw_user_meta_data) pc),
      'first_activity', (select min(at) from private.activity where user_id = u.id),
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
      'adoption', jsonb_build_object(
        'profile', exists (select 1 from public.health_profiles h where h.user_id = u.id and private.profile_has_details(h)),
        'record', exists (select 1 from public.documents where user_id = u.id),
        'file', exists (select 1 from public.document_files where user_id = u.id),
        'schedule', exists (select 1 from public.medication_schedules where user_id = u.id),
        'dose', exists (select 1 from public.dose_events where user_id = u.id and status in ('Taken','Skipped')),
        'search', exists (select 1 from private.analytics_events where user_id = u.id and name = 'search_performed'),
        'export', exists (select 1 from private.analytics_events where user_id = u.id and name = 'record_exported')),
      'uploads', jsonb_build_object(
        'failed_30d', (select count(*) from private.analytics_events where user_id = u.id and name = 'document_upload_failed' and at >= now() - interval '30 days'),
        'processing_failed_30d', (select count(*) from private.analytics_events where user_id = u.id and name = 'document_processing_failed' and at >= now() - interval '30 days')),
      'notes', case when can_notes then coalesce((select jsonb_agg(jsonb_build_object('at', n.created_at, 'body', n.body, 'author', (select email from auth.users where id = n.author)) order by n.created_at desc)
                 from private.support_notes n where n.user_id = u.id), '[]'::jsonb) end,
      'admin_actions', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'outcome', l.outcome, 'reason', l.reason, 'by', (select email from auth.users where id = l.actor)) order by l.at desc)
                 from (select * from private.admin_audit_log where target_type = 'user' and target_id = u.id::text order by at desc limit 30) l), '[]'::jsonb))
    from auth.users u where u.id = p_user);
end $$;

do $$ declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('admin_users', 'admin_user') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
