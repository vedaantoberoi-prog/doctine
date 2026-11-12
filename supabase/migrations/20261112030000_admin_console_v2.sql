-- Doctine · admin console v2 (applied after 20261112000000, 20261112010000 and 20261112020000).
--
-- What changes
--   * Roles become the five least-privilege roles: owner, admin, analyst, support, auditor. Existing members are mapped
--     (super_admin and operations → admin, developer → analyst). Permissions stay enforced in the database.
--   * Richer measures for the redesigned console: previous-period comparisons, per-day series for records, files,
--     storage, uploads, PDF reading, errors and availability, engagement, a six-step activation funnel, adoption trend,
--     recent activity, search, notification preferences, report history.
--   * Incidents gain severity, an assignee and a timeline; alerts gain the affected service and can be muted for 24 hours;
--     errors keep a cleaned stack sample, route, environment and request id; the uptime history can include the AI
--     provider; maintenance can be scheduled for a window; announcements choose their audience.
--   * Additive: new columns, tables and functions. One function signature changes (admin_users gains a registration-date
--     filter): the old one is dropped, so deploy the matching app right after applying. No existing row is deleted.

-- ───────────────────────── roles ─────────────────────────
update private.admin_members set role = case role when 'super_admin' then 'admin' when 'operations' then 'admin' when 'developer' then 'analyst' else role end
where role in ('super_admin', 'operations', 'developer');
do $$ declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'private.admin_members'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%role%' loop
    execute format('alter table private.admin_members drop constraint %I', c);
  end loop;
end $$;
alter table private.admin_members add constraint admin_members_role_check check (role in ('owner', 'admin', 'analyst', 'support', 'auditor'));

create or replace function private.role_perms(p_role text) returns text[] language sql immutable as $$
  select case p_role
    when 'owner' then array['dashboard.view','analytics.view','reports.export','users.view','users.suspend','users.reset_password','users.notes',
      'documents.view','health.view','incidents.manage','alerts.manage','flags.view','flags.manage','maintenance.manage','announcements.manage',
      'team.view','team.manage','audit.view','security.view']
    when 'admin' then array['dashboard.view','analytics.view','reports.export','users.view','users.suspend','users.reset_password','users.notes',
      'documents.view','health.view','incidents.manage','alerts.manage','flags.view','flags.manage','maintenance.manage','announcements.manage',
      'team.view','audit.view','security.view']
    when 'analyst' then array['dashboard.view','analytics.view','reports.export','documents.view','health.view']
    when 'support' then array['dashboard.view','users.view','users.reset_password','users.notes','health.view']
    when 'auditor' then array['dashboard.view','reports.export','team.view','audit.view','security.view']
    else array[]::text[] end $$;

create or replace function private.can(p_actor uuid, p_perm text) returns boolean language sql stable as $$
  select coalesce(p_perm = any (private.role_perms(private.actor_role(p_actor))), false) $$;

-- ───────────────────────── schema additions ─────────────────────────
alter table private.incidents add column if not exists severity text not null default 'minor';
alter table private.incidents add column if not exists assigned_to uuid references auth.users (id) on delete set null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'incidents_severity_check') then
    alter table private.incidents add constraint incidents_severity_check check (severity in ('critical', 'major', 'minor'));
  end if;
end $$;
create table if not exists private.incident_updates (
  id          bigint generated always as identity primary key,
  incident_id uuid not null references private.incidents (id) on delete cascade,
  at          timestamptz not null default now(),
  actor       uuid,
  status      text,
  severity    text,
  note        text check (char_length(note) <= 2000)
);
create index if not exists incident_updates_incident on private.incident_updates (incident_id, at);

alter table private.admin_alerts add column if not exists service text;
alter table private.admin_alerts add column if not exists muted_until timestamptz;
do $$ declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'private.admin_alerts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%acknowledged%' loop
    execute format('alter table private.admin_alerts drop constraint %I', c);
  end loop;
end $$;
alter table private.admin_alerts add constraint admin_alerts_status_check check (status in ('open', 'acknowledged', 'muted', 'resolved'));

alter table private.error_groups add column if not exists category text;
alter table private.error_groups add column if not exists sample_stack text;
alter table private.error_groups add column if not exists route text;
alter table private.error_groups add column if not exists environment text;
alter table private.error_groups add column if not exists last_request_id text;

do $$ declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'private.uptime_checks'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%target%' loop
    execute format('alter table private.uptime_checks drop constraint %I', c);
  end loop;
end $$;
alter table private.uptime_checks add constraint uptime_checks_target_check check (target in ('app', 'database', 'auth', 'storage', 'ai'));
alter table private.uptime_checks add column if not exists error text check (char_length(error) <= 60);

alter table private.announcements add column if not exists audience text not null default 'signed_in';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'announcements_audience_check') then
    alter table private.announcements add constraint announcements_audience_check check (audience in ('all', 'signed_in'));
  end if;
end $$;

create table if not exists private.admin_prefs (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email_alerts boolean not null default false,
  min_severity text not null default 'warning' check (min_severity in ('info', 'warning', 'critical')),
  updated_at   timestamptz not null default now()
);

create index if not exists documents_user_created_idx on public.documents (user_id, created_at);
create index if not exists document_files_user_idx on public.document_files (user_id, created_at);
create index if not exists analytics_events_name_at on private.analytics_events (name, at);
create index if not exists error_hits_hour on private.error_hits (hour);

-- ───────────────────────── maintenance window and settings ─────────────────────────
-- Maintenance is on when switched on, or during a scheduled window (value.starts_at ≤ now < value.ends_at). The window
-- is evaluated every time the app asks, so a schedule needs no background job.
create or replace function private.maintenance_on() returns boolean language sql stable as $$
  select coalesce((select enabled or (nullif(value->>'starts_at', '')::timestamptz <= now() and now() < nullif(value->>'ends_at', '')::timestamptz)
                   from private.feature_flags where key = 'maintenance'), false) $$;

create or replace function public.public_settings() returns jsonb language sql stable security definer set search_path = pg_catalog, private as $$
  select jsonb_build_object(
    'flags', coalesce((select jsonb_object_agg(key, enabled) from private.feature_flags where key <> 'maintenance'), '{}'::jsonb),
    'maintenance', jsonb_build_object('on', private.maintenance_on(),
       'message', coalesce((select value->>'message' from private.feature_flags where key = 'maintenance'), ''),
       'ends_at', (select nullif(value->>'ends_at', '') from private.feature_flags where key = 'maintenance' and private.maintenance_on())),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'body', body, 'audience', audience) order by starts_at nulls first, created_at)
       from private.announcements where status = 'published' and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())), '[]'::jsonb)) $$;

create or replace function public.uploads_allowed() returns boolean language sql stable security definer set search_path = pg_catalog, private as $$
  select coalesce((select enabled from private.feature_flags where key = 'document_upload'), true) and not private.maintenance_on() $$;

create or replace function public.hook_before_user_created(event jsonb) returns jsonb language sql stable security definer set search_path = pg_catalog, private as $$
  select case when coalesce((select enabled from private.feature_flags where key = 'registrations'), true) and not private.maintenance_on()
    then '{}'::jsonb
    else jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'New accounts are paused for a short while. Please try again later.')) end $$;

-- Switch or schedule maintenance. p_starts/p_ends set a window (both or neither).
create or replace function public.admin_set_maintenance(p_actor uuid, p_enabled boolean, p_message text, p_starts timestamptz, p_ends timestamptz, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, 'maintenance.manage');
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = '22023'; end if;
  if (p_starts is null) <> (p_ends is null) or (p_ends is not null and p_ends <= p_starts) then raise exception 'invalid window' using errcode = '22023'; end if;
  select jsonb_build_object('enabled', enabled, 'value', value) into old from private.feature_flags where key = 'maintenance' for update;
  update private.feature_flags set enabled = p_enabled, updated_at = now(), updated_by = p_actor,
    value = jsonb_build_object('message', left(coalesce(nullif(trim(p_message), ''), value->>'message', ''), 300),
                               'starts_at', coalesce(p_starts::text, ''), 'ends_at', coalesce(p_ends::text, ''))
  where key = 'maintenance';
  perform private.audit(p_actor, r, 'maintenance.set', 'flag', 'maintenance', p_reason, old,
    (select jsonb_build_object('enabled', enabled, 'value', value) from private.feature_flags where key = 'maintenance'), 'ok', p_request);
  return jsonb_build_object('ok', true, 'on_now', private.maintenance_on());
end $$;

create or replace function public.admin_flags(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'flags.view');
  return coalesce((select jsonb_agg(jsonb_build_object('key', key, 'enabled', enabled, 'value', value, 'updated_at', updated_at,
    'updated_by', (select email from auth.users where id = updated_by), 'on_now', case when key = 'maintenance' then private.maintenance_on() else enabled end) order by key)
    from private.feature_flags), '[]'::jsonb);
end $$;

-- ───────────────────────── announcements (audience) ─────────────────────────
create or replace function public.admin_announcement_save(p_actor uuid, p_data jsonb, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; aid uuid := nullif(p_data->>'id', '')::uuid; old jsonb; st text := coalesce(p_data->>'status', 'draft');
begin
  r := private.require(p_actor, 'announcements.manage');
  if st not in ('draft', 'published', 'archived') then raise exception 'invalid status' using errcode = '22023'; end if;
  if aid is null then
    insert into private.announcements (kind, title, body, status, starts_at, ends_at, audience, created_by, updated_by)
    values (p_data->>'kind', trim(p_data->>'title'), coalesce(trim(p_data->>'body'), ''), st, nullif(p_data->>'starts_at', '')::timestamptz,
            nullif(p_data->>'ends_at', '')::timestamptz, coalesce(nullif(p_data->>'audience', ''), 'signed_in'), p_actor, p_actor) returning id into aid;
  else
    select to_jsonb(a) into old from private.announcements a where id = aid for update;
    if old is null then raise exception 'no such announcement' using errcode = 'P0002'; end if;
    update private.announcements set kind = coalesce(p_data->>'kind', kind), title = coalesce(trim(p_data->>'title'), title),
      body = coalesce(trim(p_data->>'body'), body), status = st, audience = coalesce(nullif(p_data->>'audience', ''), audience),
      starts_at = case when p_data ? 'starts_at' then nullif(p_data->>'starts_at', '')::timestamptz else starts_at end,
      ends_at = case when p_data ? 'ends_at' then nullif(p_data->>'ends_at', '')::timestamptz else ends_at end,
      updated_by = p_actor, updated_at = now() where id = aid;
  end if;
  perform private.audit(p_actor, r, 'announcement.' || case when old is null then 'create' when st = 'published' then 'publish' when st = 'archived' then 'archive' when old->>'status' = 'published' then 'unpublish' else 'update' end,
    'announcement', aid::text, null, old - 'created_by' - 'updated_by', (select to_jsonb(a) - 'created_by' - 'updated_by' from private.announcements a where id = aid), 'ok', p_request);
  return jsonb_build_object('ok', true, 'id', aid);
end $$;

-- ───────────────────────── measures ─────────────────────────
-- Availability over [from, to) for one target: share of recorded checks that passed (null when there were no checks).
create or replace function private.availability(p_target text, p_from timestamptz, p_to timestamptz) returns jsonb language sql stable as $$
  select jsonb_build_object('checks', count(*), 'ok', count(*) filter (where ok),
    'pct', case when count(*) > 0 then round(count(*) filter (where ok) * 100.0 / count(*), 2) end,
    'ms_avg', round(avg(ms) filter (where ok)))
  from private.uptime_checks where target = p_target and at >= p_from and at < p_to $$;

create or replace function public.admin_overview(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare pf timestamptz := p_from - (p_to - p_from); res jsonb; ev_since timestamptz; err_since timestamptz; chk_since timestamptz;
begin
  perform private.require(p_actor, 'dashboard.view');
  if p_to <= p_from or p_to - p_from > interval '400 days' then raise exception 'invalid period' using errcode = '22023'; end if;
  ev_since := (select min(at) from private.analytics_events);
  err_since := (select min(first_seen) from private.error_groups);
  chk_since := (select min(at) from private.uptime_checks);
  with u as (select id, created_at, email_confirmed_at, last_sign_in_at from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null),
  a as (select user_id, at from private.activity),
  firsts as (select user_id, min(at) first_at from a group by user_id),
  ev as (select name, at from private.analytics_events where at >= pf and at < p_to),
  eh as (select hour, n from private.error_hits where hour >= date_trunc('hour', pf) and hour < p_to)
  select jsonb_build_object(
    'generated_at', now(), 'timezone', 'Asia/Kolkata',
    'period', jsonb_build_object('from', p_from, 'to', p_to), 'previous', jsonb_build_object('from', pf, 'to', p_from),
    'users_total', (select count(*) from u where created_at < p_to),
    'users_total_prev', (select count(*) from u where created_at < p_from),
    'users_verified', (select count(*) from u where created_at < p_to and email_confirmed_at is not null),
    'users_new', (select count(*) from u where created_at >= p_from and created_at < p_to),
    'users_new_prev', (select count(*) from u where created_at >= pf and created_at < p_from),
    'new_today', (select count(*) from u where private.day(created_at) = private.day(now())),
    'new_7d', (select count(*) from u where created_at >= now() - interval '7 days'),
    'new_30d', (select count(*) from u where created_at >= now() - interval '30 days'),
    'dau', (select count(distinct user_id) from a where private.day(at) = private.day(now())),
    'dau_prev', (select count(distinct user_id) from a where private.day(at) = private.day(now()) - 1),
    'wau', (select count(distinct user_id) from a where at >= now() - interval '7 days'),
    'wau_prev', (select count(distinct user_id) from a where at >= now() - interval '14 days' and at < now() - interval '7 days'),
    'mau', (select count(distinct user_id) from a where at >= now() - interval '30 days'),
    'mau_prev', (select count(distinct user_id) from a where at >= now() - interval '60 days' and at < now() - interval '30 days'),
    'active', (select count(distinct user_id) from a where at >= p_from and at < p_to),
    'active_prev', (select count(distinct user_id) from a where at >= pf and at < p_from),
    'returning', (select count(distinct a.user_id) from a join firsts f on f.user_id = a.user_id where a.at >= p_from and a.at < p_to and f.first_at < p_from),
    'returning_prev', (select count(distinct a.user_id) from a join firsts f on f.user_id = a.user_id where a.at >= pf and a.at < p_from and f.first_at < pf),
    'actions', (select count(*) from a where at >= p_from and at < p_to),
    'signed_in', (select count(*) from u where last_sign_in_at >= p_from and last_sign_in_at < p_to),
    'documents_new', (select count(*) from public.documents where created_at >= p_from and created_at < p_to),
    'documents_new_prev', (select count(*) from public.documents where created_at >= pf and created_at < p_from),
    'documents_total', (select count(*) from public.documents where created_at < p_to),
    'files_new', (select count(*) from public.document_files where created_at >= p_from and created_at < p_to),
    'files_new_prev', (select count(*) from public.document_files where created_at >= pf and created_at < p_from),
    'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'health-documents'),
    'storage_files', (select count(*) from storage.objects where bucket_id = 'health-documents'),
    'storage_limit', coalesce(((select value->>'storage_limit_bytes' from private.feature_flags where key = 'document_upload'))::bigint, 1073741824),
    'uploads_completed', (select count(*) from ev where name = 'document_upload_completed' and at >= p_from),
    'uploads_failed', (select count(*) from ev where name = 'document_upload_failed' and at >= p_from),
    'uploads_failed_prev', (select count(*) from ev where name = 'document_upload_failed' and at < p_from),
    'login_failures', (select count(*) from ev where name = 'login_failure' and at >= p_from),
    'app_errors', (select coalesce(sum(n), 0) from eh where hour >= date_trunc('hour', p_from)),
    'app_errors_prev', (select coalesce(sum(n), 0) from eh where hour < date_trunc('hour', p_from)),
    'availability', private.availability('app', p_from, p_to),
    'availability_prev', private.availability('app', pf, p_from),
    'events_since', ev_since, 'errors_since', err_since, 'checks_since', chk_since
  ) into res;
  return res;
end $$;

-- Day by day (India time) over [p_from, p_to), aggregated per table and joined to the calendar (no per-day subqueries).
create or replace function public.admin_series(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare d0 date := private.day(p_from); d1 date := private.day(p_to - interval '1 second');
begin
  perform private.require(p_actor, 'analytics.view');
  if p_to <= p_from or p_to - p_from > interval '400 days' then raise exception 'invalid period' using errcode = '22023'; end if;
  return coalesce((
    with days as (select d::date as day from generate_series(d0, d1, interval '1 day') d),
    u as (select private.day(created_at) as day, count(*) n from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null group by 1),
    act as (select private.day(at) as day, user_id from private.activity where at >= (d0 - 30)::timestamp at time zone 'Asia/Kolkata'),
    firsts as (select user_id, min(private.day(at)) fday from private.activity group by user_id),
    act_day as (select day, count(distinct user_id) dau, count(*) actions from act group by day),
    ret_day as (select a.day, count(distinct a.user_id) n from act a join firsts f using (user_id) where a.day > f.fday group by a.day),
    win as (select d.day, count(distinct a.user_id) filter (where a.day between d.day - 6 and d.day) wau, count(distinct a.user_id) mau
            from days d join act a on a.day between d.day - 29 and d.day group by d.day),
    docs as (select private.day(created_at) as day, count(*) n from public.documents group by 1),
    files as (select private.day(created_at) as day, count(*) n, coalesce(sum(size_bytes), 0) b from public.document_files group by 1),
    ev as (select private.day(at) as day, name, count(*) n from private.analytics_events where at >= (d0)::timestamp at time zone 'Asia/Kolkata' group by 1, 2),
    eh as (select private.day(hour) as day, sum(n) n from private.error_hits where hour >= (d0 - 1)::timestamp at time zone 'Asia/Kolkata' group by 1),
    up as (select private.day(at) as day, count(*) c, count(*) filter (where ok) o, round(avg(ms) filter (where ok)) ms from private.uptime_checks where target = 'app' group by 1)
    select jsonb_agg(jsonb_build_object(
      'day', d.day,
      'users_total', (select coalesce(sum(n), 0) from u where u.day <= d.day),
      'users_new', coalesce((select n from u where u.day = d.day), 0),
      'dau', coalesce(ad.dau, 0), 'actions', coalesce(ad.actions, 0),
      'wau', coalesce(w.wau, 0), 'mau', coalesce(w.mau, 0),
      'returning', coalesce(rd.n, 0),
      'documents', coalesce((select n from docs where docs.day = d.day), 0),
      'documents_total', (select coalesce(sum(n), 0) from docs where docs.day <= d.day),
      'files', coalesce((select n from files where files.day = d.day), 0),
      'storage_total', (select coalesce(sum(b), 0) from files where files.day <= d.day),
      'uploads_completed', coalesce((select n from ev where ev.day = d.day and name = 'document_upload_completed'), 0),
      'uploads_failed', coalesce((select n from ev where ev.day = d.day and name = 'document_upload_failed'), 0),
      'processing_completed', coalesce((select n from ev where ev.day = d.day and name = 'document_processing_completed'), 0),
      'processing_failed', coalesce((select n from ev where ev.day = d.day and name = 'document_processing_failed'), 0),
      'login_failures', coalesce((select n from ev where ev.day = d.day and name = 'login_failure'), 0),
      'app_errors', coalesce((select n from eh where eh.day = d.day), 0),
      'checks', coalesce(upd.c, 0), 'checks_ok', coalesce(upd.o, 0), 'ms_avg', upd.ms
    ) order by d.day)
    from days d left join act_day ad on ad.day = d.day left join win w on w.day = d.day left join ret_day rd on rd.day = d.day left join up upd on upd.day = d.day), '[]'::jsonb);
end $$;

-- Engagement for [p_from, p_to): actions by kind, actions per active person, returning rate.
create or replace function public.admin_engagement(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'analytics.view');
  return (with a as (select user_id, at, kind from private.activity where at >= p_from and at < p_to),
               firsts as (select user_id, min(at) f from private.activity group by user_id)
    select jsonb_build_object(
      'active', (select count(distinct user_id) from a),
      'returning', (select count(distinct a.user_id) from a join firsts using (user_id) where firsts.f < p_from),
      'actions', (select count(*) from a),
      'by_kind', coalesce((select jsonb_object_agg(kind, n) from (select kind, count(*) n from a group by kind) k), '{}'::jsonb),
      'active_days_avg', (select round(avg(n), 2) from (select user_id, count(distinct private.day(at)) n from a group by user_id) z)));
end $$;

-- Activation funnel for accounts created in [p_from, p_to).
create or replace function public.admin_funnel(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'analytics.view');
  return (with u as (select id, email_confirmed_at, last_sign_in_at from auth.users
                     where coalesce(is_anonymous, false) = false and deleted_at is null and created_at >= p_from and created_at < p_to)
    select jsonb_build_object(
      'account_created', (select count(*) from u),
      'email_verified', (select count(*) from u where email_confirmed_at is not null),
      'signed_in', (select count(*) from u where last_sign_in_at is not null),
      'profile_completed', (select count(*) from u where exists (select 1 from public.health_profiles h where h.user_id = u.id and private.profile_has_details(h))),
      'first_record', (select count(*) from u where exists (select 1 from public.documents d where d.user_id = u.id)),
      'first_file', (select count(*) from u where exists (select 1 from public.document_files f where f.user_id = u.id)),
      'first_activity', (select count(*) from u where exists (select 1 from private.activity a where a.user_id = u.id)),
      'signup_failed', (select count(*) from private.analytics_events where name = 'signup_failed' and at >= p_from and at < p_to)));
end $$;

-- Feature adoption with "measured" honesty: event-based features report measured=false until any event of that kind exists.
create or replace function public.admin_adoption(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare ev_since timestamptz := (select min(at) from private.analytics_events);
begin
  perform private.require(p_actor, 'analytics.view');
  return jsonb_build_object(
    'accounts', (select count(*) from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null),
    'events_since', ev_since,
    'features', jsonb_build_array(
      jsonb_build_object('key', 'profile', 'label', 'Health profile filled in', 'source', 'table', 'measured', true,
        'ever', (select count(*) from public.health_profiles h where private.profile_has_details(h)),
        'period', (select count(*) from public.health_profiles h where private.profile_has_details(h) and updated_at >= p_from and updated_at < p_to)),
      jsonb_build_object('key', 'record', 'label', 'Health records', 'source', 'table', 'measured', true,
        'ever', (select count(distinct user_id) from public.documents), 'period', (select count(distinct user_id) from public.documents where created_at >= p_from and created_at < p_to)),
      jsonb_build_object('key', 'file', 'label', 'Document upload', 'source', 'table', 'measured', true,
        'ever', (select count(distinct user_id) from public.document_files), 'period', (select count(distinct user_id) from public.document_files where created_at >= p_from and created_at < p_to)),
      jsonb_build_object('key', 'pdf', 'label', 'PDF reading', 'source', 'event', 'measured', ev_since is not null,
        'ever', (select count(distinct user_id) from private.analytics_events where name = 'document_processing_completed' and props->>'method' = 'pdf_text'),
        'period', (select count(distinct user_id) from private.analytics_events where name = 'document_processing_completed' and props->>'method' = 'pdf_text' and at >= p_from and at < p_to)),
      jsonb_build_object('key', 'schedule', 'label', 'Medicine schedules', 'source', 'table', 'measured', true,
        'ever', (select count(distinct user_id) from public.medication_schedules), 'period', (select count(distinct m.user_id) from public.medicines m join public.medication_schedules s on s.medicine_id = m.id where m.created_at >= p_from and m.created_at < p_to)),
      jsonb_build_object('key', 'dose', 'label', 'Dose tracking', 'source', 'table', 'measured', true,
        'ever', (select count(distinct user_id) from public.dose_events where status in ('Taken','Skipped')), 'period', (select count(distinct user_id) from public.dose_events where status in ('Taken','Skipped') and recorded_at >= p_from and recorded_at < p_to)),
      jsonb_build_object('key', 'search', 'label', 'Search', 'source', 'event', 'measured', ev_since is not null,
        'ever', (select count(distinct user_id) from private.analytics_events where name = 'search_performed'), 'period', (select count(distinct user_id) from private.analytics_events where name = 'search_performed' and at >= p_from and at < p_to)),
      jsonb_build_object('key', 'export', 'label', 'Record export', 'source', 'event', 'measured', ev_since is not null,
        'ever', (select count(distinct user_id) from private.analytics_events where name = 'record_exported'), 'period', (select count(distinct user_id) from private.analytics_events where name = 'record_exported' and at >= p_from and at < p_to))));
end $$;

-- Cumulative adopters per week (IST weeks) for the table-backed features, last p_weeks weeks.
create or replace function public.admin_adoption_trend(p_actor uuid, p_weeks int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare w int := least(greatest(coalesce(p_weeks, 12), 2), 52);
begin
  perform private.require(p_actor, 'analytics.view');
  return coalesce((
    with weeks as (select (date_trunc('week', (now() at time zone 'Asia/Kolkata')) - make_interval(weeks => g))::date wk from generate_series(0, w - 1) g),
    firsts as (
      select 'record' k, user_id, min(created_at) f from public.documents group by user_id
      union all select 'file', user_id, min(created_at) from public.document_files group by user_id
      union all select 'schedule', m.user_id, min(m.created_at) from public.medicines m join public.medication_schedules s on s.medicine_id = m.id group by m.user_id
      union all select 'dose', user_id, min(recorded_at) from public.dose_events where status in ('Taken','Skipped') group by user_id
      union all select 'profile', user_id, min(updated_at) from public.health_profiles h where private.profile_has_details(h) group by user_id)
    select jsonb_agg(jsonb_build_object('week', wk,
      'accounts', (select count(*) from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null and private.day(created_at) < wk + 7),
      'record', (select count(*) from firsts where k = 'record' and private.day(f) < wk + 7),
      'file', (select count(*) from firsts where k = 'file' and private.day(f) < wk + 7),
      'schedule', (select count(*) from firsts where k = 'schedule' and private.day(f) < wk + 7),
      'dose', (select count(*) from firsts where k = 'dose' and private.day(f) < wk + 7),
      'profile', (select count(*) from firsts where k = 'profile' and private.day(f) < wk + 7)) order by wk) from weeks), '[]'::jsonb);
end $$;

-- ───────────────────────── people ─────────────────────────
drop function if exists public.admin_users(uuid, text, text, text, int, int);
create or replace function public.admin_users(p_actor uuid, p_q text, p_status text, p_sort text, p_page int, p_size int, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 25), 1), 100); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 25), 1), 100);
        q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform private.require(p_actor, 'users.view');
  return (with base as (
      select u.id, u.email, u.created_at, u.email_confirmed_at, u.last_sign_in_at,
             (u.banned_until is not null and u.banned_until > now()) as suspended, m.role as admin_role
      from auth.users u left join private.admin_members m on m.user_id = u.id and m.status = 'active'
      where coalesce(u.is_anonymous, false) = false and u.deleted_at is null
        and (q is null or u.email ilike '%' || replace(replace(q, '%', ''), '_', '\_') || '%' or u.id::text = q)
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
      'id', u.id, 'email', u.email, 'created_at', u.created_at, 'email_confirmed_at', u.email_confirmed_at,
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

-- ───────────────────────── documents (technical metadata only) ─────────────────────────
create or replace function public.admin_documents(p_actor uuid, p_from timestamptz, p_to timestamptz, p_page int, p_size int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 25), 1), 100); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 25), 1), 100);
        lim bigint := coalesce(((select value->>'storage_limit_bytes' from private.feature_flags where key = 'document_upload'))::bigint, 1073741824);
begin
  perform private.require(p_actor, 'documents.view');
  return (with ops as (
      select f.created_at at, left(md5('doctine:' || f.user_id::text), 10) account, f.content_type file_type, f.size_bytes bytes,
             'stored' upload_status, null::text processing_status, null::text error_code, null::int ms
      from public.document_files f where f.created_at >= p_from and f.created_at < p_to
      union all
      select e.at, left(md5('doctine:' || coalesce(e.user_id::text, '')), 10), e.props->>'kind', (e.props->>'bytes')::bigint,
             case e.name when 'document_upload_failed' then 'failed' when 'document_upload_completed' then 'completed' end,
             case e.name when 'document_processing_completed' then 'read' when 'document_processing_failed' then 'failed' end,
             e.props->>'reason', (e.props->>'ms')::int
      from private.analytics_events e where e.name in ('document_upload_failed', 'document_processing_completed', 'document_processing_failed') and e.at >= p_from and e.at < p_to)
    select jsonb_build_object(
    'summary', jsonb_build_object(
      'records', (select count(*) from public.documents where created_at >= p_from and created_at < p_to),
      'records_total', (select count(*) from public.documents),
      'by_source', coalesce((select jsonb_object_agg(source, n) from (select source, count(*) n from public.documents where created_at >= p_from and created_at < p_to group by source) s), '{}'::jsonb),
      'by_category', coalesce((select jsonb_object_agg(category, n) from (select category, count(*) n from public.documents where created_at >= p_from and created_at < p_to group by category) s), '{}'::jsonb),
      'by_category_total', coalesce((select jsonb_object_agg(category, n) from (select category, count(*) n from public.documents group by category) s), '{}'::jsonb),
      'files', (select count(*) from public.document_files where created_at >= p_from and created_at < p_to),
      'files_total', (select count(*) from public.document_files),
      'by_type', coalesce((select jsonb_object_agg(content_type, n) from (select content_type, count(*) n from public.document_files where created_at >= p_from and created_at < p_to group by content_type) s), '{}'::jsonb),
      'by_type_total', coalesce((select jsonb_object_agg(content_type, n) from (select content_type, count(*) n from public.document_files group by content_type) s), '{}'::jsonb),
      'bytes', (select coalesce(sum(size_bytes), 0) from public.document_files where created_at >= p_from and created_at < p_to),
      'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'health-documents'),
      'storage_limit', lim,
      'upload_completed', (select count(*) from private.analytics_events where name = 'document_upload_completed' and at >= p_from and at < p_to),
      'upload_failed', (select count(*) from private.analytics_events where name = 'document_upload_failed' and at >= p_from and at < p_to),
      'failure_reasons', coalesce((select jsonb_object_agg(r, n) from (select coalesce(props->>'reason', 'unknown') r, count(*) n from private.analytics_events where name = 'document_upload_failed' and at >= p_from and at < p_to group by 1) s), '{}'::jsonb),
      'processing_completed', (select count(*) from private.analytics_events where name = 'document_processing_completed' and at >= p_from and at < p_to),
      'processing_failed', (select count(*) from private.analytics_events where name = 'document_processing_failed' and at >= p_from and at < p_to),
      'pdf_completed', (select count(*) from private.analytics_events where name = 'document_processing_completed' and props->>'method' = 'pdf_text' and at >= p_from and at < p_to),
      'pdf_failed', (select count(*) from private.analytics_events where name = 'document_processing_failed' and props->>'kind' = 'pdf' and at >= p_from and at < p_to),
      'processing_reasons', coalesce((select jsonb_object_agg(r, n) from (select coalesce(props->>'reason', 'unknown') r, count(*) n from private.analytics_events where name = 'document_processing_failed' and at >= p_from and at < p_to group by 1) s), '{}'::jsonb),
      'processing_ms_avg', (select round(avg((props->>'ms')::numeric)) from private.analytics_events where name = 'document_processing_completed' and props ? 'ms' and at >= p_from and at < p_to),
      'events_since', (select min(at) from private.analytics_events)),
    'total', (select count(*) from ops),
    'rows', coalesce((select jsonb_agg(to_jsonb(o) order by o.at desc) from (select * from ops order by at desc limit size offset off) o), '[]'::jsonb)));
end $$;

-- ───────────────────────── errors ─────────────────────────
create or replace function private.error_category(p_source text, p_kind text, p_message text) returns text language sql immutable as $$
  select case
    when p_source = 'server' then 'server'
    when p_kind ~* '(network|fetch|abort|timeout)' or p_message ~* '(failed to fetch|network|load failed|timeout|offline)' then 'network'
    when p_message ~* '(chunk|loading script|script error|import)' then 'loading'
    when p_message ~* '(auth|session|jwt|sign)' then 'sign-in'
    when p_message ~* '(storage|upload|quota)' then 'storage'
    when p_kind ~* '(type|reference|range|syntax)error' then 'code'
    else 'other' end $$;

create or replace function public.report_error(p_source text, p_kind text, p_message text, p_location text, p_release text,
  p_stack text, p_route text, p_env text, p_request text) returns boolean
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare k text := left(regexp_replace(coalesce(nullif(trim(p_kind), ''), 'Error'), '[^A-Za-z0-9_.: -]', '', 'g'), 60);
        m text := private.clean_error_text(p_message, 200);
        l text := left(regexp_replace(private.clean_error_text(regexp_replace(coalesce(p_location, ''), '\?.*$', ''), 120), '^https?://[^/]+', ''), 120);
        st text := left(regexp_replace(private.clean_error_text(regexp_replace(coalesce(p_stack, ''), '\?[^\s):]*', '', 'g'), 1500), 'https?://[^/\s)]+', '', 'g'), 1000);
        fp text;
begin
  if p_source not in ('client', 'server') then raise exception 'invalid source' using errcode = '22023'; end if;
  fp := md5(p_source || '|' || k || '|' || m || '|' || l);
  insert into private.error_groups (fingerprint, source, kind, message, location, release, category, sample_stack, route, environment, last_request_id)
  values (fp, p_source, k, coalesce(nullif(m, ''), '(no message)'), nullif(l, ''), left(regexp_replace(coalesce(p_release, ''), '[^a-f0-9]', '', 'g'), 40),
          private.error_category(p_source, k, m), nullif(st, ''), left(regexp_replace(coalesce(p_route, ''), '[^A-Za-z0-9/#._ -]', '', 'g'), 80),
          left(regexp_replace(coalesce(p_env, ''), '[^a-z]', '', 'g'), 20), left(regexp_replace(coalesce(p_request, ''), '[^A-Za-z0-9-]', '', 'g'), 64))
  on conflict (fingerprint) do update set count = private.error_groups.count + 1, last_seen = now(),
    release = coalesce(nullif(excluded.release, ''), private.error_groups.release),
    sample_stack = coalesce(excluded.sample_stack, private.error_groups.sample_stack),
    route = coalesce(nullif(excluded.route, ''), private.error_groups.route),
    environment = coalesce(nullif(excluded.environment, ''), private.error_groups.environment),
    last_request_id = coalesce(nullif(excluded.last_request_id, ''), private.error_groups.last_request_id),
    category = coalesce(private.error_groups.category, excluded.category),
    status = case when private.error_groups.status = 'resolved' then 'open' else private.error_groups.status end;
  insert into private.error_hits (fingerprint, hour, n) values (fp, date_trunc('hour', now()), 1)
  on conflict (fingerprint, hour) do update set n = private.error_hits.n + 1;
  if random() < 0.01 then
    delete from private.error_hits where hour < now() - interval '90 days';
    delete from private.error_groups where last_seen < now() - interval '180 days';
  end if;
  return true;
end $$;
update private.error_groups set category = private.error_category(source, kind, message) where category is null;

create or replace function public.admin_errors(p_actor uuid, p_status text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'health.view');
  return jsonb_build_object(
    'last_24h', (select coalesce(sum(n), 0) from private.error_hits where hour >= now() - interval '24 hours'),
    'last_7d', (select coalesce(sum(n), 0) from private.error_hits where hour >= now() - interval '7 days'),
    'last_30d', (select coalesce(sum(n), 0) from private.error_hits where hour >= now() - interval '30 days'),
    'open', (select count(*) from private.error_groups where status = 'open'),
    'hourly', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'n', coalesce(x.n, 0)) order by h)
       from generate_series(date_trunc('hour', now()) - interval '47 hours', date_trunc('hour', now()), interval '1 hour') h
       left join (select hour, sum(n) n from private.error_hits where hour >= now() - interval '48 hours' group by hour) x on x.hour = h), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'n', coalesce(x.n, 0)) order by d)
       from generate_series(private.day(now()) - 29, private.day(now()), interval '1 day') d
       left join (select private.day(hour) as day, sum(n) n from private.error_hits where hour >= now() - interval '31 days' group by 1) x on x.day = d::date), '[]'::jsonb),
    'by_category', coalesce((select jsonb_object_agg(coalesce(category, 'other'), n) from (select category, sum(count) n from private.error_groups group by 1) c), '{}'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(g) - 'updated_by' - 'sample_stack' || jsonb_build_object(
         'last_24h', (select coalesce(sum(n), 0) from private.error_hits e where e.fingerprint = g.fingerprint and e.hour >= now() - interval '24 hours'),
         'last_7d', (select coalesce(sum(n), 0) from private.error_hits e where e.fingerprint = g.fingerprint and e.hour >= now() - interval '7 days'),
         'last_30d', (select coalesce(sum(n), 0) from private.error_hits e where e.fingerprint = g.fingerprint and e.hour >= now() - interval '30 days'))
       order by g.last_seen desc) from (select * from private.error_groups where (coalesce(p_status, '') = '' or status = p_status) order by last_seen desc limit 200) g), '[]'::jsonb),
    'since', (select min(first_seen) from private.error_groups));
end $$;

create or replace function public.admin_error(p_actor uuid, p_fp text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'health.view');
  return (select to_jsonb(g) - 'updated_by' || jsonb_build_object(
      'updated_by_email', (select email from auth.users where id = g.updated_by),
      'hourly', coalesce((select jsonb_agg(jsonb_build_object('hour', hour, 'n', n) order by hour) from private.error_hits e where e.fingerprint = g.fingerprint and e.hour >= now() - interval '7 days'), '[]'::jsonb),
      'history', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'by', (select email from auth.users where id = l.actor)) order by l.at desc)
         from private.admin_audit_log l where l.target_type = 'error' and l.target_id = g.fingerprint), '[]'::jsonb))
    from private.error_groups g where g.fingerprint = p_fp);
end $$;

-- ───────────────────────── uptime (with the AI provider) ─────────────────────────
create or replace function public.record_uptime(p_rows jsonb) returns boolean
language plpgsql security definer set search_path = pg_catalog, private, public as $$
begin
  if exists (select 1 from private.uptime_checks where at > now() - interval '4 minutes') then return false; end if;
  insert into private.uptime_checks (target, ok, status, ms, error)
  select x->>'target', (x->>'ok')::boolean, nullif(x->>'status', '')::int, least(greatest((x->>'ms')::int, 0), 600000), left(regexp_replace(coalesce(x->>'error', ''), '[^a-z_]', '', 'g'), 60)
  from jsonb_array_elements(p_rows) x where x->>'target' in ('app', 'database', 'auth', 'storage', 'ai');
  if random() < 0.02 then delete from private.uptime_checks where at < now() - interval '90 days'; end if;
  return true;
end $$;

create or replace function public.admin_uptime(p_actor uuid, p_days int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare d int := least(greatest(coalesce(p_days, 7), 1), 90); bucket int := case when least(greatest(coalesce(p_days, 7), 1), 90) > 2 then 6 else 1 end;
begin
  perform private.require(p_actor, 'health.view');
  return jsonb_build_object(
    'days', d, 'bucket_hours', bucket,
    'since', (select min(at) from private.uptime_checks),
    'last_round', (select max(at) from private.uptime_checks),
    'rounds_24h', (select count(distinct at) from private.uptime_checks where at >= now() - interval '24 hours'),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'target', target, 'ok', ok, 'status', status, 'ms', ms, 'error', error) order by at desc, target)
       from (select * from private.uptime_checks where at >= (select max(at) from private.uptime_checks) - interval '3 hours' order by at desc limit 60) r), '[]'::jsonb),
    'targets', coalesce((select jsonb_agg(jsonb_build_object(
        'target', t,
        'checks', (select count(*) from private.uptime_checks where target = t and at >= now() - make_interval(days => d)),
        'ok', (select count(*) filter (where ok) from private.uptime_checks where target = t and at >= now() - make_interval(days => d)),
        'failures', (select count(*) filter (where not ok) from private.uptime_checks where target = t and at >= now() - make_interval(days => d)),
        'ok_24h', (select count(*) filter (where ok) from private.uptime_checks where target = t and at >= now() - interval '24 hours'),
        'checks_24h', (select count(*) from private.uptime_checks where target = t and at >= now() - interval '24 hours'),
        'ms_p50', (select percentile_cont(0.5) within group (order by ms) from private.uptime_checks where target = t and ok and at >= now() - make_interval(days => d)),
        'ms_p95', (select percentile_cont(0.95) within group (order by ms) from private.uptime_checks where target = t and ok and at >= now() - make_interval(days => d)),
        'last', (select jsonb_build_object('at', at, 'ok', ok, 'status', status, 'ms', ms, 'error', error) from private.uptime_checks where target = t order by at desc limit 1),
        'last_ok', (select max(at) from private.uptime_checks where target = t and ok),
        'last_failure', (select jsonb_build_object('at', at, 'status', status, 'error', error) from private.uptime_checks where target = t and not ok order by at desc limit 1),
        'buckets', coalesce((select jsonb_agg(jsonb_build_object('at', b, 'checks', c, 'ok', o, 'ms', ms) order by b) from (
            select date_trunc('hour', at) - make_interval(hours => extract(hour from at)::int % bucket) as b,
                   count(*) c, count(*) filter (where ok) o, round(avg(ms) filter (where ok)) ms
            from private.uptime_checks where target = t and at >= now() - make_interval(days => d) group by 1) z), '[]'::jsonb)
      ) order by array_position(array['app', 'database', 'auth', 'storage', 'ai'], t)) from unnest(array['app', 'database', 'auth', 'storage', 'ai']) t), '[]'::jsonb));
end $$;

-- ───────────────────────── alerts ─────────────────────────
create or replace function private.raise_alert(p_rule text, p_sev text, p_msg text, p_measured jsonb, p_service text) returns int language plpgsql as $$
declare is_new boolean;
begin
  insert into private.admin_alerts (rule, severity, message, measured, service) values (p_rule, p_sev, p_msg, p_measured, p_service)
  on conflict (rule) where status <> 'resolved' do update set measured = excluded.measured, message = excluded.message, updated_at = now(), service = excluded.service,
    severity = case when excluded.severity = 'critical' then 'critical' else private.admin_alerts.severity end
  returning (xmax = 0) into is_new;
  return case when is_new then 1 else 0 end;
end $$;

create or replace function private.evaluate_alerts() returns int language plpgsql as $$
declare up_ok int; up_bad int; lf int; sf int; store bigint; cap bigint; errs bigint; cnt int := 0; t text; last_round timestamptz;
begin
  -- mutes expire
  update private.admin_alerts set status = 'open', muted_until = null, updated_at = now() where status = 'muted' and muted_until <= now();
  select count(*) filter (where name = 'document_upload_completed'), count(*) filter (where name = 'document_upload_failed'),
         count(*) filter (where name = 'login_failure' and at >= now() - interval '1 hour'), count(*) filter (where name = 'signup_failed')
    into up_ok, up_bad, lf, sf from private.analytics_events where at >= now() - interval '24 hours';
  if up_ok + up_bad >= 5 and up_bad::numeric / (up_ok + up_bad) >= 0.2 then
    cnt := cnt + private.raise_alert('upload_failure_rate', 'warning', format('%s of %s uploads failed in the last 24 hours', up_bad, up_ok + up_bad), jsonb_build_object('failed', up_bad, 'completed', up_ok), 'storage');
  end if;
  if lf >= 30 then cnt := cnt + private.raise_alert('login_failures', 'warning', format('%s failed sign-ins in the last hour', lf), jsonb_build_object('failures_1h', lf), 'auth'); end if;
  if sf >= 10 then cnt := cnt + private.raise_alert('signup_failures', 'warning', format('%s account creations failed in the last 24 hours', sf), jsonb_build_object('failures_24h', sf), 'auth'); end if;
  store := (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'health-documents');
  cap := coalesce(((select value->>'storage_limit_bytes' from private.feature_flags where key = 'document_upload'))::bigint, 1073741824);
  if store >= cap * 0.8 then
    cnt := cnt + private.raise_alert('storage_near_limit', case when store >= cap * 0.95 then 'critical' else 'warning' end,
      format('Document storage is at %s%% of %s MB', round(store * 100.0 / cap), cap / 1048576), jsonb_build_object('bytes', store, 'limit', cap), 'storage');
  end if;
  errs := (select coalesce(sum(h.n), 0) from private.error_hits h where h.hour >= date_trunc('hour', now()) - interval '1 hour');
  if errs >= 25 then cnt := cnt + private.raise_alert('error_spike', 'warning', format('%s errors reported in the last hour or so', errs), jsonb_build_object('errors', errs), 'app'); end if;
  foreach t in array array['app', 'database', 'auth', 'storage', 'ai'] loop
    if (select count(*) = 2 and bool_and(not ok) from (select ok from private.uptime_checks where target = t order by at desc limit 2) z) then
      cnt := cnt + private.raise_alert('down_' || t, case when t = 'ai' then 'warning' else 'critical' end,
        case when t = 'ai' then 'The AI provider failed its last two checks' else format('%s failed its last two checks', initcap(t)) end,
        (select jsonb_build_object('status', status, 'at', at, 'error', error) from private.uptime_checks where target = t order by at desc limit 1), t);
    end if;
  end loop;
  -- the scheduled monitoring itself: rounds stopped (only once monitoring has ever run in the last week)
  last_round := (select max(at) from private.uptime_checks);
  if last_round is not null and last_round > now() - interval '7 days' and last_round < now() - interval '45 minutes' then
    cnt := cnt + private.raise_alert('monitor_stale', 'warning', format('No scheduled health check has run since %s', to_char(last_round at time zone 'Asia/Kolkata', 'DD Mon HH24:MI "IST"')),
      jsonb_build_object('last_round', last_round), 'monitoring');
  end if;
  return cnt;
end $$;

create or replace function public.admin_alert_update(p_actor uuid, p_id uuid, p_status text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old text;
begin
  r := private.require(p_actor, 'alerts.manage');
  if p_status not in ('open', 'acknowledged', 'muted', 'resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  select status into old from private.admin_alerts where id = p_id for update;
  if old is null then raise exception 'no such alert' using errcode = 'P0002'; end if;
  update private.admin_alerts set status = p_status, updated_at = now(), updated_by = p_actor,
    muted_until = case when p_status = 'muted' then now() + interval '24 hours' end where id = p_id;
  perform private.audit(p_actor, r, 'alert.' || p_status, 'alert', p_id::text, null, jsonb_build_object('status', old), jsonb_build_object('status', p_status), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- Who should be emailed: admins who opted in, with their minimum severity.
create or replace function public.monitor_run() returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare opened int := private.evaluate_alerts();
begin
  return jsonb_build_object('opened', opened,
    'open', (select count(*) from private.admin_alerts where status = 'open'),
    'to_notify', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'severity', severity, 'message', message, 'service', service, 'opened_at', opened_at) order by opened_at)
       from private.admin_alerts where status = 'open' and notified_at is null), '[]'::jsonb),
    'recipients', coalesce((select jsonb_agg(jsonb_build_object('email', u.email, 'min_severity', p.min_severity))
       from private.admin_prefs p join private.admin_members m on m.user_id = p.user_id and m.status = 'active' join auth.users u on u.id = p.user_id
       where p.email_alerts and private.can(p.user_id, 'health.view')), '[]'::jsonb));
end $$;

-- ───────────────────────── incidents ─────────────────────────
create or replace function public.admin_incidents(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'health.view');
  return coalesce((select jsonb_agg(to_jsonb(i) - 'created_by' || jsonb_build_object(
      'created_by_email', (select email from auth.users where id = i.created_by),
      'assigned_email', (select email from auth.users where id = i.assigned_to),
      'timeline', coalesce((select jsonb_agg(jsonb_build_object('at', x.at, 'status', x.status, 'severity', x.severity, 'note', x.note, 'by', (select email from auth.users where id = x.actor)) order by x.at)
         from private.incident_updates x where x.incident_id = i.id), '[]'::jsonb))
    order by (i.status = 'resolved'), i.started_at desc) from private.incidents i), '[]'::jsonb);
end $$;

create or replace function public.admin_incident_save(p_actor uuid, p_data jsonb, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; iid uuid := nullif(p_data->>'id', '')::uuid; old jsonb; st text := coalesce(p_data->>'status', 'investigating');
        sev text := coalesce(nullif(p_data->>'severity', ''), 'minor'); assignee uuid;
begin
  r := private.require(p_actor, 'incidents.manage');
  if st not in ('investigating', 'degraded', 'operational', 'resolved') or sev not in ('critical', 'major', 'minor') then raise exception 'invalid status' using errcode = '22023'; end if;
  if nullif(p_data->>'assigned_email', '') is not null then
    select m.user_id into assignee from private.admin_members m join auth.users u on u.id = m.user_id where lower(u.email) = lower(p_data->>'assigned_email') and m.status = 'active';
    if assignee is null then raise exception 'assignee must be an active admin' using errcode = '22023'; end if;
  end if;
  if iid is null then
    insert into private.incidents (title, status, severity, impact, notes, created_by, assigned_to, resolved_at)
    values (trim(p_data->>'title'), st, sev, p_data->>'impact', p_data->>'notes', p_actor, assignee, case when st = 'resolved' then now() end) returning id into iid;
  else
    select to_jsonb(i) into old from private.incidents i where id = iid for update;
    if old is null then raise exception 'no such incident' using errcode = 'P0002'; end if;
    update private.incidents set title = coalesce(trim(p_data->>'title'), title), status = st, severity = sev, impact = coalesce(p_data->>'impact', impact),
      notes = coalesce(p_data->>'notes', notes), assigned_to = case when p_data ? 'assigned_email' then assignee else assigned_to end, updated_at = now(),
      resolved_at = case when st = 'resolved' then coalesce(resolved_at, now()) else null end where id = iid;
  end if;
  insert into private.incident_updates (incident_id, actor, status, severity, note)
  values (iid, p_actor, st, sev, left(coalesce(nullif(trim(p_data->>'update_note'), ''), case when old is null then 'Incident opened' else 'Updated' end), 2000));
  perform private.audit(p_actor, r, 'incident.' || case when old is null then 'open' else 'update' end, 'incident', iid::text, null,
    old - 'created_by', (select to_jsonb(i) - 'created_by' from private.incidents i where id = iid), 'ok', p_request);
  return jsonb_build_object('ok', true, 'id', iid);
end $$;

-- ───────────────────────── team (new roles) ─────────────────────────
create or replace function public.admin_team_set(p_actor uuid, p_email text, p_role text, p_status text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; target uuid; old jsonb;
begin
  r := private.require(p_actor, 'team.manage');
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = '22023'; end if;
  select id into target from auth.users where lower(email) = lower(trim(p_email)) and deleted_at is null;
  if target is null then return jsonb_build_object('ok', false, 'error', 'no_account'); end if;
  if target = p_actor then
    perform private.audit(p_actor, r, 'team.set', 'user', target::text, p_reason, null, null, 'denied', p_request);
    return jsonb_build_object('ok', false, 'error', 'not_on_yourself');
  end if;
  select to_jsonb(m) - 'added_by' into old from private.admin_members m where user_id = target for update;
  if p_status = 'removed' then
    delete from private.admin_members where user_id = target;
  else
    if p_role not in ('owner', 'admin', 'analyst', 'support', 'auditor') or coalesce(p_status, 'active') not in ('active', 'suspended') then
      raise exception 'invalid role or status' using errcode = '22023';
    end if;
    insert into private.admin_members (user_id, role, status, added_by) values (target, p_role, coalesce(p_status, 'active'), p_actor)
    on conflict (user_id) do update set role = excluded.role, status = excluded.status, updated_at = now();
  end if;
  if not exists (select 1 from private.admin_members where role = 'owner' and status = 'active') then
    raise exception 'there must always be an active owner' using errcode = '42501';
  end if;
  perform private.audit(p_actor, r, case when old is null then 'team.add' when p_status = 'removed' then 'team.remove' else 'team.change' end,
    'user', target::text, p_reason, old, (select to_jsonb(m) - 'added_by' from private.admin_members m where user_id = target), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_team(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'team.view');
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role, 'status', m.status,
      'added_at', m.created_at, 'updated_at', m.updated_at, 'last_sign_in_at', u.last_sign_in_at, 'added_by', (select email from auth.users where id = m.added_by),
      'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified'),
      'last_admin_action', (select max(at) from private.admin_audit_log l where l.actor = m.user_id and l.outcome <> 'denied')) order by array_position(array['owner','admin','analyst','support','auditor'], m.role), u.email)
    from private.admin_members m join auth.users u on u.id = m.user_id), '[]'::jsonb);
end $$;

-- ───────────────────────── preferences, activity, search, report history ─────────────────────────
create or replace function public.admin_prefs(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'dashboard.view');
  return coalesce((select jsonb_build_object('email_alerts', email_alerts, 'min_severity', min_severity, 'updated_at', updated_at) from private.admin_prefs where user_id = p_actor),
                  jsonb_build_object('email_alerts', false, 'min_severity', 'warning'));
end $$;

create or replace function public.admin_set_prefs(p_actor uuid, p_email_alerts boolean, p_min_severity text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text := private.require(p_actor, 'dashboard.view');
begin
  if p_min_severity not in ('info', 'warning', 'critical') then raise exception 'invalid severity' using errcode = '22023'; end if;
  if p_email_alerts and not private.can(p_actor, 'health.view') then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into private.admin_prefs (user_id, email_alerts, min_severity) values (p_actor, p_email_alerts, p_min_severity)
  on conflict (user_id) do update set email_alerts = excluded.email_alerts, min_severity = excluded.min_severity, updated_at = now();
  perform private.audit(p_actor, r, 'prefs.set', 'user', p_actor::text, null, null, jsonb_build_object('email_alerts', p_email_alerts, 'min_severity', p_min_severity), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- Recent activity for the dashboard; each part only for roles that may see it (null otherwise).
create or replace function public.admin_activity(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'dashboard.view');
  return jsonb_build_object(
    'registrations', case when private.can(p_actor, 'users.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'email', email, 'at', created_at, 'confirmed', email_confirmed_at is not null) order by created_at desc)
        from (select * from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null order by created_at desc limit 6) u), '[]'::jsonb) end,
    'registrations_7d', (select count(*) from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null and created_at >= now() - interval '7 days'),
    'errors', case when private.can(p_actor, 'health.view') then coalesce((select jsonb_agg(jsonb_build_object('fingerprint', fingerprint, 'kind', kind, 'message', message, 'last_seen', last_seen, 'count', count, 'source', source) order by last_seen desc)
        from (select * from private.error_groups where status = 'open' order by last_seen desc limit 5) e), '[]'::jsonb) end,
    'checks', case when private.can(p_actor, 'health.view') then coalesce((select jsonb_agg(jsonb_build_object('target', target, 'ok', ok, 'ms', ms, 'at', at, 'status', status) order by target)
        from private.uptime_checks where at = (select max(at) from private.uptime_checks)), '[]'::jsonb) end,
    'admin_actions', case when private.can(p_actor, 'audit.view') then coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'outcome', l.outcome, 'target_type', l.target_type, 'by', (select email from auth.users where id = l.actor)) order by l.at desc)
        from (select * from private.admin_audit_log order by at desc limit 6) l), '[]'::jsonb) end,
    'incidents', case when private.can(p_actor, 'health.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'status', status, 'severity', severity, 'started_at', started_at) order by started_at desc)
        from private.incidents where status <> 'resolved'), '[]'::jsonb) end,
    'alerts', case when private.can(p_actor, 'health.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'severity', severity, 'message', message, 'service', service, 'status', status, 'opened_at', opened_at) order by opened_at desc)
        from private.admin_alerts where status in ('open', 'acknowledged')), '[]'::jsonb) end);
end $$;

-- Quick search across what the role may see.
create or replace function public.admin_search(p_actor uuid, p_q text) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform private.require(p_actor, 'dashboard.view');
  if q is null or char_length(q) < 2 then return jsonb_build_object('users', '[]'::jsonb, 'errors', '[]'::jsonb, 'incidents', '[]'::jsonb); end if;
  q := replace(replace(q, '%', ''), '_', '\_');
  return jsonb_build_object(
    'users', case when private.can(p_actor, 'users.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'email', email))
        from (select id, email from auth.users where deleted_at is null and (email ilike '%' || q || '%' or id::text = p_q) order by created_at desc limit 6) u), '[]'::jsonb) else '[]'::jsonb end,
    'errors', case when private.can(p_actor, 'health.view') then coalesce((select jsonb_agg(jsonb_build_object('fingerprint', fingerprint, 'kind', kind, 'message', message))
        from (select * from private.error_groups where message ilike '%' || q || '%' or kind ilike '%' || q || '%' or location ilike '%' || q || '%' order by last_seen desc limit 5) e), '[]'::jsonb) else '[]'::jsonb end,
    'incidents', case when private.can(p_actor, 'health.view') then coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'status', status))
        from (select * from private.incidents where title ilike '%' || q || '%' order by started_at desc limit 5) i), '[]'::jsonb) else '[]'::jsonb end);
end $$;

create or replace function public.admin_exports(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'reports.export');
  return coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'report', coalesce(l.after->>'report', l.target_id), 'format', coalesce(l.after->>'format', case when l.target_id = 'pdf' then 'pdf' else 'csv' end),
      'from', l.after->>'from', 'to', l.after->>'to', 'outcome', l.outcome, 'by', (select email from auth.users where id = l.actor)) order by l.at desc)
    from (select * from private.admin_audit_log where action = 'report.export' and outcome in ('ok', 'failed') order by at desc limit 50) l), '[]'::jsonb);
end $$;

-- ───────────────────────── privileges ─────────────────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'admin\_%' or p.proname in ('record_event', 'public_settings', 'report_error', 'record_uptime', 'monitor_run', 'monitor_mark_notified')) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relkind = 'r' loop
    execute format('alter table private.%I enable row level security', t.relname);
  end loop;
end $$;
