-- Doctine · core schema for personal health records on Supabase
-- Every row belongs to exactly one user (user_id = auth.uid()). Row-level security is on for every table.
-- Child rows carry user_id too and reference their parent with a composite key (id, user_id),
-- so the database itself refuses to attach one person's data to another person's record.

create extension if not exists pgcrypto;

-- ---------- helpers ----------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------- people ----------
create table public.health_profiles (
  user_id      uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  full_name    text check (char_length(full_name) <= 120),
  date_of_birth date check (date_of_birth between '1900-01-01' and current_date),
  height_cm    numeric(5,1) check (height_cm between 30 and 275),
  weight_kg    numeric(5,1) check (weight_kg between 1 and 500),
  blood_group  text check (char_length(blood_group) <= 10),
  allergies    text check (char_length(allergies) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Current consent per kind, plus an append-only history of every change.
create table public.consents (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('ai_chat', 'analytics', 'cloud_storage')),
  granted    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);
create table public.consent_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  granted    boolean not null,
  created_at timestamptz not null default now()
);
create or replace function public.log_consent() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.granted is distinct from old.granted then
    insert into public.consent_log (user_id, kind, granted) values (new.user_id, new.kind, new.granted);
  end if;
  return new;
end $$;

-- ---------- documents ----------
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id     bigint not null,                       -- the app's own id for the record
  title         text not null check (char_length(title) between 1 and 160),
  category      text not null default 'Other' check (category in ('Lab report', 'Prescription', 'Imaging', 'Other')),
  document_date date,
  provider      text check (char_length(provider) <= 160),
  source        text not null default 'upload' check (source in ('scan', 'upload', 'manual')),
  fields        jsonb not null default '{}'::jsonb,     -- values the person confirmed or entered
  extraction    jsonb,                                  -- the untouched AI reading, kept for reference
  page_count    int not null default 0 check (page_count between 0 and 30),
  file_hash     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, client_id),
  unique (id, user_id)
);
create index documents_user_date_idx on public.documents (user_id, document_date desc);

create table public.document_files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid(),
  document_id  uuid not null,
  kind         text not null check (kind in ('original', 'cleaned')),
  page         int not null check (page between 0 and 29),
  storage_path text not null,
  content_type text not null default 'image/jpeg',
  size_bytes   int,
  created_at   timestamptz not null default now(),
  unique (document_id, kind, page),
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete cascade,
  -- files must live in the owner's own folder of the private bucket
  check (storage_path like (user_id::text || '/%'))
);

-- Structured rows derived from a document's AI reading (rebuilt by trigger) or entered by the person.
create table public.lab_results (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  document_id     uuid not null,
  test            text not null,
  value           text,
  unit            text,
  reference_range text,
  flag            text,
  confidence      text check (confidence in ('high', 'medium', 'low')),
  origin          text not null default 'ai_extracted' check (origin in ('ai_extracted', 'user_entered')),
  created_at      timestamptz not null default now(),
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete cascade
);
create index lab_results_user_test_idx on public.lab_results (user_id, lower(test));

create table public.prescriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid(),
  document_id   uuid not null,
  doctor        text,
  facility      text,
  prescribed_on date,
  created_at    timestamptz not null default now(),
  unique (id, user_id),
  unique (document_id),
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete cascade
);
create table public.prescription_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  prescription_id uuid not null,
  position        int not null default 0,
  raw_text        text,                                -- exactly as written on the paper
  name            text,
  form            text,
  strength        text,
  frequency       text,
  timing          text,
  duration        text,
  confidence      text check (confidence in ('high', 'medium', 'low')),
  alternatives    text[] not null default '{}',
  confirmed       boolean not null default false,      -- true only after the person checks it against the paper
  unique (id, user_id),
  foreign key (prescription_id, user_id) references public.prescriptions (id, user_id) on delete cascade
);

-- ---------- medicines ----------
create table public.medicines (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id          bigint not null,
  name               text not null check (char_length(name) between 1 and 120),
  dose               text not null check (char_length(dose) between 1 and 120),   -- as prescribed, typed or confirmed by the person
  status             text not null default 'active' check (status in ('active', 'paused', 'completed')),
  start_date         date not null,
  end_date           date check (end_date is null or end_date >= start_date),
  source_document_id uuid,                              -- the prescription it came from, if any
  source_raw         text,                              -- the line as written on that prescription
  source_confidence  text check (source_confidence in ('high', 'medium', 'low')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, client_id),
  unique (id, user_id),
  foreign key (source_document_id, user_id) references public.documents (id, user_id) on delete set null (source_document_id)
);
create table public.medication_schedules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid(),
  medicine_id  uuid not null unique,
  frequency    text not null default 'daily' check (frequency in ('daily', 'weekly')),
  days_of_week int[] not null default '{}' check (days_of_week <@ array[0,1,2,3,4,5,6]),
  times        text[] not null check (cardinality(times) between 1 and 12),
  timezone     text not null default 'Asia/Kolkata',
  foreign key (medicine_id, user_id) references public.medicines (id, user_id) on delete cascade,
  check (frequency = 'daily' or cardinality(days_of_week) > 0)
);
create or replace function public.valid_times(t text[]) returns boolean language sql immutable as $$
  select coalesce(bool_and(x ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'), false) from unnest(t) x $$;
alter table public.medication_schedules add constraint schedule_times_valid check (public.valid_times(times));

create table public.dose_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid(),
  medicine_id    uuid not null,
  scheduled_date date not null,
  scheduled_time text not null check (scheduled_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  status         text not null check (status in ('Taken', 'Skipped') or status ~ '^Snoozed until ([01][0-9]|2[0-3]):[0-5][0-9]$'),
  recorded_at    timestamptz not null default now(),
  unique (medicine_id, scheduled_date, scheduled_time),
  foreign key (medicine_id, user_id) references public.medicines (id, user_id) on delete cascade
);

-- ---------- conversations (designed now; the app stores chats only when the person opts in) ----------
create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text,
  document_id uuid,
  created_at  timestamptz not null default now(),
  unique (id, user_id),
  foreign key (document_id, user_id) references public.documents (id, user_id) on delete set null (document_id)
);
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  conversation_id uuid not null,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null check (char_length(content) <= 20000),
  payload         jsonb,
  created_at      timestamptz not null default now(),
  foreign key (conversation_id, user_id) references public.conversations (id, user_id) on delete cascade
);

-- ---------- rebuild structured rows from a document's AI reading ----------
-- Runs as the person making the change, so row-level security still applies to what it writes.
create or replace function public.derive_from_extraction() returns trigger language plpgsql as $$
declare
  ex jsonb := new.extraction;
  rx uuid;
  m jsonb;
  i int := 0;
begin
  if tg_op = 'UPDATE' and new.extraction is not distinct from old.extraction then return new; end if;
  delete from public.lab_results where document_id = new.id and origin = 'ai_extracted';
  delete from public.prescriptions where document_id = new.id;
  if ex is null or jsonb_typeof(ex) <> 'object' then return new; end if;

  insert into public.lab_results (user_id, document_id, test, value, unit, reference_range, flag, confidence)
  select new.user_id, new.id, left(l->>'test', 120), left(l->>'value', 60), left(l->>'unit', 40), left(l->>'range', 80), left(l->>'flag', 12),
         case when l->>'confidence' in ('high','medium','low') then l->>'confidence' else 'low' end
  from jsonb_array_elements(case when jsonb_typeof(ex->'lab_results') = 'array' then ex->'lab_results' else '[]'::jsonb end) l
  where coalesce(l->>'test', '') <> '';

  if jsonb_typeof(ex->'medicines') = 'array' and jsonb_array_length(ex->'medicines') > 0 then
    insert into public.prescriptions (user_id, document_id, doctor, facility, prescribed_on)
    values (new.user_id, new.id, left(ex->>'doctor', 160), left(ex->>'facility', 160), new.document_date)
    returning id into rx;
    for m in select * from jsonb_array_elements(ex->'medicines') loop
      insert into public.prescription_items (user_id, prescription_id, position, raw_text, name, form, strength, frequency, timing, duration, confidence, alternatives)
      values (new.user_id, rx, i, left(m->>'raw', 240), left(m->>'name', 120), left(m->>'form', 40), left(m->>'strength', 60), left(m->>'frequency', 60),
              left(m->>'timing', 60), left(m->>'duration', 60),
              case when m->>'confidence' in ('high','medium','low') then m->>'confidence' else 'low' end,
              coalesce(array(select left(x, 120) from jsonb_array_elements_text(case when jsonb_typeof(m->'alternatives') = 'array' then m->'alternatives' else '[]'::jsonb end) x), '{}'));
      i := i + 1;
    end loop;
  end if;
  return new;
end $$;

-- ---------- triggers ----------
create trigger health_profiles_touch before update on public.health_profiles for each row execute function public.touch_updated_at();
create trigger documents_touch before update on public.documents for each row execute function public.touch_updated_at();
create trigger medicines_touch before update on public.medicines for each row execute function public.touch_updated_at();
create trigger consents_touch before update on public.consents for each row execute function public.touch_updated_at();
create trigger consents_log after insert or update on public.consents for each row execute function public.log_consent();
create trigger documents_derive after insert or update of extraction on public.documents for each row execute function public.derive_from_extraction();

-- ---------- row-level security: each person sees and changes only their own rows ----------
do $$
declare t text;
begin
  foreach t in array array['health_profiles','consents','documents','document_files','lab_results','prescriptions',
                           'prescription_items','medicines','medication_schedules','dose_events','conversations','messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('create policy "%s: owner reads" on public.%I for select to authenticated using (user_id = auth.uid())', t, t);
    execute format('create policy "%s: owner adds" on public.%I for insert to authenticated with check (user_id = auth.uid())', t, t);
    execute format('create policy "%s: owner changes" on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t, t);
    execute format('create policy "%s: owner removes" on public.%I for delete to authenticated using (user_id = auth.uid())', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
-- the consent history is read-only for its owner; only the consent trigger (security definer) writes it
alter table public.consent_log enable row level security;
create policy "consent_log: owner reads" on public.consent_log for select to authenticated using (user_id = auth.uid());
revoke all on public.consent_log from anon, authenticated;
grant select on public.consent_log to authenticated;

-- ---------- private storage for document images ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('health-documents', 'health-documents', false, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "health-documents: owner reads" on storage.objects for select to authenticated
  using (bucket_id = 'health-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "health-documents: owner uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'health-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "health-documents: owner replaces" on storage.objects for update to authenticated
  using (bucket_id = 'health-documents' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "health-documents: owner deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'health-documents' and (storage.foldername(name))[1] = auth.uid()::text);
