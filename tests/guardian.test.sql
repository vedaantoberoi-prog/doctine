-- Doctine · Guardian foundation (20261125000000_guardian.sql), run by run-db-tests.sh. Fictional accounts and numbers only.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.raises(sql text, state text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then if sqlstate = state then raise notice 'ok: %', what; return; end if; raise exception 'FAILED: % (got %: %)', what, sqlstate, sqlerrm; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;

insert into auth.users (id, email) values ('e0000000-0000-0000-0000-0000000000a1', 'guardian-a@example.test'), ('e0000000-0000-0000-0000-0000000000b1', 'guardian-b@example.test') on conflict do nothing;
\set A '''e0000000-0000-0000-0000-0000000000a1'''
\set B '''e0000000-0000-0000-0000-0000000000b1'''

-- switch and settings
select pg_temp.expect((select enabled = false from private.feature_flags where key = 'guardian'), 'the guardian switch exists and is off');
select pg_temp.expect((public.guardian_settings_get(:A)->>'enabled')::boolean = false, 'Guardian is off for a person until they switch it on');
select pg_temp.expect((public.guardian_settings_save(:A, '{"enabled":true,"share_location":true}')->>'share_location')::boolean, 'settings save');

-- contacts
create temp table t_c as select (public.guardian_contact_save(:A, '{"name":"Fictional Sister","phone":"+91 90000 00001","relationship":"Sister","priority":1,"status":"verified"}')->>'id')::uuid as id;
select pg_temp.expect((select status from private.guardian_contacts where id = (select id from t_c)) = 'unverified', 'a contact can not be saved as verified (needs a verification flow)');
update private.guardian_contacts set status = 'verified', verified_at = now() where id = (select id from t_c);
select pg_temp.expect((public.guardian_contact_save(:A, jsonb_build_object('id', (select id from t_c), 'name', 'Fictional Sister', 'phone', '+91 90000 00009'))->>'status') = 'unverified', 'changing the number makes the contact unverified again');
select pg_temp.raises(format($q$select public.guardian_contact_save(%L, '{"name":"X","phone":"call me"}')$q$, 'e0000000-0000-0000-0000-0000000000a1'), '23514', 'a phone number must look like one');
select pg_temp.raises(format($q$select public.guardian_contact_save(%L, jsonb_build_object('id', %L, 'name', 'Taken', 'phone', '+91 90000 00002'))$q$, 'e0000000-0000-0000-0000-0000000000b1', (select id from t_c)), 'P0002', 'another person cannot edit my contact');
do $$ begin for i in 2..5 loop perform public.guardian_contact_save('e0000000-0000-0000-0000-0000000000a1', jsonb_build_object('name', 'Fictional Contact ' || i, 'phone', '+91 90000 0000' || i)); end loop; end $$;
select pg_temp.raises(format($q$select public.guardian_contact_save(%L, '{"name":"Six","phone":"+91 90000 00006"}')$q$, 'e0000000-0000-0000-0000-0000000000a1'), '22023', 'at most 5 trusted contacts');
select pg_temp.expect(jsonb_array_length(public.guardian_contacts_list(:B)) = 0, 'contacts are per person');

-- incidents: open, idempotent, compare-and-set transitions along the allowed list only
create temp table t_i as select public.guardian_incident_insert(:A,
  '{"event_id":"f0000000-0000-4000-8000-000000000001","event_type":"sos","source":"app_button","confidence":1,"signal_quality":"unknown","observed_at":"2026-11-25T10:00:00Z","location":{"lat":18.52,"lng":73.85,"accuracy_m":20,"at":"2026-11-25T10:00:00Z"}}',
  'USER_CONFIRMED', '{"trigger":"open_confirmed","from":"NORMAL","to":"USER_CONFIRMED","reason":"person_asked_for_help","at":"2026-11-25T10:00:00Z"}') as r;
select (r->'incident'->>'id') as inc from t_i \gset
select pg_temp.expect((select (r->>'created')::boolean from t_i), 'an incident opens');
select pg_temp.expect((public.guardian_incident_insert(:A, '{"event_id":"f0000000-0000-4000-8000-000000000001","event_type":"sos","source":"app_button","confidence":1,"signal_quality":"unknown","observed_at":"2026-11-25T10:00:00Z"}', 'USER_CONFIRMED', '{"trigger":"open_confirmed"}')->>'created')::boolean = false, 'the same event again returns the same incident');
select pg_temp.expect((select count(*) from private.guardian_incidents where user_id = :A) = 1, 'still one incident');
select pg_temp.raises(format($q$select public.guardian_incident_insert(%L, '{"event_id":"f0000000-0000-4000-8000-000000000002","event_type":"sos","source":"app_button","confidence":1,"signal_quality":"unknown","observed_at":"2026-11-25T10:00:00Z"}', 'ESCALATING', '{"trigger":"open_confirmed"}')$q$, 'e0000000-0000-0000-0000-0000000000a1'), '22023', 'an incident cannot open in a state the list does not allow');
select pg_temp.expect((public.guardian_incident_transition(:A, :'inc', 'USER_CONFIRMED', 'ESCALATING', '{"trigger":"escalate"}', '{}')->>'ok')::boolean, 'an allowed transition applies');
select pg_temp.expect((public.guardian_incident_transition(:A, :'inc', 'USER_CONFIRMED', 'ESCALATING', '{"trigger":"escalate"}', '{}')->>'ok')::boolean = false, 'the same transition again does nothing (compare-and-set)');
select pg_temp.expect((public.guardian_incident_transition(:A, :'inc', 'ESCALATING', 'CANCELLED', '{"trigger":"user_ok"}', '{}')->>'ok')::boolean = false, 'a transition not on the list is refused (escalated incidents are RESOLVED, not CANCELLED)');
select pg_temp.expect((public.guardian_incident_transition(:B, :'inc', 'ESCALATING', 'FAILED_TO_DELIVER', '{"trigger":"delivery_failed"}', '{}')->>'ok')::boolean = false, 'another person cannot move my incident');
select pg_temp.expect(public.guardian_incident_get(:B, :'inc') is null, 'another person cannot read my incident');

-- deliveries: honest statuses, one per key, acknowledged stays acknowledged
select pg_temp.expect((public.guardian_delivery_upsert(:A, :'inc', jsonb_build_object('contact_id', (select id from t_c), 'channel', 'sms', 'wave', 1, 'kind', 'alert', 'status', 'not_configured', 'provider', 'none', 'error', 'no_provider'))->>'status') = 'not_configured', 'a delivery records not_configured');
select pg_temp.expect((public.guardian_delivery_upsert(:A, :'inc', jsonb_build_object('contact_id', (select id from t_c), 'channel', 'sms', 'wave', 1, 'kind', 'alert', 'status', 'not_configured', 'provider', 'none'))->>'attempts')::int = 2, 'retrying the same delivery updates it instead of adding another');
select pg_temp.raises(format($q$select public.guardian_delivery_upsert(%L, %L, jsonb_build_object('contact_id', %L, 'channel', 'sms', 'status', 'delivered'))$q$, 'e0000000-0000-0000-0000-0000000000b1', :'inc', (select id from t_c)), 'P0002', 'another person cannot add deliveries to my incident');
select pg_temp.raises(format($q$select public.guardian_delivery_upsert(%L, %L, jsonb_build_object('contact_id', %L, 'channel', 'sms', 'status', 'probably fine'))$q$, 'e0000000-0000-0000-0000-0000000000a1', :'inc', (select id from t_c)), '23514', 'only the defined delivery statuses exist');
select public.guardian_mark_ack(:A, :'inc', (select id from t_c));
select pg_temp.expect((select status from private.guardian_deliveries where incident_id = :'inc' and contact_id = (select id from t_c)) = 'acknowledged', 'a contact acknowledgement is recorded');
select public.guardian_delivery_upsert(:A, :'inc', jsonb_build_object('contact_id', (select id from t_c), 'channel', 'sms', 'wave', 1, 'kind', 'alert', 'status', 'failed'));
select pg_temp.expect((select status from private.guardian_deliveries where incident_id = :'inc' and contact_id = (select id from t_c)) = 'acknowledged', 'an acknowledged delivery stays acknowledged');
select pg_temp.expect((public.guardian_incident_for_contact(:'inc', (select id from t_c))->>'uid') = 'e0000000-0000-0000-0000-0000000000a1', 'a contact link finds the incident through its own contact');
insert into private.guardian_contacts (user_id, name, phone) values (:B, 'Fictional Stranger', '+91 90000 00099');
select pg_temp.expect(public.guardian_incident_for_contact(:'inc', (select id from private.guardian_contacts where name = 'Fictional Stranger')) is null, 'someone else''s contact cannot open my incident');

-- the transition log is append-only
select pg_temp.expect(jsonb_array_length(public.guardian_transitions(:A, :'inc')) = 2, 'both transitions are logged');
select pg_temp.raises(format($q$update private.guardian_transitions set to_state = 'RESOLVED' where incident_id = %L$q$, :'inc'), '42501', 'the transition log cannot be edited');

-- retention
update private.guardian_incidents set state = 'RESOLVED', closed_at = now() - interval '31 days' where id = :'inc';
select pg_temp.expect((public.guardian_purge()->>'locations_erased')::int = 1, 'a location is erased 30 days after the incident closed');
select pg_temp.expect((select lat is null from private.guardian_incidents where id = :'inc'), 'the incident is kept without its location');
update private.guardian_incidents set closed_at = now() - interval '13 months' where id = :'inc';
select pg_temp.expect((public.guardian_purge()->>'incidents_deleted')::int = 1, 'closed incidents are deleted after 12 months');

-- consent: a contact agrees only while the number is unchanged; declining is recorded
create temp table t_k as select (public.guardian_contact_save(:B, '{"name":"Fictional Cousin","phone":"+91 90000 00077"}')->>'id')::uuid as id;
select pg_temp.expect((public.guardian_contact_for_consent((select id from t_k))->>'status') = 'unverified', 'a new contact is unverified');
select pg_temp.raises(format($q$select public.guardian_contact_set_consent(%L, '+91 90000 00078', 'verified')$q$, (select id from t_k)), 'P0002', 'consent for a different number is refused');
select pg_temp.raises(format($q$select public.guardian_contact_set_consent(%L, '+91 90000 00077', 'admin')$q$, (select id from t_k)), '22023', 'only agree or decline');
select pg_temp.expect((public.guardian_contact_set_consent((select id from t_k), '+91 90000 00077', 'verified')->>'status') = 'verified', 'the contact agrees');
select pg_temp.expect((select verified_at is not null from private.guardian_contacts where id = (select id from t_k)), 'when they agreed is recorded');
select pg_temp.expect((public.guardian_contact_set_consent((select id from t_k), '+91 90000 00077', 'declined')->>'status') = 'declined', 'they can change their mind and decline');
select pg_temp.expect(public.guardian_contact_for_consent((select id from t_k))::text !~ 'user_id', 'the consent lookup reveals nothing about the person');

-- browsers can't reach any of it
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"e0000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false);
select pg_temp.raises('select count(*) from private.guardian_incidents', '42501', 'a signed-in person cannot read the incident tables directly');
select pg_temp.raises('select count(*) from private.guardian_contacts', '42501', 'a signed-in person cannot read the contacts table directly');
select pg_temp.raises($q$select public.guardian_settings_get('e0000000-0000-0000-0000-0000000000a1')$q$, '42501', 'a signed-in person cannot call the server functions, even for themselves');
select pg_temp.raises($q$select public.guardian_incident_insert('e0000000-0000-0000-0000-0000000000a1', '{}', 'USER_CONFIRMED', '{}')$q$, '42501', 'a signed-in person cannot open incidents directly');
select pg_temp.raises($q$select public.guardian_contact_set_consent('e0000000-0000-0000-0000-0000000000a1', '+91', 'verified')$q$, '42501', 'a signed-in person cannot mark a contact as agreed');
select set_config('request.jwt.claims', '', false);
reset role;

-- admin summary: Founder-only, counts only
select pg_temp.expect(exists (select 1 from private.admin_members where role = 'founder' and status = 'active'), 'a Founder exists (from admin.test.sql)');
select pg_temp.expect((public.admin_guardian_summary((select user_id from private.admin_members where role = 'founder' and status = 'active' limit 1)) ? 'by_state'), 'the Founder sees counts');
select pg_temp.expect(public.admin_guardian_summary((select user_id from private.admin_members where role = 'founder' and status = 'active' limit 1))::text !~ '(lat|phone|Fictional)', 'the summary holds no location, number or name');

-- the switch is Founder-only to change
insert into auth.users (id, email) values ('e0000000-0000-0000-0000-0000000000c1', 'guardian-cofounder@example.test') on conflict do nothing;
insert into private.admin_members (user_id, role, status, permissions) values ('e0000000-0000-0000-0000-0000000000c1', 'co_founder', 'active', private.perm_preset('admin'))
  on conflict (user_id) do update set role = 'co_founder', status = 'active', permissions = private.perm_preset('admin');
select pg_temp.raises($q$select public.admin_set_flag('e0000000-0000-0000-0000-0000000000c1', 'guardian', true, null, 'try', null)$q$, '42501', 'a Co-Founder without ai.manage cannot switch Guardian on');

-- deleting the account removes everything Guardian holds about them
delete from auth.users where id in ('e0000000-0000-0000-0000-0000000000a1', 'e0000000-0000-0000-0000-0000000000b1', 'e0000000-0000-0000-0000-0000000000c1');
select pg_temp.expect((select count(*) from private.guardian_contacts) + (select count(*) from private.guardian_incidents) + (select count(*) from private.guardian_settings) = 0, 'deleting an account deletes its Guardian data');
\echo 'guardian tests: all passed'
