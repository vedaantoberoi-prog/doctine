-- Rollback for 20261122000000_health_profile_history.sql.
-- WARNING: removes the structured medical history, its change log and the new profile and medicine details.
-- Take a backup first. Medicines saved without a start date get today's date so the old NOT NULL rule can return.
drop trigger if exists health_records_log on public.health_records;
drop function if exists private.log_health_record_change();
drop table if exists public.health_record_changes;
drop table if exists public.health_records;

alter table public.medicines drop constraint if exists medicines_start_known;
update public.medicines set start_date = current_date where start_date is null;
alter table public.medicines alter column start_date set not null;
alter table public.medicines
  drop column if exists category, drop column if exists generic_name, drop column if exists route, drop column if exists reason,
  drop column if exists prescriber, drop column if exists last_used, drop column if exists stop_reason, drop column if exists stopped_on_advice,
  drop column if exists use_frequency, drop column if exists notes;

alter table public.health_profiles
  drop column if exists sex_at_birth, drop column if exists phone, drop column if exists contact_email, drop column if exists city,
  drop column if exists country, drop column if exists emergency_name, drop column if exists emergency_relationship,
  drop column if exists emergency_phone, drop column if exists units, drop column if exists waist_cm, drop column if exists measured_on,
  drop column if exists lifestyle, drop column if exists history_answers, drop column if exists womens_health;
