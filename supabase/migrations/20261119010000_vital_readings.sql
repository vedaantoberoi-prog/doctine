-- Doctine · health readings the person adds themselves (19 Nov 2026): heart rate, blood pressure, blood glucose,
-- oxygen saturation and weight, each with its unit and when it was measured.
-- A new table only; nothing existing changes. Same owner-only rules as every other health table: each person reads and
-- changes only their own readings, signed-out visitors get nothing, and readings go when the account is deleted.
-- The app never invents readings and never labels one as healthy or unhealthy; the checks below only refuse values that
-- can't be a real measurement (a typing slip), not unusual ones.
-- Rollback: supabase/rollback/20261119010000_vital_readings_down.sql

create table if not exists public.vital_readings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id   bigint not null,
  kind        text not null check (kind in ('heart_rate', 'blood_pressure', 'glucose', 'spo2', 'weight')),
  value       numeric(6,1) not null,
  value2      numeric(6,1),                                   -- diastolic, for blood pressure only
  unit        text not null check (unit in ('bpm', 'mmHg', 'mg/dL', '%', 'kg')),
  context     text check (context in ('fasting', 'after_meal', 'random')),   -- blood glucose only
  note        text check (note is null or char_length(note) between 1 and 200),
  source      text not null default 'manual' check (source in ('manual')),
  measured_at timestamptz not null,
  created_at  timestamptz not null default now(),
  unique (user_id, client_id),
  check (coalesce(case kind
    when 'heart_rate'     then unit = 'bpm'   and value between 20 and 250 and value2 is null
    when 'blood_pressure' then unit = 'mmHg'  and value between 50 and 260 and value2 is not null and value2 between 30 and 160 and value2 < value
    when 'glucose'        then unit = 'mg/dL' and value between 20 and 600 and value2 is null
    when 'spo2'           then unit = '%'     and value between 50 and 100 and value2 is null
    when 'weight'         then unit = 'kg'    and value between 1 and 500 and value2 is null
  end, false)),
  check (context is null or kind = 'glucose')
);
create index if not exists vital_readings_user_kind_idx on public.vital_readings (user_id, kind, measured_at desc);

alter table public.vital_readings enable row level security;
alter table public.vital_readings force row level security;
drop policy if exists "vital_readings: owner reads" on public.vital_readings;
drop policy if exists "vital_readings: owner adds" on public.vital_readings;
drop policy if exists "vital_readings: owner changes" on public.vital_readings;
drop policy if exists "vital_readings: owner removes" on public.vital_readings;
create policy "vital_readings: owner reads" on public.vital_readings for select to authenticated using (user_id = auth.uid());
create policy "vital_readings: owner adds" on public.vital_readings for insert to authenticated with check (user_id = auth.uid());
create policy "vital_readings: owner changes" on public.vital_readings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "vital_readings: owner removes" on public.vital_readings for delete to authenticated using (user_id = auth.uid());
revoke all on public.vital_readings from anon;
grant select, insert, update, delete on public.vital_readings to authenticated;
