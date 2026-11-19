-- Rollback for 20261119010000_vital_readings.sql. Deletes every reading people have added, so it refuses to run while any exist.
do $$ begin
  if exists (select 1 from public.vital_readings) then
    raise exception 'Rollback stopped: % health reading(s) exist. Export or remove them first.', (select count(*) from public.vital_readings);
  end if;
end $$;
drop table if exists public.vital_readings;
