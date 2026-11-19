-- Doctine · medicine details for the redesigned Add medicine form (19 Nov 2026).
-- Additive only. Existing rows, policies and the `dose` column are unchanged; nothing is dropped or rewritten.
--   medicines:            brand, strength (e.g. "500 mg"), form (tablet, syrup…), dose_amount + dose_unit (e.g. "1" + "tablet"),
--                         instructions (e.g. "After food"). All optional, so older app versions keep working.
--   medication_schedules: interval_hours ("every 6 hours", stored alongside the concrete times it produces), and a new
--                         frequency 'as_needed' (taken only when needed: no reminder times). The checks are widened for that.
-- `dose` stays required: the app fills it with the amount and unit ("1 tablet"), so older app versions still show a dose.
-- Rollback: supabase/rollback/20261119000000_medicine_details_down.sql

alter table public.medicines
  add column if not exists brand        text check (brand is null or char_length(brand) between 1 and 120),
  add column if not exists strength     text check (strength is null or char_length(strength) between 1 and 60),
  add column if not exists form         text check (form is null or char_length(form) between 1 and 40),
  add column if not exists dose_amount  text check (dose_amount is null or char_length(dose_amount) between 1 and 20),
  add column if not exists dose_unit    text check (dose_unit is null or char_length(dose_unit) between 1 and 30),
  add column if not exists instructions text check (instructions is null or char_length(instructions) between 1 and 500);

alter table public.medication_schedules
  add column if not exists interval_hours smallint check (interval_hours is null or interval_hours between 1 and 24);

-- Widen the schedule checks for 'as_needed' (the original names come from 20261104000000_doctine_core.sql).
alter table public.medication_schedules drop constraint if exists medication_schedules_frequency_check;
alter table public.medication_schedules add constraint medication_schedules_frequency_check
  check (frequency in ('daily', 'weekly', 'as_needed'));

alter table public.medication_schedules drop constraint if exists medication_schedules_times_check;
alter table public.medication_schedules add constraint medication_schedules_times_check
  check (case when frequency = 'as_needed' then cardinality(times) = 0 else cardinality(times) between 1 and 12 end);

alter table public.medication_schedules drop constraint if exists medication_schedules_check;
alter table public.medication_schedules add constraint medication_schedules_check
  check (frequency <> 'weekly' or cardinality(days_of_week) > 0);

alter table public.medication_schedules drop constraint if exists schedule_times_valid;
alter table public.medication_schedules add constraint schedule_times_valid
  check (cardinality(times) = 0 or public.valid_times(times));

alter table public.medication_schedules drop constraint if exists schedule_interval_daily;
alter table public.medication_schedules add constraint schedule_interval_daily
  check (interval_hours is null or frequency = 'daily');
