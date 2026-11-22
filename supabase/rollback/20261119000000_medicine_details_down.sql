-- Rollback for 20261119000000_medicine_details.sql. Run only after the app version that writes these fields is rolled back.
-- It refuses to run while any "only when needed" schedule exists, because the original checks require at least one time.
do $$ begin
  if exists (select 1 from public.medication_schedules where frequency = 'as_needed') then
    raise exception 'Rollback stopped: % schedule(s) are "as needed". Give them times or remove them first.',
      (select count(*) from public.medication_schedules where frequency = 'as_needed');
  end if;
end $$;

alter table public.medication_schedules drop constraint if exists schedule_interval_daily;
alter table public.medication_schedules drop constraint if exists schedule_times_valid;
alter table public.medication_schedules add constraint schedule_times_valid check (public.valid_times(times));
alter table public.medication_schedules drop constraint if exists medication_schedules_check;
alter table public.medication_schedules add constraint medication_schedules_check check (frequency = 'daily' or cardinality(days_of_week) > 0);
alter table public.medication_schedules drop constraint if exists medication_schedules_times_check;
alter table public.medication_schedules add constraint medication_schedules_times_check check (cardinality(times) between 1 and 12);
alter table public.medication_schedules drop constraint if exists medication_schedules_frequency_check;
alter table public.medication_schedules add constraint medication_schedules_frequency_check check (frequency in ('daily', 'weekly'));
alter table public.medication_schedules drop column if exists interval_hours;

-- The new medicine columns hold only what people typed. Dropping them loses that detail (dose text is kept).
alter table public.medicines
  drop column if exists instructions, drop column if exists dose_unit, drop column if exists dose_amount,
  drop column if exists form, drop column if exists strength, drop column if exists brand;
