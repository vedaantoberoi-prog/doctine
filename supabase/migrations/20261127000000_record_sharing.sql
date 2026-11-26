-- Doctine · patient-controlled record sharing with a verified doctor (27 Nov 2026). Builds on 20261126000000_doctor_onboarding.
--
-- A person chooses one verified doctor (by the doctor's sharing code), which parts of their record to share, for how
-- long (1, 7 or 30 days) and why. They can stop sharing at any time and see every time the doctor opened something.
--   * private.record_shares: one row per grant (person, doctor, parts, purpose, until, stopped).
--   * private.record_access_log: append-only; one row each time a doctor opens one part of a shared record.
--   * private.practitioners.share_code: a 10-character code a VERIFIED doctor gives to patients.
--   * The `record_sharing` switch (off, Founder only).
-- A doctor sees a shared record only while: the share is active (not stopped, not expired), the doctor is VERIFIED
-- (suspension or lapse ends access at once), and only the parts that were shared. Nothing is copied: each opening reads
-- the live record and is logged. Files (scans, PDFs) are not shared in this phase, only their titles and dates.
-- Staff see counts only. No data changes for anyone who doesn't share. Rollback: supabase/rollback/20261127000000_record_sharing_down.sql

alter table private.practitioners add column if not exists share_code text unique check (share_code is null or share_code ~ '^[A-HJ-NP-Z2-9]{10}$');

create table if not exists private.record_shares (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid not null references auth.users (id) on delete cascade,
  practitioner_id  uuid not null references private.practitioners (user_id) on delete cascade,
  scopes           text[] not null check (cardinality(scopes) between 1 and 6 and scopes <@ array['profile', 'allergies', 'medicines', 'history', 'labs', 'documents']),
  purpose          text not null check (purpose in ('consultation', 'second_opinion', 'follow_up', 'other')),
  note             text check (note is null or char_length(note) <= 300),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  check (patient_id <> practitioner_id),
  check (expires_at > created_at and expires_at <= created_at + interval '30 days 1 minute')
);
create index if not exists record_shares_patient on private.record_shares (patient_id, created_at desc);
create index if not exists record_shares_practitioner on private.record_shares (practitioner_id, expires_at);

create table if not exists private.record_access_log (
  id               bigserial primary key,
  share_id         uuid not null references private.record_shares (id) on delete cascade,
  patient_id       uuid not null references auth.users (id) on delete cascade,
  practitioner_id  uuid not null,
  scope            text not null,
  items            int not null default 0,
  at               timestamptz not null default now()
);
create index if not exists record_access_log_patient on private.record_access_log (patient_id, at desc);

create or replace function private.record_access_append_only() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  -- Removed only with the person's account or the share itself (foreign-key cascades).
  if tg_op = 'DELETE' and (not exists (select 1 from auth.users where id = old.patient_id) or not exists (select 1 from private.record_shares where id = old.share_id)) then return old; end if;
  raise exception 'the access log cannot be changed or deleted' using errcode = '42501';
end $$;
drop trigger if exists record_access_no_change on private.record_access_log;
create trigger record_access_no_change before update or delete on private.record_access_log for each row execute function private.record_access_append_only();

do $$ declare t text; begin
  foreach t in array array['record_shares', 'record_access_log'] loop
    execute format('alter table private.%I enable row level security', t);
    execute format('alter table private.%I force row level security', t);
    execute format('revoke all on private.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence private.record_access_log_id_seq from public, anon, authenticated;

-- ───────────── helpers ─────────────
create or replace function private.share_active(s private.record_shares) returns boolean language sql stable set search_path = pg_catalog, private as $$
  select s.revoked_at is null and s.expires_at > now()
     and exists (select 1 from private.practitioners p where p.user_id = s.practitioner_id and p.status = 'VERIFIED' and p.expires_at > now()) $$;

-- What a patient is shown about a doctor before and while sharing (the registration details the guidelines ask platforms to show).
create or replace function private.doctor_public(p private.practitioners) returns jsonb language sql stable set search_path = pg_catalog, private as $$
  select jsonb_build_object('name', p.full_name, 'registration_number', p.registration_number, 'registration_council', p.registration_council,
    'qualifications', (select coalesce(jsonb_agg(q->>'degree'), '[]'::jsonb) from jsonb_array_elements(p.qualifications) q), 'specialties', to_jsonb(p.specialties),
    'verified', p.status = 'VERIFIED' and p.expires_at > now(), 'verified_at', p.verified_at) $$;

create or replace function private.patient_display(p_patient uuid) returns jsonb language sql stable set search_path = pg_catalog, private, public as $$
  select jsonb_build_object(
    'name', coalesce(nullif(trim(h.full_name), ''), private.account_name(u.raw_user_meta_data), 'Doctine member'),
    'age', case when h.date_of_birth is not null then extract(year from age(current_date, h.date_of_birth))::int end,
    'sex_at_birth', h.sex_at_birth)
  from auth.users u left join public.health_profiles h on h.user_id = u.id where u.id = p_patient $$;

-- ───────────── the doctor's sharing code ─────────────
create or replace function public.practitioner_share_code(p_user uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare p private.practitioners; c text; tries int := 0;
begin
  select * into p from private.practitioners where user_id = p_user for update;
  if p.user_id is null or p.status <> 'VERIFIED' or p.expires_at <= now() then raise exception 'only a verified doctor has a sharing code' using errcode = '22023'; end if;
  if p.share_code is not null then return jsonb_build_object('code', p.share_code); end if;
  loop
    c := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 32), 1), '') from (select decode(replace(gen_random_uuid()::text, '-', ''), 'hex') b) x, generate_series(0, 9) i);
    begin
      update private.practitioners set share_code = c, updated_at = now() where user_id = p_user;
      return jsonb_build_object('code', c);
    exception when unique_violation then tries := tries + 1; if tries > 5 then raise; end if;
    end;
  end loop;
end $$;

-- ───────────── the patient's side (server only, with the id it verified from the sign-in token) ─────────────
create or replace function public.share_lookup(p_patient uuid, p_code text) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare p private.practitioners;
begin
  select * into p from private.practitioners where share_code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if p.user_id is null or p.status <> 'VERIFIED' or p.expires_at <= now() or p.user_id = p_patient then raise exception 'not found' using errcode = 'P0002'; end if;
  return private.doctor_public(p);
end $$;

create or replace function public.share_create(p_patient uuid, p_code text, p jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare d private.practitioners; days int := (p->>'days')::int; sid uuid;
  sc text[] := (select coalesce(array_agg(distinct s), '{}') from jsonb_array_elements_text(coalesce(p->'scopes', '[]'::jsonb)) s);
begin
  select * into d from private.practitioners where share_code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if d.user_id is null or d.status <> 'VERIFIED' or d.expires_at <= now() or d.user_id = p_patient then raise exception 'not found' using errcode = 'P0002'; end if;
  if days not in (1, 7, 30) then raise exception 'share for 1, 7 or 30 days' using errcode = '22023'; end if;
  if (p->>'confirm')::boolean is not true then raise exception 'please confirm' using errcode = '22023'; end if;
  if exists (select 1 from private.record_shares s where s.patient_id = p_patient and s.practitioner_id = d.user_id and s.revoked_at is null and s.expires_at > now()) then
    raise exception 'you are already sharing with this doctor; stop that share first to change it' using errcode = '22023';
  end if;
  if (select count(*) from private.record_shares s where s.patient_id = p_patient and s.revoked_at is null and s.expires_at > now()) >= 10 then
    raise exception 'at most 10 active shares' using errcode = '22023';
  end if;
  insert into private.record_shares (patient_id, practitioner_id, scopes, purpose, note, expires_at)
  values (p_patient, d.user_id, sc, p->>'purpose', nullif(left(trim(coalesce(p->>'note', '')), 300), ''), now() + make_interval(days => days)) returning id into sid;
  return jsonb_build_object('ok', true, 'id', sid);
end $$;

create or replace function public.share_list(p_patient uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  return jsonb_build_object(
    'shares', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'doctor', private.doctor_public(p), 'scopes', to_jsonb(s.scopes), 'purpose', s.purpose, 'note', s.note,
        'created_at', s.created_at, 'expires_at', s.expires_at, 'revoked_at', s.revoked_at, 'active', private.share_active(s),
        'opened', (select count(*) from private.record_access_log a where a.share_id = s.id), 'last_opened', (select max(at) from private.record_access_log a where a.share_id = s.id))
        order by private.share_active(s) desc, s.created_at desc)
      from private.record_shares s join private.practitioners p on p.user_id = s.practitioner_id
      where s.patient_id = p_patient and s.created_at > now() - interval '180 days'), '[]'::jsonb),
    'access', coalesce((select jsonb_agg(jsonb_build_object('doctor', p.full_name, 'scope', a.scope, 'items', a.items, 'at', a.at) order by a.at desc)
      from (select * from private.record_access_log where patient_id = p_patient order by at desc limit 50) a join private.practitioners p on p.user_id = a.practitioner_id), '[]'::jsonb));
end $$;

create or replace function public.share_revoke(p_patient uuid, p_id uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
begin
  update private.record_shares set revoked_at = now() where id = p_id and patient_id = p_patient and revoked_at is null;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- ───────────── the doctor's side ─────────────
create or replace function public.doctor_shares(p_doctor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  if not exists (select 1 from private.practitioners where user_id = p_doctor and status = 'VERIFIED' and expires_at > now()) then
    raise exception 'only a verified doctor can see shared records' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'patient', private.patient_display(s.patient_id), 'scopes', to_jsonb(s.scopes), 'purpose', s.purpose, 'note', s.note,
      'created_at', s.created_at, 'expires_at', s.expires_at) order by s.created_at desc)
    from private.record_shares s where s.practitioner_id = p_doctor and private.share_active(s)), '[]'::jsonb);
end $$;

-- One part of one shared record, read live, and logged. Each item says where it came from.
create or replace function public.doctor_share_record(p_doctor uuid, p_share uuid, p_scope text) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare s private.record_shares; u uuid; out jsonb; n int;
begin
  select * into s from private.record_shares where id = p_share;
  if s.id is null or s.practitioner_id <> p_doctor or not private.share_active(s) then raise exception 'not found' using errcode = 'P0002'; end if;
  if not (p_scope = any (s.scopes)) then raise exception 'that part was not shared' using errcode = '42501'; end if;
  u := s.patient_id;
  if p_scope = 'profile' then
    out := (select jsonb_build_object('full_name', h.full_name, 'date_of_birth', h.date_of_birth, 'age', case when h.date_of_birth is not null then extract(year from age(current_date, h.date_of_birth))::int end,
      'sex_at_birth', h.sex_at_birth, 'gender', h.gender, 'blood_group', h.blood_group, 'height_cm', h.height_cm, 'weight_kg', h.weight_kg, 'measured_on', h.measured_on, 'updated_at', h.updated_at, 'source', 'patient')
      from public.health_profiles h where h.user_id = u);
    n := case when out is null then 0 else 1 end;
  elsif p_scope = 'allergies' then
    out := jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('title', r.title, 'category', r.category, 'certainty', r.certainty, 'severity', r.severity, 'onset', r.onset,
        'reaction', r.details->>'reaction', 'source', r.source, 'updated_at', r.updated_at) order by r.title) from public.health_records r where r.user_id = u and r.kind = 'allergy'), '[]'::jsonb),
      'free_text', (select nullif(trim(allergies), '') from public.health_profiles where user_id = u),
      'answer', (select history_answers->>'allergies' from public.health_profiles where user_id = u));
    n := jsonb_array_length(out->'items');
  elsif p_scope = 'medicines' then
    out := jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('name', m.name, 'generic_name', m.generic_name, 'strength', m.strength, 'form', m.form, 'dose', m.dose, 'route', m.route,
        'category', m.category, 'status', case m.status when 'completed' then 'stopped' else m.status end, 'start_date', m.start_date, 'end_date', m.end_date, 'reason', m.reason, 'prescriber', m.prescriber,
        'stop_reason', m.stop_reason, 'instructions', m.instructions, 'source', case when m.source_document_id is not null then 'document' else 'patient' end, 'updated_at', m.updated_at)
        order by (m.status = 'completed'), m.name) from public.medicines m where m.user_id = u), '[]'::jsonb));
    n := jsonb_array_length(out->'items');
  elsif p_scope = 'history' then
    out := jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'title', r.title, 'status', r.status, 'certainty', r.certainty, 'severity', r.severity, 'onset', r.onset,
        'category', r.category, 'source', r.source, 'updated_at', r.updated_at) order by r.kind, r.onset desc nulls last, r.title)
      from public.health_records r where r.user_id = u and r.kind <> 'allergy'), '[]'::jsonb));
    n := jsonb_array_length(out->'items');
  elsif p_scope = 'labs' then
    out := jsonb_build_object('items', coalesce((select jsonb_agg(x order by x->>'date' desc nulls last, x->>'test') from (
        select jsonb_build_object('test', l.test, 'value', l.value, 'unit', l.unit, 'reference_range', l.reference_range, 'flag', l.flag, 'date', d.document_date,
          'report', d.title, 'source', case l.origin when 'user_entered' then 'patient' else 'ai_extracted' end, 'confidence', l.confidence) x
        from public.lab_results l join public.documents d on d.id = l.document_id and d.user_id = l.user_id where l.user_id = u order by d.document_date desc nulls last limit 300) y), '[]'::jsonb));
    n := jsonb_array_length(out->'items');
  elsif p_scope = 'documents' then
    out := jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('title', d.title, 'category', d.category, 'date', d.document_date, 'provider', d.provider, 'pages', d.page_count, 'added', d.created_at)
        order by d.document_date desc nulls last) from public.documents d where d.user_id = u), '[]'::jsonb), 'files_shared', false);
    n := jsonb_array_length(out->'items');
  else raise exception 'unknown part' using errcode = '22023';
  end if;
  insert into private.record_access_log (share_id, patient_id, practitioner_id, scope, items) values (s.id, u, p_doctor, p_scope, coalesce(n, 0));
  return jsonb_build_object('scope', p_scope, 'data', out, 'patient', private.patient_display(u), 'shared_until', s.expires_at, 'read_at', now());
end $$;

-- ───────────── leadership: counts only ─────────────
create or replace function public.admin_sharing_summary(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'doctors.view');
  return jsonb_build_object('active_shares', (select count(*) from private.record_shares s where private.share_active(s)),
    'shares_30d', (select count(*) from private.record_shares where created_at > now() - interval '30 days'),
    'stopped_30d', (select count(*) from private.record_shares where revoked_at > now() - interval '30 days'),
    'openings_30d', (select count(*) from private.record_access_log where at > now() - interval '30 days'));
end $$;

do $$ declare f text; begin
  foreach f in array array['practitioner_share_code(uuid)', 'share_lookup(uuid, text)', 'share_create(uuid, text, jsonb)', 'share_list(uuid)', 'share_revoke(uuid, uuid)',
    'doctor_shares(uuid)', 'doctor_share_record(uuid, uuid, text)', 'admin_sharing_summary(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['share_active(private.record_shares)', 'doctor_public(private.practitioners)', 'patient_display(uuid)', 'record_access_append_only()'] loop
    execute format('revoke all on function private.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ───────────── the `record_sharing` switch (off, Founder only) ─────────────
alter table private.feature_flags drop constraint if exists feature_flags_key_check;
alter table private.feature_flags add constraint feature_flags_key_check
  check (key in ('registrations', 'document_upload', 'pdf_reading', 'sample_data', 'ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian', 'doctor_onboarding', 'record_sharing', 'maintenance'));
insert into private.feature_flags (key, enabled) values ('record_sharing', false) on conflict (key) do nothing;

create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key in ('ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian', 'doctor_onboarding', 'record_sharing') then 'ai.manage' else 'flags.manage' end);
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
revoke all on function public.admin_set_flag(uuid, text, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_flag(uuid, text, boolean, text, text, text) to service_role;
