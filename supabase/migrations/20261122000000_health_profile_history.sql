-- Doctine · complete health profile and medical history (22 Nov 2026).
-- Additive only: new optional columns, one new table for structured history, and one change log. Nothing existing is
-- dropped, renamed or rewritten, and every existing row stays valid.
--
--   health_profiles  + personal details (sex assigned at birth, contact phone and email, city, country, emergency contact),
--                      body measurements (units, waist, date measured) and three small JSON objects the app fills in:
--                      lifestyle (diet, activity, sleep, habits), history_answers (the explicit "yes / no / not sure /
--                      prefer not to say" per section, so an empty list is never read as "none") and womens_health.
--                      The account email (auth.users) is untouched: contact_email is a separate, optional field.
--   medicines        + category (regular / occasional), generic name, route, reason, prescriber, last used, how often
--                      (occasional), notes, why it was stopped and whether on medical advice. "Discontinued" is the existing status 'completed'.
--                      start_date may now be empty for an occasional or discontinued medicine (a date is never invented).
--   health_records   one row per condition, past illness, surgery, hospital stay, other history item, allergy, medical
--                      device or family-history entry. Where it came from (user / clinician / document / import) and,
--                      optionally, the document it came from, are kept with it.
--   health_record_changes  who changed which record and when (insert / update / delete). Never the content itself.
--
-- Same owner-only rules as every other health table: each person reads and changes only their own rows, signed-out
-- visitors get nothing, and everything goes when the account is deleted.
-- Rollback: supabase/rollback/20261122000000_health_profile_history_down.sql

-- ---------- health_profiles ----------
alter table public.health_profiles
  add column if not exists sex_at_birth text check (sex_at_birth in ('female', 'male', 'intersex', 'prefer_not_to_say')),
  add column if not exists phone text check (phone ~ '^\+?[0-9][0-9 ()-]{5,22}$'),
  add column if not exists contact_email text check (char_length(contact_email) <= 254 and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column if not exists city text check (char_length(city) between 1 and 80),
  add column if not exists country text check (char_length(country) between 1 and 80),
  add column if not exists emergency_name text check (char_length(emergency_name) between 1 and 120),
  add column if not exists emergency_relationship text check (char_length(emergency_relationship) between 1 and 60),
  add column if not exists emergency_phone text check (emergency_phone ~ '^\+?[0-9][0-9 ()-]{5,22}$'),
  add column if not exists units text check (units in ('metric', 'imperial')),
  add column if not exists waist_cm numeric(5,1) check (waist_cm between 30 and 250),
  add column if not exists measured_on date check (measured_on between '1900-01-01' and current_date),
  add column if not exists lifestyle jsonb check (jsonb_typeof(lifestyle) = 'object' and pg_column_size(lifestyle) <= 8000),
  add column if not exists history_answers jsonb check (
    jsonb_typeof(history_answers) = 'object'
    and (history_answers - array['conditions', 'past', 'surgery', 'hosp', 'other', 'allergies', 'devices', 'family', 'meds_regular', 'meds_occasional']) = '{}'::jsonb
    and not jsonb_path_exists(history_answers, '$.* ? (@ != "yes" && @ != "no" && @ != "not_sure" && @ != "prefer_not" && @ != "nka" && @ != "not_assessed")')),
  add column if not exists womens_health jsonb check (jsonb_typeof(womens_health) = 'object' and pg_column_size(womens_health) <= 4000);

-- ---------- medicines ----------
alter table public.medicines
  add column if not exists category text not null default 'regular' check (category in ('regular', 'occasional')),
  add column if not exists generic_name text check (char_length(generic_name) between 1 and 120),
  add column if not exists route text check (route in ('oral', 'topical', 'injection', 'inhalation', 'other')),
  add column if not exists reason text check (char_length(reason) between 1 and 200),
  add column if not exists prescriber text check (char_length(prescriber) between 1 and 120),
  add column if not exists last_used date,
  add column if not exists stop_reason text check (char_length(stop_reason) between 1 and 300),
  add column if not exists stopped_on_advice text check (stopped_on_advice in ('yes', 'no', 'unknown')),
  add column if not exists use_frequency text check (char_length(use_frequency) between 1 and 120),   -- how often an occasional medicine is taken, in the person's words
  add column if not exists notes text check (char_length(notes) between 1 and 1000);
-- An occasional or discontinued medicine may have no known start date; a current regular one still needs it (reminders).
alter table public.medicines alter column start_date drop not null;
alter table public.medicines drop constraint if exists medicines_start_known;
alter table public.medicines add constraint medicines_start_known
  check (start_date is not null or category = 'occasional' or status = 'completed');

-- ---------- health_records ----------
create table if not exists public.health_records (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id          bigint not null,
  kind               text not null check (kind in ('condition', 'past_illness', 'surgery', 'hospitalization', 'other_history', 'allergy', 'device', 'family')),
  title              text not null check (char_length(title) between 1 and 160),
  status             text,
  category           text,
  severity           text check (severity in ('mild', 'moderate', 'severe', 'unknown')),
  certainty          text check (certainty in ('confirmed', 'suspected', 'intolerance', 'adverse_reaction')),
  onset              text check (onset ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$'),   -- a year, a month or a day; never more precise than the person knows
  details            jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 8000),
  source             text not null default 'user' check (source in ('user', 'clinician', 'document', 'import')),
  source_document_id uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, client_id),
  unique (id, user_id),
  foreign key (source_document_id, user_id) references public.documents (id, user_id) on delete set null (source_document_id),
  -- what each kind of record may say about itself
  check (coalesce(case kind
    when 'condition'       then (status is null or status in ('active', 'controlled', 'remission', 'resolved', 'unknown')) and category is null and certainty is null
    when 'past_illness'    then (status is null or status in ('recovered', 'ongoing_effects', 'recurring', 'unknown')) and category is null and severity is null and certainty is null
    when 'surgery'         then (status is null or status in ('recovered', 'recovering', 'ongoing_effects', 'unknown')) and category is null and severity is null and certainty is null
    when 'hospitalization' then status is null and category is null and severity is null and certainty is null
    when 'other_history'   then status is null and category in ('transfusion', 'injury', 'transplant', 'cancer', 'neurological', 'cardiovascular', 'other') and severity is null and certainty is null
    when 'allergy'         then status is null and category in ('medication', 'food', 'environmental', 'insect', 'latex', 'other') and certainty is not null
    when 'device'          then (status is null or status in ('in_use', 'removed', 'unknown')) and (category is null or category in ('implanted', 'external', 'wearable', 'other')) and severity is null and certainty is null
    when 'family'          then (status is null or status in ('living', 'deceased', 'unknown')) and category in ('mother', 'father', 'brother', 'sister', 'maternal_grandfather', 'maternal_grandmother', 'paternal_grandfather', 'paternal_grandmother', 'son', 'daughter', 'other') and severity is null and certainty is null
  end, false))
);
create index if not exists health_records_user_kind_idx on public.health_records (user_id, kind);
create index if not exists health_records_source_document_idx on public.health_records (source_document_id) where source_document_id is not null;

drop trigger if exists health_records_touch on public.health_records;
create trigger health_records_touch before update on public.health_records for each row execute function public.touch_updated_at();

alter table public.health_records enable row level security;
alter table public.health_records force row level security;
drop policy if exists "health_records: owner reads" on public.health_records;
drop policy if exists "health_records: owner adds" on public.health_records;
drop policy if exists "health_records: owner changes" on public.health_records;
drop policy if exists "health_records: owner removes" on public.health_records;
create policy "health_records: owner reads" on public.health_records for select to authenticated using (user_id = auth.uid());
create policy "health_records: owner adds" on public.health_records for insert to authenticated with check (user_id = auth.uid());
create policy "health_records: owner changes" on public.health_records for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "health_records: owner removes" on public.health_records for delete to authenticated using (user_id = auth.uid());
revoke all on public.health_records from anon, public;
grant select, insert, update, delete on public.health_records to authenticated;

-- ---------- change log: which record changed, how and when; never its content ----------
create table if not exists public.health_record_changes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  record_id  uuid not null,
  kind       text not null,
  action     text not null check (action in ('insert', 'update', 'delete')),
  fields     text[] not null default '{}',                    -- names of the columns that changed, for updates
  changed_at timestamptz not null default now()
);
create index if not exists health_record_changes_user_idx on public.health_record_changes (user_id, changed_at desc);
alter table public.health_record_changes enable row level security;
alter table public.health_record_changes force row level security;
drop policy if exists "health_record_changes: owner reads" on public.health_record_changes;
create policy "health_record_changes: owner reads" on public.health_record_changes for select to authenticated using (user_id = auth.uid());
revoke all on public.health_record_changes from anon, public, authenticated;
grant select on public.health_record_changes to authenticated;

create or replace function private.log_health_record_change() returns trigger language plpgsql security definer
  set search_path = public, extensions, pg_temp as $$
declare changed text[] := '{}';
begin
  -- the account itself is being deleted (its rows go with it): there is nobody left to keep a log for
  if tg_op = 'DELETE' and not exists (select 1 from auth.users where id = old.user_id) then return old; end if;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}') into changed
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value and n.key not in ('updated_at');
    if cardinality(changed) = 0 then return new; end if;
  end if;
  insert into public.health_record_changes (user_id, record_id, kind, action, fields)
  values (coalesce(new.user_id, old.user_id), coalesce(new.id, old.id), coalesce(new.kind, old.kind), lower(tg_op), changed);
  return coalesce(new, old);
end $$;
revoke all on function private.log_health_record_change() from public, anon, authenticated;
drop trigger if exists health_records_log on public.health_records;
create trigger health_records_log after insert or update or delete on public.health_records
  for each row execute function private.log_health_record_change();
