-- Doctine · account names in the admin console, and a Database overview (applied after 20261112040000_leadership.sql).
--
-- 1. Names: the name a person gave when signing up (or from Google), from their sign-up details
--    (auth.users.raw_user_meta_data: full_name, else name). Shown in the account list, the account panel and search,
--    to anyone who may already see the account list (users.view). Nothing from the health profile is used.
-- 2. Database overview (new permission data.view; the Founder holds it automatically, Co-Founders only if granted):
--    every table in the app's schemas with its purpose, row count, rows added in the period, last write, size on disk and
--    row-level-security state, plus storage buckets. Counts and sizes only: no row, field or file content is ever read
--    out. Health tables are counted, never opened.
-- 3. Search and filter text matches literally (%, _ and \ are no longer treated as patterns or dropped).
-- Safety: no table, column or row is changed or deleted; function signatures are unchanged, so the live console keeps
-- working before and after. Rollback: re-run 20261112030000_admin_console_v2.sql's admin_users/admin_user/admin_search and
-- 20261112040000_leadership.sql's perm_catalog, and drop public.admin_data_overview.

-- Search text as a literal ILIKE pattern: backslash, % and _ match themselves (they used to be dropped, so "%" matched everyone).
create or replace function private.like_literal(q text) returns text language sql immutable as $$
  select replace(replace(replace(coalesce(q, ''), '\', '\\'), '%', '\%'), '_', '\_') $$;

create or replace function private.account_name(meta jsonb) returns text language sql immutable as $$
  select nullif(left(trim(coalesce(nullif(trim(meta->>'full_name'), ''), nullif(trim(meta->>'name'), ''), '')), 120), '') $$;

create or replace function private.perm_catalog() returns table (key text, grp text, label text, founder_only boolean, standard boolean)
language sql immutable as $$
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

create or replace function public.admin_users(p_actor uuid, p_q text, p_status text, p_sort text, p_page int, p_size int, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 25), 1), 100); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 25), 1), 100);
        q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform private.require(p_actor, 'users.view');
  return (with base as (
      select u.id, u.email, private.account_name(u.raw_user_meta_data) as name, u.created_at, u.email_confirmed_at, u.last_sign_in_at,
             (u.banned_until is not null and u.banned_until > now()) as suspended, m.role as admin_role
      from auth.users u left join private.admin_members m on m.user_id = u.id and m.status = 'active'
      where coalesce(u.is_anonymous, false) = false and u.deleted_at is null
        and (q is null or u.email ilike '%' || private.like_literal(q) || '%' or u.id::text = q
             or private.account_name(u.raw_user_meta_data) ilike '%' || private.like_literal(q) || '%')
        and (p_from is null or u.created_at >= p_from) and (p_to is null or u.created_at < p_to)
        and (p_status is null or p_status = '' or (p_status = 'suspended' and u.banned_until > now()) or (p_status = 'active' and (u.banned_until is null or u.banned_until <= now()))
             or (p_status = 'unverified' and u.email_confirmed_at is null) or (p_status = 'verified' and u.email_confirmed_at is not null)
             or (p_status = 'admins' and m.role is not null))),
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

create or replace function public.admin_search(p_actor uuid, p_q text) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform private.require(p_actor, 'dashboard.view');
  if q is null or char_length(q) < 2 then return jsonb_build_object('users', '[]'::jsonb, 'errors', '[]'::jsonb, 'incidents', '[]'::jsonb); end if;
  q := private.like_literal(q);
  return jsonb_build_object(
    'users', case when private.can(p_actor, 'users.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'email', email, 'name', name))
        from (select id, email, private.account_name(raw_user_meta_data) name from auth.users where deleted_at is null
              and (email ilike '%' || q || '%' or id::text = p_q or private.account_name(raw_user_meta_data) ilike '%' || q || '%') order by created_at desc limit 6) u), '[]'::jsonb) else '[]'::jsonb end,
    'errors', case when private.can(p_actor, 'health.view') then coalesce((select jsonb_agg(jsonb_build_object('fingerprint', fingerprint, 'kind', kind, 'message', message))
        from (select * from private.error_groups where message ilike '%' || q || '%' or kind ilike '%' || q || '%' or location ilike '%' || q || '%' order by last_seen desc limit 5) e), '[]'::jsonb) else '[]'::jsonb end,
    'incidents', case when private.can(p_actor, 'health.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'status', status))
        from (select * from private.incidents where title ilike '%' || q || '%' order by started_at desc limit 5) i), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- Audit log filters: the admin-email and action filters match literally too.
create or replace function public.admin_audit(p_actor uuid, p_admin text, p_action text, p_target text, p_from timestamptz, p_to timestamptz, p_page int, p_size int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 50), 1), 200); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 50), 1), 200);
begin
  perform private.require(p_actor, 'audit.view');
  return (with f as (select l.*, u.email as actor_email from private.admin_audit_log l left join auth.users u on u.id = l.actor
      where (nullif(p_admin, '') is null or u.email ilike '%' || private.like_literal(p_admin) || '%')
        and (nullif(p_action, '') is null or l.action like private.like_literal(p_action) || '%')
        and (nullif(p_target, '') is null or l.target_id = p_target)
        and (p_from is null or l.at >= p_from) and (p_to is null or l.at < p_to))
    select jsonb_build_object('total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) - 'actor' order by x.at desc) from (select * from f order by at desc limit size offset off) x), '[]'::jsonb)));
end $$;

-- What each table holds, in plain words. Tables not listed here still appear (purpose "Not described yet").
create or replace function private.table_purpose(p_schema text, p_table text) returns table (area text, purpose text) language sql immutable as $$
  select t.area, t.purpose from (values
    ('public', 'health_profiles', 'Health data', 'Health profiles'), ('public', 'documents', 'Health data', 'Health records'),
    ('public', 'document_files', 'Health data', 'Uploaded document files (file details; the files are in storage)'),
    ('public', 'medicines', 'Health data', 'Medicines'), ('public', 'medication_schedules', 'Health data', 'Medicine schedules'),
    ('public', 'dose_events', 'Health data', 'Doses taken or skipped'), ('public', 'prescriptions', 'Health data', 'Prescriptions'),
    ('public', 'prescription_items', 'Health data', 'Prescription items'), ('public', 'lab_results', 'Health data', 'Lab results'),
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

create or replace function public.admin_data_overview(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare t record; rows_n bigint; new_n bigint; last_w timestamptz; has_c boolean; has_u boolean; out jsonb := '[]'::jsonb; est real;
begin
  perform private.require(p_actor, 'data.view');
  if p_to <= p_from or p_to - p_from > interval '400 days' then raise exception 'invalid period' using errcode = '22023'; end if;
  for t in select n.nspname s, c.relname r, c.oid, c.relrowsecurity rls, c.relforcerowsecurity forced, c.reltuples
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'r' and n.nspname in ('public', 'private') order by n.nspname, c.relname loop
    has_c := exists (select 1 from information_schema.columns where table_schema = t.s and table_name = t.r and column_name = 'created_at');
    has_u := exists (select 1 from information_schema.columns where table_schema = t.s and table_name = t.r and column_name = 'updated_at');
    -- Exact counts while tables are small; the planner's estimate beyond a million rows (marked as an estimate).
    if t.reltuples > 1000000 then rows_n := t.reltuples::bigint; else execute format('select count(*) from %I.%I', t.s, t.r) into rows_n; end if;
    new_n := null; last_w := null;
    if has_c then execute format('select count(*) from %I.%I where created_at >= $1 and created_at < $2', t.s, t.r) into new_n using p_from, p_to; end if;
    if has_u then execute format('select max(updated_at) from %I.%I', t.s, t.r) into last_w;
    elsif has_c then execute format('select max(created_at) from %I.%I', t.s, t.r) into last_w; end if;
    out := out || jsonb_build_object('schema', t.s, 'table', t.r, 'area', coalesce((select area from private.table_purpose(t.s, t.r)), case when t.s = 'private' then 'Administration' else 'App data' end),
      'purpose', coalesce((select purpose from private.table_purpose(t.s, t.r)), 'Not described yet'), 'rows', rows_n, 'estimated', t.reltuples > 1000000,
      'new_in_period', new_n, 'last_write', last_w, 'bytes', pg_total_relation_size(t.oid), 'rls', t.rls, 'rls_forced', t.forced,
      'policies', (select count(*) from pg_policies p where p.schemaname = t.s and p.tablename = t.r),
      'browser_access', t.s = 'public' and (has_table_privilege('authenticated', t.oid, 'select') or has_table_privilege('anon', t.oid, 'select')));
  end loop;
  return jsonb_build_object(
    'generated_at', now(), 'database_bytes', pg_database_size(current_database()),
    'accounts', (select count(*) from auth.users where deleted_at is null and not coalesce(is_anonymous, false)),
    'accounts_new', (select count(*) from auth.users where deleted_at is null and not coalesce(is_anonymous, false) and created_at >= p_from and created_at < p_to),
    'tables', out,
    'buckets', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'public', b.public, 'file_size_limit', b.file_size_limit,
        'objects', (select count(*) from storage.objects o where o.bucket_id = b.id),
        'bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = b.id),
        'new_in_period', (select count(*) from storage.objects o where o.bucket_id = b.id and o.created_at >= p_from and o.created_at < p_to)) order by b.id)
      from storage.buckets b), '[]'::jsonb));
end $$;

do $$ declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('admin_users', 'admin_user', 'admin_search', 'admin_audit', 'admin_data_overview') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
