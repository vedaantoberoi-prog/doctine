-- Doctine · admin console: section-by-section health profile completion, profile save tracking and analytics (22 Nov 2026).
--
-- Completion is CALCULATED from the same tables the patient app saves to (health_profiles, health_records, medicines);
-- nothing is copied. Only field names, states, counts and timestamps leave the database, never an answer.
--
-- Field states: completed · not_answered · pending (said "yes" but no entry added yet) · not_applicable (a conditional
-- field whose condition isn't met) · optional (shown, never counted). Explicit answers such as "No", "Not sure",
-- "Prefer not to say", "No known allergies" and "Never been checked" count as completed; an unanswered question never
-- counts, and is never read as "no".
-- Section % = completed ÷ applicable counted fields. Overall % = the average of the seven section percentages, so a
-- section with many small fields can't outweigh the others. A section is complete at 100 %.
--
-- Tracking: private.profile_events records each SUCCESSFUL save (database triggers): which section, what kind of change,
-- when. Never the content. Nothing is back-filled; everything saved before this migration is labelled "before tracking".
-- Opening a section (not a save) is recorded only for people who allowed product measurements (analytics_events,
-- 'profile_section_opened'), and is shown separately from saves.
--
-- Additive: new private table + triggers + functions; admin_users / admin_user gain fields (old ones kept).
-- Rollback: supabase/rollback/20261122020000_admin_profile_sections_down.sql

-- ---------- when tracking began ----------
create table if not exists private.profile_tracking (id int primary key default 1 check (id = 1), started_at timestamptz not null default now());
insert into private.profile_tracking (id) values (1) on conflict do nothing;
alter table private.profile_tracking enable row level security;
revoke all on private.profile_tracking from public, anon, authenticated;

-- ---------- successful profile saves ----------
create table if not exists private.profile_events (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  section text not null check (section in ('profile', 'personal', 'body', 'history', 'medicines', 'allergies', 'devices', 'family')),
  action  text not null check (action in ('created', 'saved', 'answered', 'entry_added', 'entry_updated', 'entry_removed')),
  at      timestamptz not null default now()
);
create index if not exists profile_events_user_at on private.profile_events (user_id, at desc);
create index if not exists profile_events_at on private.profile_events (at desc);
alter table private.profile_events enable row level security;
revoke all on private.profile_events from public, anon, authenticated;

create or replace function private.log_profile_save() returns trigger language plpgsql security definer
  set search_path = public, extensions, pg_temp as $$
declare o public.health_profiles; n public.health_profiles := new; a jsonb; b jsonb; k text; sec text; secs text[] := '{}'; act text;
begin
  if tg_op = 'UPDATE' then o := old; end if;
  if tg_op = 'INSERT' then insert into private.profile_events (user_id, section, action) values (n.user_id, 'profile', 'created'); end if;
  if (o.date_of_birth, o.sex_at_birth, o.gender, o.blood_group, o.phone, o.contact_email, o.city, o.country, o.emergency_name, o.emergency_relationship, o.emergency_phone)
     is distinct from (n.date_of_birth, n.sex_at_birth, n.gender, n.blood_group, n.phone, n.contact_email, n.city, n.country, n.emergency_name, n.emergency_relationship, n.emergency_phone)
     and (tg_op = 'UPDATE' or coalesce(n.date_of_birth::text, n.sex_at_birth, n.gender, n.blood_group, n.phone, n.city, n.country, n.emergency_name, n.emergency_phone) is not null) then
    insert into private.profile_events (user_id, section, action) values (n.user_id, 'personal', 'saved');
  end if;
  if (o.height_cm, o.weight_kg, o.waist_cm, o.measured_on, o.units, coalesce(o.lifestyle, '{}'))
     is distinct from (n.height_cm, n.weight_kg, n.waist_cm, n.measured_on, n.units, coalesce(n.lifestyle, '{}'))
     and (tg_op = 'UPDATE' or coalesce(n.height_cm::text, n.weight_kg::text) is not null or coalesce(n.lifestyle, '{}') <> '{}') then
    insert into private.profile_events (user_id, section, action) values (n.user_id, 'body', 'saved');
  end if;
  -- the explicit "yes / no / not sure / prefer not to say" answers, and the older free-text allergy note
  a := coalesce(o.history_answers, '{}'); b := coalesce(n.history_answers, '{}');
  for k in select x from jsonb_object_keys(a || b) x loop
    if (a->>k) is distinct from (b->>k) then
      sec := case when k in ('conditions', 'past', 'surgery', 'hosp', 'other') then 'history' when k = 'allergies' then 'allergies' when k = 'devices' then 'devices'
                  when k = 'family' then 'family' when k like 'meds_%' then 'medicines' end;
      if sec is not null and not sec = any (secs) then secs := secs || sec; end if;
    end if;
  end loop;
  if nullif(trim(o.allergies), '') is distinct from nullif(trim(n.allergies), '') and not 'allergies' = any (secs) then secs := secs || 'allergies'::text; end if;
  foreach sec in array secs loop insert into private.profile_events (user_id, section, action) values (n.user_id, sec, 'answered'); end loop;
  return new;
end $$;

create or replace function private.log_profile_entry() returns trigger language plpgsql security definer
  set search_path = public, extensions, pg_temp as $$
declare uid uuid := coalesce(new.user_id, old.user_id); sec text; act text;
begin
  -- the account itself is being deleted (its rows go with it): nothing to record
  if tg_op = 'DELETE' and not exists (select 1 from auth.users where id = uid) then return old; end if;
  if tg_table_name = 'medicines' then sec := 'medicines';
  else sec := case coalesce(new.kind, old.kind) when 'allergy' then 'allergies' when 'device' then 'devices' when 'family' then 'family' else 'history' end; end if;
  if tg_op = 'UPDATE' and to_jsonb(new) - 'updated_at' = to_jsonb(old) - 'updated_at' then return new; end if;
  act := case tg_op when 'INSERT' then 'entry_added' when 'UPDATE' then 'entry_updated' else 'entry_removed' end;
  insert into private.profile_events (user_id, section, action) values (uid, sec, act);
  return coalesce(new, old);
end $$;
revoke all on function private.log_profile_save() from public, anon, authenticated;
revoke all on function private.log_profile_entry() from public, anon, authenticated;
drop trigger if exists health_profiles_track on public.health_profiles;
create trigger health_profiles_track after insert or update on public.health_profiles for each row execute function private.log_profile_save();
drop trigger if exists health_records_track on public.health_records;
create trigger health_records_track after insert or update or delete on public.health_records for each row execute function private.log_profile_entry();
drop trigger if exists medicines_track on public.medicines;
create trigger medicines_track after insert or update or delete on public.medicines for each row execute function private.log_profile_entry();

-- ---------- the completion calculation (one function, used by the list, the account panel and analytics) ----------
create or replace function private.pf(p_key text, p_label text, p_state text, p_counted boolean default true) returns jsonb language sql immutable
  set search_path = public, extensions, pg_temp as $$ select jsonb_build_object('key', p_key, 'label', p_label, 'state', p_state, 'counted', p_counted) $$;
create or replace function private.has(v text) returns text language sql immutable
  set search_path = public, extensions, pg_temp as $$ select case when nullif(trim(v), '') is not null then 'completed' else 'not_answered' end $$;
-- an explicit-answer question: entries, or an explicit no / not sure / prefer not to say, complete it; "yes" with no entry is pending
create or replace function private.ans_state(p_answer text, p_entries int) returns text language sql immutable
  set search_path = public, extensions, pg_temp as $$
  select case when p_entries > 0 then 'completed' when p_answer in ('no', 'not_sure', 'prefer_not', 'nka', 'not_assessed') then 'completed'
              when p_answer = 'yes' then 'pending' else 'not_answered' end $$;
create or replace function private.ps(p_key text, p_label text, p_fields jsonb, p_updated timestamptz, p_tracked boolean, p_extra jsonb default '{}') returns jsonb language sql immutable
  set search_path = public, extensions, pg_temp as $$
  with f as (select x from jsonb_array_elements(p_fields) x),
       c as (select count(*) filter (where (x->>'counted')::boolean and x->>'state' <> 'not_applicable') appl,
                    count(*) filter (where (x->>'counted')::boolean and x->>'state' = 'completed') done,
                    count(*) filter (where (x->>'counted')::boolean and x->>'state' = 'pending') pend,
                    count(*) filter (where (x->>'counted')::boolean and x->>'state' = 'not_applicable') na from f)
  select jsonb_build_object('key', p_key, 'label', p_label, 'applicable', appl, 'completed', done, 'incomplete', appl - done, 'pending', pend, 'not_applicable', na,
    'pct', case when appl = 0 then 0 else round(100.0 * done / appl)::int end,
    'status', case when appl > 0 and done = appl then 'complete' when done > 0 or pend > 0 then 'in_progress' else 'not_started' end,
    'updated_at', p_updated, 'updated_source', case when p_updated is null then null when p_tracked then 'tracked' else 'before_tracking' end,
    'fields', p_fields) || p_extra from c $$;

create or replace function private.profile_sections(p_user uuid) returns jsonb language plpgsql stable
  set search_path = public, extensions, pg_temp as $$
declare h public.health_profiles; a jsonb; l jsonb; cnt jsonb; ev jsonb; t0 timestamptz; secs jsonb := '[]'::jsonb;
  m_reg int; m_occ int; m_cur int; m_stop int; m_noreason int; fam int; fam_noage int; fam_nostat int; al int; dev int; st text; tr timestamptz; hist timestamptz;
  meta jsonb;
begin
  select * into h from public.health_profiles where user_id = p_user;
  select raw_user_meta_data into meta from auth.users where id = p_user;
  a := coalesce(h.history_answers, '{}'); l := coalesce(h.lifestyle, '{}');
  select coalesce(jsonb_object_agg(kind, n), '{}') into cnt from (select kind, count(*) n from public.health_records where user_id = p_user group by kind) k;
  select coalesce(jsonb_object_agg(section, last_at), '{}') into ev from (select section, max(at) last_at from private.profile_events where user_id = p_user group by section) e;
  select started_at into t0 from private.profile_tracking;
  select count(*) filter (where category = 'regular'), count(*) filter (where category = 'occasional'),
         count(*) filter (where status <> 'completed' and (end_date is null or end_date >= current_date)),
         count(*) filter (where status = 'completed' or end_date < current_date),
         count(*) filter (where status <> 'completed' and (end_date is null or end_date >= current_date) and nullif(trim(reason), '') is null)
    into m_reg, m_occ, m_cur, m_stop, m_noreason from public.medicines where user_id = p_user;
  select count(*), count(*) filter (where nullif(trim(details->>'age'), '') is null), count(*) filter (where status is null)
    into fam, fam_noage, fam_nostat from public.health_records where user_id = p_user and kind = 'family';
  al := coalesce((cnt->>'allergy')::int, 0); dev := coalesce((cnt->>'device')::int, 0);

  -- A. Personal information (the account name comes from sign-up, so it is shown but not counted)
  tr := (ev->>'personal')::timestamptz;
  secs := secs || private.ps('personal', 'Personal information', jsonb_build_array(
      private.pf('name', 'Full name', private.has(coalesce(h.full_name, private.account_name(meta))), false),
      private.pf('date_of_birth', 'Date of birth', case when h.date_of_birth is not null then 'completed' else 'not_answered' end),
      private.pf('sex_at_birth', 'Sex assigned at birth', private.has(h.sex_at_birth)),
      private.pf('gender', 'Gender', private.has(h.gender)),
      private.pf('blood_group', 'Blood group', private.has(h.blood_group)),
      private.pf('phone', 'Phone, with country code', private.has(h.phone)),
      private.pf('contact_email', 'Contact email', private.has(h.contact_email), false),
      private.pf('city', 'City', private.has(h.city)),
      private.pf('country', 'Country', private.has(h.country)),
      private.pf('emergency_name', 'Emergency contact name', private.has(h.emergency_name)),
      private.pf('emergency_relationship', 'Emergency contact relationship', private.has(h.emergency_relationship), false),
      private.pf('emergency_phone', 'Emergency contact phone', private.has(h.emergency_phone))),
    coalesce(tr, case when h.user_id is not null and coalesce(h.date_of_birth::text, h.sex_at_birth, h.gender, h.blood_group, h.phone, h.city, h.country) is not null then least(h.updated_at, t0) end), tr is not null);

  -- B. Body & lifestyle (the diet description only applies when the diet is "Other")
  tr := (ev->>'body')::timestamptz;
  secs := secs || private.ps('body', 'Body & lifestyle', jsonb_build_array(
      private.pf('height', 'Height', case when h.height_cm is not null then 'completed' else 'not_answered' end),
      private.pf('weight', 'Weight', case when h.weight_kg is not null then 'completed' else 'not_answered' end),
      private.pf('waist', 'Waist', case when h.waist_cm is not null then 'completed' else 'not_answered' end, false),
      private.pf('diet', 'What you eat', private.has(l->>'diet')),
      private.pf('diet_other', 'Diet, described', case when l->>'diet' = 'other' then private.has(l->>'dietOther') else 'not_applicable' end),
      private.pf('activity', 'How active you are', private.has(l->>'activity')),
      private.pf('sleep_hours', 'Usual hours of sleep', private.has(l->>'sleepH')),
      private.pf('sleep_quality', 'Sleep quality', private.has(l->>'sleepQ')),
      private.pf('smoking', 'Smoking', private.has(l->>'smoking')),
      private.pf('alcohol', 'Alcohol', private.has(l->>'alcohol')),
      private.pf('tobacco', 'Other tobacco', private.has(l->>'tobacco')),
      private.pf('substances', 'Recreational substances', private.has(l->>'subst')),
      private.pf('caffeine', 'Tea, coffee and other caffeine', private.has(l->>'caffeine'))),
    coalesce(tr, case when h.height_cm is not null or h.weight_kg is not null or l <> '{}' then least(h.updated_at, t0) end), tr is not null);

  -- C. Medical history
  tr := (ev->>'history')::timestamptz;
  select max(updated_at) into hist from public.health_records where user_id = p_user and kind in ('condition', 'past_illness', 'surgery', 'hospitalization', 'other_history') and updated_at < t0;
  secs := secs || private.ps('history', 'Medical history', jsonb_build_array(
      private.pf('conditions', 'Long-term or ongoing conditions', private.ans_state(a->>'conditions', coalesce((cnt->>'condition')::int, 0))),
      private.pf('past', 'Past illnesses', private.ans_state(a->>'past', coalesce((cnt->>'past_illness')::int, 0))),
      private.pf('surgery', 'Surgeries and procedures', private.ans_state(a->>'surgery', coalesce((cnt->>'surgery')::int, 0))),
      private.pf('hosp', 'Hospital stays', private.ans_state(a->>'hosp', coalesce((cnt->>'hospitalization')::int, 0))),
      private.pf('other', 'Other important history', private.ans_state(a->>'other', coalesce((cnt->>'other_history')::int, 0)))),
    coalesce(tr, hist), tr is not null,
    jsonb_build_object('entries', coalesce((cnt->>'condition')::int, 0) + coalesce((cnt->>'past_illness')::int, 0) + coalesce((cnt->>'surgery')::int, 0) + coalesce((cnt->>'hospitalization')::int, 0) + coalesce((cnt->>'other_history')::int, 0)));

  -- D. Medicines ("what it is for" only applies when there are current medicines)
  tr := (ev->>'medicines')::timestamptz;
  select max(updated_at) into hist from public.medicines where user_id = p_user and updated_at < t0;
  secs := secs || private.ps('medicines', 'Medicines', jsonb_build_array(
      private.pf('regular', 'Medicines taken regularly', private.ans_state(a->>'meds_regular', m_reg)),
      private.pf('occasional', 'Medicines taken now and then', private.ans_state(a->>'meds_occasional', m_occ)),
      private.pf('details', 'What each current medicine is for', case when m_cur = 0 then 'not_applicable' when m_noreason = 0 then 'completed' else 'not_answered' end)),
    coalesce(tr, hist), tr is not null,
    jsonb_build_object('entries', m_reg + m_occ, 'current', m_cur, 'stopped', m_stop, 'details_missing', m_noreason));

  -- E. Allergies: entries, or an explicit "no known allergies" / "never been checked" / "prefer not to say", or the older note
  st := case when al > 0 then 'declared' when a->>'allergies' = 'nka' then 'no_known' when a->>'allergies' = 'not_assessed' then 'not_assessed'
             when a->>'allergies' = 'prefer_not' then 'prefer_not' when nullif(trim(h.allergies), '') is not null then 'declared_older_note'
             when a->>'allergies' = 'yes' then 'pending' else 'unanswered' end;
  tr := (ev->>'allergies')::timestamptz;
  select max(updated_at) into hist from public.health_records where user_id = p_user and kind = 'allergy' and updated_at < t0;
  secs := secs || private.ps('allergies', 'Allergies', jsonb_build_array(
      private.pf('allergies', 'Allergies', case when st in ('declared', 'no_known', 'not_assessed', 'prefer_not', 'declared_older_note') then 'completed' when st = 'pending' then 'pending' else 'not_answered' end)),
    coalesce(tr, hist, case when nullif(trim(h.allergies), '') is not null then least(h.updated_at, t0) end), tr is not null,
    jsonb_build_object('entries', al, 'answer', st));

  -- F. Medical devices
  st := case when dev > 0 then 'declared' when a->>'devices' = 'no' then 'none' when a->>'devices' = 'not_sure' then 'not_sure' when a->>'devices' = 'prefer_not' then 'prefer_not'
             when a->>'devices' = 'yes' then 'pending' else 'unanswered' end;
  tr := (ev->>'devices')::timestamptz;
  select max(updated_at) into hist from public.health_records where user_id = p_user and kind = 'device' and updated_at < t0;
  secs := secs || private.ps('devices', 'Medical devices', jsonb_build_array(
      private.pf('devices', 'Medical devices', private.ans_state(a->>'devices', dev))),
    coalesce(tr, hist), tr is not null, jsonb_build_object('entries', dev, 'answer', st));

  -- G. Family history (the per-entry details only apply when there are entries)
  tr := (ev->>'family')::timestamptz;
  select max(updated_at) into hist from public.health_records where user_id = p_user and kind = 'family' and updated_at < t0;
  secs := secs || private.ps('family', 'Family history', jsonb_build_array(
      private.pf('family', 'Conditions in blood relatives', private.ans_state(a->>'family', fam)),
      private.pf('ages', 'Age at diagnosis, for each entry', case when fam = 0 then 'not_applicable' when fam_noage = 0 then 'completed' else 'not_answered' end),
      private.pf('status', 'Whether each relative is living', case when fam = 0 then 'not_applicable' when fam_nostat = 0 then 'completed' else 'not_answered' end)),
    coalesce(tr, hist), tr is not null, jsonb_build_object('entries', fam));

  return jsonb_build_object(
    'pct', (select round(avg((s->>'pct')::int))::int from jsonb_array_elements(secs) s),
    'sections_done', (select count(*) from jsonb_array_elements(secs) s where s->>'status' = 'complete'),
    'sections_started', (select count(*) from jsonb_array_elements(secs) s where s->>'status' <> 'not_started'),
    'sections_total', jsonb_array_length(secs),
    'started', exists (select 1 from jsonb_array_elements(secs) s where s->>'status' <> 'not_started'),
    'last_saved', (select max(at) from private.profile_events where user_id = p_user and section <> 'profile'),
    'tracking_since', t0, 'sections', secs);
end $$;
revoke all on function private.profile_sections(uuid) from public, anon, authenticated;
revoke all on function private.pf(text, text, text, boolean), private.has(text), private.ans_state(text, int), private.ps(text, text, jsonb, timestamptz, boolean, jsonb) from public, anon, authenticated;

-- ---------- meaningful activity also counts medical-history entries and health readings ----------
create or replace view private.activity as
  select user_id, created_at as at, 'record' as kind from public.documents
  union all select user_id, created_at, 'file' from public.document_files
  union all select user_id, recorded_at, 'dose' from public.dose_events
  union all select user_id, created_at, 'medicine' from public.medicines
  union all select user_id, updated_at, 'medicine' from public.medicines where updated_at > created_at + interval '5 seconds'
  union all select user_id, updated_at, 'profile' from public.health_profiles where updated_at > created_at + interval '5 seconds'
  union all select user_id, created_at, 'history' from public.health_records
  union all select user_id, updated_at, 'history' from public.health_records where updated_at > created_at + interval '5 seconds'
  union all select user_id, created_at, 'reading' from public.vital_readings
  union all select user_id, created_at, 'assistant' from public.messages where role = 'user'
  union all select user_id, at, name from private.analytics_events where user_id is not null and name in ('search_performed','record_exported');

-- ---------- opening a profile section (measurements, only for people who allowed them) ----------
create or replace function private.event_props_ok(p_name text, p_props jsonb) returns boolean language sql immutable
  set search_path = public, extensions, pg_temp as $$
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
               when 'profile_section_opened' then array['section']
               else array[]::text[] end))
          or not (jsonb_typeof(e.value) = 'number' or (jsonb_typeof(e.value) = 'string' and e.value #>> '{}' ~ '^[a-z0-9_.-]{1,40}$')))
     and (p_name <> 'profile_section_opened' or coalesce(p_props->>'section', '') in ('personal', 'body', 'history', 'meds', 'allergy', 'family', 'women')) $$;

create or replace function public.record_event(p_user uuid, p_name text, p_props jsonb, p_dedupe text) returns boolean
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare n int;
begin
  if p_name not in ('account_created','email_verified','login_success','login_failure','signup_failed','profile_saved',
                    'document_upload_completed','document_upload_failed','document_processing_completed','document_processing_failed',
                    'medicine_schedule_created','medicine_marked_taken','medicine_marked_skipped','search_performed','record_exported','app_error',
                    'profile_section_opened')
     or p_dedupe is null or p_dedupe !~ '^[A-Za-z0-9_.:-]{1,80}$' or not private.event_props_ok(p_name, p_props) then
    raise exception 'invalid event' using errcode = '22023';
  end if;
  insert into private.analytics_events (user_id, name, props, dedupe_key) values (p_user, p_name, coalesce(p_props, '{}'::jsonb), p_dedupe)
  on conflict do nothing;
  get diagnostics n = row_count;
  if random() < 0.002 then delete from private.analytics_events where at < now() - interval '400 days'; end if; -- retention: about 13 months
  return n > 0;
end $$;
revoke all on function public.record_event(uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_event(uuid, text, jsonb, text) to service_role;

-- ---------- Users list: overall completion, sections, documents and medicines; completion bands and activity filters ----------
create or replace function public.admin_users(p_actor uuid, p_q text, p_status text, p_sort text, p_page int, p_size int, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare size int := least(greatest(coalesce(p_size, 25), 1), 100); off int := greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_size, 25), 1), 100);
        q text := nullif(trim(coalesce(p_q, '')), '');
begin
  perform private.require(p_actor, 'users.view');
  return (with acc as (
      select u.id, u.email, private.account_name(u.raw_user_meta_data) as name, u.created_at, u.email_confirmed_at, u.last_sign_in_at,
             (u.banned_until is not null and u.banned_until > now()) as suspended, m.role as admin_role
      from auth.users u left join private.admin_members m on m.user_id = u.id and m.status = 'active'
      where coalesce(u.is_anonymous, false) = false and u.deleted_at is null
        and (q is null or u.email ilike '%' || private.like_literal(q) || '%' or u.id::text = q
             or private.account_name(u.raw_user_meta_data) ilike '%' || private.like_literal(q) || '%')
        and (p_from is null or u.created_at >= p_from) and (p_to is null or u.created_at < p_to)),
    withp as (select acc.*, ps.j, (ps.j->>'pct')::int as profile_pct, (ps.j->>'sections_done')::int as sections_done, (ps.j->>'sections_total')::int as sections_total,
                     (select max(at) from private.activity a where a.user_id = acc.id) as last_activity
              from acc cross join lateral (select private.profile_sections(acc.id) j) ps),
    base as (select * from withp where (p_status is null or p_status = ''
             or (p_status = 'suspended' and suspended) or (p_status = 'active' and not suspended)
             or (p_status = 'unverified' and email_confirmed_at is null) or (p_status = 'verified' and email_confirmed_at is not null)
             or (p_status = 'admins' and admin_role is not null)
             or (p_status = 'profile_not_started' and not (j->>'started')::boolean)
             or (p_status = 'profile_lt25' and (j->>'started')::boolean and profile_pct < 25)
             or (p_status = 'profile_25_49' and profile_pct between 25 and 49) or (p_status = 'profile_50_74' and profile_pct between 50 and 74)
             or (p_status = 'profile_75_99' and profile_pct between 75 and 99)
             or (p_status = 'profile_complete' and profile_pct = 100) or (p_status = 'profile_incomplete' and profile_pct < 100)
             or (p_status = 'recently_active' and last_activity >= now() - interval '7 days')
             or (p_status = 'inactive' and (last_activity is null or last_activity < now() - interval '30 days')))),
    docs as (select user_id, count(*) n from public.documents where user_id in (select id from base) group by user_id),
    files as (select user_id, count(*) n from public.document_files where user_id in (select id from base) group by user_id),
    meds as (select user_id, count(*) n from public.medicines where user_id in (select id from base) group by user_id),
    full_rows as (select b.id, b.email, b.name, b.created_at, b.email_confirmed_at, b.last_sign_in_at, b.suspended, b.admin_role, b.last_activity,
                         b.profile_pct, b.sections_done, b.sections_total, (b.j->>'sections_started')::int as sections_started,
                         b.sections_total - b.sections_done as sections_incomplete, (b.j->>'started')::boolean as profile_started,
                         b.sections_done as profile_filled,
                         coalesce(docs.n, 0) records, coalesce(files.n, 0) files, coalesce(meds.n, 0) medicines
      from base b left join docs on docs.user_id = b.id left join files on files.user_id = b.id left join meds on meds.user_id = b.id)
    select jsonb_build_object('total', (select count(*) from base), 'page', greatest(coalesce(p_page, 1), 1), 'size', size,
      'rows', coalesce((select jsonb_agg(to_jsonb(r)) from (select * from full_rows order by
          case when p_sort = 'created_asc' then extract(epoch from created_at) end asc nulls last,
          case when p_sort = 'activity_desc' then extract(epoch from last_activity) end desc nulls last,
          case when p_sort = 'activity_asc' then extract(epoch from last_activity) end asc nulls last,
          case when p_sort = 'email' then email end asc,
          case when p_sort = 'name' then lower(name) end asc nulls last,
          case when p_sort = 'records_desc' then records end desc,
          case when p_sort = 'files_desc' then files end desc,
          case when p_sort = 'medicines_desc' then medicines end desc,
          case when p_sort = 'profile_desc' then profile_pct end desc,
          case when p_sort = 'profile_asc' then profile_pct end asc,
          case when p_sort = 'sections_asc' then sections_done end asc,
          case when p_sort = 'sections_desc' then sections_done end desc,
          created_at desc limit size offset off) r), '[]'::jsonb)));
end $$;

-- ---------- Account panel ----------
create or replace function public.admin_user(p_actor uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare can_notes boolean; ps jsonb;
begin
  perform private.require(p_actor, 'users.view');
  can_notes := private.can(p_actor, 'users.notes');
  ps := private.profile_sections(p_user);
  return (select jsonb_build_object(
      'id', u.id, 'email', u.email, 'name', private.account_name(u.raw_user_meta_data), 'created_at', u.created_at, 'email_confirmed_at', u.email_confirmed_at,
      'last_sign_in_at', u.last_sign_in_at, 'suspended', (u.banned_until is not null and u.banned_until > now()),
      'admin_role', (select role from private.admin_members where user_id = u.id and status = 'active'),
      'sign_in_methods', coalesce((select jsonb_agg(distinct provider) from auth.identities i where i.user_id = u.id), '[]'::jsonb),
      'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status = 'verified'),
      -- kept for older console versions: the overall score and sections complete
      'profile', jsonb_build_object('pct', ps->'pct', 'filled', ps->'sections_done', 'total', ps->'sections_total', 'updated_at', (select updated_at from public.health_profiles where user_id = u.id)),
      'profile_sections', ps,
      'profile_activity', coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'section', e.section, 'action', e.action) order by e.at desc)
                 from (select * from private.profile_events where user_id = u.id order by at desc limit 60) e), '[]'::jsonb),
      'profile_opened', coalesce((select jsonb_object_agg(sec, last_at) from (select props->>'section' sec, max(at) last_at from private.analytics_events
                 where user_id = u.id and name = 'profile_section_opened' group by 1) o), '{}'::jsonb),
      'first_activity', (select min(at) from private.activity where user_id = u.id),
      'usage', jsonb_build_object(
        'records', (select count(*) from public.documents where user_id = u.id),
        'records_by_source', coalesce((select jsonb_object_agg(source, n) from (select source, count(*) n from public.documents where user_id = u.id group by source) s), '{}'::jsonb),
        'files', (select count(*) from public.document_files where user_id = u.id),
        'file_bytes', (select coalesce(sum(size_bytes), 0) from public.document_files where user_id = u.id),
        'medicines', (select count(*) from public.medicines where user_id = u.id),
        'history_entries', (select count(*) from public.health_records where user_id = u.id),
        'readings', (select count(*) from public.vital_readings where user_id = u.id),
        'doses_recorded', (select count(*) from public.dose_events where user_id = u.id),
        'profile_saved', (ps->>'started')::boolean,
        'last_activity', (select max(at) from private.activity where user_id = u.id),
        'active_days_30', (select count(distinct private.day(at)) from private.activity where user_id = u.id and at >= now() - interval '30 days')),
      'adoption', jsonb_build_object(
        'profile', (ps->>'started')::boolean,
        'record', exists (select 1 from public.documents where user_id = u.id),
        'file', exists (select 1 from public.document_files where user_id = u.id),
        'medicine', exists (select 1 from public.medicines where user_id = u.id),
        'schedule', exists (select 1 from public.medication_schedules where user_id = u.id),
        'dose', exists (select 1 from public.dose_events where user_id = u.id and status in ('Taken','Skipped')),
        'search', exists (select 1 from private.analytics_events where user_id = u.id and name = 'search_performed'),
        'export', exists (select 1 from private.analytics_events where user_id = u.id and name = 'record_exported')),
      -- each feature: last use and how many different days it was used in the last 30 (from saved data or permitted measurements)
      'features', (select jsonb_agg(jsonb_build_object('key', f.key, 'label', f.label, 'last', f.last, 'days_30', f.days, 'measured', f.measured,
                     'state', case when f.last is null then 'not_started' when f.days >= 2 then 'active' else 'used' end) order by f.ord)
        from (values
          (1, 'profile', 'Health profile', (select max(at) from private.activity where user_id = u.id and kind in ('profile', 'history')), (select count(distinct private.day(at)) from private.activity where user_id = u.id and kind in ('profile', 'history') and at >= now() - interval '30 days')::int, true),
          (2, 'record', 'Medical records', (select max(at) from private.activity where user_id = u.id and kind = 'record'), (select count(distinct private.day(at)) from private.activity where user_id = u.id and kind = 'record' and at >= now() - interval '30 days')::int, true),
          (3, 'file', 'Documents', (select max(at) from private.activity where user_id = u.id and kind = 'file'), (select count(distinct private.day(at)) from private.activity where user_id = u.id and kind = 'file' and at >= now() - interval '30 days')::int, true),
          (4, 'medicine', 'Medicine management', (select max(at) from private.activity where user_id = u.id and kind = 'medicine'), (select count(distinct private.day(at)) from private.activity where user_id = u.id and kind = 'medicine' and at >= now() - interval '30 days')::int, true),
          (5, 'schedule', 'Medicine schedules', (select max(m.updated_at) from public.medicines m join public.medication_schedules s on s.medicine_id = m.id where m.user_id = u.id and s.frequency <> 'as_needed'), (select count(distinct private.day(m.updated_at)) from public.medicines m join public.medication_schedules s on s.medicine_id = m.id where m.user_id = u.id and s.frequency <> 'as_needed' and m.updated_at >= now() - interval '30 days')::int, true),
          (6, 'dose', 'Dose tracking', (select max(recorded_at) from public.dose_events where user_id = u.id), (select count(distinct private.day(recorded_at)) from public.dose_events where user_id = u.id and recorded_at >= now() - interval '30 days')::int, true),
          (7, 'search', 'Search', (select max(at) from private.analytics_events where user_id = u.id and name = 'search_performed'), (select count(distinct private.day(at)) from private.analytics_events where user_id = u.id and name = 'search_performed' and at >= now() - interval '30 days')::int, false),
          (8, 'export', 'Export', (select max(at) from private.analytics_events where user_id = u.id and name = 'record_exported'), (select count(distinct private.day(at)) from private.analytics_events where user_id = u.id and name = 'record_exported' and at >= now() - interval '30 days')::int, false)
        ) f(ord, key, label, last, days, measured)),
      'uploads', jsonb_build_object(
        'failed_30d', (select count(*) from private.analytics_events where user_id = u.id and name = 'document_upload_failed' and at >= now() - interval '30 days'),
        'processing_failed_30d', (select count(*) from private.analytics_events where user_id = u.id and name = 'document_processing_failed' and at >= now() - interval '30 days')),
      'notes', case when can_notes then coalesce((select jsonb_agg(jsonb_build_object('at', n.created_at, 'body', n.body, 'author', (select email from auth.users where id = n.author)) order by n.created_at desc)
                 from private.support_notes n where n.user_id = u.id), '[]'::jsonb) end,
      'admin_actions', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'outcome', l.outcome, 'reason', l.reason, 'by', (select email from auth.users where id = l.actor)) order by l.at desc)
                 from (select * from private.admin_audit_log where target_type = 'user' and target_id = u.id::text order by at desc limit 30) l), '[]'::jsonb))
    from auth.users u where u.id = p_user);
end $$;

-- ---------- Health profile analytics (platform-wide; counts only) ----------
create or replace function public.admin_profile_analytics(p_actor uuid, p_from timestamptz, p_to timestamptz, p_inactive_days int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare win int := least(greatest(coalesce(p_inactive_days, 14), 1), 180);
begin
  perform private.require(p_actor, 'analytics.view');
  if p_to <= p_from or p_to - p_from > interval '3700 days' then raise exception 'invalid period' using errcode = '22023'; end if;
  return (with us as (
      select u.id, u.created_at, private.profile_sections(u.id) j, (select max(at) from private.activity a where a.user_id = u.id) last_act,
             (select max(at) from private.profile_events e where e.user_id = u.id and e.section <> 'profile') last_save
      from auth.users u where coalesce(u.is_anonymous, false) = false and u.deleted_at is null),
    secs as (select us.id, us.last_act, us.last_save, s.ord, s.x from us cross join lateral jsonb_array_elements(us.j->'sections') with ordinality s(x, ord)),
    -- where people stop: the first section in order that isn't complete, for people who started but haven't finished,
    -- counted as "stopped" only after the inactivity window with no meaningful activity
    stop as (select distinct on (id) id, x->>'key' k, x->>'label' lbl from secs
             where (select (j->>'started')::boolean and (j->>'pct')::int < 100 from us where us.id = secs.id) and x->>'status' <> 'complete'
               and (last_act is null or last_act < now() - make_interval(days => win)) order by id, ord),
    days as (select generate_series(private.day(p_from), private.day(p_to - interval '1 second'), interval '1 day')::date d)
    select jsonb_build_object(
      'tracking_since', (select started_at from private.profile_tracking), 'inactive_days', win,
      'users_total', (select count(*) from us),
      'started', (select count(*) from us where (j->>'started')::boolean),
      'completed', (select count(*) from us where (j->>'pct')::int = 100),
      'avg_pct', coalesce((select round(avg((j->>'pct')::int), 1) from us), 0),
      'distribution', (select jsonb_agg(jsonb_build_object('band', b.band, 'label', b.label, 'n', (select count(*) from us where (not (j->>'started')::boolean and b.band = 'none') or ((j->>'started')::boolean and (j->>'pct')::int between b.lo and b.hi and b.band <> 'none'))) order by b.o)
        from (values (0, 'none', 'Not started', -1, -1), (1, 'lt25', '1–24%', 0, 24), (2, '25_49', '25–49%', 25, 49), (3, '50_74', '50–74%', 50, 74), (4, '75_99', '75–99%', 75, 99), (5, 'full', '100%', 100, 100)) b(o, band, label, lo, hi)),
      'sections', (select jsonb_agg(jsonb_build_object('key', k, 'label', lbl, 'started', st, 'completed', done, 'avg_pct', avgp, 'stopped_here', (select count(*) from stop where stop.k = z.k)) order by o)
        from (select x->>'key' k, x->>'label' lbl, min(ord) o, count(*) filter (where x->>'status' <> 'not_started') st, count(*) filter (where x->>'status' = 'complete') done,
                     round(avg((x->>'pct')::int), 1) avgp from secs group by 1, 2) z),
      'stopped_total', (select count(*) from stop),
      'returned_after_save', (select count(*) from us where last_save is not null and last_act > last_save + interval '1 hour'),
      -- successful saves (tracked since tracking began), per day and per section, in the period
      'saves_by_day', (select jsonb_agg(jsonb_build_object('day', d, 'people', (select count(distinct user_id) from private.profile_events e where private.day(e.at) = days.d and e.section <> 'profile'),
                        'saves', (select count(*) from private.profile_events e where private.day(e.at) = days.d and e.section <> 'profile'),
                        'started', (select count(*) from (select user_id, min(at) f from private.profile_events where section <> 'profile' group by user_id) fs where private.day(fs.f) = days.d)) order by d) from days),
      'saves_by_section', (select coalesce(jsonb_object_agg(section, n), '{}') from (select section, count(distinct user_id) n from private.profile_events where at >= p_from and at < p_to and section <> 'profile' group by section) s),
      -- opening a section (only people who allowed measurements), in the period
      'opened_by_section', (select coalesce(jsonb_object_agg(sec, n), '{}') from (select props->>'section' sec, count(distinct user_id) n from private.analytics_events where name = 'profile_section_opened' and at >= p_from and at < p_to group by 1) o),
      'measured_people', (select count(distinct user_id) from private.analytics_events where at >= p_from and at < p_to)));
end $$;

do $$ declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('admin_users', 'admin_user', 'admin_profile_analytics') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
