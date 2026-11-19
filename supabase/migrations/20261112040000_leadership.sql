-- Doctine · Founder and Co-Founder administration (applied after 20261112030000_admin_console_v2.sql).
--
-- What changes
--   * Two leadership roles replace the five generic ones: one FOUNDER (enforced by a unique index) and any number of
--     CO-FOUNDERS. Each Co-Founder holds an individual list of permissions chosen by the Founder. Permissions that govern
--     the platform itself (managing leadership, security policy, the AI switch) are Founder-only and cannot be granted.
--   * Existing members are mapped without losing access: owner → founder; admin, analyst, support and auditor →
--     co_founder holding exactly the permissions their old role had (presets of the same name).
--   * Invitations: the Founder invites by email; the person becomes a Co-Founder only after signing in with that
--     verified email and accepting. Pending, accepted, revoked and expired invitations are kept.
--   * New operational modules, each behind its own permissions: support requests (people write in from the app; staff
--     reply), product feedback, bugs/features/tasks, and content with release notes (drafting separate from publishing;
--     clinical content needs a recorded clinical review).
--   * Audit: console sign-in (once per session) and sign-out, invitation events, permission changes with before/after.
--
-- Safety
--   * No user, record, file or existing admin row is deleted. New tables are in `private` with row-level security on and
--     no policies; functions run as before (service_role only), except four functions for signed-in people (support and
--     feedback), which act only on the caller's own rows and are rate-limited.
--   * Rollback: supabase/rollback/20261112040000_leadership_down.sql, then re-run 20261112030000_admin_console_v2.sql and
--     redeploy the previous app build. New tables and their rows are kept.

-- ───────────────────────── permission catalogue ─────────────────────────
-- The one list of permissions. founder_only: never grantable to a Co-Founder. standard: in the default Co-Founder set.
create or replace function private.perm_catalog() returns table (key text, grp text, label text, founder_only boolean, standard boolean)
language sql immutable as $$
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
    ('flags.view', 'Platform control', 'View feature switches', false, false),
    ('flags.manage', 'Platform control', 'Change feature switches (not the AI switch)', false, false),
    ('maintenance.manage', 'Platform control', 'Maintenance mode and windows', false, false),
    ('team.view', 'Governance', 'See the leadership team', false, false),
    ('audit.view', 'Governance', 'Read the audit log', false, false),
    ('security.view', 'Governance', 'Security events', false, false),
    ('team.manage', 'Founder only', 'Invite, remove and set permissions of Co-Founders', true, false),
    ('security.manage', 'Founder only', 'Security policy and leadership sessions', true, false),
    ('ai.manage', 'Founder only', 'The AI assistant switch', true, false) $$;

create or replace function private.grantable() returns text[] language sql immutable as $$
  select array_agg(key) from private.perm_catalog() where not founder_only $$;

-- Named starting points for a Co-Founder's permissions (the Founder can then add or remove any grantable permission).
create or replace function private.perm_preset(p_name text) returns text[] language sql immutable as $$
  select case p_name
    when 'standard' then (select array_agg(key) from private.perm_catalog() where standard)
    when 'operations' then private.grantable()
    when 'admin' then array['dashboard.view','analytics.view','reports.export','users.view','users.suspend','users.reset_password','users.notes',
      'documents.view','health.view','incidents.manage','alerts.manage','flags.view','flags.manage','maintenance.manage','content.view','content.edit','content.publish',
      'team.view','audit.view','security.view']
    when 'analyst' then array['dashboard.view','analytics.view','reports.export','documents.view','health.view']
    when 'support' then array['dashboard.view','users.view','users.reset_password','users.notes','health.view','support.view','support.assign','support.respond']
    when 'auditor' then array['dashboard.view','reports.export','team.view','audit.view','security.view']
    when 'product' then array['dashboard.view','analytics.view','feedback.view','feedback.manage','bugs.view','bugs.manage','content.view','content.edit','releases.view','releases.manage']
    else null end $$;

-- ───────────────────────── leadership roles ─────────────────────────
alter table private.admin_members add column if not exists permissions text[] not null default '{}';
do $$ declare c text;
begin
  for c in select conname from pg_constraint where conrelid = 'private.admin_members'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%role%' loop
    execute format('alter table private.admin_members drop constraint %I', c);
  end loop;
end $$;
-- Old roles → Co-Founders with the same access they had. Runs once (only rows still holding an old role name).
update private.admin_members set permissions = private.perm_preset(role), role = 'co_founder', updated_at = now()
where role in ('admin', 'analyst', 'support', 'auditor');
update private.admin_members set role = 'founder', permissions = '{}', updated_at = now() where role = 'owner';
alter table private.admin_members add constraint admin_members_role_check check (role in ('founder', 'co_founder'));
create unique index if not exists admin_members_one_founder on private.admin_members (role) where role = 'founder';

-- Kept for anything that still asks by role: the Founder holds every permission; a Co-Founder's are per person.
create or replace function private.role_perms(p_role text) returns text[] language sql immutable as $$
  select case when p_role = 'founder' then (select array_agg(key) from private.perm_catalog()) else array[]::text[] end $$;

create or replace function private.actor_perms(p_actor uuid) returns text[] language sql stable as $$
  select case m.role
    when 'founder' then (select array_agg(key) from private.perm_catalog())
    else coalesce((select array_agg(p) from unnest(m.permissions) p where p = any (private.grantable())), array[]::text[]) end
  from private.admin_members m join auth.users u on u.id = m.user_id
  where m.user_id = p_actor and m.status = 'active' and (u.banned_until is null or u.banned_until < now()) $$;

create or replace function private.require(p_actor uuid, p_perm text) returns text language plpgsql stable as $$
declare r text := private.actor_role(p_actor);
begin
  if r is null or not (p_perm = any (coalesce(private.actor_perms(p_actor), array[]::text[]))) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return r;
end $$;

create or replace function private.can(p_actor uuid, p_perm text) returns boolean language sql stable as $$
  select coalesce(p_perm = any (private.actor_perms(p_actor)), false) $$;

create or replace function private.title(p_role text) returns text language sql immutable as $$
  select case p_role when 'founder' then 'Founder' when 'co_founder' then 'Co-Founder' end $$;

-- ───────────────────────── invitations ─────────────────────────
create table if not exists private.admin_invites (
  id           uuid primary key default gen_random_uuid(),
  email        text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  permissions  text[] not null default '{}',
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  delivery     text check (delivery in ('email_sent', 'email_failed', 'existing_account')),
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users (id) on delete set null,
  revoked_at   timestamptz,
  revoked_by   uuid references auth.users (id) on delete set null
);
create unique index if not exists admin_invites_one_pending on private.admin_invites (email) where status = 'pending';
alter table private.admin_invites enable row level security;

create or replace function private.invite_state(i private.admin_invites) returns text language sql stable as $$
  select case when i.status = 'pending' and i.expires_at <= now() then 'expired' else i.status end $$;

-- The pending, unexpired invitation for this account's verified email, if any.
create or replace function private.pending_invite(p_user uuid) returns private.admin_invites language sql stable as $$
  select i.* from private.admin_invites i join auth.users u on lower(u.email) = i.email
  where u.id = p_user and u.email_confirmed_at is not null and i.status = 'pending' and i.expires_at > now()
  order by i.created_at desc limit 1 $$;

-- ───────────────────────── who am I ─────────────────────────
create or replace function public.admin_me(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare r text := private.actor_role(p_actor); inv private.admin_invites;
begin
  if r is null then
    inv := private.pending_invite(p_actor);
    return jsonb_build_object('role', null, 'perms', '[]'::jsonb,
      'suspended', exists (select 1 from private.admin_members where user_id = p_actor and status = 'suspended'),
      'invite', case when inv.id is not null then jsonb_build_object('id', inv.id, 'title', 'Co-Founder', 'expires_at', inv.expires_at,
        'invited_by', (select email from auth.users where id = inv.invited_by), 'permissions', to_jsonb(inv.permissions),
        'needs_password', (select coalesce(encrypted_password, '') = '' from auth.users where id = p_actor)) end);
  end if;
  return jsonb_build_object('role', r, 'title', private.title(r), 'perms', to_jsonb(private.actor_perms(p_actor)),
    'email', (select email from auth.users where id = p_actor),
    'mfa_enrolled', exists (select 1 from auth.mfa_factors f where f.user_id = p_actor and f.status = 'verified'));
end $$;

-- The permission catalogue and presets, for the Founder's permission editor (labels only; enforcement is above).
create or replace function public.admin_perm_catalog(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'dashboard.view');
  return jsonb_build_object(
    'permissions', (select jsonb_agg(jsonb_build_object('key', key, 'group', grp, 'label', label, 'founder_only', founder_only, 'standard', standard)) from private.perm_catalog()),
    'presets', (select jsonb_object_agg(p, to_jsonb(private.perm_preset(p))) from unnest(array['standard','product','support','analyst','auditor','operations']) p));
end $$;

-- ───────────────────────── leadership team ─────────────────────────
drop function if exists public.admin_team_set(uuid, text, text, text, text, text);

create or replace function public.admin_team(p_actor uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare see_perms boolean;
begin
  perform private.require(p_actor, 'team.view');
  see_perms := private.can(p_actor, 'team.manage');
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role, 'title', private.title(m.role), 'status', m.status,
        'permissions', case when m.role = 'founder' then '["*"]'::jsonb when see_perms or m.user_id = p_actor then to_jsonb(m.permissions) end,
        'added_at', m.created_at, 'updated_at', m.updated_at, 'last_sign_in_at', u.last_sign_in_at, 'added_by', (select email from auth.users where id = m.added_by),
        'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified'),
        'last_admin_action', (select max(at) from private.admin_audit_log l where l.actor = m.user_id and l.outcome <> 'denied'))
        order by m.role = 'co_founder', u.email)
      from private.admin_members m join auth.users u on u.id = m.user_id), '[]'::jsonb),
    'invites', case when see_perms then coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'state', private.invite_state(i), 'permissions', to_jsonb(i.permissions),
        'created_at', i.created_at, 'expires_at', i.expires_at, 'delivery', i.delivery, 'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at,
        'invited_by', (select email from auth.users where id = i.invited_by)) order by i.created_at desc)
      from (select * from private.admin_invites order by created_at desc limit 50) i), '[]'::jsonb) end);
end $$;

create or replace function private.check_perms(p text[]) returns text[] language plpgsql immutable as $$
declare bad text;
begin
  select x into bad from unnest(coalesce(p, array[]::text[])) x where not (x = any (private.grantable())) limit 1;
  if bad is not null then raise exception 'permission % cannot be granted', bad using errcode = '22023'; end if;
  return (select coalesce(array_agg(distinct x order by x), array[]::text[]) from unnest(coalesce(p, array[]::text[])) x);
end $$;

-- Founder only. Invites one email as Co-Founder with a set of permissions. The server then sends Supabase's invitation
-- email (or, for someone who already has an account, tells them to sign in) and records the delivery.
create or replace function public.admin_invite_create(p_actor uuid, p_email text, p_permissions text[], p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; em text := lower(trim(coalesce(p_email, ''))); perms text[]; iid uuid; existing uuid;
begin
  r := private.require(p_actor, 'team.manage');
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(em) > 254 then raise exception 'invalid email' using errcode = '22023'; end if;
  perms := private.check_perms(p_permissions);
  if not ('dashboard.view' = any (perms)) then perms := array_append(perms, 'dashboard.view'); end if;
  select id into existing from auth.users where lower(email) = em and deleted_at is null;
  if existing is not null and exists (select 1 from private.admin_members where user_id = existing) then
    return jsonb_build_object('ok', false, 'error', 'already_member');
  end if;
  update private.admin_invites set status = 'revoked', revoked_at = now(), revoked_by = p_actor where email = em and status = 'pending';
  insert into private.admin_invites (email, permissions, invited_by) values (em, perms, p_actor) returning id into iid;
  perform private.audit(p_actor, r, 'invite.create', 'invite', iid::text, p_reason, null,
    jsonb_build_object('email', em, 'title', 'Co-Founder', 'permissions', perms), 'ok', p_request);
  return jsonb_build_object('ok', true, 'id', iid, 'existing_account', existing is not null);
end $$;

create or replace function public.admin_invite_delivery(p_actor uuid, p_id uuid, p_delivery text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text;
begin
  r := private.require(p_actor, 'team.manage');
  if p_delivery not in ('email_sent', 'email_failed', 'existing_account') then raise exception 'invalid' using errcode = '22023'; end if;
  update private.admin_invites set delivery = p_delivery where id = p_id;
  perform private.audit(p_actor, r, 'invite.delivery', 'invite', p_id::text, null, null, jsonb_build_object('delivery', p_delivery),
    case when p_delivery = 'email_failed' then 'failed' else 'ok' end, p_request);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_invite_revoke(p_actor uuid, p_id uuid, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; n int;
begin
  r := private.require(p_actor, 'team.manage');
  update private.admin_invites set status = 'revoked', revoked_at = now(), revoked_by = p_actor where id = p_id and status = 'pending';
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'not_pending'); end if;
  perform private.audit(p_actor, r, 'invite.revoke', 'invite', p_id::text, p_reason, jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'revoked'), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- The invited person, signed in with the invited (verified) email, accepts. Nobody else can accept for them.
create or replace function public.admin_invite_accept(p_actor uuid, p_id uuid, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare inv private.admin_invites;
begin
  inv := private.pending_invite(p_actor);
  -- Refusals return (not raise) so that their audit entry is kept.
  if inv.id is null or inv.id <> p_id or exists (select 1 from private.admin_members where user_id = p_actor) then
    perform private.audit(p_actor, null, 'invite.accept', 'invite', p_id::text, null, null, null, 'denied', p_request);
    return jsonb_build_object('ok', false, 'error', 'not_invited');
  end if;
  insert into private.admin_members (user_id, role, status, permissions, added_by) values (p_actor, 'co_founder', 'active', private.check_perms(inv.permissions), inv.invited_by);
  update private.admin_invites set status = 'accepted', accepted_at = now(), accepted_by = p_actor where id = inv.id;
  perform private.audit(p_actor, 'co_founder', 'invite.accept', 'invite', inv.id::text, null, null,
    jsonb_build_object('title', 'Co-Founder', 'permissions', inv.permissions), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- Founder only: a Co-Founder's permissions, suspension, reactivation or removal. The Founder cannot be changed here,
-- nobody can change themselves, and there is always exactly one active Founder.
create or replace function public.admin_member_set(p_actor uuid, p_user uuid, p_status text, p_permissions text[], p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb; trole text; perms text[];
begin
  r := private.require(p_actor, 'team.manage');
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = '22023'; end if;
  if p_status not in ('active', 'suspended', 'removed') then raise exception 'invalid status' using errcode = '22023'; end if;
  select role, to_jsonb(m) - 'added_by' into trole, old from private.admin_members m where user_id = p_user for update;
  if trole is null then raise exception 'not a member' using errcode = 'P0002'; end if;
  if p_user = p_actor or trole = 'founder' then
    perform private.audit(p_actor, r, 'member.set', 'user', p_user::text, p_reason, null, null, 'denied', p_request);
    return jsonb_build_object('ok', false, 'error', case when p_user = p_actor then 'not_on_yourself' else 'founder_protected' end);
  end if;
  if p_status = 'removed' then
    delete from private.admin_members where user_id = p_user;
  else
    if p_permissions is null then select permissions into perms from private.admin_members where user_id = p_user;
    else perms := private.check_perms(p_permissions); end if;
    update private.admin_members set status = p_status, permissions = perms, updated_at = now() where user_id = p_user;
  end if;
  if p_status in ('suspended', 'removed') then
    begin delete from auth.sessions where user_id = p_user; exception when insufficient_privilege or undefined_table then null; end;
  end if;
  perform private.audit(p_actor, r, case when p_status = 'removed' then 'member.remove' when p_status = 'suspended' and old->>'status' = 'active' then 'member.suspend'
      when p_status = 'active' and old->>'status' = 'suspended' then 'member.reactivate' else 'member.permissions' end,
    'user', p_user::text, p_reason, old, (select to_jsonb(m) - 'added_by' from private.admin_members m where user_id = p_user), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- Console sign-in (recorded once per Supabase session) and sign-out.
create or replace function public.admin_log_session(p_actor uuid, p_event text, p_session text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text := private.actor_role(p_actor);
begin
  if r is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_event not in ('sign_in', 'sign_out') or coalesce(p_session, '') !~ '^[0-9a-f]{16}$' then raise exception 'invalid' using errcode = '22023'; end if;
  if p_event = 'sign_in' and exists (select 1 from private.admin_audit_log where actor = p_actor and action = 'console.sign_in' and target_id = p_session and at > now() - interval '24 hours') then
    return jsonb_build_object('ok', true, 'recorded', false);
  end if;
  perform private.audit(p_actor, r, 'console.' || p_event, 'session', p_session, null, null, null, 'ok', p_request);
  return jsonb_build_object('ok', true, 'recorded', true);
end $$;

-- Accounts: only the Founder may act on another leadership member's account; nobody on their own.
create or replace function public.admin_user_action(p_actor uuid, p_user uuid, p_action text, p_reason text, p_note text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; target_admin text; before_s boolean; perm text; ended int := null; log_id bigint;
begin
  perm := case p_action when 'suspend' then 'users.suspend' when 'restore' then 'users.suspend' when 'revoke_sessions' then 'users.suspend'
                        when 'note' then 'users.notes' else null end;
  if perm is null then raise exception 'invalid action' using errcode = '22023'; end if;
  r := private.require(p_actor, perm);
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'no such account' using errcode = 'P0002'; end if;
  if p_action <> 'note' and coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required' using errcode = '22023'; end if;
  target_admin := (select role from private.admin_members where user_id = p_user);
  if p_action in ('suspend', 'restore', 'revoke_sessions') and (p_user = p_actor or target_admin = 'founder' or (target_admin is not null and r <> 'founder')) then
    perform private.audit(p_actor, r, 'user.' || p_action, 'user', p_user::text, p_reason, null, null, 'denied', p_request);
    return jsonb_build_object('ok', false, 'error', case when p_user = p_actor then 'not_on_yourself' else 'admin_target_needs_founder' end);
  end if;
  select (banned_until is not null and banned_until > now()) into before_s from auth.users where id = p_user;
  if p_action in ('suspend', 'revoke_sessions') then
    begin
      delete from auth.sessions where user_id = p_user;
      get diagnostics ended = row_count;
    exception when insufficient_privilege or undefined_table then ended := null;
    end;
  elsif p_action = 'note' then
    if coalesce(trim(p_note), '') = '' then raise exception 'empty note' using errcode = '22023'; end if;
    insert into private.support_notes (user_id, author, body) values (p_user, p_actor, left(trim(p_note), 1000));
  end if;
  log_id := private.audit(p_actor, r, 'user.' || p_action, 'user', p_user::text, p_reason,
    case when p_action in ('suspend', 'restore') then jsonb_build_object('suspended', before_s) end,
    case when p_action in ('suspend', 'revoke_sessions') then jsonb_build_object('sessions_ended', ended) end,
    case when p_action in ('suspend', 'restore') then 'requested' else 'ok' end, p_request);
  return jsonb_build_object('ok', true, 'log_id', log_id, 'sessions_ended', ended, 'apply_ban', case p_action when 'suspend' then 'on' when 'restore' then 'off' end);
end $$;

-- The AI switch is Founder-only; other switches need flags.manage; maintenance its own permission.
create or replace function public.admin_set_flag(p_actor uuid, p_key text, p_enabled boolean, p_message text, p_reason text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb;
begin
  r := private.require(p_actor, case when p_key = 'maintenance' then 'maintenance.manage' when p_key = 'ai_assistant' then 'ai.manage' else 'flags.manage' end);
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

-- Announcements: drafting needs content.edit; publishing, unpublishing or archiving needs content.publish.
create or replace function public.admin_announcement_save(p_actor uuid, p_data jsonb, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; aid uuid := nullif(p_data->>'id', '')::uuid; old jsonb; st text := coalesce(p_data->>'status', 'draft');
begin
  if st not in ('draft', 'published', 'archived') then raise exception 'invalid status' using errcode = '22023'; end if;
  r := private.require(p_actor, 'content.edit');
  if aid is not null then
    select to_jsonb(a) into old from private.announcements a where id = aid for update;
    if old is null then raise exception 'no such announcement' using errcode = 'P0002'; end if;
  end if;
  if st <> 'draft' or old->>'status' = 'published' then r := private.require(p_actor, 'content.publish'); end if;
  if aid is null then
    insert into private.announcements (kind, title, body, status, starts_at, ends_at, audience, created_by, updated_by)
    values (p_data->>'kind', trim(p_data->>'title'), coalesce(trim(p_data->>'body'), ''), st, nullif(p_data->>'starts_at', '')::timestamptz,
            nullif(p_data->>'ends_at', '')::timestamptz, coalesce(nullif(p_data->>'audience', ''), 'signed_in'), p_actor, p_actor) returning id into aid;
  else
    update private.announcements set kind = coalesce(p_data->>'kind', kind), title = coalesce(trim(p_data->>'title'), title),
      body = coalesce(trim(p_data->>'body'), body), status = st, audience = coalesce(nullif(p_data->>'audience', ''), audience),
      starts_at = case when p_data ? 'starts_at' then nullif(p_data->>'starts_at', '')::timestamptz else starts_at end,
      ends_at = case when p_data ? 'ends_at' then nullif(p_data->>'ends_at', '')::timestamptz else ends_at end,
      updated_by = p_actor, updated_at = now() where id = aid;
  end if;
  perform private.audit(p_actor, r, 'announcement.' || case when old is null then 'create' when st = 'published' then 'publish' when st = 'archived' then 'archive' when old->>'status' = 'published' then 'unpublish' else 'update' end,
    'announcement', aid::text, null, old - 'created_by' - 'updated_by', (select to_jsonb(a) - 'created_by' - 'updated_by' from private.announcements a where id = aid), 'ok', p_request);
  return jsonb_build_object('ok', true, 'id', aid);
end $$;

-- ───────────────────────── support requests ─────────────────────────
create table if not exists private.support_requests (
  id                 uuid primary key default gen_random_uuid(),
  num                bigint generated always as identity unique,
  user_id            uuid not null references auth.users (id) on delete cascade,
  category           text not null check (category in ('account', 'sign_in', 'records', 'documents', 'medicines', 'privacy', 'bug', 'other')),
  subject            text not null check (char_length(subject) between 3 and 120),
  status             text not null default 'new' check (status in ('new', 'open', 'waiting', 'resolved', 'closed')),
  priority           text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  assigned_to        uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  first_response_at  timestamptz,
  resolved_at        timestamptz
);
create index if not exists support_requests_status on private.support_requests (status, updated_at desc);
create index if not exists support_requests_user on private.support_requests (user_id, created_at desc);
create table if not exists private.support_messages (
  id          bigint generated always as identity primary key,
  request_id  uuid not null references private.support_requests (id) on delete cascade,
  at          timestamptz not null default now(),
  author      uuid references auth.users (id) on delete set null,
  from_staff  boolean not null default false,
  internal    boolean not null default false check (not internal or from_staff),
  body        text not null check (char_length(body) between 1 and 2000)
);
create index if not exists support_messages_request on private.support_messages (request_id, at);
alter table private.support_requests enable row level security;
alter table private.support_messages enable row level security;

-- For signed-in people (not anonymous): open a request, read their own (never internal notes), reply.
create or replace function private.caller() returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then raise exception 'sign in first' using errcode = '42501'; end if;
  return u;
end $$;

create or replace function public.support_submit(p_category text, p_subject text, p_body text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare u uuid := private.caller(); rid uuid; n bigint;
begin
  if (select count(*) from private.support_requests where user_id = u and created_at > now() - interval '24 hours') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  if char_length(trim(coalesce(p_body, ''))) < 10 then raise exception 'too short' using errcode = '22023'; end if;
  insert into private.support_requests (user_id, category, subject) values (u, p_category, trim(p_subject)) returning id, num into rid, n;
  insert into private.support_messages (request_id, author, body) values (rid, u, left(trim(p_body), 2000));
  return jsonb_build_object('ok', true, 'id', rid, 'ref', 'S-' || n);
end $$;

create or replace function public.support_mine() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare u uuid := private.caller();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'ref', 'S-' || r.num, 'category', r.category, 'subject', r.subject,
      'status', case when r.status in ('new', 'open') then 'open' else r.status end, 'created_at', r.created_at, 'updated_at', r.updated_at,
      'messages', coalesce((select jsonb_agg(jsonb_build_object('at', m.at, 'from', case when m.from_staff then 'Doctine support' else 'You' end, 'body', m.body) order by m.at)
        from private.support_messages m where m.request_id = r.id and not m.internal), '[]'::jsonb)) order by r.updated_at desc)
    from (select * from private.support_requests where user_id = u order by updated_at desc limit 20) r), '[]'::jsonb);
end $$;

create or replace function public.support_reply(p_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare u uuid := private.caller();
begin
  if not exists (select 1 from private.support_requests where id = p_id and user_id = u) then raise exception 'not found' using errcode = 'P0002'; end if;
  if (select count(*) from private.support_messages m join private.support_requests r on r.id = m.request_id where r.user_id = u and not m.from_staff and m.at > now() - interval '24 hours') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  insert into private.support_messages (request_id, author, body) values (p_id, u, left(trim(coalesce(p_body, '')), 2000));
  update private.support_requests set updated_at = now(), status = case when status in ('waiting', 'resolved', 'closed') then 'open' else status end,
    resolved_at = case when status in ('resolved', 'closed') then null else resolved_at end where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Staff side. Requester identity (email) is shown only with support.view, and opening a request is audited.
create or replace function public.admin_support(p_actor uuid, p_status text, p_mine boolean, p_page int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare off int := greatest(coalesce(p_page, 1) - 1, 0) * 25;
begin
  perform private.require(p_actor, 'support.view');
  return jsonb_build_object(
    'counts', (select jsonb_build_object('new', count(*) filter (where status = 'new'), 'open', count(*) filter (where status = 'open'), 'waiting', count(*) filter (where status = 'waiting'),
       'unassigned', count(*) filter (where assigned_to is null and status in ('new', 'open')), 'resolved_30d', count(*) filter (where resolved_at > now() - interval '30 days'),
       'first_response_hours', round((extract(epoch from avg(first_response_at - created_at) filter (where created_at > now() - interval '30 days')) / 3600)::numeric, 1),
       'resolution_hours', round((extract(epoch from avg(resolved_at - created_at) filter (where resolved_at > now() - interval '30 days')) / 3600)::numeric, 1)) from private.support_requests),
    'total', (select count(*) from private.support_requests where (p_status is null or status = p_status) and (not coalesce(p_mine, false) or assigned_to = p_actor)),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'ref', 'S-' || r.num, 'category', r.category, 'subject', r.subject, 'status', r.status, 'priority', r.priority,
        'assigned_email', (select email from auth.users where id = r.assigned_to), 'created_at', r.created_at, 'updated_at', r.updated_at, 'first_response_at', r.first_response_at,
        'messages', (select count(*) from private.support_messages m where m.request_id = r.id and not m.internal),
        'awaiting_staff', (select not from_staff from private.support_messages m where m.request_id = r.id and not m.internal order by at desc limit 1)) order by r.updated_at desc)
      from (select * from private.support_requests where (p_status is null or status = p_status) and (not coalesce(p_mine, false) or assigned_to = p_actor)
            order by case status when 'new' then 0 when 'open' then 1 when 'waiting' then 2 else 3 end, updated_at desc offset off limit 25) r), '[]'::jsonb));
end $$;

create or replace function public.admin_support_item(p_actor uuid, p_id uuid, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; res jsonb;
begin
  r := private.require(p_actor, 'support.view');
  select jsonb_build_object('id', q.id, 'ref', 'S-' || q.num, 'category', q.category, 'subject', q.subject, 'status', q.status, 'priority', q.priority,
      'assigned_email', (select email from auth.users where id = q.assigned_to), 'created_at', q.created_at, 'updated_at', q.updated_at,
      'first_response_at', q.first_response_at, 'resolved_at', q.resolved_at,
      'requester', jsonb_build_object('id', q.user_id, 'email', u.email, 'created_at', u.created_at, 'email_confirmed', u.email_confirmed_at is not null),
      'messages', coalesce((select jsonb_agg(jsonb_build_object('at', m.at, 'from_staff', m.from_staff, 'internal', m.internal, 'body', m.body,
          'by', case when m.from_staff then (select email from auth.users where id = m.author) end) order by m.at) from private.support_messages m where m.request_id = q.id), '[]'::jsonb))
    into res from private.support_requests q join auth.users u on u.id = q.user_id where q.id = p_id;
  if res is null then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.audit(p_actor, r, 'support.open', 'support', p_id::text, null, null, null, 'ok', p_request);
  return res;
end $$;

create or replace function public.admin_support_update(p_actor uuid, p_id uuid, p_data jsonb, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old jsonb; assignee uuid; st text := p_data->>'status';
begin
  select to_jsonb(q) - 'user_id' into old from private.support_requests q where id = p_id for update;
  if old is null then raise exception 'not found' using errcode = 'P0002'; end if;
  if p_data ? 'assigned_email' or p_data ? 'priority' then r := private.require(p_actor, 'support.assign'); end if;
  if st is not null then r := private.require(p_actor, 'support.respond'); end if;
  if r is null then raise exception 'invalid' using errcode = '22023'; end if;
  if p_data ? 'assigned_email' and nullif(p_data->>'assigned_email', '') is not null then
    select m.user_id into assignee from private.admin_members m join auth.users u on u.id = m.user_id where lower(u.email) = lower(p_data->>'assigned_email') and m.status = 'active';
    if assignee is null or not (private.can(assignee, 'support.respond')) then raise exception 'assignee must be an active member who can respond to support' using errcode = '22023'; end if;
  end if;
  update private.support_requests set
    status = coalesce(st, status), priority = coalesce(p_data->>'priority', priority),
    assigned_to = case when p_data ? 'assigned_email' then assignee else assigned_to end,
    resolved_at = case when st in ('resolved', 'closed') then coalesce(resolved_at, now()) when st is not null then null else resolved_at end,
    updated_at = now() where id = p_id;
  perform private.audit(p_actor, r, 'support.update', 'support', p_id::text, null, old - 'subject', (select to_jsonb(q) - 'user_id' - 'subject' from private.support_requests q where id = p_id), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- A reply the person sees in the app, or an internal note they never see.
create or replace function public.admin_support_message(p_actor uuid, p_id uuid, p_body text, p_internal boolean, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text;
begin
  r := private.require(p_actor, 'support.respond');
  if not exists (select 1 from private.support_requests where id = p_id) then raise exception 'not found' using errcode = 'P0002'; end if;
  if char_length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty' using errcode = '22023'; end if;
  insert into private.support_messages (request_id, author, from_staff, internal, body) values (p_id, p_actor, true, coalesce(p_internal, false), left(trim(p_body), 2000));
  update private.support_requests set updated_at = now(),
    first_response_at = case when not coalesce(p_internal, false) then coalesce(first_response_at, now()) else first_response_at end,
    status = case when not coalesce(p_internal, false) and status in ('new', 'open') then 'waiting' when status = 'new' then 'open' else status end
  where id = p_id;
  perform private.audit(p_actor, r, case when coalesce(p_internal, false) then 'support.note' else 'support.reply' end, 'support', p_id::text, null, null, null, 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- ───────────────────────── product feedback ─────────────────────────
create table if not exists private.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('idea', 'problem', 'praise', 'other')),
  area        text not null default 'other' check (area in ('records', 'documents', 'medicines', 'reminders', 'profile', 'assistant', 'sign_in', 'other')),
  body        text not null check (char_length(body) between 3 and 1000),
  status      text not null default 'new' check (status in ('new', 'reviewed', 'planned', 'done', 'declined')),
  work_item   uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists feedback_status on private.feedback (status, created_at desc);
alter table private.feedback enable row level security;

create or replace function public.feedback_submit(p_kind text, p_area text, p_body text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare u uuid := private.caller();
begin
  if (select count(*) from private.feedback where user_id = u and created_at > now() - interval '24 hours') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  insert into private.feedback (user_id, kind, area, body) values (u, p_kind, coalesce(nullif(p_area, ''), 'other'), trim(p_body));
  return jsonb_build_object('ok', true);
end $$;

-- Feedback is read without the person's identity: a short pseudonymous code only.
create or replace function public.admin_feedback(p_actor uuid, p_status text, p_kind text, p_page int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare off int := greatest(coalesce(p_page, 1) - 1, 0) * 25;
begin
  perform private.require(p_actor, 'feedback.view');
  return jsonb_build_object(
    'counts', (select jsonb_build_object('new', count(*) filter (where status = 'new'), 'last_7d', count(*) filter (where created_at > now() - interval '7 days'),
       'by_kind', coalesce((select jsonb_object_agg(kind, c) from (select kind, count(*) c from private.feedback group by kind) k), '{}'::jsonb),
       'by_status', coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from private.feedback group by status) k), '{}'::jsonb)) from private.feedback),
    'total', (select count(*) from private.feedback where (p_status is null or status = p_status) and (p_kind is null or kind = p_kind)),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'area', f.area, 'body', f.body, 'status', f.status, 'created_at', f.created_at,
        'account', left(md5(coalesce(f.user_id::text, 'x') || 'doctine-feedback'), 8), 'work_item', f.work_item,
        'work_ref', (select upper(left(w.type, 1)) || '-' || w.num from private.work_items w where w.id = f.work_item)) order by f.created_at desc)
      from (select * from private.feedback where (p_status is null or status = p_status) and (p_kind is null or kind = p_kind) order by created_at desc offset off limit 25) f), '[]'::jsonb));
end $$;

create or replace function public.admin_feedback_update(p_actor uuid, p_id uuid, p_status text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; old text;
begin
  r := private.require(p_actor, 'feedback.manage');
  select status into old from private.feedback where id = p_id for update;
  if old is null then raise exception 'not found' using errcode = 'P0002'; end if;
  update private.feedback set status = p_status, updated_at = now() where id = p_id;
  perform private.audit(p_actor, r, 'feedback.update', 'feedback', p_id::text, null, jsonb_build_object('status', old), jsonb_build_object('status', p_status), 'ok', p_request);
  return jsonb_build_object('ok', true);
end $$;

-- ───────────────────────── bugs, feature requests and tasks ─────────────────────────
create table if not exists private.work_items (
  id               uuid primary key default gen_random_uuid(),
  num              bigint generated always as identity unique,
  type             text not null check (type in ('bug', 'feature', 'task')),
  title            text not null check (char_length(title) between 3 and 160),
  description      text not null default '' check (char_length(description) <= 4000),
  status           text not null default 'backlog' check (status in ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'wont_do')),
  priority         text not null default 'normal' check (priority in ('urgent', 'high', 'normal', 'low')),
  severity         text check (severity in ('critical', 'major', 'minor')),
  category         text check (char_length(category) <= 40),
  assigned_to      uuid references auth.users (id) on delete set null,
  source_feedback  uuid references private.feedback (id) on delete set null,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index if not exists work_items_type_status on private.work_items (type, status, updated_at desc);
alter table private.work_items enable row level security;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'feedback_work_item_fkey') then
    alter table private.feedback add constraint feedback_work_item_fkey foreign key (work_item) references private.work_items (id) on delete set null;
  end if;
end $$;

create or replace function private.work_perm(p_type text, p_manage boolean) returns text language sql immutable as $$
  select case when p_type = 'bug' then case when p_manage then 'bugs.manage' else 'bugs.view' end else case when p_manage then 'feedback.manage' else 'feedback.view' end end $$;

create or replace function public.admin_work(p_actor uuid, p_type text, p_status text, p_page int) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare off int := greatest(coalesce(p_page, 1) - 1, 0) * 50; see_bugs boolean := private.can(p_actor, 'bugs.view'); see_other boolean := private.can(p_actor, 'feedback.view');
begin
  if not (see_bugs or see_other) or (p_type = 'bug' and not see_bugs) or (p_type in ('feature', 'task') and not see_other) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'counts', (select jsonb_build_object('open_bugs', count(*) filter (where type = 'bug' and status not in ('done', 'wont_do')),
       'open_bugs_by_severity', coalesce((select jsonb_object_agg(coalesce(severity, 'unset'), c) from (select severity, count(*) c from private.work_items where type = 'bug' and status not in ('done', 'wont_do') group by severity) s), '{}'::jsonb),
       'open_features', count(*) filter (where type = 'feature' and status not in ('done', 'wont_do')), 'open_tasks', count(*) filter (where type = 'task' and status not in ('done', 'wont_do')),
       'bugs_resolved_30d', count(*) filter (where type = 'bug' and resolved_at > now() - interval '30 days'),
       'bug_resolution_days', round((extract(epoch from avg(resolved_at - created_at) filter (where type = 'bug' and resolved_at > now() - interval '90 days')) / 86400)::numeric, 1))
      from private.work_items where (type = 'bug' and see_bugs) or (type <> 'bug' and see_other)),
    'weekly', case when see_bugs then coalesce((select jsonb_agg(jsonb_build_object('week', w, 'bugs_opened', (select count(*) from private.work_items where type = 'bug' and private.day(created_at) >= w and private.day(created_at) < w + 7),
        'bugs_resolved', (select count(*) from private.work_items where type = 'bug' and resolved_at is not null and private.day(resolved_at) >= w and private.day(resolved_at) < w + 7)) order by w)
      from (select g::date w from generate_series(date_trunc('week', (now() at time zone 'Asia/Kolkata')) - interval '11 weeks', (now() at time zone 'Asia/Kolkata'), interval '7 days') g) ws), '[]'::jsonb) end,
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'ref', upper(left(w.type, 1)) || '-' || w.num, 'type', w.type, 'title', w.title, 'description', w.description,
        'status', w.status, 'priority', w.priority, 'severity', w.severity, 'category', w.category, 'assigned_email', (select email from auth.users where id = w.assigned_to),
        'created_by', (select email from auth.users where id = w.created_by), 'created_at', w.created_at, 'updated_at', w.updated_at, 'resolved_at', w.resolved_at,
        'source_feedback', w.source_feedback) order by case w.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, w.updated_at desc)
      from (select * from private.work_items where ((type = 'bug' and see_bugs) or (type <> 'bug' and see_other)) and (p_type is null or type = p_type)
            and (p_status is null or (p_status = 'open' and status not in ('done', 'wont_do')) or status = p_status) order by updated_at desc offset off limit 50) w), '[]'::jsonb));
end $$;

create or replace function public.admin_work_save(p_actor uuid, p_data jsonb, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; wid uuid := nullif(p_data->>'id', '')::uuid; old jsonb; t text; assignee uuid; st text; fb uuid := nullif(p_data->>'source_feedback', '')::uuid;
begin
  if wid is not null then
    select to_jsonb(w) into old from private.work_items w where id = wid for update;
    if old is null then raise exception 'not found' using errcode = 'P0002'; end if;
    t := old->>'type';
  else
    t := p_data->>'type';
  end if;
  r := private.require(p_actor, private.work_perm(t, true));
  if nullif(p_data->>'assigned_email', '') is not null then
    select m.user_id into assignee from private.admin_members m join auth.users u on u.id = m.user_id where lower(u.email) = lower(p_data->>'assigned_email') and m.status = 'active';
    if assignee is null then raise exception 'assignee must be an active member' using errcode = '22023'; end if;
  end if;
  st := coalesce(p_data->>'status', old->>'status', 'backlog');
  if wid is null then
    insert into private.work_items (type, title, description, status, priority, severity, category, assigned_to, source_feedback, created_by)
    values (t, trim(p_data->>'title'), coalesce(trim(p_data->>'description'), ''), st, coalesce(p_data->>'priority', 'normal'),
            case when t = 'bug' then nullif(p_data->>'severity', '') end, nullif(trim(p_data->>'category'), ''), assignee, fb, p_actor) returning id into wid;
    if fb is not null then update private.feedback set work_item = wid, status = case when status = 'new' then 'planned' else status end, updated_at = now() where id = fb; end if;
  else
    update private.work_items set title = coalesce(trim(p_data->>'title'), title), description = coalesce(trim(p_data->>'description'), description), status = st,
      priority = coalesce(p_data->>'priority', priority), severity = case when type = 'bug' and p_data ? 'severity' then nullif(p_data->>'severity', '') else severity end,
      category = case when p_data ? 'category' then nullif(trim(p_data->>'category'), '') else category end,
      assigned_to = case when p_data ? 'assigned_email' then assignee else assigned_to end,
      resolved_at = case when st in ('done', 'wont_do') then coalesce(resolved_at, now()) else null end, updated_at = now()
    where id = wid;
  end if;
  perform private.audit(p_actor, r, 'work.' || case when old is null then 'create' else 'update' end, t, wid::text, null,
    old - 'description', (select to_jsonb(w) - 'description' from private.work_items w where id = wid), 'ok', p_request);
  return jsonb_build_object('ok', true, 'id', wid);
end $$;

-- ───────────────────────── content and release notes ─────────────────────────
create table if not exists private.content_items (
  id                   uuid primary key default gen_random_uuid(),
  type                 text not null check (type in ('release_note', 'help_article', 'education', 'internal_doc')),
  title                text not null check (char_length(title) between 3 and 160),
  body                 text not null default '' check (char_length(body) <= 20000),
  status               text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'published', 'archived')),
  clinical             boolean not null default false,
  clinical_reviewed_by uuid references auth.users (id) on delete set null,
  clinical_reviewed_at timestamptz,
  clinical_note        text check (char_length(clinical_note) <= 500),
  published_at         timestamptz,
  published_by         uuid references auth.users (id) on delete set null,
  created_by           uuid references auth.users (id) on delete set null,
  updated_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists content_items_type_status on private.content_items (type, status, updated_at desc);
alter table private.content_items enable row level security;

create or replace function public.admin_content(p_actor uuid, p_type text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
declare see_rel boolean := private.can(p_actor, 'releases.view'); see_con boolean := private.can(p_actor, 'content.view');
begin
  if not (see_rel or see_con) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'counts', (select jsonb_build_object('drafts', count(*) filter (where status = 'draft'), 'in_review', count(*) filter (where status = 'in_review'),
       'approved', count(*) filter (where status = 'approved'), 'published_30d', count(*) filter (where published_at > now() - interval '30 days'))
       from private.content_items where (type = 'release_note' and see_rel) or (type <> 'release_note' and see_con)),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'type', c.type, 'title', c.title, 'body', c.body, 'status', c.status, 'clinical', c.clinical,
        'clinical_reviewed_by', (select email from auth.users where id = c.clinical_reviewed_by), 'clinical_reviewed_at', c.clinical_reviewed_at, 'clinical_note', c.clinical_note,
        'published_at', c.published_at, 'published_by', (select email from auth.users where id = c.published_by), 'updated_by', (select email from auth.users where id = c.updated_by),
        'created_at', c.created_at, 'updated_at', c.updated_at) order by c.updated_at desc)
      from (select * from private.content_items where ((type = 'release_note' and see_rel) or (type <> 'release_note' and see_con)) and (p_type is null or type = p_type)
            order by updated_at desc limit 100) c), '[]'::jsonb));
end $$;

-- p_action: save (draft text), submit (for review), approve, clinical_review, publish, unpublish, archive.
create or replace function public.admin_content_save(p_actor uuid, p_data jsonb, p_action text, p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, private, public as $$
declare r text; cid uuid := nullif(p_data->>'id', '')::uuid; old private.content_items; t text; pub_perm text; oldj jsonb;
begin
  if cid is not null then
    select * into old from private.content_items where id = cid for update;
    if old.id is null then raise exception 'not found' using errcode = 'P0002'; end if;
    t := old.type; oldj := to_jsonb(old) - 'body';
  else
    t := p_data->>'type';
    if t not in ('release_note', 'help_article', 'education', 'internal_doc') then raise exception 'invalid type' using errcode = '22023'; end if;
  end if;
  pub_perm := case when t = 'release_note' then 'releases.manage' else 'content.publish' end;
  r := private.require(p_actor, case p_action when 'publish' then pub_perm when 'unpublish' then pub_perm when 'approve' then pub_perm
                                              when 'clinical_review' then 'content.clinical_review' else 'content.edit' end);
  if p_action = 'save' then
    if cid is null then
      insert into private.content_items (type, title, body, clinical, created_by, updated_by)
      values (t, trim(p_data->>'title'), coalesce(p_data->>'body', ''), coalesce((p_data->>'clinical')::boolean, false), p_actor, p_actor) returning id into cid;
    else
      if old.status = 'published' then raise exception 'unpublish before editing' using errcode = '22023'; end if;
      -- Editing the text of reviewed content sends it back to draft and clears any clinical review.
      update private.content_items set title = coalesce(trim(p_data->>'title'), title), body = coalesce(p_data->>'body', body),
        clinical = coalesce((p_data->>'clinical')::boolean, clinical), status = 'draft',
        clinical_reviewed_by = null, clinical_reviewed_at = null, clinical_note = null, updated_by = p_actor, updated_at = now() where id = cid;
    end if;
  elsif cid is null then raise exception 'save first' using errcode = '22023';
  elsif p_action = 'submit' then
    update private.content_items set status = 'in_review', updated_by = p_actor, updated_at = now() where id = cid and status = 'draft';
  elsif p_action = 'clinical_review' then
    if coalesce(trim(p_data->>'clinical_note'), '') = '' then raise exception 'name the reviewer and their qualification' using errcode = '22023'; end if;
    update private.content_items set clinical_reviewed_by = p_actor, clinical_reviewed_at = now(), clinical_note = left(trim(p_data->>'clinical_note'), 500), updated_at = now() where id = cid;
  elsif p_action = 'approve' then
    update private.content_items set status = 'approved', updated_by = p_actor, updated_at = now() where id = cid and status in ('draft', 'in_review');
  elsif p_action = 'publish' then
    if old.clinical and old.clinical_reviewed_at is null then return jsonb_build_object('ok', false, 'error', 'clinical_review_required'); end if;
    update private.content_items set status = 'published', published_at = now(), published_by = p_actor, updated_at = now() where id = cid;
  elsif p_action = 'unpublish' then
    update private.content_items set status = 'draft', updated_at = now(), updated_by = p_actor where id = cid and status = 'published';
  elsif p_action = 'archive' then
    if old.status = 'published' then perform private.require(p_actor, pub_perm); end if;
    update private.content_items set status = 'archived', updated_at = now(), updated_by = p_actor where id = cid;
  else raise exception 'invalid action' using errcode = '22023';
  end if;
  perform private.audit(p_actor, r, 'content.' || p_action, t, cid::text, null, oldj, (select to_jsonb(c) - 'body' from private.content_items c where id = cid), 'ok', p_request);
  return jsonb_build_object('ok', true, 'id', cid);
end $$;

-- ───────────────────────── product and leadership overview (dashboard) ─────────────────────────
create or replace function public.admin_product_overview(p_actor uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, private, public as $$
begin
  perform private.require(p_actor, 'dashboard.view');
  if p_to <= p_from or p_to - p_from > interval '400 days' then raise exception 'invalid period' using errcode = '22023'; end if;
  return jsonb_build_object(
    'support', case when private.can(p_actor, 'support.view') then (select jsonb_build_object(
        'open', count(*) filter (where status in ('new', 'open', 'waiting')), 'new', count(*) filter (where status = 'new'),
        'created', count(*) filter (where created_at >= p_from and created_at < p_to), 'resolved', count(*) filter (where resolved_at >= p_from and resolved_at < p_to),
        'daily', (select jsonb_agg(jsonb_build_object('day', d, 'created', (select count(*) from private.support_requests where private.day(created_at) = d),
            'resolved', (select count(*) from private.support_requests where resolved_at is not null and private.day(resolved_at) = d)) order by d)
          from (select g::date d from generate_series(private.day(p_from)::timestamp, private.day(p_to - interval '1 second')::timestamp, interval '1 day') g) ds)) from private.support_requests) end,
    'feedback', case when private.can(p_actor, 'feedback.view') then (select jsonb_build_object('new', count(*) filter (where status = 'new'),
        'period', count(*) filter (where created_at >= p_from and created_at < p_to)) from private.feedback) end,
    'bugs', case when private.can(p_actor, 'bugs.view') then (select jsonb_build_object('open', count(*) filter (where status not in ('done', 'wont_do')),
        'critical', count(*) filter (where severity = 'critical' and status not in ('done', 'wont_do')),
        'resolved', count(*) filter (where resolved_at >= p_from and resolved_at < p_to)) from private.work_items where type = 'bug') end,
    'content', case when private.can(p_actor, 'content.view') or private.can(p_actor, 'releases.view') then (select jsonb_build_object('in_review', count(*) filter (where status = 'in_review'),
        'published', count(*) filter (where published_at >= p_from and published_at < p_to)) from private.content_items) end,
    'leadership', case when private.can(p_actor, 'team.view') then jsonb_build_object(
        'co_founders', (select count(*) from private.admin_members where role = 'co_founder' and status = 'active'),
        'suspended', (select count(*) from private.admin_members where status = 'suspended'),
        'pending_invites', (select count(*) from private.admin_invites where status = 'pending' and expires_at > now()),
        'without_mfa', (select count(*) from private.admin_members m where m.status = 'active' and not exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified')),
        'denied_24h', (select count(*) from private.admin_audit_log where outcome = 'denied' and at > now() - interval '24 hours')) end);
end $$;

-- ───────────────────────── public settings and sign-up hook ─────────────────────────
-- Adds published release notes ("What's new" in the app). Nothing else changes.
create or replace function public.public_settings() returns jsonb language sql stable security definer set search_path = pg_catalog, private as $$
  select jsonb_build_object(
    'flags', coalesce((select jsonb_object_agg(key, enabled) from private.feature_flags where key <> 'maintenance'), '{}'::jsonb),
    'maintenance', jsonb_build_object('on', private.maintenance_on(),
       'message', coalesce((select value->>'message' from private.feature_flags where key = 'maintenance'), ''),
       'ends_at', (select nullif(value->>'ends_at', '') from private.feature_flags where key = 'maintenance' and private.maintenance_on())),
    'announcements', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'body', body, 'audience', audience) order by starts_at nulls first, created_at)
       from private.announcements where status = 'published' and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now())), '[]'::jsonb),
    'whats_new', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'body', left(body, 1200), 'published_at', published_at) order by published_at desc)
       from (select * from private.content_items where type = 'release_note' and status = 'published' and not (clinical and clinical_reviewed_at is null) order by published_at desc limit 5) c), '[]'::jsonb)) $$;

-- Sign-ups paused: still let an invited Co-Founder's account be created.
create or replace function public.hook_before_user_created(event jsonb) returns jsonb language sql stable security definer set search_path = pg_catalog, private as $$
  select case when (coalesce((select enabled from private.feature_flags where key = 'registrations'), true) and not private.maintenance_on())
              or exists (select 1 from private.admin_invites where email = lower(event->'user'->>'email') and status = 'pending' and expires_at > now())
    then '{}'::jsonb
    else jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'New accounts are paused for a short while. Please try again later.')) end $$;

-- ───────────────────────── privileges ─────────────────────────
do $$ declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'admin\_%' or p.proname in ('public_settings', 'support_submit', 'support_mine', 'support_reply', 'feedback_submit')) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname in ('support_submit', 'support_mine', 'support_reply', 'feedback_submit') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
do $$ declare t record;
begin
  for t in select c.oid::regclass as rel from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relkind = 'r' loop
    execute format('alter table %s enable row level security', t.rel);
  end loop;
end $$;
