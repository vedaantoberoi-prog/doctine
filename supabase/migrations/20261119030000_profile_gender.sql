-- Doctine · gender in the health profile (19 Nov 2026).
-- One new optional column; existing profiles are unchanged (gender stays empty until the person picks one).
-- "Prefer not to say" is a valid answer and counts as filled in. The admin console's profile completion now counts seven
-- details instead of six, and still only ever sees whether each one is filled in, never the answer.
-- Rollback: supabase/rollback/20261119030000_profile_gender_down.sql

alter table public.health_profiles
  add column if not exists gender text check (gender in ('female', 'male', 'non_binary', 'other', 'prefer_not_to_say'));

create or replace function private.profile_completion(h public.health_profiles, meta jsonb,
  out filled int, out total int, out pct int, out fields jsonb) language sql stable
  set search_path = public, extensions, pg_temp as $$
  with f as (select jsonb_build_object(
      'name', coalesce(nullif(trim(h.full_name), ''), private.account_name(meta)) is not null,
      'date_of_birth', h.date_of_birth is not null,
      'gender', h.gender is not null,
      'height', h.height_cm is not null,
      'weight', h.weight_kg is not null,
      'blood_group', nullif(trim(h.blood_group), '') is not null,
      'allergies', nullif(trim(h.allergies), '') is not null) j)
  select (select count(*)::int from jsonb_each(j) where value = 'true'::jsonb), 7,
         round(100.0 * (select count(*) from jsonb_each(j) where value = 'true'::jsonb) / 7)::int, j from f $$;
revoke all on function private.profile_completion(public.health_profiles, jsonb) from public, anon, authenticated;

create or replace function private.profile_has_details(h public.health_profiles) returns boolean language sql immutable
  set search_path = public, extensions, pg_temp as $$
  select coalesce(h.date_of_birth::text, h.gender, h.height_cm::text, h.weight_kg::text, nullif(h.blood_group, ''), nullif(h.allergies, '')) is not null $$;
