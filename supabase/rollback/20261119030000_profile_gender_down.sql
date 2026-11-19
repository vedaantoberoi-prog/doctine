-- Rollback for 20261119030000_profile_gender.sql: the six-detail completion, then the column. People's gender answers are lost.
create or replace function private.profile_completion(h public.health_profiles, meta jsonb,
  out filled int, out total int, out pct int, out fields jsonb) language sql stable
  set search_path = public, extensions, pg_temp as $$
  with f as (select jsonb_build_object(
      'name', coalesce(nullif(trim(h.full_name), ''), private.account_name(meta)) is not null,
      'date_of_birth', h.date_of_birth is not null,
      'height', h.height_cm is not null,
      'weight', h.weight_kg is not null,
      'blood_group', nullif(trim(h.blood_group), '') is not null,
      'allergies', nullif(trim(h.allergies), '') is not null) j)
  select (select count(*)::int from jsonb_each(j) where value = 'true'::jsonb), 6,
         round(100.0 * (select count(*) from jsonb_each(j) where value = 'true'::jsonb) / 6)::int, j from f $$;
create or replace function private.profile_has_details(h public.health_profiles) returns boolean language sql immutable
  set search_path = public, extensions, pg_temp as $$
  select coalesce(h.date_of_birth::text, h.height_cm::text, h.weight_kg::text, nullif(h.blood_group, ''), nullif(h.allergies, '')) is not null $$;
alter table public.health_profiles drop column if exists gender;
