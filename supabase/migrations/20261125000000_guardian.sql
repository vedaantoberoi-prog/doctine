-- Doctine · Guardian foundation (25 Nov 2026): safety settings, trusted contacts, incidents with an append-only
-- transition log, deliveries with honest statuses, and the `guardian` switch (off).
--
-- Everything lives in the private schema, out of reach of browsers: only the server (service role) calls these
-- functions, always passing the person's id it verified from their sign-in token. The incident state machine is the
-- code's (netlify/lib/guardian/states.mjs); the list of allowed transitions is enforced here a second time, so even a
-- bug in the server can't move an incident along a path that doesn't exist. Nothing about medical records changes.
-- Retention: an incident's location is erased 30 days after it closes; closed incidents are deleted after 12 months.
-- Rollback: supabase/rollback/20261125000000_guardian_down.sql

-- ───────────── the allowed transitions (must equal TRANSITION_LIST in states.mjs; tests check) ─────────────
create table if not exists private.guardian_allowed_transition (
  from_state text not null, trigger text not null, to_state text not null,
  primary key (from_state, trigger)
);
alter table private.guardian_allowed_transition enable row level security;
alter table private.guardian_allowed_transition force row level security;
revoke all on private.guardian_allowed_transition from public, anon, authenticated;
delete from private.guardian_allowed_transition;
insert into private.guardian_allowed_transition (from_state, trigger, to_state) values
-- transitions:begin
  ('NORMAL', 'open_suspected', 'SUSPECTED_EVENT'), ('NORMAL', 'open_high', 'HIGH_CONFIDENCE_EVENT'), ('NORMAL', 'open_confirmed', 'USER_CONFIRMED'), ('NORMAL', 'open_expired', 'CANCELLED'),
  ('SUSPECTED_EVENT', 'checkin_start', 'CHECKING_IN'), ('SUSPECTED_EVENT', 'corroborated', 'HIGH_CONFIDENCE_EVENT'), ('SUSPECTED_EVENT', 'user_ok', 'CANCELLED'), ('SUSPECTED_EVENT', 'user_help', 'USER_CONFIRMED'),
  ('HIGH_CONFIDENCE_EVENT', 'checkin_start', 'CHECKING_IN'), ('HIGH_CONFIDENCE_EVENT', 'platform_unresponsive', 'ESCALATING'), ('HIGH_CONFIDENCE_EVENT', 'user_ok', 'CANCELLED'), ('HIGH_CONFIDENCE_EVENT', 'user_help', 'USER_CONFIRMED'),
  ('CHECKING_IN', 'checkin_timeout', 'POSSIBLE_EMERGENCY'), ('CHECKING_IN', 'user_ok', 'CANCELLED'), ('CHECKING_IN', 'user_help', 'USER_CONFIRMED'),
  ('POSSIBLE_EMERGENCY', 'policy_escalate', 'ESCALATING'), ('POSSIBLE_EMERGENCY', 'user_ok', 'CANCELLED'), ('POSSIBLE_EMERGENCY', 'user_help', 'USER_CONFIRMED'), ('POSSIBLE_EMERGENCY', 'resolve', 'RESOLVED'),
  ('USER_CONFIRMED', 'escalate', 'ESCALATING'), ('USER_CONFIRMED', 'user_ok', 'CANCELLED'),
  ('ESCALATING', 'contact_ack', 'CONTACT_ACKNOWLEDGED'), ('ESCALATING', 'delivery_failed', 'FAILED_TO_DELIVER'), ('ESCALATING', 'user_ok', 'RESOLVED'), ('ESCALATING', 'resolve', 'RESOLVED'),
  ('FAILED_TO_DELIVER', 'retry', 'ESCALATING'), ('FAILED_TO_DELIVER', 'contact_ack', 'CONTACT_ACKNOWLEDGED'), ('FAILED_TO_DELIVER', 'user_ok', 'RESOLVED'), ('FAILED_TO_DELIVER', 'resolve', 'RESOLVED'),
  ('CONTACT_ACKNOWLEDGED', 'user_ok', 'RESOLVED'), ('CONTACT_ACKNOWLEDGED', 'resolve', 'RESOLVED')
-- transitions:end
;

-- ───────────── settings and trusted contacts ─────────────
create table if not exists private.guardian_settings (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  enabled        boolean not null default false,
  share_location boolean not null default false,
  everyday       boolean not null default true,
  updated_at     timestamptz not null default now()
);
create table if not exists private.guardian_contacts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  relationship text check (char_length(relationship) <= 40),
  phone        text not null check (phone ~ '^\+?[0-9][0-9 ()-]{5,22}$'),
  priority     smallint not null default 1 check (priority between 1 and 5),
  status       text not null default 'unverified' check (status in ('unverified', 'verified', 'declined')),
  notify       boolean not null default true,
  verified_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists guardian_contacts_user on private.guardian_contacts (user_id, priority);

-- ───────────── incidents ─────────────
create table if not exists private.guardian_incidents (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  event_id         uuid not null,
  event_type       text not null check (event_type in ('road_incident', 'fall', 'wearable_alert', 'voice_distress', 'sos', 'missed_checkin', 'inactivity')),
  source           text not null check (char_length(source) <= 40),
  state            text not null check (state in ('SUSPECTED_EVENT', 'CHECKING_IN', 'POSSIBLE_EMERGENCY', 'USER_CONFIRMED', 'HIGH_CONFIDENCE_EVENT', 'ESCALATING', 'CONTACT_ACKNOWLEDGED', 'RESOLVED', 'CANCELLED', 'FAILED_TO_DELIVER')),
  confidence       numeric(4, 3) not null check (confidence between 0 and 1),
  signal_quality   text not null check (signal_quality in ('good', 'fair', 'poor', 'unknown')),
  lat              double precision check (lat between -90 and 90),
  lng              double precision check (lng between -180 and 180),
  location_accuracy_m numeric check (location_accuracy_m >= 0),
  location_at      timestamptz,
  observed_at      timestamptz not null,
  opened_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  closed_at        timestamptz,
  checkin_deadline timestamptz,
  is_test          boolean not null default false,
  evidence         jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  notes            jsonb not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array'),
  unique (user_id, event_id)
);
create index if not exists guardian_incidents_open on private.guardian_incidents (user_id, opened_at desc) where closed_at is null;
create index if not exists guardian_incidents_user on private.guardian_incidents (user_id, opened_at desc);
-- every event id ever seen for a person (the first one and any that joined an open incident): one incident per event
create table if not exists private.guardian_event_ids (
  user_id     uuid not null references auth.users (id) on delete cascade,
  event_id    uuid not null,
  incident_id uuid not null references private.guardian_incidents (id) on delete cascade,
  primary key (user_id, event_id)
);
-- the append-only log of every state change
create table if not exists private.guardian_transitions (
  id          bigint generated always as identity primary key,
  incident_id uuid not null references private.guardian_incidents (id) on delete cascade,
  from_state  text not null,
  to_state    text not null,
  trigger     text not null,
  record      jsonb not null,
  at          timestamptz not null default now()
);
create index if not exists guardian_transitions_incident on private.guardian_transitions (incident_id, id);
create or replace function private.guardian_transitions_append_only() returns trigger language plpgsql set search_path = pg_catalog, private as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from private.guardian_incidents where id = old.incident_id) then return old; end if;  -- cascade from a deleted incident
  raise exception 'the Guardian transition log cannot be changed' using errcode = '42501';
end $$;
drop trigger if exists guardian_transitions_no_change on private.guardian_transitions;
create trigger guardian_transitions_no_change before update on private.guardian_transitions for each row execute function private.guardian_transitions_append_only();

create table if not exists private.guardian_deliveries (
  id           uuid primary key default gen_random_uuid(),
  incident_id  uuid not null references private.guardian_incidents (id) on delete cascade,
  contact_id   uuid references private.guardian_contacts (id) on delete set null,
  channel      text not null check (channel in ('sms', 'whatsapp', 'voice', 'manual_share')),
  wave         smallint not null default 1 check (wave between 0 and 50),
  kind         text not null default 'alert' check (kind in ('alert', 'all_clear')),
  status       text not null check (status in ('pending', 'not_configured', 'user_initiated', 'sent', 'delivered', 'failed', 'acknowledged')),
  provider     text check (char_length(provider) <= 40),
  provider_ref text check (char_length(provider_ref) <= 120),
  error        text check (char_length(error) <= 80),
  attempts     int not null default 1,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (incident_id, contact_id, channel, wave, kind)
);
-- device and monitoring failures: status only, never incidents; kept 30 days
create table if not exists private.guardian_status_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  source      text not null check (char_length(source) <= 40),
  observed_at timestamptz not null,
  received_at timestamptz not null default now(),
  flags       jsonb not null default '[]'::jsonb
);

do $$ declare t text; begin
  foreach t in array array['guardian_settings', 'guardian_contacts', 'guardian_incidents', 'guardian_event_ids', 'guardian_transitions', 'guardian_deliveries', 'guardian_status_events'] loop
    execute format('alter table private.%I enable row level security', t);
    execute format('alter table private.%I force row level security', t);
    execute format('revoke all on private.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- ───────────── helpers ─────────────
create or replace function private.guardian_incident_json(p_id uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private as $$
  select jsonb_build_object('id', i.id, 'user_id', i.user_id, 'event_id', i.event_id, 'event_type', i.event_type, 'source', i.source, 'state', i.state,
    'confidence', i.confidence::float8, 'signal_quality', i.signal_quality,
    'location', case when i.lat is null then null else jsonb_build_object('lat', i.lat, 'lng', i.lng, 'accuracy_m', i.location_accuracy_m, 'at', i.location_at) end,
    'observed_at', i.observed_at, 'opened_at', i.opened_at, 'updated_at', i.updated_at, 'closed_at', i.closed_at, 'checkin_deadline', i.checkin_deadline,
    'test', i.is_test, 'evidence', i.evidence)
  from private.guardian_incidents i where i.id = p_id $$;
create or replace function private.guardian_delivery_json(d private.guardian_deliveries) returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object('id', d.id, 'contact_id', d.contact_id, 'channel', d.channel, 'wave', d.wave, 'kind', d.kind, 'status', d.status, 'provider', d.provider,
    'provider_ref', d.provider_ref, 'error', d.error, 'attempts', d.attempts, 'created_at', d.created_at, 'updated_at', d.updated_at) $$;
create or replace function private.guardian_evidence_item(p jsonb) returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_strip_nulls(jsonb_build_object('event_id', p->>'event_id', 'event_type', p->>'event_type', 'source', p->>'source', 'confidence', (p->>'confidence')::float8,
    'signal_quality', p->>'signal_quality', 'observed_at', p->>'observed_at', 'flags', coalesce(p->'flags', '[]'::jsonb), 'model_version', p->>'model_version',
    'supporting_features', p->'supporting_features')) $$;
create or replace function private.guardian_owns(p_user uuid, p_id uuid) returns boolean language sql stable security definer set search_path = pg_catalog, private as $$
  select exists (select 1 from private.guardian_incidents where id = p_id and user_id = p_user) $$;

-- ───────────── server functions (service role only) ─────────────
create or replace function public.guardian_settings_get(p_user uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select coalesce((select jsonb_build_object('enabled', enabled, 'share_location', share_location, 'everyday', everyday, 'updated_at', updated_at) from private.guardian_settings where user_id = p_user),
    jsonb_build_object('enabled', false, 'share_location', false, 'everyday', true)) $$;

create or replace function public.guardian_settings_save(p_user uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
begin
  insert into private.guardian_settings as s (user_id, enabled, share_location, everyday)
  values (p_user, coalesce((p->>'enabled')::boolean, false), coalesce((p->>'share_location')::boolean, false), coalesce((p->>'everyday')::boolean, true))
  on conflict (user_id) do update set
    enabled = coalesce((p->>'enabled')::boolean, s.enabled), share_location = coalesce((p->>'share_location')::boolean, s.share_location),
    everyday = coalesce((p->>'everyday')::boolean, s.everyday), updated_at = now();
  return public.guardian_settings_get(p_user);
end $$;

create or replace function public.guardian_contacts_list(p_user uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'relationship', relationship, 'phone', phone, 'priority', priority, 'status', status, 'notify', notify, 'updated_at', updated_at) order by priority, created_at), '[]'::jsonb)
  from private.guardian_contacts where user_id = p_user $$;

-- Saves one contact. The status can't be set here: a contact is 'unverified' until a verification flow confirms
-- they agreed, and changing the phone number makes them unverified again. At most 5 contacts.
create or replace function public.guardian_contact_save(p_user uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare cid uuid := nullif(p->>'id', '')::uuid; row private.guardian_contacts;
begin
  if cid is null then
    if (select count(*) from private.guardian_contacts where user_id = p_user) >= 5 then raise exception 'at most 5 trusted contacts' using errcode = '22023'; end if;
    insert into private.guardian_contacts (user_id, name, relationship, phone, priority, notify)
    values (p_user, trim(p->>'name'), nullif(trim(p->>'relationship'), ''), trim(p->>'phone'), coalesce((p->>'priority')::smallint, 1), coalesce((p->>'notify')::boolean, true))
    returning * into row;
  else
    update private.guardian_contacts c set name = trim(p->>'name'), relationship = nullif(trim(p->>'relationship'), ''),
      status = case when c.phone is distinct from trim(p->>'phone') then 'unverified' else c.status end,
      verified_at = case when c.phone is distinct from trim(p->>'phone') then null else c.verified_at end,
      phone = trim(p->>'phone'), priority = coalesce((p->>'priority')::smallint, c.priority), notify = coalesce((p->>'notify')::boolean, c.notify), updated_at = now()
    where c.id = cid and c.user_id = p_user returning * into row;
    if row.id is null then raise exception 'no such contact' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object('id', row.id, 'name', row.name, 'relationship', row.relationship, 'phone', row.phone, 'priority', row.priority, 'status', row.status, 'notify', row.notify, 'updated_at', row.updated_at);
end $$;

create or replace function public.guardian_contact_delete(p_user uuid, p_id uuid) returns boolean language sql security definer set search_path = pg_catalog, private, public as $$
  with d as (delete from private.guardian_contacts where id = p_id and user_id = p_user returning 1) select exists (select 1 from d) $$;

-- For a contact's consent link: the contact's name, number and status only (never anything about the person).
create or replace function public.guardian_contact_for_consent(p_contact uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select jsonb_build_object('id', id, 'name', name, 'phone', phone, 'status', status) from private.guardian_contacts where id = p_contact $$;

-- The contact agreed ('verified') or declined. Only while the number is still the one the link was made for.
create or replace function public.guardian_contact_set_consent(p_contact uuid, p_phone text, p_status text) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare row private.guardian_contacts;
begin
  if p_status not in ('verified', 'declined') then raise exception 'invalid consent' using errcode = '22023'; end if;
  update private.guardian_contacts set status = p_status, verified_at = case when p_status = 'verified' then now() end, updated_at = now()
  where id = p_contact and phone = p_phone returning * into row;
  if row.id is null then raise exception 'no such contact' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', row.id, 'status', row.status);
end $$;

create or replace function public.guardian_incident_by_event(p_user uuid, p_event uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select private.guardian_incident_json(incident_id) from private.guardian_event_ids where user_id = p_user and event_id = p_event $$;

create or replace function public.guardian_incidents_open(p_user uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select coalesce(jsonb_agg(private.guardian_incident_json(id) order by opened_at desc), '[]'::jsonb) from private.guardian_incidents where user_id = p_user and closed_at is null $$;

create or replace function public.guardian_incidents_recent(p_user uuid, p_limit int) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select coalesce(jsonb_agg(private.guardian_incident_json(id) order by opened_at desc), '[]'::jsonb)
  from (select id, opened_at from private.guardian_incidents where user_id = p_user order by opened_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) x $$;

create or replace function public.guardian_incident_get(p_user uuid, p_id uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select private.guardian_incident_json(id) from private.guardian_incidents where id = p_id and user_id = p_user $$;

-- For a contact's acknowledgement link: the incident, only if that contact belongs to the incident's owner.
create or replace function public.guardian_incident_for_contact(p_id uuid, p_contact uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select jsonb_build_object('uid', i.user_id, 'incident', private.guardian_incident_json(i.id), 'contact_name', c.name)
  from private.guardian_incidents i join private.guardian_contacts c on c.id = p_contact and c.user_id = i.user_id where i.id = p_id $$;

-- Opens an incident from a normalized event, with its first transition. Idempotent on (person, event id).
create or replace function public.guardian_incident_insert(p_user uuid, p_event jsonb, p_state text, p_record jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare eid uuid := (p_event->>'event_id')::uuid; existing uuid; new_id uuid;
begin
  if not exists (select 1 from private.guardian_allowed_transition where from_state = 'NORMAL' and trigger = p_record->>'trigger' and to_state = p_state) then
    raise exception 'transition not allowed' using errcode = '22023';
  end if;
  select incident_id into existing from private.guardian_event_ids where user_id = p_user and event_id = eid;
  if existing is not null then return jsonb_build_object('created', false, 'incident', private.guardian_incident_json(existing)); end if;
  insert into private.guardian_incidents (user_id, event_id, event_type, source, state, confidence, signal_quality, lat, lng, location_accuracy_m, location_at, observed_at, opened_at, updated_at, closed_at, is_test, evidence)
  values (p_user, eid, p_event->>'event_type', p_event->>'source', p_state, (p_event->>'confidence')::numeric, p_event->>'signal_quality',
    (p_event->'location'->>'lat')::float8, (p_event->'location'->>'lng')::float8, (p_event->'location'->>'accuracy_m')::numeric, (p_event->'location'->>'at')::timestamptz,
    (p_event->>'observed_at')::timestamptz, coalesce((p_record->>'at')::timestamptz, now()), coalesce((p_record->>'at')::timestamptz, now()),
    case when p_state in ('RESOLVED', 'CANCELLED') then coalesce((p_record->>'at')::timestamptz, now()) end,
    coalesce((p_event->>'test')::boolean, false), jsonb_build_array(private.guardian_evidence_item(p_event)))
  on conflict (user_id, event_id) do nothing
  returning id into new_id;
  if new_id is null then   -- the same event arrived twice at the same moment
    select id into existing from private.guardian_incidents where user_id = p_user and event_id = eid;
    return jsonb_build_object('created', false, 'incident', private.guardian_incident_json(existing));
  end if;
  insert into private.guardian_event_ids (user_id, event_id, incident_id) values (p_user, eid, new_id);
  insert into private.guardian_transitions (incident_id, from_state, to_state, trigger, record, at) values (new_id, 'NORMAL', p_state, p_record->>'trigger', p_record, coalesce((p_record->>'at')::timestamptz, now()));
  return jsonb_build_object('created', true, 'incident', private.guardian_incident_json(new_id));
end $$;

-- Compare-and-set: moves the incident only if it is still in p_from and the transition is allowed.
create or replace function public.guardian_incident_transition(p_user uuid, p_id uuid, p_from text, p_to text, p_record jsonb, p_patch jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare done uuid;
begin
  if not exists (select 1 from private.guardian_allowed_transition where from_state = p_from and trigger = p_record->>'trigger' and to_state = p_to) then
    return jsonb_build_object('ok', false, 'incident', public.guardian_incident_get(p_user, p_id));
  end if;
  update private.guardian_incidents set state = p_to, updated_at = coalesce((p_record->>'at')::timestamptz, now()),
    checkin_deadline = case when p_patch ? 'checkin_deadline' then (p_patch->>'checkin_deadline')::timestamptz else checkin_deadline end,
    closed_at = case when p_to in ('RESOLVED', 'CANCELLED') then coalesce((p_patch->>'closed_at')::timestamptz, now()) else closed_at end
  where id = p_id and user_id = p_user and state = p_from returning id into done;
  if done is null then return jsonb_build_object('ok', false, 'incident', public.guardian_incident_get(p_user, p_id)); end if;
  insert into private.guardian_transitions (incident_id, from_state, to_state, trigger, record, at) values (p_id, p_from, p_to, p_record->>'trigger', p_record, coalesce((p_record->>'at')::timestamptz, now()));
  return jsonb_build_object('ok', true, 'incident', private.guardian_incident_json(p_id));
end $$;

create or replace function public.guardian_incident_evidence(p_user uuid, p_id uuid, p_event jsonb, p_patch jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
begin
  if not private.guardian_owns(p_user, p_id) then return null; end if;
  insert into private.guardian_event_ids (user_id, event_id, incident_id) values (p_user, (p_event->>'event_id')::uuid, p_id) on conflict do nothing;
  if found then
    update private.guardian_incidents set evidence = evidence || jsonb_build_array(private.guardian_evidence_item(p_event)),
      confidence = greatest(confidence, coalesce((p_patch->>'confidence')::numeric, confidence)), updated_at = now()
    where id = p_id and jsonb_array_length(evidence) < 50;
  end if;
  return private.guardian_incident_json(p_id);
end $$;

create or replace function public.guardian_incident_note(p_user uuid, p_id uuid, p_note jsonb) returns void language sql security definer set search_path = pg_catalog, private, public as $$
  update private.guardian_incidents set notes = notes || jsonb_build_array(p_note || jsonb_build_object('at', now())) where id = p_id and user_id = p_user and jsonb_array_length(notes) < 100 $$;

-- One delivery per (incident, contact, channel, wave, kind). An acknowledged delivery stays acknowledged.
create or replace function public.guardian_delivery_upsert(p_user uuid, p_id uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare row private.guardian_deliveries;
begin
  if not private.guardian_owns(p_user, p_id) then raise exception 'no such incident' using errcode = 'P0002'; end if;
  if p->>'contact_id' is not null and not exists (select 1 from private.guardian_contacts where id = (p->>'contact_id')::uuid and user_id = p_user) then raise exception 'no such contact' using errcode = 'P0002'; end if;
  insert into private.guardian_deliveries as d (incident_id, contact_id, channel, wave, kind, status, provider, provider_ref, error)
  values (p_id, (p->>'contact_id')::uuid, p->>'channel', coalesce((p->>'wave')::smallint, 1), coalesce(p->>'kind', 'alert'), p->>'status', p->>'provider', p->>'provider_ref', p->>'error')
  on conflict (incident_id, contact_id, channel, wave, kind) do update set
    status = case when d.status = 'acknowledged' then d.status else excluded.status end,
    provider_ref = coalesce(excluded.provider_ref, d.provider_ref), error = excluded.error, attempts = d.attempts + 1, updated_at = now()
  returning * into row;
  return private.guardian_delivery_json(row);
end $$;

create or replace function public.guardian_deliveries(p_user uuid, p_id uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select coalesce(jsonb_agg(private.guardian_delivery_json(d) order by d.created_at, d.id), '[]'::jsonb)
  from private.guardian_deliveries d where d.incident_id = p_id and private.guardian_owns(p_user, p_id) $$;

create or replace function public.guardian_mark_ack(p_user uuid, p_id uuid, p_contact uuid) returns void language plpgsql security definer set search_path = pg_catalog, private, public as $$
begin
  if not private.guardian_owns(p_user, p_id) then return; end if;
  update private.guardian_deliveries set status = 'acknowledged', updated_at = now() where incident_id = p_id and contact_id = p_contact and kind = 'alert';
  if not found then
    insert into private.guardian_deliveries (incident_id, contact_id, channel, wave, kind, status, provider) values (p_id, p_contact, 'manual_share', 0, 'alert', 'acknowledged', 'person')
    on conflict (incident_id, contact_id, channel, wave, kind) do update set status = 'acknowledged', updated_at = now();
  end if;
end $$;

create or replace function public.guardian_transitions(p_user uuid, p_id uuid) returns jsonb language sql stable security definer set search_path = pg_catalog, private, public as $$
  select coalesce(jsonb_agg(t.record order by t.id), '[]'::jsonb) from private.guardian_transitions t where t.incident_id = p_id and private.guardian_owns(p_user, p_id) $$;

create or replace function public.guardian_status_event(p_user uuid, p jsonb) returns void language sql security definer set search_path = pg_catalog, private, public as $$
  insert into private.guardian_status_events (user_id, source, observed_at, flags) values (p_user, left(p->>'source', 40), coalesce((p->>'observed_at')::timestamptz, now()), coalesce(p->'flags', '[]'::jsonb)) $$;

-- Retention, run by the server now and then: locations erased 30 days after an incident closes, closed incidents
-- deleted after 12 months, status events after 30 days. Returns what it did (counts only).
create or replace function public.guardian_purge() returns jsonb language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare a int; b int; c int;
begin
  update private.guardian_incidents set lat = null, lng = null, location_accuracy_m = null, location_at = null where closed_at < now() - interval '30 days' and lat is not null;
  get diagnostics a = row_count;
  delete from private.guardian_incidents where closed_at < now() - interval '12 months'; get diagnostics b = row_count;
  delete from private.guardian_status_events where received_at < now() - interval '30 days'; get diagnostics c = row_count;
  return jsonb_build_object('locations_erased', a, 'incidents_deleted', b, 'status_events_deleted', c);
end $$;

-- Admin: counts only (by state and kind, last 30 days). Never a location, a contact or a person.
create or replace function public.admin_guardian_summary(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'ai.manage');
  return jsonb_build_object(
    'by_state', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from private.guardian_incidents where opened_at > now() - interval '30 days' and not is_test group by state) x), '{}'::jsonb),
    'by_type', coalesce((select jsonb_object_agg(event_type, n) from (select event_type, count(*) n from private.guardian_incidents where opened_at > now() - interval '30 days' and not is_test group by event_type) x), '{}'::jsonb),
    'people_enabled', (select count(*) from private.guardian_settings where enabled));
end $$;

do $$ declare f text; begin
  foreach f in array array['guardian_settings_get(uuid)', 'guardian_settings_save(uuid, jsonb)', 'guardian_contacts_list(uuid)', 'guardian_contact_save(uuid, jsonb)', 'guardian_contact_delete(uuid, uuid)',
    'guardian_incident_by_event(uuid, uuid)', 'guardian_incidents_open(uuid)', 'guardian_incidents_recent(uuid, int)', 'guardian_incident_get(uuid, uuid)', 'guardian_incident_for_contact(uuid, uuid)',
    'guardian_incident_insert(uuid, jsonb, text, jsonb)', 'guardian_incident_transition(uuid, uuid, text, text, jsonb, jsonb)', 'guardian_incident_evidence(uuid, uuid, jsonb, jsonb)',
    'guardian_incident_note(uuid, uuid, jsonb)', 'guardian_delivery_upsert(uuid, uuid, jsonb)', 'guardian_deliveries(uuid, uuid)', 'guardian_mark_ack(uuid, uuid, uuid)',
    'guardian_transitions(uuid, uuid)', 'guardian_status_event(uuid, jsonb)', 'guardian_purge()', 'admin_guardian_summary(uuid)',
    'guardian_contact_for_consent(uuid)', 'guardian_contact_set_consent(uuid, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['guardian_incident_json(uuid)', 'guardian_owns(uuid, uuid)'] loop
    execute format('revoke all on function private.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- ───────────── the `guardian` switch (off) ─────────────
alter table private.feature_flags drop constraint if exists feature_flags_key_check;
alter table private.feature_flags add constraint feature_flags_key_check
  check (key in ('registrations', 'document_upload', 'pdf_reading', 'sample_data', 'ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian', 'maintenance'));
insert into private.feature_flags (key, enabled) values ('guardian', false) on conflict (key) do nothing;

-- Guardian joins the AI switches as Founder-only (ai.manage); other switches need flags.manage; maintenance its own.
create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key in ('ai_assistant', 'ai_gateway', 'ai_orchestrator', 'ai_actions', 'guardian') then 'ai.manage' else 'flags.manage' end);
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
