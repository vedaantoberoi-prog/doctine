-- Doctine · Doctor network, phase 1 (26 Nov 2026): doctor identity, credentials and a verification workflow.
--
-- What this adds:
--   * private.practitioners: a doctor's professional profile, keyed by their Doctine account. One per account.
--   * private.practitioner_documents: their credential files (registration certificate, degree, photo ID). The files
--     live in the private storage bucket `practitioner-credentials`; only the server (service role) reads or writes it.
--   * private.practitioner_events: an append-only history of every status change, with who made it, why, and (for a
--     verification) the evidence the reviewer recorded. It can't be edited or deleted.
--   * The verification state machine (the code's is netlify/lib/doctors/verification.mjs; the list of allowed
--     transitions is enforced here a second time):
--       NOT_STARTED → DOCUMENTS_SUBMITTED → UNDER_REVIEW → VERIFIED → SUSPENDED / EXPIRED_REQUIRES_REVERIFICATION,
--       with REJECTED, and resubmission after REJECTED or EXPIRED.
--   * Two new leadership permissions, doctors.view and doctors.verify (grantable; not in the standard set).
--   * The `doctor_onboarding` switch (off, Founder only).
--
-- What this does NOT do: no doctor is shown to patients, nothing is bookable, no consultation, prescription or payment
-- exists. VERIFIED means "Doctine staff checked this person's registration against an official register and recorded
-- the evidence", nothing more. A staff member can never verify their own application.
-- Nothing about existing medical records changes. Rollback: supabase/rollback/20261126000000_doctor_onboarding_down.sql

-- ───────────── the allowed transitions (must equal TRANSITION_LIST in verification.mjs; tests check) ─────────────
create table if not exists private.practitioner_allowed_transition (
  from_status text not null, to_status text not null, by_kind text not null check (by_kind in ('doctor', 'staff', 'system')),
  primary key (from_status, to_status, by_kind)
);
alter table private.practitioner_allowed_transition enable row level security;
alter table private.practitioner_allowed_transition force row level security;
revoke all on private.practitioner_allowed_transition from public, anon, authenticated;
delete from private.practitioner_allowed_transition;
insert into private.practitioner_allowed_transition (from_status, to_status, by_kind) values
-- transitions:begin
  ('NOT_STARTED', 'DOCUMENTS_SUBMITTED', 'doctor'), ('REJECTED', 'DOCUMENTS_SUBMITTED', 'doctor'), ('EXPIRED_REQUIRES_REVERIFICATION', 'DOCUMENTS_SUBMITTED', 'doctor'),
  ('DOCUMENTS_SUBMITTED', 'UNDER_REVIEW', 'staff'), ('DOCUMENTS_SUBMITTED', 'REJECTED', 'staff'),
  ('UNDER_REVIEW', 'VERIFIED', 'staff'), ('UNDER_REVIEW', 'REJECTED', 'staff'), ('UNDER_REVIEW', 'DOCUMENTS_SUBMITTED', 'staff'),
  ('VERIFIED', 'SUSPENDED', 'staff'), ('VERIFIED', 'EXPIRED_REQUIRES_REVERIFICATION', 'staff'), ('VERIFIED', 'EXPIRED_REQUIRES_REVERIFICATION', 'system'),
  ('SUSPENDED', 'VERIFIED', 'staff'), ('SUSPENDED', 'REJECTED', 'staff'), ('SUSPENDED', 'EXPIRED_REQUIRES_REVERIFICATION', 'system')
-- transitions:end
;

-- ───────────── tables ─────────────
create table if not exists private.practitioners (
  user_id               uuid primary key references auth.users (id) on delete cascade,
  status                text not null default 'NOT_STARTED' check (status in ('NOT_STARTED', 'DOCUMENTS_SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED', 'EXPIRED_REQUIRES_REVERIFICATION')),
  full_name             text check (full_name is null or char_length(full_name) between 2 and 120),
  registration_number   text check (registration_number is null or registration_number ~ '^[A-Za-z0-9/ .-]{2,40}$'),
  registration_council  text check (registration_council is null or char_length(registration_council) between 2 and 120),
  registration_year     int check (registration_year is null or registration_year between 1940 and 2100),
  qualifications        jsonb not null default '[]' check (jsonb_typeof(qualifications) = 'array' and jsonb_array_length(qualifications) <= 8),
  specialties           text[] not null default '{}' check (cardinality(specialties) <= 5),
  languages             text[] not null default '{}' check (cardinality(languages) <= 10),
  consultation_modes    text[] not null default '{}' check (consultation_modes <@ array['text', 'audio', 'video']),
  experience_years      int check (experience_years is null or experience_years between 0 and 70),
  bio                   text check (bio is null or char_length(bio) <= 1200),
  declaration_at        timestamptz,
  submitted_at          timestamptz,
  verified_at           timestamptz,
  verified_by           uuid references auth.users (id) on delete set null,
  expires_at            timestamptz,
  status_reason         text check (status_reason is null or char_length(status_reason) <= 1000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists practitioners_status on private.practitioners (status, submitted_at);

create table if not exists private.practitioner_documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references private.practitioners (user_id) on delete cascade,
  kind          text not null check (kind in ('registration_certificate', 'degree_certificate', 'photo_id', 'other')),
  storage_path  text not null unique check (char_length(storage_path) <= 200),
  file_name     text not null check (char_length(file_name) between 1 and 160),
  mime          text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes    int not null check (size_bytes between 1 and 5242880),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at   timestamptz not null default now(),
  removed_at    timestamptz
);
create index if not exists practitioner_documents_user on private.practitioner_documents (user_id, uploaded_at);

create table if not exists private.practitioner_events (
  id           bigserial primary key,
  user_id      uuid not null references private.practitioners (user_id) on delete cascade,
  from_status  text not null,
  to_status    text not null,
  by_kind      text not null check (by_kind in ('doctor', 'staff', 'system')),
  actor        uuid references auth.users (id) on delete set null,
  reason       text check (reason is null or char_length(reason) <= 1000),
  evidence     jsonb,
  at           timestamptz not null default now()
);
create index if not exists practitioner_events_user on private.practitioner_events (user_id, at);

create or replace function private.practitioner_events_append_only() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  -- Rows are removed only when the doctor's whole account is deleted (the foreign-key cascade), and the only change
  -- allowed is the database blanking `actor` when that staff member's own account is deleted (on delete set null).
  if tg_op = 'DELETE' and not exists (select 1 from private.practitioners where user_id = old.user_id) then return old; end if;
  if tg_op = 'UPDATE' and new.actor is null and old.actor is not null
     and (new.id, new.user_id, new.from_status, new.to_status, new.by_kind, new.reason, new.evidence, new.at)
         is not distinct from (old.id, old.user_id, old.from_status, old.to_status, old.by_kind, old.reason, old.evidence, old.at) then return new; end if;
  raise exception 'the verification history cannot be changed or deleted' using errcode = '42501';
end $$;
drop trigger if exists practitioner_events_no_change on private.practitioner_events;
create trigger practitioner_events_no_change before update or delete on private.practitioner_events for each row execute function private.practitioner_events_append_only();

do $$ declare t text; begin
  foreach t in array array['practitioners', 'practitioner_documents', 'practitioner_events'] loop
    execute format('alter table private.%I enable row level security', t);
    execute format('alter table private.%I force row level security', t);
    execute format('revoke all on private.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence private.practitioner_events_id_seq from public, anon, authenticated;

-- The credentials bucket: private, 5 MB, PDF/JPEG/PNG. No browser policies: only the server (service role) uses it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('practitioner-credentials', 'practitioner-credentials', false, 5242880, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ───────────── helpers ─────────────
create or replace function private.practitioner_editable(p_status text) returns boolean language sql immutable set search_path = pg_catalog as $$
  select p_status in ('NOT_STARTED', 'REJECTED', 'EXPIRED_REQUIRES_REVERIFICATION') $$;

-- What is still missing before an application can be submitted (empty = ready).
create or replace function private.practitioner_missing(p private.practitioners) returns text[] language sql stable set search_path = pg_catalog, private as $$
  select array_remove(array[
    case when p.full_name is null then 'full_name' end,
    case when p.registration_number is null then 'registration_number' end,
    case when p.registration_council is null then 'registration_council' end,
    case when p.registration_year is null then 'registration_year' end,
    case when jsonb_array_length(p.qualifications) = 0 then 'qualifications' end,
    case when cardinality(p.specialties) = 0 then 'specialties' end,
    case when cardinality(p.languages) = 0 then 'languages' end,
    case when p.declaration_at is null then 'declaration' end,
    case when not exists (select 1 from private.practitioner_documents d where d.user_id = p.user_id and d.kind = 'registration_certificate' and d.removed_at is null) then 'doc:registration_certificate' end,
    case when not exists (select 1 from private.practitioner_documents d where d.user_id = p.user_id and d.kind = 'degree_certificate' and d.removed_at is null) then 'doc:degree_certificate' end,
    case when not exists (select 1 from private.practitioner_documents d where d.user_id = p.user_id and d.kind = 'photo_id' and d.removed_at is null) then 'doc:photo_id' end
  ], null) $$;

-- Moves one application along an allowed transition and records it. Compare-and-set on the current status.
create or replace function private.practitioner_move(p_user uuid, p_from text, p_to text, p_by text, p_actor uuid, p_reason text, p_evidence jsonb)
returns void language plpgsql set search_path = pg_catalog, private as $$
begin
  if not exists (select 1 from private.practitioner_allowed_transition where from_status = p_from and to_status = p_to and by_kind = p_by) then
    raise exception 'that change is not allowed (% → % by %)', p_from, p_to, p_by using errcode = '22023';
  end if;
  update private.practitioners set status = p_to, updated_at = now(),
    status_reason = case when p_by in ('staff', 'system') and p_to in ('REJECTED', 'SUSPENDED', 'DOCUMENTS_SUBMITTED', 'EXPIRED_REQUIRES_REVERIFICATION') then left(p_reason, 1000) else null end,
    submitted_at = case when p_to = 'DOCUMENTS_SUBMITTED' and p_by = 'doctor' then now() else submitted_at end,
    verified_at = case when p_to = 'VERIFIED' and p_from = 'UNDER_REVIEW' then now() else verified_at end,
    verified_by = case when p_to = 'VERIFIED' and p_from = 'UNDER_REVIEW' then p_actor else verified_by end,
    expires_at = case when p_to = 'VERIFIED' and p_from = 'UNDER_REVIEW' then now() + interval '12 months' when p_to in ('REJECTED', 'DOCUMENTS_SUBMITTED') then null else expires_at end
  where user_id = p_user and status = p_from;
  if not found then raise exception 'the application changed meanwhile' using errcode = '40001'; end if;
  insert into private.practitioner_events (user_id, from_status, to_status, by_kind, actor, reason, evidence)
  values (p_user, p_from, p_to, p_by, p_actor, left(nullif(trim(p_reason), ''), 1000), p_evidence);
end $$;

-- Verification lapses 12 months after it was granted. Run on every read, so no scheduled job is needed.
create or replace function private.practitioner_expire() returns int language plpgsql set search_path = pg_catalog, private as $$
declare r record; n int := 0;
begin
  for r in select user_id, status from private.practitioners where status in ('VERIFIED', 'SUSPENDED') and expires_at is not null and expires_at <= now() for update skip locked loop
    perform private.practitioner_move(r.user_id, r.status, 'EXPIRED_REQUIRES_REVERIFICATION', 'system', null, 'Verification is more than 12 months old; the registration must be checked again.', null);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function private.practitioner_json(p private.practitioners, p_staff boolean) returns jsonb language sql stable set search_path = pg_catalog, private as $$
  select jsonb_build_object(
    'status', p.status, 'full_name', p.full_name, 'registration_number', p.registration_number, 'registration_council', p.registration_council,
    'registration_year', p.registration_year, 'qualifications', p.qualifications, 'specialties', to_jsonb(p.specialties), 'languages', to_jsonb(p.languages),
    'consultation_modes', to_jsonb(p.consultation_modes), 'experience_years', p.experience_years, 'bio', p.bio, 'declaration_at', p.declaration_at,
    'submitted_at', p.submitted_at, 'verified_at', p.verified_at, 'expires_at', p.expires_at, 'status_reason', p.status_reason,
    'created_at', p.created_at, 'updated_at', p.updated_at, 'editable', private.practitioner_editable(p.status), 'missing', to_jsonb(private.practitioner_missing(p)),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'file_name', d.file_name, 'mime', d.mime, 'size_bytes', d.size_bytes,
        'sha256', d.sha256, 'uploaded_at', d.uploaded_at, 'removed_at', d.removed_at) order by d.uploaded_at)
      from private.practitioner_documents d where d.user_id = p.user_id and (p_staff or d.removed_at is null)), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('from', e.from_status, 'to', e.to_status, 'by', e.by_kind, 'reason', e.reason, 'at', e.at)
        || case when p_staff then jsonb_build_object('actor_email', (select email from auth.users u where u.id = e.actor), 'evidence', e.evidence) else '{}'::jsonb end
        order by e.at, e.id) from private.practitioner_events e where e.user_id = p.user_id), '[]'::jsonb)) $$;

-- ───────────── the doctor's own application (server only, with the id it verified from the sign-in token) ─────────────
create or replace function public.practitioner_get(p_user uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare p private.practitioners;
begin
  perform private.practitioner_expire();
  select * into p from private.practitioners where user_id = p_user;
  if p.user_id is null then return jsonb_build_object('status', 'NOT_STARTED', 'exists', false, 'editable', true, 'documents', '[]'::jsonb, 'history', '[]'::jsonb); end if;
  return private.practitioner_json(p, false) || jsonb_build_object('exists', true);
end $$;

create or replace function public.practitioner_save(p_user uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare cur private.practitioners; quals jsonb := coalesce(p->'qualifications', '[]'::jsonb); q jsonb;
begin
  insert into private.practitioners (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into cur from private.practitioners where user_id = p_user for update;
  if not private.practitioner_editable(cur.status) then raise exception 'the application can not be changed while it is %', cur.status using errcode = '22023'; end if;
  if jsonb_typeof(quals) <> 'array' then raise exception 'qualifications must be a list' using errcode = '22023'; end if;
  for q in select * from jsonb_array_elements(quals) loop
    if jsonb_typeof(q) <> 'object' or char_length(coalesce(q->>'degree', '')) not between 2 and 80 or char_length(coalesce(q->>'institution', '')) not between 2 and 160
       or coalesce(q->>'year', '') !~ '^(19[4-9][0-9]|20[0-9][0-9])$' then raise exception 'each qualification needs a degree, an institution and a year' using errcode = '22023'; end if;
  end loop;
  update private.practitioners set
    full_name = nullif(left(trim(coalesce(p->>'full_name', '')), 120), ''),
    registration_number = nullif(upper(trim(coalesce(p->>'registration_number', ''))), ''),
    registration_council = nullif(left(trim(coalesce(p->>'registration_council', '')), 120), ''),
    registration_year = nullif(p->>'registration_year', '')::int,
    qualifications = (select coalesce(jsonb_agg(jsonb_build_object('degree', trim(x->>'degree'), 'institution', trim(x->>'institution'), 'year', (x->>'year')::int)), '[]'::jsonb) from jsonb_array_elements(quals) x),
    specialties = coalesce((select array_agg(distinct left(trim(s), 60)) from jsonb_array_elements_text(coalesce(p->'specialties', '[]'::jsonb)) s where trim(s) <> ''), '{}'),
    languages = coalesce((select array_agg(distinct left(trim(s), 40)) from jsonb_array_elements_text(coalesce(p->'languages', '[]'::jsonb)) s where trim(s) <> ''), '{}'),
    consultation_modes = coalesce((select array_agg(distinct s) from jsonb_array_elements_text(coalesce(p->'consultation_modes', '[]'::jsonb)) s), '{}'),
    experience_years = nullif(p->>'experience_years', '')::int,
    bio = nullif(left(trim(coalesce(p->>'bio', '')), 1200), ''),
    declaration_at = case when coalesce((p->>'declaration')::boolean, false) then coalesce(declaration_at, now()) else null end,
    updated_at = now()
  where user_id = p_user;
  return public.practitioner_get(p_user);
end $$;

create or replace function public.practitioner_document_add(p_user uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare st text; did uuid;
begin
  insert into private.practitioners (user_id) values (p_user) on conflict (user_id) do nothing;
  select status into st from private.practitioners where user_id = p_user for update;
  if not private.practitioner_editable(st) then raise exception 'documents can not be added while the application is %', st using errcode = '22023'; end if;
  if coalesce(p->>'path', '') not like p_user::text || '/%' then raise exception 'wrong storage path' using errcode = '22023'; end if;
  if (select count(*) from private.practitioner_documents where user_id = p_user and removed_at is null) >= 10 then raise exception 'at most 10 documents' using errcode = '22023'; end if;
  insert into private.practitioner_documents (user_id, kind, storage_path, file_name, mime, size_bytes, sha256)
  values (p_user, p->>'kind', p->>'path', left(p->>'file_name', 160), p->>'mime', (p->>'size_bytes')::int, lower(p->>'sha256')) returning id into did;
  return jsonb_build_object('id', did);
end $$;

-- Removing hides a document from the application; the file and its row are kept as part of the record.
create or replace function public.practitioner_document_remove(p_user uuid, p_id uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare st text;
begin
  select status into st from private.practitioners where user_id = p_user for update;
  if st is null or not private.practitioner_editable(st) then raise exception 'documents can not be removed now' using errcode = '22023'; end if;
  update private.practitioner_documents set removed_at = now() where id = p_id and user_id = p_user and removed_at is null;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.practitioner_submit(p_user uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare p private.practitioners; miss text[];
begin
  select * into p from private.practitioners where user_id = p_user for update;
  if p.user_id is null then raise exception 'nothing to submit yet' using errcode = '22023'; end if;
  miss := private.practitioner_missing(p);
  if cardinality(miss) > 0 then return jsonb_build_object('ok', false, 'error', 'incomplete', 'missing', to_jsonb(miss)); end if;
  perform private.practitioner_move(p_user, p.status, 'DOCUMENTS_SUBMITTED', 'doctor', p_user, null, null);
  return jsonb_build_object('ok', true) || public.practitioner_get(p_user);
end $$;

-- ───────────── leadership: the verification queue ─────────────
create or replace function public.admin_practitioners(p_actor uuid, p_status text) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'doctors.view');
  perform private.practitioner_expire();
  return jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from private.practitioners group by status) x), '{}'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'email', u.email, 'full_name', p.full_name, 'status', p.status,
        'registration_council', p.registration_council, 'specialties', to_jsonb(p.specialties), 'submitted_at', p.submitted_at, 'updated_at', p.updated_at,
        'expires_at', p.expires_at, 'documents', (select count(*) from private.practitioner_documents d where d.user_id = p.user_id and d.removed_at is null))
        order by p.submitted_at nulls last, p.updated_at desc)
      from (select * from private.practitioners where (coalesce(p_status, '') = '' and status <> 'NOT_STARTED') or status = p_status order by submitted_at nulls last limit 200) p
      join auth.users u on u.id = p.user_id), '[]'::jsonb));
end $$;

create or replace function public.admin_practitioner(p_actor uuid, p_user uuid, p_request text) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; p private.practitioners;
begin
  r := private.require(p_actor, 'doctors.view');
  select * into p from private.practitioners where user_id = p_user;
  if p.user_id is null then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.audit(p_actor, r, 'doctor.view', 'practitioner', p_user::text, null, null, null, 'ok', p_request);
  return private.practitioner_json(p, true) || jsonb_build_object('user_id', p.user_id, 'email', (select email from auth.users where id = p.user_id),
    'self', p_actor = p_user, 'can_verify', private.can(p_actor, 'doctors.verify') and p_actor <> p_user);
end $$;

-- Hands the server the storage path of one credential file so it can make a short-lived link. Every opening is audited.
create or replace function public.admin_practitioner_document(p_actor uuid, p_user uuid, p_doc uuid, p_request text) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; d private.practitioner_documents;
begin
  r := private.require(p_actor, 'doctors.view');
  select * into d from private.practitioner_documents where id = p_doc and user_id = p_user;
  if d.id is null then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.audit(p_actor, r, 'doctor.document_open', 'practitioner', p_user::text, null, null, jsonb_build_object('document', d.id, 'kind', d.kind), 'ok', p_request);
  return jsonb_build_object('path', d.storage_path, 'mime', d.mime, 'file_name', d.file_name);
end $$;

-- A verification needs recorded evidence: which official register was checked, when, and that the name, registration
-- number and council matched it and the photo ID. Rejection and suspension need a reason the doctor will see.
create or replace function public.admin_practitioner_transition(p_actor uuid, p_user uuid, p_to text, p_reason text, p_evidence jsonb, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; p private.practitioners; ev jsonb := null; checked date;
begin
  r := private.require(p_actor, 'doctors.verify');
  if p_actor = p_user then raise exception 'you can not review your own application' using errcode = '42501'; end if;
  perform private.practitioner_expire();
  select * into p from private.practitioners where user_id = p_user for update;
  if p.user_id is null then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_to in ('REJECTED', 'SUSPENDED', 'DOCUMENTS_SUBMITTED', 'EXPIRED_REQUIRES_REVERIFICATION') and char_length(trim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023';
  end if;
  if p_to = 'VERIFIED' then
    if p.status = 'SUSPENDED' then
      if char_length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'a reason is required to reinstate' using errcode = '22023'; end if;
    else
      begin checked := (p_evidence->>'checked_on')::date; exception when others then checked := null; end;
      if coalesce(p_evidence->>'register', '') not in ('nmr', 'state_council')
         or char_length(coalesce(p_evidence->>'register_name', '')) < 3
         or checked is null or checked > current_date or checked < current_date - 30
         or coalesce((p_evidence->'matched'->>'name')::boolean, false) is not true
         or coalesce((p_evidence->'matched'->>'registration_number')::boolean, false) is not true
         or coalesce((p_evidence->'matched'->>'council')::boolean, false) is not true
         or coalesce((p_evidence->'matched'->>'photo_id')::boolean, false) is not true
         or coalesce((p_evidence->'matched'->>'active')::boolean, false) is not true then
        raise exception 'verification needs the register checked (within 30 days) and name, number, council, active status and photo ID all matched' using errcode = '22023';
      end if;
      ev := jsonb_build_object('register', p_evidence->>'register', 'register_name', left(p_evidence->>'register_name', 120), 'checked_on', checked,
        'register_reference', left(coalesce(p_evidence->>'register_reference', ''), 200), 'matched', p_evidence->'matched', 'notes', left(coalesce(p_evidence->>'notes', ''), 1000));
    end if;
  end if;
  perform private.practitioner_move(p_user, p.status, p_to, 'staff', p_actor, p_reason, ev);
  perform private.audit(p_actor, r, 'doctor.status', 'practitioner', p_user::text, p_reason, jsonb_build_object('status', p.status), jsonb_build_object('status', p_to, 'evidence', ev), 'ok', p_request);
  return jsonb_build_object('ok', true, 'status', p_to);
end $$;

do $$ declare f text; begin
  foreach f in array array['practitioner_get(uuid)', 'practitioner_save(uuid, jsonb)', 'practitioner_document_add(uuid, jsonb)', 'practitioner_document_remove(uuid, uuid)',
    'practitioner_submit(uuid)', 'admin_practitioners(uuid, text)', 'admin_practitioner(uuid, uuid, text)', 'admin_practitioner_document(uuid, uuid, uuid, text)',
    'admin_practitioner_transition(uuid, uuid, text, text, jsonb, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['practitioner_editable(text)', 'practitioner_missing(private.practitioners)', 'practitioner_move(uuid, text, text, text, uuid, text, jsonb)',
    'practitioner_expire()', 'practitioner_json(private.practitioners, boolean)', 'practitioner_events_append_only()'] loop
    execute format('revoke all on function private.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ───────────── permissions: doctors.view, doctors.verify (grantable, not standard) ─────────────
create or replace function private.perm_catalog() returns table (key text, grp text, label text, founder_only boolean, standard boolean)
language sql immutable set search_path = pg_catalog as $$
  values
    ('dashboard.view', 'Overview', 'Dashboard (aggregate figures)', false, true),
    ('analytics.view', 'Overview', 'Analytics and charts', false, true),
    ('reports.export', 'Overview', 'Reports and exports (CSV, PDF)', false, false),
    ('users.view', 'Accounts', 'Account list and basic account details', false, true),
    ('users.notes', 'Accounts', 'Internal notes on accounts', false, false),
    ('users.reset_password', 'Accounts', 'Send password-reset emails', false, false),
    ('users.suspend', 'Accounts', 'Suspend and restore accounts', false, false),
    ('documents.view', 'Operations', 'Document and storage statistics', false, true),
    ('health.view', 'Operations', 'Platform health, errors, incidents and alerts (view)', false, true),
    ('incidents.manage', 'Operations', 'Open and update incidents', false, false),
    ('alerts.manage', 'Operations', 'Acknowledge alerts, resolve errors', false, false),
    ('support.view', 'Support', 'View support requests', false, false),
    ('support.assign', 'Support', 'Assign and prioritise support requests', false, false),
    ('support.respond', 'Support', 'Reply, add internal notes, change status', false, false),
    ('feedback.view', 'Product', 'View product feedback and feature requests', false, true),
    ('feedback.manage', 'Product', 'Triage feedback, manage feature requests and tasks', false, true),
    ('bugs.view', 'Product', 'View bugs', false, true),
    ('bugs.manage', 'Product', 'Create, categorise and update bugs', false, true),
    ('content.view', 'Content', 'View content and drafts', false, true),
    ('content.edit', 'Content', 'Draft announcements, release notes and content', false, true),
    ('content.publish', 'Content', 'Publish announcements and content', false, false),
    ('content.clinical_review', 'Content', 'Record clinical review of medical content', false, false),
    ('releases.view', 'Content', 'View release notes', false, true),
    ('releases.manage', 'Content', 'Publish release notes', false, false),
    ('doctors.view', 'Doctor network', 'Doctor applications and their credential files (every opening is logged)', false, false),
    ('doctors.verify', 'Doctor network', 'Verify, reject, suspend and reinstate doctors (never your own application)', false, false),
    ('data.view', 'Operations', 'Database overview: tables, row counts, sizes and security (never contents)', false, false),
    ('flags.view', 'Platform control', 'View feature switches', false, false),
    ('flags.manage', 'Platform control', 'Change feature switches (not the AI switch)', false, false),
    ('maintenance.manage', 'Platform control', 'Maintenance mode and windows', false, false),
    ('team.view', 'Governance', 'See the leadership team', false, false),
    ('audit.view', 'Governance', 'Read the audit log', false, false),
    ('security.view', 'Governance', 'Security events', false, false),
    ('team.manage', 'Founder only', 'Invite, remove and set permissions of Co-Founders', true, false),
    ('security.manage', 'Founder only', 'Security policy and leadership sessions', true, false),
    ('ai.manage', 'Founder only', 'The AI assistant switch', true, false) $$;

-- ───────────── the `doctor_onboarding` switch (off, Founder only) ─────────────
alter table private.feature_flags drop constraint if exists feature_flags_key_check;
alter table private.feature_flags add constraint feature_flags_key_check
  check (key in ('registrations', 'document_upload', 'pdf_reading', 'sample_data', 'ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian', 'doctor_onboarding', 'maintenance'));
insert into private.feature_flags (key, enabled) values ('doctor_onboarding', false) on conflict (key) do nothing;

create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key in ('ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian', 'doctor_onboarding') then 'ai.manage' else 'flags.manage' end);
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
