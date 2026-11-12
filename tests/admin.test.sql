-- Doctine · admin console database tests (run by run-db-tests.sh). Fictional people only.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
-- Runs sql and passes only if it fails with "forbidden" (42501).
create or replace function pg_temp.denied(sql text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when insufficient_privilege then raise notice 'ok: %', what; return; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;

-- Start from an empty set of accounts (this throw-away database was used by the earlier test files).
delete from auth.users;

-- Fictional accounts: one per role, two ordinary people and a suspended admin.
insert into auth.users (id, email, created_at, email_confirmed_at, last_sign_in_at) values
  ('a0000000-0000-0000-0000-000000000001', 'owner@example.test', now() - interval '60 days', now() - interval '60 days', now()),
  ('a0000000-0000-0000-0000-000000000002', 'admin@example.test', now() - interval '50 days', now() - interval '50 days', now()),
  ('a0000000-0000-0000-0000-000000000003', 'ops@example.test', now() - interval '40 days', now() - interval '40 days', now()),
  ('a0000000-0000-0000-0000-000000000004', 'analyst@example.test', now() - interval '30 days', now() - interval '30 days', now()),
  ('a0000000-0000-0000-0000-000000000005', 'support@example.test', now() - interval '20 days', now() - interval '20 days', now()),
  ('a0000000-0000-0000-0000-000000000006', 'auditor@example.test', now() - interval '10 days', now() - interval '10 days', now()),
  ('a0000000-0000-0000-0000-000000000007', 'former@example.test', now() - interval '10 days', now() - interval '10 days', now()),
  ('b0000000-0000-0000-0000-000000000001', 'asha.sample@example.test', now() - interval '3 days', now() - interval '3 days', now() - interval '1 day'),
  ('b0000000-0000-0000-0000-000000000002', 'ravi.sample@example.test', now() - interval '2 hours', null, null);
insert into private.admin_members (user_id, role, status) values
  ('a0000000-0000-0000-0000-000000000001', 'owner', 'active'), ('a0000000-0000-0000-0000-000000000002', 'admin', 'active'),
  ('a0000000-0000-0000-0000-000000000003', 'admin', 'active'), ('a0000000-0000-0000-0000-000000000004', 'analyst', 'active'),
  ('a0000000-0000-0000-0000-000000000005', 'support', 'active'), ('a0000000-0000-0000-0000-000000000006', 'auditor', 'active'),
  ('a0000000-0000-0000-0000-000000000007', 'admin', 'suspended');
insert into public.documents (user_id, client_id, title, category, provider, source, fields, page_count)
  values ('b0000000-0000-0000-0000-000000000001', 1, 'SECRET-TITLE Sample CBC', 'Lab report', 'SECRET-PROVIDER Sample Lab', 'scan', '{"Haemoglobin":"SECRET-VALUE 13.1"}', 1);
insert into public.document_files (user_id, document_id, kind, page, storage_path, content_type, size_bytes)
  select user_id, id, 'original', 0, user_id || '/x.jpg', 'image/jpeg', 120000 from public.documents;
insert into public.health_profiles (user_id, full_name, allergies) values ('b0000000-0000-0000-0000-000000000001', 'SECRET-NAME', 'SECRET-ALLERGY');
insert into auth.sessions (user_id) values ('b0000000-0000-0000-0000-000000000001'), ('b0000000-0000-0000-0000-000000000001');

\set owner '''a0000000-0000-0000-0000-000000000001'''
\set adm '''a0000000-0000-0000-0000-000000000002'''
\set ops '''a0000000-0000-0000-0000-000000000003'''
\set analyst '''a0000000-0000-0000-0000-000000000004'''
\set support '''a0000000-0000-0000-0000-000000000005'''
\set auditor '''a0000000-0000-0000-0000-000000000006'''
\set former '''a0000000-0000-0000-0000-000000000007'''
\set asha '''b0000000-0000-0000-0000-000000000001'''
\set ravi '''b0000000-0000-0000-0000-000000000002'''

-- ── nobody but the server can reach any of it ──
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', false);
select pg_temp.denied($$select public.admin_me('a0000000-0000-0000-0000-000000000001')$$, 'a signed-in browser (even the owner''s) cannot call admin functions');
select pg_temp.denied($$select public.admin_overview('a0000000-0000-0000-0000-000000000001', now() - interval '7 days', now())$$, 'a signed-in browser cannot read the dashboard');
select pg_temp.denied($$select * from private.admin_members$$, 'a signed-in browser cannot read the admin team');
select pg_temp.denied($$select * from private.admin_audit_log$$, 'a signed-in browser cannot read the audit log');
select pg_temp.denied($$select * from private.analytics_events$$, 'a signed-in browser cannot read analytics');
select pg_temp.denied($$insert into private.admin_members values ('b0000000-0000-0000-0000-000000000001', 'owner')$$, 'a signed-in browser cannot make itself an admin');
select pg_temp.denied($$select public.record_event('b0000000-0000-0000-0000-000000000001', 'login_success', '{}', 'k1')$$, 'a signed-in browser cannot write analytics directly');
select pg_temp.denied($$select public.public_settings()$$, 'a signed-in browser cannot call the settings function directly');
reset role;
set role anon;
select pg_temp.denied($$select public.admin_me('a0000000-0000-0000-0000-000000000001')$$, 'signed-out visitors cannot call admin functions');
select pg_temp.denied($$select public.admin_team_set('a0000000-0000-0000-0000-000000000001', 'x@example.test', 'owner', 'active', 'x', null)$$, 'signed-out visitors cannot appoint admins');
reset role;

-- ── the server, acting for each role ──
set role service_role;
select pg_temp.expect((public.admin_me(:asha)->>'role') is null, 'an ordinary account has no admin role');
select pg_temp.expect((public.admin_me(:former)->>'role') is null, 'a suspended admin has no admin role');
select pg_temp.denied(format('select public.admin_overview(%L, now() - interval ''7 days'', now())', :asha), 'an ordinary account is refused the dashboard');
select pg_temp.denied(format('select public.admin_users(%L, null, null, null, 1, 25, null, null)', :former), 'a suspended admin is refused the user list');
select pg_temp.expect((public.admin_me(:owner)->>'role') = 'owner', 'the owner is recognised');
select pg_temp.expect((public.admin_overview(:analyst, now() - interval '7 days', now())->>'users_total')::int = 9, 'analysts see the dashboard (9 accounts)');
select pg_temp.expect((public.admin_overview(:owner, now() - interval '7 days', now())->>'users_new')::int = 2, 'new accounts in the period are counted (2)');
select pg_temp.expect((public.admin_overview(:owner, now() - interval '7 days', now())->>'active')::int = 1, 'one person had qualifying activity this week');
select pg_temp.expect(jsonb_array_length(public.admin_series(:analyst, now() - interval '7 days', now())) between 7 and 8, 'daily series covers the period');
select pg_temp.denied(format('select public.admin_series(%L, now() - interval ''7 days'', now())', :support), 'support cannot see analytics charts');
select pg_temp.denied(format('select public.admin_users(%L, null, null, null, 1, 25, null, null)', :analyst), 'analysts cannot see the user list');
select pg_temp.expect((public.admin_users(:support, 'sample', null, null, 1, 25, null, null)->>'total')::int = 2, 'support can search people by email');

-- no health information leaves the database through any admin function
do $$ declare blob text; begin
  blob := concat_ws(' ', public.admin_users('a0000000-0000-0000-0000-000000000001', null, null, null, 1, 100, null, null),
    public.admin_user('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
    public.admin_documents('a0000000-0000-0000-0000-000000000001', now() - interval '30 days', now() + interval '1 hour', 1, 100),
    public.admin_overview('a0000000-0000-0000-0000-000000000001', now() - interval '30 days', now()),
    public.admin_adoption('a0000000-0000-0000-0000-000000000001', now() - interval '30 days', now()));
  if blob like '%SECRET-%' then raise exception 'FAILED: an admin function returned health information'; end if;
  raise notice 'ok: no titles, providers, values, names or allergies appear in any admin response';
end $$;
select pg_temp.expect(public.admin_documents(:analyst, now() - interval '1 day', now() + interval '1 hour', 1, 10)->'rows'->0->>'account' !~ '-', 'analysts see a short code, not the account id, on documents');

-- user actions
select pg_temp.denied(format('select public.admin_user_action(%L, %L, ''suspend'', ''test'', null, null)', :analyst, :asha), 'analysts cannot suspend accounts');
select pg_temp.denied(format('select public.admin_user_action(%L, %L, ''suspend'', ''test'', null, null)', :support, :asha), 'support cannot suspend accounts');
do $$ begin
  begin perform public.admin_user_action('a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 'suspend', '', null, null);
    raise exception 'FAILED: suspended without a reason';
  exception when invalid_parameter_value then raise notice 'ok: a reason is required to suspend'; end;
end $$;
select pg_temp.expect((public.admin_user_action(:ops, :asha, 'suspend', 'fictional abuse report', null, 'req-1')->>'apply_ban') = 'on', 'an admin can suspend an ordinary account');
reset role;
select pg_temp.expect(not exists (select 1 from auth.sessions where user_id = :asha), 'suspending ends the person''s sessions');
set role service_role;
select pg_temp.expect((public.admin_user_action(:ops, :adm, 'suspend', 'x', null, null)->>'error') = 'admin_target_needs_owner', 'an admin cannot suspend another admin (only the owner can)');
select pg_temp.expect((public.admin_user_action(:owner, :owner, 'suspend', 'x', null, null)->>'error') = 'not_on_yourself', 'nobody can suspend themselves');
select pg_temp.expect((public.admin_user_action(:support, :asha, 'note', null, 'Asked about export (fictional)', null)->>'ok')::boolean, 'support can add a note');
select pg_temp.expect(jsonb_array_length(public.admin_user(:support, :asha)->'notes') = 1, 'support sees notes');
select pg_temp.denied(format('select public.admin_user(%L, %L)', :auditor, :asha), 'auditors cannot open a person''s account');
select pg_temp.denied(format('select public.admin_user(%L, %L)', :analyst, :asha), 'analysts cannot open a person''s account');
select pg_temp.denied(format('select public.admin_log_action(%L, ''users.reset_password'', ''user.reset_password'', ''user'', %L, null, null, ''requested'', null)', :analyst, :asha), 'analysts cannot send password resets');
select pg_temp.expect((public.admin_log_action(:support, 'users.reset_password', 'user.reset_password', 'user', :asha, null, null, 'requested', null)->>'email') = 'asha.sample@example.test', 'support can request a password reset');

-- switches and maintenance
select pg_temp.denied(format('select public.admin_set_flag(%L, ''document_upload'', false, null, ''x'', null)', :auditor), 'auditors cannot change switches');
select pg_temp.denied(format('select public.admin_set_flag(%L, ''document_upload'', false, null, ''x'', null)', :support), 'support cannot change switches');
select pg_temp.denied(format('select public.admin_set_flag(%L, ''maintenance'', true, ''x'', ''x'', null)', :analyst), 'analysts cannot turn on maintenance');
select pg_temp.expect((public.admin_set_flag(:adm, 'document_upload', false, null, 'fictional storage incident', null)->>'ok')::boolean, 'an admin can switch uploads off');
select pg_temp.expect(not public.uploads_allowed(), 'the upload switch is enforced by the storage policy check');
select pg_temp.expect((public.public_settings()->'flags'->>'document_upload')::boolean = false, 'the app is told uploads are off');
select public.admin_set_flag(:adm, 'document_upload', true, null, 'resolved', null);
select public.admin_set_flag(:owner, 'maintenance', true, 'Back at 10:00 IST', 'fictional upgrade', null);
select pg_temp.expect(not public.uploads_allowed() and (public.public_settings()->'maintenance'->>'on')::boolean, 'maintenance blocks uploads and is announced to the app');
select public.admin_set_flag(:owner, 'maintenance', false, null, 'done', null);
select pg_temp.expect((public.public_settings()->'flags'->>'ai_assistant')::boolean = false, 'the assistant switch starts off');

-- announcements: drafts and expired ones are never shown to people
select public.admin_announcement_save(:ops, '{"kind":"product","title":"Draft only"}', null);
select public.admin_announcement_save(:ops, jsonb_build_object('kind','service','title','Expired','status','published','starts_at', now() - interval '2 days','ends_at', now() - interval '1 day'), null);
select public.admin_announcement_save(:ops, '{"kind":"service","title":"Live notice","status":"published"}', null);
select pg_temp.expect(jsonb_array_length(public.public_settings()->'announcements') = 1 and public.public_settings()->'announcements'->0->>'title' = 'Live notice', 'only live published announcements reach the app');
select pg_temp.denied(format('select public.admin_announcement_save(%L, ''{"kind":"product","title":"x"}'', null)', :analyst), 'analysts cannot publish announcements');

-- team: only the owner, never an account that does not exist, always one owner left
select pg_temp.denied(format('select public.admin_team_set(%L, ''ravi.sample@example.test'', ''analyst'', ''active'', ''x'', null)', :adm), 'an admin cannot appoint admins');
select pg_temp.expect((public.admin_team_set(:owner, 'nobody@example.test', 'analyst', 'active', 'x', null)->>'error') = 'no_account', 'appointing needs an existing account (none are created)');
select pg_temp.expect((public.admin_team_set(:owner, 'RAVI.sample@example.test', 'analyst', 'active', 'new analyst', null)->>'ok')::boolean, 'the owner can appoint an existing account');
select pg_temp.expect((public.admin_me(:ravi)->>'role') = 'analyst', 'the appointment takes effect');
select pg_temp.expect((public.admin_team_set(:owner, 'owner@example.test', 'analyst', 'active', 'x', null)->>'error') = 'not_on_yourself', 'the owner cannot demote themselves');
select public.admin_team_set(:owner, 'admin@example.test', 'owner', 'active', 'second owner (fictional)', null);
select pg_temp.expect((public.admin_team_set(:adm, 'owner@example.test', 'support', 'active', 'handover test', null)->>'ok')::boolean, 'a second owner can change the first owner''s role');
select pg_temp.denied(format('select public.admin_team_set(%L, ''admin@example.test'', ''support'', ''active'', ''x'', null)', :owner), 'the demoted owner loses the power to appoint at once');
select public.admin_team_set(:adm, 'owner@example.test', 'owner', 'active', 'restore', null);
select public.admin_team_set(:owner, 'admin@example.test', 'admin', 'active', 'restore', null);

-- audit log: everything is recorded and nothing can be altered, even by the server
select pg_temp.denied($$update private.admin_audit_log set reason = 'edited'$$, 'the audit log cannot be edited');
select pg_temp.denied($$delete from private.admin_audit_log$$, 'the audit log cannot be deleted');
select pg_temp.denied($$truncate private.admin_audit_log$$, 'the audit log cannot be emptied');
select pg_temp.denied(format('select public.admin_audit(%L, null, null, null, null, null, 1, 10)', :analyst), 'analysts cannot read the audit log');
select pg_temp.denied(format('select public.admin_audit(%L, null, null, null, null, null, 1, 10)', :support), 'support cannot read the audit log');
select pg_temp.expect((public.admin_audit(:auditor, null, null, null, null, null, 1, 10)->>'total')::int > 5, 'auditors can read the audit log');
select pg_temp.denied(format('select public.admin_user_action(%L, %L, ''suspend'', ''x'', null, null)', :auditor, :ravi), 'auditors cannot act on accounts');
select pg_temp.expect((public.admin_audit(:owner, null, null, null, null, null, 1, 10)->>'total')::int > 5, 'the owner can read the audit log');
reset role;
-- even the database owner cannot quietly edit history
select pg_temp.expect((select count(*) from private.admin_audit_log where action = 'user.suspend' and outcome = 'requested' and request_id = 'req-1') = 1, 'the suspension is in the audit log');
select pg_temp.expect((select count(*) from private.admin_audit_log where outcome = 'denied') >= 3, 'refusals by rule are in the audit log');
select pg_temp.expect((select count(*) from private.admin_audit_log where action like 'flag.%' or action like 'maintenance.%') >= 4, 'switch changes are in the audit log');
do $$ begin
  begin update private.admin_audit_log set reason = 'x'; raise exception 'FAILED: the database owner edited the audit log';
  exception when insufficient_privilege then raise notice 'ok: the audit log refuses edits from the database owner too'; end;
end $$;

-- analytics events: fixed names, short codes only, retries counted once
set role service_role;
select pg_temp.expect(public.record_event(:asha, 'record_exported', '{"format":"pdf"}', 'exp-1'), 'a valid event is recorded');
select pg_temp.expect(not public.record_event(:asha, 'record_exported', '{"format":"pdf"}', 'exp-1'), 'a retried event is counted once');
do $$ begin
  begin perform public.record_event('b0000000-0000-0000-0000-000000000001', 'document_upload_failed', '{"reason":"Haemoglobin 13.1 g/dL"}', 'k2');
    raise exception 'FAILED: free text was accepted in an event';
  exception when invalid_parameter_value then raise notice 'ok: free text is refused in event properties'; end;
  begin perform public.record_event('b0000000-0000-0000-0000-000000000001', 'search_performed', '{"query":"diabetes"}', 'k3');
    raise exception 'FAILED: an unlisted property was accepted';
  exception when invalid_parameter_value then raise notice 'ok: properties outside the allow-list are refused'; end;
  begin perform public.record_event(null, 'chat_message', '{}', 'k4');
    raise exception 'FAILED: an unknown event was accepted';
  exception when invalid_parameter_value then raise notice 'ok: unknown event names are refused'; end;
end $$;
select pg_temp.expect((public.admin_overview(:owner, now() - interval '7 days', now() + interval '1 minute')->>'active')::int = 1, 'an export counts as activity');

-- alerts only from measurements
select public.record_event(null, 'document_upload_failed', '{"reason":"network"}', 'f' || g) from generate_series(1, 4) g;
select public.record_event(null, 'document_upload_completed', '{"kind":"image"}', 'c' || g) from generate_series(1, 6) g;
select pg_temp.expect(exists (select 1 from jsonb_array_elements(public.admin_alerts(:analyst, true)) a where a->>'rule' = 'upload_failure_rate'), 'a 40% upload failure rate opens an alert');
select pg_temp.expect((select count(*) from jsonb_array_elements(public.admin_alerts(:analyst, true)) a where a->>'rule' = 'upload_failure_rate') = 1, 're-checking does not duplicate an open alert');
select pg_temp.expect(not exists (select 1 from jsonb_array_elements(public.admin_alerts(:analyst, true)) a where a->>'rule' = 'login_failures'), 'no alert without measurements behind it');
select pg_temp.denied(format('select public.admin_alert_update(%L, gen_random_uuid(), ''resolved'', null)', :support), 'support cannot resolve alerts');
reset role;

-- error tracking: cleaned, grouped, reopened when they come back
set role service_role;
select public.report_error('client', 'TypeError', 'Cannot read "Haemoglobin 13.1" for asha.sample@example.test at 42', '/index.html:120:7?x=SECRET', 'abc123');
select public.report_error('client', 'TypeError', 'Cannot read "something else 9.9" for ravi@example.test at 7', '/index.html:120:9', 'abc123');
reset role;
select pg_temp.expect((select count(*) from private.error_groups) = 1 and (select count from private.error_groups) = 2, 'the same error is grouped, whatever values were in it');
select pg_temp.expect((select message from private.error_groups) !~ '(13|Haemoglobin|example|42)' and (select location from private.error_groups) !~ 'SECRET', 'values, quoted text, emails and query strings are removed before storage');
set role service_role;
select pg_temp.expect((public.admin_errors(:analyst, null)->>'last_24h')::int = 2, 'analysts see error counts');
select pg_temp.denied(format('select public.admin_errors(%L, null)', :asha), 'ordinary accounts cannot see errors');
select public.admin_error_update(:ops, (select fingerprint from jsonb_to_recordset(public.admin_errors(:ops, null)->'groups') x(fingerprint text)), 'resolved', null);
select public.report_error('server', 'x', 'y', null, null);
select public.report_error('client', 'TypeError', 'Cannot read "z" for a@b.c at 1', '/index.html:120:1', null);
select pg_temp.expect((select count(*) from jsonb_to_recordset(public.admin_errors(:ops, 'open')->'groups') x(fingerprint text)) = 2, 'a resolved error that happens again is reopened');
do $$ begin
  begin perform public.report_error('browser', 'x', 'y', null, null); raise exception 'FAILED: unknown source accepted';
  exception when invalid_parameter_value then raise notice 'ok: only client or server errors are accepted'; end;
end $$;
reset role;
set role authenticated;
select pg_temp.denied($$select public.report_error('client', 'x', 'y', null, null)$$, 'browsers cannot write errors directly (only through the rate-limited server)');
reset role;

-- uptime history and scheduled alerts
set role service_role;
select pg_temp.expect(public.record_uptime('[{"target":"app","ok":true,"status":200,"ms":120},{"target":"database","ok":false,"status":503,"ms":900},{"target":"nonsense","ok":true}]'), 'a round of checks is recorded');
select pg_temp.expect(not public.record_uptime('[{"target":"app","ok":true,"status":200,"ms":1}]'), 'a second round within 4 minutes is ignored');
reset role;
select pg_temp.expect((select count(*) from private.uptime_checks) = 2, 'unknown targets are dropped');
update private.uptime_checks set at = at - interval '10 minutes';
set role service_role;
select public.record_uptime('[{"target":"app","ok":true,"status":200,"ms":110},{"target":"database","ok":false,"status":503,"ms":900}]');
select pg_temp.expect((select (t->>'checks')::int = 2 and (t->>'ok')::int = 0 from jsonb_array_elements(public.admin_uptime(:analyst, 7)->'targets') t where t->>'target' = 'database'), 'uptime history per service');
select pg_temp.denied(format('select public.admin_uptime(%L, 7)', :asha), 'ordinary accounts cannot see uptime history');
select pg_temp.expect((public.monitor_run()->>'opened')::int >= 1, 'two failed database checks in a row open an alert on the scheduled run');
select pg_temp.expect(exists (select 1 from jsonb_array_elements(public.monitor_run()->'to_notify') a where a->>'message' like 'Database failed%'), '…which is waiting to be emailed');
select public.monitor_mark_notified(array(select (a->>'id')::uuid from jsonb_array_elements(public.monitor_run()->'to_notify') a), 'github');
select pg_temp.expect(jsonb_array_length(public.monitor_run()->'to_notify') = 0, 'nobody is emailed twice about the same alert');
reset role;
-- ── v2: roles, measures, activity, search, preferences, incidents, alerts, maintenance window, errors ──
set role service_role;
select pg_temp.expect((public.admin_me(:auditor)->'perms') ? 'audit.view' and not ((public.admin_me(:auditor)->'perms') ? 'users.view'), 'auditors read audit and security history only');
do $$ begin
  begin perform public.admin_team_set('a0000000-0000-0000-0000-000000000001', 'ravi.sample@example.test', 'super_admin', 'active', 'x', null);
    raise exception 'FAILED: an old role name was accepted';
  exception when invalid_parameter_value then raise notice 'ok: only the five current roles can be given'; end;
end $$;
select pg_temp.expect((public.admin_overview(:owner, now() - interval '7 days', now() + interval '1 minute') ?& array['users_total_prev','returning_prev','files_new','app_errors','availability','checks_since']), 'the overview carries previous-period and reliability figures');
select pg_temp.expect((select bool_and(d ?& array['documents_total','storage_total','returning','checks','app_errors']) from jsonb_array_elements(public.admin_series(:analyst, now() - interval '7 days', now())) d), 'the daily series carries records, storage, returning people, checks and errors');
select pg_temp.expect((public.admin_funnel(:owner, now() - interval '30 days', now() + interval '1 minute') ?& array['profile_completed','first_record','first_file']), 'the activation funnel has all six steps');
select pg_temp.expect((public.admin_funnel(:owner, now() - interval '30 days', now() + interval '1 minute')->>'first_record')::int = 1, '…counting the person who added a record');
select pg_temp.expect((select (f->>'measured')::boolean from jsonb_array_elements(public.admin_adoption(:analyst, now() - interval '30 days', now())->'features') f where f->>'key' = 'record'), 'table-backed features are always measured');
select pg_temp.expect(jsonb_array_length(public.admin_adoption_trend(:analyst, 8)) = 8, 'adoption trend: one point per week');
select pg_temp.expect((public.admin_engagement(:analyst, now() - interval '30 days', now() + interval '1 minute')->>'actions')::int >= 2, 'engagement counts meaningful actions');
select pg_temp.denied(format('select public.admin_engagement(%L, now() - interval ''7 days'', now())', :support), 'support cannot see engagement analytics');
select pg_temp.expect((public.admin_users(:owner, null, null, null, 1, 25, now() - interval '4 days', now())->>'total')::int = 2, 'users can be filtered by registration date');
select pg_temp.expect((public.admin_activity(:analyst)->'registrations') = 'null'::jsonb and jsonb_typeof(public.admin_activity(:owner)->'registrations') = 'array', 'recent registrations (with emails) only for roles that may see accounts');
select pg_temp.expect((public.admin_activity(:support)->'admin_actions') = 'null'::jsonb, 'recent admin actions only for roles that may read the audit log');
select pg_temp.expect(jsonb_array_length(public.admin_search(:owner, 'asha')->'users') = 1 and jsonb_array_length(public.admin_search(:analyst, 'asha')->'users') = 0, 'search returns only what the role may see');
select pg_temp.expect((public.admin_user(:owner, :asha)->'adoption'->>'record')::boolean, 'account detail shows feature adoption (yes or no only)');
select pg_temp.denied(format('select public.admin_documents(%L, now() - interval ''1 day'', now(), 1, 10)', :support), 'support no longer sees document operations');
select pg_temp.expect((select bool_and(r->>'account' ~ '^[0-9a-f]{10}$') from jsonb_array_elements(public.admin_documents(:owner, now() - interval '1 day', now() + interval '1 hour', 1, 10)->'rows') r), 'document operations use a pseudonymous account code for every role');

-- notification preferences and who is emailed
select public.admin_set_prefs(:owner, true, 'warning', null);
select pg_temp.expect(exists (select 1 from jsonb_array_elements(public.monitor_run()->'recipients') r where r->>'email' = 'owner@example.test'), 'an admin who opts in is emailed new alerts');
do $$ begin
  begin perform public.admin_set_prefs('a0000000-0000-0000-0000-000000000006', true, 'warning', null); raise exception 'FAILED: an auditor subscribed to operational alerts';
  exception when insufficient_privilege then raise notice 'ok: only roles that see platform health can subscribe to alerts'; end;
end $$;

-- alerts: mute for 24 hours, then back
select public.admin_alert_update(:ops, (select (a->>'id')::uuid from jsonb_array_elements(public.admin_alerts(:ops, false)) a where a->>'status' = 'open' limit 1), 'muted', null);
reset role;
select pg_temp.expect(exists (select 1 from private.admin_alerts where status = 'muted' and muted_until > now() + interval '23 hours'), 'an alert can be muted for 24 hours');
update private.admin_alerts set muted_until = now() - interval '1 minute' where status = 'muted';
set role service_role;
select public.monitor_run();
reset role;
select pg_temp.expect(not exists (select 1 from private.admin_alerts where status = 'muted'), 'an expired mute reopens the alert');
-- monitoring stopped
update private.uptime_checks set at = at - interval '2 hours';
set role service_role;
select public.monitor_run();
reset role;
select pg_temp.expect(exists (select 1 from private.admin_alerts where rule = 'monitor_stale' and service = 'monitoring'), 'no health round for 45 minutes opens a "monitoring stopped" alert');
set role service_role;
select pg_temp.expect(public.record_uptime('[{"target":"ai","ok":false,"status":401,"ms":300,"error":"auth_failed"}]'), 'the AI provider can be part of the uptime history');

-- incidents: severity, assignee, timeline
select pg_temp.expect((public.admin_incident_save(:ops, '{"title":"Uploads slow (fictional)","severity":"major","assigned_email":"admin@example.test","update_note":"Looking into it"}', null)->>'ok')::boolean, 'an incident opens with severity and an assignee');
do $$ begin
  begin perform public.admin_incident_save('a0000000-0000-0000-0000-000000000003', '{"title":"x","assigned_email":"asha.sample@example.test"}', null);
    raise exception 'FAILED: an ordinary account was assigned an incident';
  exception when invalid_parameter_value then raise notice 'ok: incidents can only be assigned to active admins'; end;
end $$;
select public.admin_incident_save(:ops, jsonb_build_object('id', (select i->>'id' from jsonb_array_elements(public.admin_incidents(:ops)) i limit 1), 'status', 'resolved', 'severity', 'major', 'update_note', 'Fixed'), null);
select pg_temp.expect((select jsonb_array_length(i->'timeline') = 2 and i->>'assigned_email' = 'admin@example.test' and i->>'status' = 'resolved' from jsonb_array_elements(public.admin_incidents(:analyst)) i limit 1), 'the incident keeps a timeline of every change');

-- maintenance window and announcement audience
select pg_temp.expect((public.admin_set_maintenance(:owner, false, 'Planned upgrade', now() - interval '1 minute', now() + interval '1 hour', 'fictional window', null)->>'on_now')::boolean, 'a scheduled maintenance window is on during the window');
select pg_temp.expect(not public.uploads_allowed() and (public.public_settings()->'maintenance'->>'on')::boolean, '…and enforced like manual maintenance');
select public.admin_set_maintenance(:owner, false, null, null, null, 'end window', null);
select pg_temp.expect(public.uploads_allowed(), 'clearing the window ends it');
select pg_temp.denied(format('select public.admin_set_maintenance(%L, true, null, null, null, ''x'', null)', :analyst), 'analysts cannot schedule maintenance');
select public.admin_announcement_save(:ops, '{"kind":"service","title":"Everyone notice","status":"published","audience":"all"}', null);
select pg_temp.expect(exists (select 1 from jsonb_array_elements(public.public_settings()->'announcements') a where a->>'audience' = 'all'), 'announcements carry their audience to the app');

-- errors: detail with a cleaned stack sample
select public.report_error('client', 'TypeError', 'x is undefined', '/index.html:9:1', 'abc', 'TypeError: x\n at render (https://app.doctine.com/index.html?token=SECRET:9:1) "Haemoglobin 13.1"', '#reports', 'production', 'req-123');
reset role;
select pg_temp.expect((select (public.admin_error(:analyst, fingerprint)->>'sample_stack') !~ '(SECRET|13|Haemoglobin|https)' from private.error_groups where kind = 'TypeError' and message like 'x is%'), 'stack samples keep no query strings, hosts, numbers or quoted text');
select pg_temp.expect((select public.admin_error(:analyst, fingerprint)->>'route' = '#reports' and public.admin_error(:analyst, fingerprint)->>'category' = 'code' from private.error_groups where message like 'x is%'), 'errors keep route and a category');

set role service_role;
-- report history
select public.admin_log_action(:analyst, 'reports.export', 'report.export', 'report', 'daily', null, '{"report":"daily","format":"csv"}', 'ok', null);
select pg_temp.expect(jsonb_array_length(public.admin_exports(:analyst)) >= 1, 'exports are listed in the report history');
select pg_temp.denied(format('select public.admin_exports(%L)', :support), 'support has no report history');
reset role;

select pg_temp.expect(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relkind = 'r' and not c.relrowsecurity), 'every private table has row-level security on');
\echo ALL ADMIN TESTS PASSED
