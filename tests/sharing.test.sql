-- Doctine · patient-controlled record sharing (20261127000000_record_sharing.sql), run by run-db-tests.sh. Fictional people only.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.raises(sql text, state text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then if sqlstate = state then raise notice 'ok: %', what; return; end if; raise exception 'FAILED: % (got %: %)', what, sqlstate, sqlerrm; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;

-- A verified doctor D, an applicant U, a patient P with a small fictional record, another patient Q, a Co-Founder C (doctors.view).
insert into auth.users (id, email, email_confirmed_at) values
  ('f5000000-0000-0000-0000-0000000000d1', 'dr.meera.fictional@example.test', now()), ('f5000000-0000-0000-0000-0000000000d2', 'dr.applicant.fictional@example.test', now()),
  ('f5000000-0000-0000-0000-0000000000a1', 'patient.p@example.test', now()), ('f5000000-0000-0000-0000-0000000000a2', 'patient.q@example.test', now()),
  ('f5000000-0000-0000-0000-0000000000c1', 'sharing.viewer@example.test', now()), ('f5000000-0000-0000-0000-0000000000c2', 'sharing.flags@example.test', now()) on conflict do nothing;
insert into private.admin_members (user_id, role, status, permissions) values ('f5000000-0000-0000-0000-0000000000c1', 'co_founder', 'active', array['dashboard.view', 'doctors.view']),
  ('f5000000-0000-0000-0000-0000000000c2', 'co_founder', 'active', private.perm_preset('admin')) on conflict (user_id) do update set permissions = excluded.permissions, status = 'active';
insert into private.practitioners (user_id, status, full_name, registration_number, registration_council, registration_year, qualifications, specialties, languages, verified_at, expires_at)
values ('f5000000-0000-0000-0000-0000000000d1', 'VERIFIED', 'Dr Meera Fictional', 'DMC/12345', 'Delhi Medical Council', 2012, '[{"degree":"MBBS","institution":"Fictional College","year":2011}]', '{General physician}', '{English}', now(), now() + interval '12 months'),
       ('f5000000-0000-0000-0000-0000000000d2', 'DOCUMENTS_SUBMITTED', 'Dr Applicant Fictional', 'X/1', 'Delhi Medical Council', 2015, '[]', '{}', '{}', null, null);
insert into public.health_profiles (user_id, full_name, date_of_birth, blood_group, allergies) values ('f5000000-0000-0000-0000-0000000000a1', 'Asha Patient Fictional', '1990-05-01', 'B+', null);
insert into public.health_records (user_id, client_id, kind, title, category, certainty) values ('f5000000-0000-0000-0000-0000000000a1', 1, 'allergy', 'Fictional penicillin', 'medication', 'confirmed');
insert into public.health_records (user_id, client_id, kind, title, status) values ('f5000000-0000-0000-0000-0000000000a1', 2, 'condition', 'Fictional hypertension', 'controlled');
insert into public.medicines (user_id, client_id, name, dose, start_date) values ('f5000000-0000-0000-0000-0000000000a1', 1, 'Fictional amlodipine', '5 mg daily', current_date - 100);
insert into public.documents (id, user_id, client_id, title, category, document_date) values ('f5000000-0000-0000-0000-00000000d0c1', 'f5000000-0000-0000-0000-0000000000a1', 1, 'Fictional blood report', 'Lab report', current_date - 10);
insert into public.lab_results (user_id, document_id, test, value, unit, origin) values ('f5000000-0000-0000-0000-0000000000a1', 'f5000000-0000-0000-0000-00000000d0c1', 'HbA1c', '5.6', '%', 'user_entered');
\set D '''f5000000-0000-0000-0000-0000000000d1'''
\set U '''f5000000-0000-0000-0000-0000000000d2'''
\set P '''f5000000-0000-0000-0000-0000000000a1'''
\set Q '''f5000000-0000-0000-0000-0000000000a2'''
\set C '''f5000000-0000-0000-0000-0000000000c1'''

-- switch and grants
select pg_temp.expect((select enabled = false from private.feature_flags where key = 'record_sharing'), 'the record_sharing switch exists and is off');
select pg_temp.raises(format($q$select public.admin_set_flag(%L, 'record_sharing', true, null, 'trying', 'r1')$q$, 'f5000000-0000-0000-0000-0000000000c2'), '42501', 'only the Founder can switch sharing on');
select pg_temp.expect(not has_function_privilege('authenticated', 'public.doctor_share_record(uuid, uuid, text)', 'execute') and not has_function_privilege('anon', 'public.share_create(uuid, text, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.share_list(uuid)', 'execute'), 'only the server can call the sharing functions');
select pg_temp.expect((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('private.record_shares'::regclass, 'private.record_access_log'::regclass)), 'row security is on and forced');

-- the doctor's code
select pg_temp.raises(format($q$select public.practitioner_share_code(%L)$q$, 'f5000000-0000-0000-0000-0000000000d2'), '22023', 'an unverified applicant has no sharing code');
select (public.practitioner_share_code(:D)->>'code') as code \gset
select pg_temp.expect(:'code' ~ '^[A-HJ-NP-Z2-9]{10}$', 'a verified doctor gets a 10-character code without look-alike characters');
select pg_temp.expect((public.practitioner_share_code(:D)->>'code') = :'code', 'the code stays the same');

-- the patient finds the doctor and shares
select pg_temp.expect((public.share_lookup(:P, lower(substr(:'code', 1, 5)) || '-' || substr(:'code', 6))->>'registration_number') = 'DMC/12345', 'lookup shows the registration details (case and dashes ignored)');
select pg_temp.raises(format($q$select public.share_lookup(%L, 'AAAAAAAAAA')$q$, 'f5000000-0000-0000-0000-0000000000a1'), 'P0002', 'an unknown code finds nobody');
select pg_temp.raises(format($q$select public.share_lookup(%L, %L)$q$, 'f5000000-0000-0000-0000-0000000000d1', :'code'), 'P0002', 'a doctor cannot share with themselves');
select pg_temp.raises(format($q$select public.share_create(%L, %L, '{"scopes":["medicines"],"days":7,"purpose":"consultation"}')$q$, 'f5000000-0000-0000-0000-0000000000a1', :'code'), '22023', 'sharing needs an explicit confirmation');
select pg_temp.raises(format($q$select public.share_create(%L, %L, '{"scopes":["medicines"],"days":90,"purpose":"consultation","confirm":true}')$q$, 'f5000000-0000-0000-0000-0000000000a1', :'code'), '22023', 'only 1, 7 or 30 days');
select pg_temp.raises(format($q$select public.share_create(%L, %L, '{"scopes":["everything"],"days":7,"purpose":"consultation","confirm":true}')$q$, 'f5000000-0000-0000-0000-0000000000a1', :'code'), '23514', 'only the listed parts can be shared');
select pg_temp.raises(format($q$select public.share_create(%L, %L, '{"scopes":[],"days":7,"purpose":"consultation","confirm":true}')$q$, 'f5000000-0000-0000-0000-0000000000a1', :'code'), '23514', 'at least one part');
select (public.share_create(:P, :'code', '{"scopes":["profile","allergies","medicines","history"],"days":7,"purpose":"consultation","note":"Fictional fever since Monday","confirm":true}')->>'id') as sid \gset
select pg_temp.expect((select expires_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 minute' from private.record_shares where id = :'sid'), 'shared for exactly 7 days');
select pg_temp.raises(format($q$select public.share_create(%L, %L, '{"scopes":["labs"],"days":1,"purpose":"follow_up","confirm":true}')$q$, 'f5000000-0000-0000-0000-0000000000a1', :'code'), '22023', 'one active share per doctor');

-- the doctor reads what was shared, and only that
select pg_temp.raises(format($q$select public.doctor_shares(%L)$q$, 'f5000000-0000-0000-0000-0000000000d2'), '42501', 'an unverified applicant sees no shared records');
select pg_temp.expect((public.doctor_shares(:D)->0->'patient'->>'name') = 'Asha Patient Fictional' and (public.doctor_shares(:D)->0->'patient'->>'age')::int >= 30, 'the doctor sees who shared, with age');
select pg_temp.expect((public.doctor_share_record(:D, :'sid', 'medicines')->'data'->'items'->0->>'name') = 'Fictional amlodipine', 'medicines are readable');
select pg_temp.expect((public.doctor_share_record(:D, :'sid', 'allergies')->'data'->'items'->0->>'certainty') = 'confirmed', 'allergies with certainty');
select pg_temp.expect((public.doctor_share_record(:D, :'sid', 'history')->'data'->'items'->0->>'source') = 'user', 'history carries where each item came from');
select pg_temp.raises(format($q$select public.doctor_share_record(%L, %L, 'labs')$q$, 'f5000000-0000-0000-0000-0000000000d1', :'sid'), '42501', 'a part that was not shared stays closed');
select pg_temp.raises(format($q$select public.doctor_share_record(%L, %L, 'medicines')$q$, 'f5000000-0000-0000-0000-0000000000d2', :'sid'), 'P0002', 'another doctor cannot use the share');
select pg_temp.expect((select count(*) from private.record_access_log where share_id = :'sid') = 3, 'every opening is logged');
select pg_temp.expect((public.share_list(:P)->'shares'->0->>'opened')::int = 3 and jsonb_array_length(public.share_list(:P)->'access') = 3, 'the patient sees each opening');
select pg_temp.expect(jsonb_array_length(public.share_list(:Q)->'shares') = 0, 'shares are per person');
select pg_temp.raises(format($q$update private.record_access_log set scope = 'x' where share_id = %L$q$, :'sid'), '42501', 'the access log cannot be edited');
select pg_temp.raises(format($q$delete from private.record_access_log where share_id = %L$q$, :'sid'), '42501', 'the access log cannot be deleted');

-- suspension, stopping and expiry end access at once
update private.practitioners set status = 'SUSPENDED' where user_id = :D;
select pg_temp.raises(format($q$select public.doctor_share_record(%L, %L, 'medicines')$q$, 'f5000000-0000-0000-0000-0000000000d1', :'sid'), 'P0002', 'a suspended doctor loses access');
update private.practitioners set status = 'VERIFIED' where user_id = :D;
select pg_temp.raises(format($q$select public.share_revoke(%L, %L)$q$, 'f5000000-0000-0000-0000-0000000000a2', :'sid'), 'P0002', 'someone else cannot stop my share');
select pg_temp.expect((public.share_revoke(:P, :'sid')->>'ok')::boolean, 'the patient stops sharing');
select pg_temp.raises(format($q$select public.doctor_share_record(%L, %L, 'medicines')$q$, 'f5000000-0000-0000-0000-0000000000d1', :'sid'), 'P0002', 'after stopping, nothing can be read');
select pg_temp.expect(jsonb_array_length(public.doctor_shares(:D)) = 0, 'and the patient disappears from the doctor''s list');
select (public.share_create(:P, :'code', '{"scopes":["labs","documents"],"days":1,"purpose":"follow_up","confirm":true}')->>'id') as sid2 \gset
select pg_temp.expect((public.doctor_share_record(:D, :'sid2', 'labs')->'data'->'items'->0->>'test') = 'HbA1c' and (public.doctor_share_record(:D, :'sid2', 'documents')->'data'->>'files_shared')::boolean = false, 'labs come with their report; documents are titles only');
update private.record_shares set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = :'sid2';
select pg_temp.raises(format($q$select public.doctor_share_record(%L, %L, 'labs')$q$, 'f5000000-0000-0000-0000-0000000000d1', :'sid2'), 'P0002', 'an expired share opens nothing');

-- leadership sees counts only
select pg_temp.expect((public.admin_sharing_summary(:C)->>'openings_30d')::int >= 5 and public.admin_sharing_summary(:C)::text not like '%Asha%', 'staff see counts, never names or records');
select pg_temp.raises(format($q$select public.admin_sharing_summary(%L)$q$, 'f5000000-0000-0000-0000-0000000000a1'), '42501', 'patients are not staff');

-- deleting the patient's account removes their shares and the log
delete from auth.users where id = :P;
select pg_temp.expect(not exists (select 1 from private.record_shares where patient_id = :P) and not exists (select 1 from private.record_access_log where patient_id = :P), 'account deletion removes shares and their log');
select 'sharing tests PASSED';
