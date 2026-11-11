-- Doctine · internal admin console (app.doctine.com/admin).
--
-- Design
--   * Admin data lives in the `private` schema, which the public Data API does not expose: no browser can reach it.
--   * Every admin read and write is a function in `public` that only the server's privileged role (service_role) may run.
--     Each one first checks the acting person's role and permission (private.require) and writes the audit log in the same
--     transaction, so a bug in the web server cannot skip a check or an audit entry.
--   * The audit log is append-only: a trigger refuses UPDATE, DELETE and TRUNCATE for everyone, the server included.
--   * No function here returns health information: no titles, values, prescriptions, messages or extracted text.
--   * Additive and safe to re-run: new schema objects, new indexes, and one replaced storage policy (uploads also obey the
--     "document_upload" switch and maintenance mode). No existing table or row is changed or removed.
--
-- Review before applying to production. Then provision the first owner with docs/ADMIN_CONSOLE.md → "First owner".

create schema if not exists private;
revoke all on schema private from public;

-- ───────────────────────── roles and permissions ─────────────────────────
create table if not exists private.admin_members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'super_admin', 'operations', 'analyst', 'support', 'developer')),
  status     text not null default 'active' check (status in ('active', 'suspended')),
  added_by   uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The one place permissions are defined. The web console reads it to show the right menus (cosmetic only); every function
-- below enforces it.
create or replace function private.role_perms(p_role text) returns text[] language sql immutable as $$
  select case p_role
    when 'owner' then array['dashboard.view','analytics.view','reports.export','users.view','users.suspend','users.reset_password','users.notes',
      'documents.view','health.view','incidents.manage','alerts.manage','flags.view','flags.manage','maintenance.manage','announcements.manage',
      'team.view','team.manage','audit.view','security.view']
    when 'super_admin' then array['dashboard.view','analytics.view','reports.export','users.view','users.suspend','users.reset_password','users.notes',
      'documents.view','health.view','incidents.manage','alerts.manage','flags.view','flags.manage','maintenance.manage','announcements.manage',
      'team.view','audit.view','security.view']
    when 'operations' then array['dashboard.view','analytics.view','reports.export','users.view','users.suspend','users.reset_password','users.notes',
      'documents.view','health.view','incidents.manage','alerts.manage','flags.view','announcements.manage']
    when 'analyst' then array['dashboard.view','analytics.view','reports.export','documents.view','health.view']
    when 'support' then array['dashboard.view','users.view','users.reset_password','users.notes','documents.view','health.view']
    when 'developer' then array['dashboard.view','analytics.view','documents.view','health.view','incidents.manage','alerts.manage','flags.view','security.view']
    else array[]::text[] end $$;

create or replace function private.actor_role(p_actor uuid) returns text language sql stable as $$
  select m.role from private.admin_members m join auth.users u on u.id = m.user_id
  where m.user_id = p_actor and m.status = 'active' and (u.banned_until is null or u.banned_until < now()) $$;

-- Raises "forbidden" (SQLSTATE 42501) unless p_actor is an active admin holding p_perm. Returns the role.
create or replace function private.require(p_actor uuid, p_perm text) returns text language plpgsql stable as $$
declare r text := private.actor_role(p_actor);
begin
  if r is null or not (p_perm = any (private.role_perms(r))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return r;
end $$;

-- ───────────────────────── audit log (append-only) ─────────────────────────
create table if not exists private.admin_audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_role  text,
  action      text not null check (char_length(action) <= 64),
  target_type text check (char_length(target_type) <= 32),
  target_id   text check (char_length(target_id) <= 80),
  reason      text check (char_length(reason) <= 500),
  before      jsonb,
  after       jsonb,
  outcome     text not null default 'ok' check (outcome in ('ok', 'denied', 'failed', 'requested')),
  request_id  text check (char_length(request_id) <= 64)
);
create index if not exists admin_audit_at_idx on private.admin_audit_log (at desc);
create index if not exists admin_audit_actor_idx on private.admin_audit_log (actor, at desc);
create index if not exists admin_audit_action_idx on private.admin_audit_log (action, at desc);

create or replace function private.audit_is_append_only() returns trigger language plpgsql as $$
begin raise exception 'the admin audit log cannot be changed or deleted' using errcode = '42501'; end $$;
drop trigger if exists admin_audit_no_change on private.admin_audit_log;
create trigger admin_audit_no_change before update or delete on private.admin_audit_log for each row execute function private.audit_is_append_only();
drop trigger if exists admin_audit_no_truncate on private.admin_audit_log;
create trigger admin_audit_no_truncate before truncate on private.admin_audit_log for each statement execute function private.audit_is_append_only();

create or replace function private.audit(p_actor uuid, p_role text, p_action text, p_target_type text, p_target_id text, p_reason text,
  p_before jsonb, p_after jsonb, p_outcome text, p_request text) returns bigint language sql as $$
  insert into private.admin_audit_log (actor, actor_role, action, target_type, target_id, reason, before, after, outcome, request_id)
  values (p_actor, p_role, left(p_action, 64), left(p_target_type, 32), left(p_target_id, 80), left(nullif(trim(p_reason), ''), 500),
          p_before, p_after, coalesce(p_outcome, 'ok'), left(p_request, 64))
  returning id $$;

-- ───────────────────────── product analytics (first-party, minimal) ─────────────────────────
-- Event names and their allowed properties are fixed here; anything else is refused. Properties are short codes and
-- numbers only — never document text, values, names, messages or anything a person typed.
create table if not exists private.analytics_events (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid references auth.users (id) on delete cascade,
  name       text not null,
  props      jsonb not null default '{}'::jsonb check (pg_column_size(props) <= 512),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 80)
);
-- Retries and repeated page loads collapse onto one row: one row per (event, person or anonymous, dedupe key).
create unique index if not exists analytics_events_dedupe on private.analytics_events (name, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), dedupe_key);
create index if not exists analytics_events_at on private.analytics_events (at desc);
create index if not exists analytics_events_user_at on private.analytics_events (user_id, at desc);

create or replace function private.event_props_ok(p_name text, p_props jsonb) returns boolean language sql immutable as $$
  select jsonb_typeof(coalesce(p_props, '{}'::jsonb)) = 'object'
     and not exists (
       select 1 from jsonb_each(coalesce(p_props, '{}'::jsonb)) e
       where not (e.key = any (case p_name
               when 'document_upload_completed' then array['kind','pages','bytes','ms']
               when 'document_upload_failed' then array['kind','reason']
               when 'document_processing_completed' then array['kind','ms','method']
               when 'document_processing_failed' then array['kind','reason','method']
               when 'login_failure' then array['reason','method']
               when 'signup_failed' then array['reason']
               when 'app_error' then array['where','code']
               when 'search_performed' then array['scope']
               when 'record_exported' then array['format']
               else array[]::text[] end))
          or not (jsonb_typeof(e.value) = 'number' or (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' ~ '^[a-z0-9_.-]{1,40}$'))) $$;

create or replace function public.record_event(p_user uuid, p_name text, p_props jsonb, p_dedupe text) returns boolean
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare n int;
begin
  if p_name not in ('account_created','email_verified','login_success','login_failure','signup_failed','profile_saved',
                    'document_upload_completed','document_upload_failed','document_processing_completed','document_processing_failed',
                    'medicine_schedule_created','medicine_marked_taken','medicine_marked_skipped','search_performed','record_exported','app_error')
     or p_dedupe is null or p_dedupe !~ '^[A-Za-z0-9_.:-]{1,80}$' or not private.event_props_ok(p_name, p_props) then
    raise exception 'invalid event' using errcode = '22023';
  end if;
  insert into private.analytics_events (user_id, name, props, dedupe_key) values (p_user, p_name, coalesce(p_props, '{}'::jsonb), p_dedupe)
  on conflict do nothing;
  get diagnostics n = row_count;
  if random() < 0.002 then delete from private.analytics_events where at < now() - interval '400 days'; end if; -- retention: about 13 months
  return n > 0;
end $$;

-- ───────────────────────── switches, maintenance, announcements ─────────────────────────
create table if not exists private.feature_flags (
  key        text primary key check (key in ('registrations','document_upload','pdf_reading','sample_data','ai_assistant','maintenance')),
  enabled    boolean not null,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into private.feature_flags (key, enabled) values
  ('registrations', true), ('document_upload', true), ('pdf_reading', true), ('sample_data', true), ('ai_assistant', false), ('maintenance', false)
on conflict (key) do nothing;

create table if not exists private.announcements (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('service', 'maintenance', 'product')),
  title        text not null check (char_length(title) between 1 and 120),
  body         text not null default '' check (char_length(body) <= 600),
  status       text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  starts_at    timestamptz,
  ends_at      timestamptz check (ends_at is null or starts_at is null or ends_at > starts_at),
  created_by   uuid,
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- What the app needs to know at start-up: the switches, maintenance and live announcements. Read by /api/config only.
create or replace function public.public_settings() returns jsonb language sql stable security definer set search_path = pg_catalog, private as $$
  select jsonb_build_object(
    'flags', coalesce((select jsonb_object_agg(key, enabled) from private.feature_flags where key <> 'maintenance'), '{}'::jsonb),
    'maintenance', coalesce((select jsonb_build_object('on', enabled, 'message', coalesce(value->>'message', '')) from private.feature_flags where key = 'maintenance'), '{"on":false}'::jsonb),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'body', body) order by starts_at nulls first, created_at)
       from private.announcements where status = 'published' and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())), '[]'::jsonb)) $$;

-- File uploads obey the document_upload switch and maintenance mode, in the database itself (the storage policy below).
create or replace function public.uploads_allowed() returns boolean language sql stable security definer set search_path = pg_catalog, private as $$
  select coalesce((select enabled from private.feature_flags where key = 'document_upload'), true)
     and not coalesce((select enabled from private.feature_flags where key = 'maintenance'), false) $$;
revoke all on function public.uploads_allowed() from public, anon;
grant execute on function public.uploads_allowed() to authenticated, service_role;

drop policy if exists "health-documents: owner uploads" on storage.objects;
create policy "health-documents: owner uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'health-documents' and (storage.foldername(name))[1] = auth.uid()::text and public.uploads_allowed());

-- ───────────────────────── operations: incidents, alerts, support notes ─────────────────────────
create table if not exists private.incidents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 160),
  status      text not null default 'investigating' check (status in ('investigating', 'degraded', 'operational', 'resolved')),
  impact      text check (char_length(impact) <= 600),
  notes       text check (char_length(notes) <= 2000),
  started_at  timestamptz not null default now(),
  resolved_at timestamptz,
  created_by  uuid,
  updated_at  timestamptz not null default now()
);
create table if not exists private.admin_alerts (
  id          uuid primary key default gen_random_uuid(),
  rule        text not null,
  severity    text not null check (severity in ('info', 'warning', 'critical')),
  message     text not null,
  measured    jsonb not null default '{}'::jsonb,
  status      text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  opened_at   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create unique index if not exists admin_alerts_one_open_per_rule on private.admin_alerts (rule) where status <> 'resolved';
create table if not exists private.support_notes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  author     uuid not null,
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

-- Indexes for the activity measures below (existing tables; additive only).
create index if not exists documents_created_idx on public.documents (created_at);
create index if not exists document_files_created_idx on public.document_files (created_at);
create index if not exists dose_events_recorded_idx on public.dose_events (recorded_at);
create index if not exists medicines_created_idx on public.medicines (created_at);
create index if not exists messages_created_idx on public.messages (created_at);

-- ───────────────────────── measures ─────────────────────────
-- "Qualifying activity": something the person did with their records — added or changed a record, uploaded a file,
-- recorded a dose, saved their profile, searched, exported or used the assistant. Signing in, opening pages and
-- refreshing are NOT activity. Days are calendar days in India Standard Time (Asia/Kolkata).
create or replace view private.activity as
  select user_id, created_at as at, 'record' as kind from public.documents
  union all select user_id, created_at, 'file' from public.document_files
  union all select user_id, recorded_at, 'dose' from public.dose_events
  union all select user_id, created_at, 'medicine' from public.medicines
  union all select user_id, updated_at, 'medicine' from public.medicines where updated_at > created_at + interval '5 seconds'
  union all select user_id, updated_at, 'profile' from public.health_profiles
  union all select user_id, created_at, 'assistant' from public.messages where role = 'user'
  union all select user_id, at, name from private.analytics_events where user_id is not null and name in ('search_performed','record_exported');

create or replace function private.day(t timestamptz) returns date language sql immutable as $$ select (t at time zone 'Asia/Kolkata')::date $$;

create or replace function public.admin_me(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare r text := private.actor_role(p_actor);
begin
  if r is null then return jsonb_build_object('role', null, 'perms', '[]'::jsonb); end if;
  return jsonb_build_object('role', r, 'perms', to_jsonb(private.role_perms(r)),
    'email', (select email from auth.users where id = p_actor));
end $$;

-- Overview for a period [p_from, p_to), with the same measures for the equal-length period just before it.
create or replace function public.admin_overview(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare len interval := p_to - p_from; pf timestamptz := p_from - (p_to - p_from); res jsonb;
begin
  perform private.require(p_actor, 'dashboard.view');
  if p_to <= p_from or len > interval '400 days' then raise exception 'invalid period' using errcode = '22023'; end if;
  with u as (select id, created_at, email_confirmed_at, last_sign_in_at from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null),
  a as (select user_id, at from private.activity),
  ev as (select name, at from private.analytics_events)
  select jsonb_build_object(
    'generated_at', now(), 'timezone', 'Asia/Kolkata',
    'period', jsonb_build_object('from', p_from, 'to', p_to), 'previous', jsonb_build_object('from', pf, 'to', p_from),
    'users_total', (select count(*) from u where created_at < p_to),
    'users_verified', (select count(*) from u where created_at < p_to and email_confirmed_at is not null),
    'users_new', (select count(*) from u where created_at >= p_from and created_at < p_to),
    'users_new_prev', (select count(*) from u where created_at >= pf and created_at < p_from),
    'new_today', (select count(*) from u where private.day(created_at) = private.day(now())),
    'new_7d', (select count(*) from u where created_at >= now() - interval '7 days'),
    'new_30d', (select count(*) from u where created_at >= now() - interval '30 days'),
    'dau', (select count(distinct user_id) from a where private.day(at) = private.day(now())),
    'wau', (select count(distinct user_id) from a where at >= now() - interval '7 days'),
    'mau', (select count(distinct user_id) from a where at >= now() - interval '30 days'),
    'active', (select count(distinct user_id) from a where at >= p_from and at < p_to),
    'active_prev', (select count(distinct user_id) from a where at >= pf and at < p_from),
    'returning', (select count(distinct x.user_id) from a x where x.at >= p_from and x.at < p_to and exists (select 1 from a y where y.user_id = x.user_id and y.at < p_from)),
    'signed_in', (select count(*) from u where last_sign_in_at >= p_from and last_sign_in_at < p_to),
    'documents_new', (select count(*) from public.documents where created_at >= p_from and created_at < p_to),
    'documents_new_prev', (select count(*) from public.documents where created_at >= pf and created_at < p_from),
    'documents_total', (select count(*) from public.documents where created_at < p_to),
    'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'health-documents'),
    'storage_files', (select count(*) from storage.objects where bucket_id = 'health-documents'),
    'uploads_failed', (select count(*) from ev where name = 'document_upload_failed' and at >= p_from and at < p_to),
    'login_failures', (select count(*) from ev where name = 'login_failure' and at >= p_from and at < p_to),
    'app_errors', (select count(*) from ev where name = 'app_error' and at >= p_from and at < p_to),
    'events_since', (select min(at) from private.analytics_events)
  ) into res;
  return res;
end $$;

-- Day by day (India time) over [p_from, p_to): total and new accounts, active people, records added, failed uploads.
create or replace function public.admin_series(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'analytics.view');
  if p_to <= p_from or p_to - p_from > interval '400 days' then raise exception 'invalid period' using errcode = '22023'; end if;
  return coalesce((
    with days as (select d::date as day from generate_series(private.day(p_from), private.day(p_to - interval '1 second'), interval '1 day') d),
    u as (select private.day(created_at) as day from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null),
    act as (select private.day(at) as day, user_id from private.activity)
    select jsonb_agg(jsonb_build_object(
      'day', d.day,
      'users_total', (select count(*) from u where u.day <= d.day),
      'users_new', (select count(*) from u where u.day = d.day),
      'dau', (select count(distinct user_id) from act where act.day = d.day),
      'wau', (select count(distinct user_id) from act where act.day between d.day - 6 and d.day),
      'mau', (select count(distinct user_id) from act where act.day between d.day - 29 and d.day),
      'documents', (select count(*) from public.documents where private.day(created_at) = d.day),
      'uploads_failed', (select count(*) from private.analytics_events where name = 'document_upload_failed' and private.day(at) = d.day),
      'processing_failed', (select count(*) from private.analytics_events where name = 'document_processing_failed' and private.day(at) = d.day),
      'login_failures', (select count(*) from private.analytics_events where name = 'login_failure' and private.day(at) = d.day),
      'app_errors', (select count(*) from private.analytics_events where name = 'app_error' and private.day(at) = d.day)
    ) order by d.day) from days d), '[]'::jsonb);
end $$;

-- Weekly sign-up cohorts: of the people who joined in each week, how many had qualifying activity 1, 7 and 30 days later
-- (activity on day N or any day after it, within 7 days). Cohorts too young to measure are null, not zero.
create or replace function public.admin_retention(p_actor uuid, p_weeks int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'analytics.view');
  return coalesce((
    with u as (select id, created_at from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null
               and created_at >= date_trunc('week', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' - make_interval(weeks => least(greatest(p_weeks, 1), 26) - 1)),
    c as (select date_trunc('week', created_at at time zone 'Asia/Kolkata')::date as week, id, created_at from u),
    r as (select c.week, c.id, c.created_at,
            exists (select 1 from private.activity a where a.user_id = c.id and a.at >= c.created_at + interval '1 day' and a.at < c.created_at + interval '8 days') as d1,
            exists (select 1 from private.activity a where a.user_id = c.id and a.at >= c.created_at + interval '7 days' and a.at < c.created_at + interval '14 days') as d7,
            exists (select 1 from private.activity a where a.user_id = c.id and a.at >= c.created_at + interval '30 days' and a.at < c.created_at + interval '37 days') as d30
          from c)
    select jsonb_agg(jsonb_build_object('week', week, 'size', size,
      'd1', case when d1_n > 0 then d1 end, 'd1_eligible', d1_n,
      'd7', case when d7_n > 0 then d7 end, 'd7_eligible', d7_n,
      'd30', case when d30_n > 0 then d30 end, 'd30_eligible', d30_n) order by week)
    from (select week, count(*) as size,
            count(*) filter (where d1 and created_at <= now() - interval '8 days') as d1, count(*) filter (where created_at <= now() - interval '8 days') as d1_n,
            count(*) filter (where d7 and created_at <= now() - interval '14 days') as d7, count(*) filter (where created_at <= now() - interval '14 days') as d7_n,
            count(*) filter (where d30 and created_at <= now() - interval '37 days') as d30, count(*) filter (where created_at <= now() - interval '37 days') as d30_n
          from r group by week) g), '[]'::jsonb);
end $$;

-- Sign-up funnel for people who created an account in [p_from, p_to). Only steps that are actually recorded:
-- account created → email confirmed → signed in at least once → first qualifying activity.
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
      'first_activity', (select count(*) from u where exists (select 1 from private.activity a where a.user_id = u.id)),
      'signup_failed', (select count(*) from private.analytics_events where name = 'signup_failed' and at >= p_from and at < p_to)));
end $$;

-- Feature adoption: people (active accounts) who have used each feature at least once, ever and within [p_from, p_to).
create or replace function public.admin_adoption(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'analytics.view');
  return jsonb_build_object(
    'accounts', (select count(*) from auth.users where coalesce(is_anonymous, false) = false and deleted_at is null),
    'features', jsonb_build_array(
      jsonb_build_object('key', 'profile', 'label', 'Health profile saved',
        'ever', (select count(distinct user_id) from public.health_profiles), 'period', (select count(distinct user_id) from public.health_profiles where updated_at >= p_from and updated_at < p_to)),
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

-- ───────────────────────── people ─────────────────────────
-- Account metadata only (no health information): id, email, dates, verification, suspension, admin role, record and
-- file counts, last qualifying activity.
create or replace function public.admin_users(p_actor uuid, p_q text, p_status text, p_sort text, p_page int, p_size int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 25), 1), 100); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 25), 1), 100);
        q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform private.require(p_actor, 'users.view');
  return (with base as (
      select u.id, u.email, u.created_at, u.email_confirmed_at, u.last_sign_in_at,
             (u.banned_until is not null and u.banned_until > now()) as suspended, m.role as admin_role,
             (select count(*) from public.documents d where d.user_id = u.id) as records,
             (select count(*) from public.document_files f where f.user_id = u.id) as files,
             (select max(a.at) from private.activity a where a.user_id = u.id) as last_activity
      from auth.users u left join private.admin_members m on m.user_id = u.id and m.status = 'active'
      where coalesce(u.is_anonymous, false) = false and u.deleted_at is null
        and (q is null or u.email ilike '%' || replace(replace(q, '%', ''), '_', '\_') || '%' or u.id::text = q)
        and (p_status is null or p_status = '' or (p_status = 'suspended' and u.banned_until > now())
             or (p_status = 'unverified' and u.email_confirmed_at is null) or (p_status = 'verified' and u.email_confirmed_at is not null)
             or (p_status = 'admins' and m.role is not null)))
    select jsonb_build_object('total', (select count(*) from base), 'page', greatest(coalesce(p_page, 1), 1), 'size', size,
      'rows', coalesce((select jsonb_agg(to_jsonb(b)) from (select * from base order by
          case when p_sort = 'created_asc' then extract(epoch from created_at) end asc nulls last,
          case when p_sort = 'activity_desc' then extract(epoch from last_activity) end desc nulls last,
          case when p_sort = 'email' then email end asc,
          created_at desc limit size offset off) b), '[]'::jsonb)));
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
        'profile_saved', exists (select 1 from public.health_profiles where user_id = u.id),
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

-- Suspend, restore, end sessions, or add a support note. Owners and other admins can only be suspended by an owner,
-- and nobody can act on themselves. Every call is audited, including refusals by rule.
-- Suspension itself is applied by the web server through Supabase's Auth admin API (ban_duration), the supported way to
-- block sign-in; this function decides whether it is allowed, ends the person's sessions and writes the audit entry
-- ("requested"); the server then records the result with admin_log_action ("ok" or "failed").
create or replace function public.admin_user_action(p_actor uuid, p_user uuid, p_action text, p_reason text, p_note text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; target_admin text; before_s boolean; perm text; ended int := null; log_id bigint;
begin
  perm := case p_action when 'suspend' then 'users.suspend' when 'restore' then 'users.suspend' when 'revoke_sessions' then 'users.suspend'
                        when 'note' then 'users.notes' else null end;
  if perm is null then raise exception 'invalid action' using errcode = '22023'; end if;
  r := private.require(p_actor, perm);
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'no such account' using errcode = 'P0002'; end if;
  if p_action <> 'note' and coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = '22023'; end if;
  target_admin := (select role from private.admin_members where user_id = p_user and status = 'active');
  if p_action in ('suspend', 'restore', 'revoke_sessions') and (p_user = p_actor or (target_admin is not null and r <> 'owner')) then
    perform private.audit(p_actor, r, 'user.' || p_action, 'user', p_user::text, p_reason, null, null, 'denied', p_request);
    return jsonb_build_object('ok', false, 'error', case when p_user = p_actor then 'not_on_yourself' else 'admin_target_needs_owner' end);
  end if;
  select (banned_until is not null and banned_until > now()) into before_s from auth.users where id = p_user;
  if p_action in ('suspend', 'revoke_sessions') then
    begin
      delete from auth.sessions where user_id = p_user;
      get diagnostics ended = row_count;
    exception when insufficient_privilege or undefined_table then ended := null;
    end;
  elsif p_action = 'note' then
    if coalesce(trim(p_note), '') = '' then raise exception 'empty note' using errcode = '22023'; end if;
    insert into private.support_notes (user_id, author, body) values (p_user, p_actor, left(trim(p_note), 1000));
  end if;
  log_id := private.audit(p_actor, r, 'user.' || p_action, 'user', p_user::text, p_reason,
    case when p_action in ('suspend', 'restore') then jsonb_build_object('suspended', before_s) end,
    case when p_action in ('suspend', 'revoke_sessions') then jsonb_build_object('sessions_ended', ended) end,
    case when p_action in ('suspend', 'restore') then 'requested' else 'ok' end, p_request);
  return jsonb_build_object('ok', true, 'log_id', log_id, 'sessions_ended', ended, 'apply_ban', case p_action when 'suspend' then 'on' when 'restore' then 'off' end);
end $$;

-- For actions carried out by the web server after this check (password-reset email, exports): checks the permission
-- and records the action; the server records the outcome with a second call.
create or replace function public.admin_log_action(p_actor uuid, p_perm text, p_action text, p_target_type text, p_target_id text,
  p_reason text, p_detail jsonb, p_outcome text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text;
begin
  if p_perm not in ('users.reset_password', 'users.suspend', 'reports.export') or p_outcome not in ('requested', 'ok', 'failed') then
    raise exception 'invalid' using errcode = '22023';
  end if;
  r := private.require(p_actor, p_perm);
  return jsonb_build_object('ok', true, 'log_id', private.audit(p_actor, r, p_action, p_target_type, p_target_id, p_reason, null, p_detail, p_outcome, p_request),
    'email', case when p_perm = 'users.reset_password' and p_target_type = 'user' then (select email from auth.users where id::text = p_target_id) end);
end $$;

-- Refused admin requests (not an admin, missing permission) are security events. Anyone the server can identify.
create or replace function public.admin_log_denied(p_actor uuid, p_action text, p_request text) returns void
language sql security definer set search_path = pg_catalog, private, public as $$
  select private.audit(p_actor, private.actor_role(p_actor), left('denied:' || coalesce(p_action, '?'), 64), null, null, null, null, null, 'denied', p_request); $$;

-- ───────────────────────── documents (technical metadata only) ─────────────────────────
create or replace function public.admin_documents(p_actor uuid, p_from timestamptz, p_to timestamptz, p_page int, p_size int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 25), 1), 100); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 25), 1), 100);
        can_see_owner boolean;
begin
  perform private.require(p_actor, 'documents.view');
  can_see_owner := 'users.view' = any (private.role_perms(private.actor_role(p_actor)));
  return jsonb_build_object(
    'summary', jsonb_build_object(
      'records', (select count(*) from public.documents where created_at >= p_from and created_at < p_to),
      'records_total', (select count(*) from public.documents),
      'by_source', coalesce((select jsonb_object_agg(source, n) from (select source, count(*) n from public.documents where created_at >= p_from and created_at < p_to group by source) s), '{}'::jsonb),
      'by_category', coalesce((select jsonb_object_agg(category, n) from (select category, count(*) n from public.documents where created_at >= p_from and created_at < p_to group by category) s), '{}'::jsonb),
      'files', (select count(*) from public.document_files where created_at >= p_from and created_at < p_to),
      'by_type', coalesce((select jsonb_object_agg(content_type, n) from (select content_type, count(*) n from public.document_files where created_at >= p_from and created_at < p_to group by content_type) s), '{}'::jsonb),
      'bytes', (select coalesce(sum(size_bytes), 0) from public.document_files where created_at >= p_from and created_at < p_to),
      'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'health-documents'),
      'upload_completed', (select count(*) from private.analytics_events where name = 'document_upload_completed' and at >= p_from and at < p_to),
      'upload_failed', (select count(*) from private.analytics_events where name = 'document_upload_failed' and at >= p_from and at < p_to),
      'failure_reasons', coalesce((select jsonb_object_agg(coalesce(props->>'reason', 'unknown'), n) from (select props, count(*) n from private.analytics_events where name = 'document_upload_failed' and at >= p_from and at < p_to group by props) s), '{}'::jsonb),
      'processing_completed', (select count(*) from private.analytics_events where name = 'document_processing_completed' and at >= p_from and at < p_to),
      'processing_failed', (select count(*) from private.analytics_events where name = 'document_processing_failed' and at >= p_from and at < p_to),
      'processing_ms_avg', (select round(avg((props->>'ms')::numeric)) from private.analytics_events where name = 'document_processing_completed' and props ? 'ms' and at >= p_from and at < p_to),
      'events_since', (select min(at) from private.analytics_events)),
    'total', (select count(*) from public.documents where created_at >= p_from and created_at < p_to),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'account', case when can_see_owner then d.user_id::text else left(md5(d.user_id::text), 8) end,
        'created_at', d.created_at, 'source', d.source, 'pages', d.page_count,
        'files', (select count(*) from public.document_files f where f.document_id = d.id),
        'bytes', (select coalesce(sum(size_bytes), 0) from public.document_files f where f.document_id = d.id),
        'types', (select coalesce(jsonb_agg(distinct f.content_type), '[]'::jsonb) from public.document_files f where f.document_id = d.id)) order by d.created_at desc)
      from (select * from public.documents where created_at >= p_from and created_at < p_to order by created_at desc limit size offset off) d), '[]'::jsonb));
end $$;

-- ───────────────────────── switches and maintenance ─────────────────────────
create or replace function public.admin_flags(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'flags.view');
  return coalesce((select jsonb_agg(jsonb_build_object('key', key, 'enabled', enabled, 'value', value, 'updated_at', updated_at,
    'updated_by', (select email from auth.users where id = updated_by)) order by key) from private.feature_flags), '[]'::jsonb);
end $$;

create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' else 'flags.manage' end);
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

-- ───────────────────────── announcements ─────────────────────────
create or replace function public.admin_announcements(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'dashboard.view');
  return coalesce((select jsonb_agg(to_jsonb(a) - 'created_by' - 'updated_by' || jsonb_build_object(
      'live', a.status = 'published' and (a.starts_at is null or a.starts_at <= now()) and (a.ends_at is null or a.ends_at > now())) order by a.updated_at desc)
    from private.announcements a), '[]'::jsonb);
end $$;

create or replace function public.admin_announcement_save(p_actor uuid, p_data jsonb, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; aid uuid := nullif(p_data->>'id', '')::uuid; old jsonb; st text := coalesce(p_data->>'status', 'draft');
begin
  r := private.require(p_actor, 'announcements.manage');
  if st not in ('draft', 'published', 'archived') then raise exception 'invalid status' using errcode = '22023'; end if;
  if aid is null then
    insert into private.announcements (kind, title, body, status, starts_at, ends_at, created_by, updated_by)
    values (p_data->>'kind', trim(p_data->>'title'), coalesce(trim(p_data->>'body'), ''), st, nullif(p_data->>'starts_at', '')::timestamptz,
            nullif(p_data->>'ends_at', '')::timestamptz, p_actor, p_actor) returning id into aid;
  else
    select to_jsonb(a) into old from private.announcements a where id = aid for update;
    if old is null then raise exception 'no such announcement' using errcode = 'P0002'; end if;
    update private.announcements set kind = coalesce(p_data->>'kind', kind), title = coalesce(trim(p_data->>'title'), title),
      body = coalesce(trim(p_data->>'body'), body), status = st,
      starts_at = case when p_data ? 'starts_at' then nullif(p_data->>'starts_at', '')::timestamptz else starts_at end,
      ends_at = case when p_data ? 'ends_at' then nullif(p_data->>'ends_at', '')::timestamptz else ends_at end,
      updated_by = p_actor, updated_at = now() where id = aid;
  end if;
  perform private.audit(p_actor, r, 'announcement.' || case when old is null then 'create' when st = 'published' then 'publish' when st = 'archived' then 'archive' else 'update' end,
    'announcement', aid::text, null, old - 'created_by' - 'updated_by', (select to_jsonb(a) - 'created_by' - 'updated_by' from private.announcements a where id = aid), 'ok', p_request);
  return jsonb_build_object('ok', true, 'id', aid);
end $$;

-- ───────────────────────── incidents and alerts ─────────────────────────
create or replace function public.admin_incidents(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'health.view');
  return coalesce((select jsonb_agg(to_jsonb(i) - 'created_by' order by (i.status = 'resolved'), i.started_at desc) from private.incidents i), '[]'::jsonb);
end $$;

create or replace function public.admin_incident_save(p_actor uuid, p_data jsonb, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; iid uuid := nullif(p_data->>'id', '')::uuid; old jsonb; st text := coalesce(p_data->>'status', 'investigating');
begin
  r := private.require(p_actor, 'incidents.manage');
  if st not in ('investigating', 'degraded', 'operational', 'resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  if iid is null then
    insert into private.incidents (title, status, impact, notes, created_by, resolved_at)
    values (trim(p_data->>'title'), st, p_data->>'impact', p_data->>'notes', p_actor, case when st = 'resolved' then now() end) returning id into iid;
  else
    select to_jsonb(i) into old from private.incidents i where id = iid for update;
    if old is null then raise exception 'no such incident' using errcode = 'P0002'; end if;
    update private.incidents set title = coalesce(trim(p_data->>'title'), title), status = st, impact = coalesce(p_data->>'impact', impact),
      notes = coalesce(p_data->>'notes', notes), updated_at = now(),
      resolved_at = case when st = 'resolved' then coalesce(resolved_at, now()) else null end where id = iid;
  end if;
  perform private.audit(p_actor, r, 'incident.' || case when old is null then 'open' else 'update' end, 'incident', iid::text, null,
    old - 'created_by', (select to_jsonb(i) - 'created_by' from private.incidents i where id = iid), 'ok', p_request);
  return jsonb_build_object('ok', true, 'id', iid);
end $$;

-- Alert rules, evaluated when an admin opens the alert centre (there is no background scheduler). Each rule needs enough
-- measurements to judge; with too little data it stays quiet rather than guessing.
create or replace function public.admin_alerts(p_actor uuid, p_evaluate boolean) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; up_ok int; up_bad int; lf int; sf int; store bigint; cap bigint;
begin
  r := private.require(p_actor, 'health.view');
  if p_evaluate then
    select count(*) filter (where name = 'document_upload_completed'), count(*) filter (where name = 'document_upload_failed'),
           count(*) filter (where name = 'login_failure' and at >= now() - interval '1 hour'), count(*) filter (where name = 'signup_failed')
      into up_ok, up_bad, lf, sf from private.analytics_events where at >= now() - interval '24 hours';
    if up_ok + up_bad >= 5 and up_bad::numeric / (up_ok + up_bad) >= 0.2 then
      insert into private.admin_alerts (rule, severity, message, measured) values ('upload_failure_rate', 'warning',
        format('%s of %s uploads failed in the last 24 hours', up_bad, up_ok + up_bad), jsonb_build_object('failed', up_bad, 'completed', up_ok))
      on conflict (rule) where status <> 'resolved' do update set measured = excluded.measured, message = excluded.message, updated_at = now();
    end if;
    if lf >= 30 then
      insert into private.admin_alerts (rule, severity, message, measured) values ('login_failures', 'warning',
        format('%s failed sign-ins in the last hour', lf), jsonb_build_object('failures_1h', lf))
      on conflict (rule) where status <> 'resolved' do update set measured = excluded.measured, message = excluded.message, updated_at = now();
    end if;
    if sf >= 10 then
      insert into private.admin_alerts (rule, severity, message, measured) values ('signup_failures', 'warning',
        format('%s account creations failed in the last 24 hours', sf), jsonb_build_object('failures_24h', sf))
      on conflict (rule) where status <> 'resolved' do update set measured = excluded.measured, message = excluded.message, updated_at = now();
    end if;
    store := (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'health-documents');
    cap := coalesce(((select value->>'storage_limit_bytes' from private.feature_flags where key = 'document_upload'))::bigint, 1073741824); -- Supabase Free: 1 GB
    if store >= cap * 0.8 then
      insert into private.admin_alerts (rule, severity, message, measured) values ('storage_near_limit', case when store >= cap * 0.95 then 'critical' else 'warning' end,
        format('Document storage is at %s%% of %s MB', round(store * 100.0 / cap), cap / 1048576), jsonb_build_object('bytes', store, 'limit', cap))
      on conflict (rule) where status <> 'resolved' do update set measured = excluded.measured, message = excluded.message, updated_at = now();
    end if;
  end if;
  return coalesce((select jsonb_agg(to_jsonb(a) - 'updated_by' order by (a.status = 'resolved'), a.opened_at desc) from (select * from private.admin_alerts order by opened_at desc limit 100) a), '[]'::jsonb);
end $$;

create or replace function public.admin_alert_update(p_actor uuid, p_id uuid, p_status text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old text;
begin
  r := private.require(p_actor, 'alerts.manage');
  if p_status not in ('acknowledged', 'resolved') then raise exception 'invalid status' using errcode = '22023'; end if;
  select status into old from private.admin_alerts where id = p_id for update;
  if old is null then raise exception 'no such alert' using errcode = 'P0002'; end if;
  update private.admin_alerts set status = p_status, updated_at = now(), updated_by = p_actor where id = p_id;
  perform private.audit(p_actor, r, 'alert.' || p_status, 'alert', p_id::text, null, jsonb_build_object('status', old), jsonb_build_object('status', p_status), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- ───────────────────────── team ─────────────────────────
create or replace function public.admin_team(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'team.view');
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role, 'status', m.status,
      'added_at', m.created_at, 'updated_at', m.updated_at, 'last_sign_in_at', u.last_sign_in_at,
      'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified')) order by m.role, u.email)
    from private.admin_members m join auth.users u on u.id = m.user_id), '[]'::jsonb);
end $$;

-- Owner only. Adds an EXISTING Doctine account (by email) to the team, changes its role, or suspends/removes it.
-- No account is ever created here. The last active owner cannot be demoted, suspended or removed, and nobody can change
-- their own membership.
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
    if p_role not in ('owner', 'super_admin', 'operations', 'analyst', 'support', 'developer') or coalesce(p_status, 'active') not in ('active', 'suspended') then
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

-- ───────────────────────── audit and security views ─────────────────────────
create or replace function public.admin_audit(p_actor uuid, p_admin text, p_action text, p_target text, p_from timestamptz, p_to timestamptz, p_page int, p_size int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 50), 1), 200); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 50), 1), 200);
begin
  perform private.require(p_actor, 'audit.view');
  return (with f as (select l.*, u.email as actor_email from private.admin_audit_log l left join auth.users u on u.id = l.actor
      where (nullif(p_admin, '') is null or u.email ilike '%' || p_admin || '%')
        and (nullif(p_action, '') is null or l.action like p_action || '%')
        and (nullif(p_target, '') is null or l.target_id = p_target)
        and (p_from is null or l.at >= p_from) and (p_to is null or l.at < p_to))
    select jsonb_build_object('total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(to_jsonb(x) - 'actor' order by x.at desc) from (select * from f order by at desc limit size offset off) x), '[]'::jsonb)));
end $$;

create or replace function public.admin_security(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'security.view');
  return jsonb_build_object(
    'denied_24h', (select count(*) from private.admin_audit_log where outcome = 'denied' and at >= now() - interval '24 hours'),
    'denied_recent', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'who', (select email from auth.users where id = l.actor)) order by l.at desc)
       from (select * from private.admin_audit_log where outcome = 'denied' order by at desc limit 25) l), '[]'::jsonb),
    'login_failures_24h', (select count(*) from private.analytics_events where name = 'login_failure' and at >= now() - interval '24 hours'),
    'login_failures_by_reason', coalesce((select jsonb_object_agg(coalesce(props->>'reason', 'unknown'), n) from (select props, count(*) n from private.analytics_events where name = 'login_failure' and at >= now() - interval '7 days' group by props) s), '{}'::jsonb),
    'suspended_accounts', (select count(*) from auth.users where banned_until > now()),
    'admins_without_mfa', (select count(*) from private.admin_members m where m.status = 'active' and not exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified')));
end $$;

-- ───────────────────────── privileges: only the server may call any of this ─────────────────────────
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'admin\_%' or p.proname in ('record_event', 'public_settings')) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;
