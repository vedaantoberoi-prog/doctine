-- Doctine · row-level security tests. Run against a scratch database after supabase-stubs.sql and the migration.
-- Every check raises an error if it fails; the script ends by printing "ALL RLS TESTS PASSED".
\set ON_ERROR_STOP on
insert into auth.users values ('aaaaaaaa-0000-0000-0000-000000000001'), ('bbbbbbbb-0000-0000-0000-000000000002');

create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); execute 'set role authenticated'; end $$;
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;

-- ===== Structure: every table is protected =====
select pg_temp.expect(not exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity),
  'every table in the public schema has row-level security on');
select pg_temp.expect((select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relforcerowsecurity
  and relname = any(array['health_profiles','consents','documents','document_files','lab_results','prescriptions','prescription_items',
                          'medicines','medication_schedules','dose_events','conversations','messages','vital_readings'])) = 13,
  'row-level security is forced on all 13 health-data tables (it applies even to the table owner)');
select pg_temp.expect(not exists (select 1 from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prokind = 'f'
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')), 'every Doctine function has a fixed search path');
select pg_temp.expect(not has_function_privilege('anon', 'public.log_consent()', 'execute') and not has_function_privilege('authenticated', 'public.log_consent()', 'execute'),
  'the consent-logging trigger function cannot be called directly');
select pg_temp.expect(not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'vital_readings' and grantee = 'anon'),
  'signed-out visitors have no access to health readings');
-- consent_log is the one deliberate exception: only the security-definer consent trigger writes it, and it has no write policy.
select pg_temp.expect(not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name = 'consent_log'
  and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE')), 'nobody can write the consent history directly');

-- ===== Person A creates their records =====
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
insert into health_profiles (full_name, date_of_birth, allergies) values ('Person A', '1988-04-12', 'Penicillin');
insert into documents (client_id, title, category, document_date, source, extraction) values
 (1, 'Prescription – Dr. A. Kumar – 28 Oct 2026', 'Prescription', '2026-10-28', 'scan',
  '{"doctor":"Dr. A. Kumar","medicines":[{"raw":"Tab Pan-D 1-0-0 AC x5d","name":"Pan-D","frequency":"1-0-0","confidence":"medium","alternatives":["Pan-DSR"]},{"raw":"Tab Dolo 650","name":"Dolo 650","confidence":"high"}],
    "lab_results":[{"test":"Hemoglobin","value":"11.4","unit":"g/dL","range":"12-15.5","confidence":"high"}]}');
select pg_temp.expect((select count(*) from prescription_items) = 2, 'AI reading is turned into 2 prescription items');
select pg_temp.expect((select bool_and(not confirmed) from prescription_items), 'extracted medicines start unconfirmed');
select pg_temp.expect((select alternatives from prescription_items where name = 'Pan-D') = '{Pan-DSR}', 'alternative readings are kept');
select pg_temp.expect((select count(*) from lab_results where test = 'Hemoglobin') = 1, 'AI reading is turned into a lab result');
insert into document_files (document_id, kind, page, storage_path)
 select id, 'original', 0, 'aaaaaaaa-0000-0000-0000-000000000001/1/original-0.jpg' from documents where client_id = 1;
insert into medicines (client_id, name, dose, start_date, source_document_id, source_raw, source_confidence)
 select 11, 'Pan-D', '40 mg before food', '2026-11-01', id, 'Tab Pan-D 1-0-0 AC x5d', 'medium' from documents where client_id = 1;
insert into medication_schedules (medicine_id, frequency, times) select id, 'daily', '{08:00}' from medicines where client_id = 11;
insert into dose_events (medicine_id, scheduled_date, scheduled_time, status) select id, '2026-11-02', '08:00', 'Taken' from medicines where client_id = 11;
-- medicine details (20261119000000): structured strength / dose / form / instructions, "as needed" and "every N hours"
insert into medicines (client_id, name, dose, start_date, brand, strength, form, dose_amount, dose_unit, instructions)
 values (12, 'Fictional paracetamol', '1 tablet', '2026-11-01', 'Fictobrand', '500 mg', 'tablet', '1', 'tablet', 'After food'),
        (13, 'Fictional antibiotic', '1 capsule', '2026-11-01', null, '250 mg', 'capsule', '1', 'capsule', null),
        (14, 'Old-style medicine', '1 tablet after dinner', '2026-11-01', null, null, null, null, null, null);
insert into medication_schedules (medicine_id, frequency, times) select id, 'as_needed', '{}' from medicines where client_id = 12;
insert into medication_schedules (medicine_id, frequency, times, interval_hours) select id, 'daily', '{06:00,12:00,18:00}', 6 from medicines where client_id = 13;
select pg_temp.expect((select strength || '|' || dose_amount || '|' || dose_unit || '|' || form || '|' || instructions from medicines where client_id = 12) = '500 mg|1|tablet|tablet|After food', 'medicine details are stored as separate fields');
select pg_temp.expect((select frequency = 'as_needed' and cardinality(times) = 0 from medication_schedules s join medicines m on m.id = s.medicine_id where m.client_id = 12), 'an "as needed" medicine has no reminder times');
select pg_temp.expect((select interval_hours from medication_schedules s join medicines m on m.id = s.medicine_id where m.client_id = 13) = 6, 'an "every 6 hours" schedule keeps its interval');
do $$ begin
  begin update medication_schedules set times = '{}' where frequency = 'daily'; raise exception 'FAILED: daily schedule without times';
  exception when check_violation then raise notice 'ok: a daily schedule needs at least one time'; end;
  begin update medication_schedules set times = '{08:00}' where frequency = 'as_needed'; raise exception 'FAILED: as-needed with times';
  exception when check_violation then raise notice 'ok: an "as needed" schedule has no reminder times'; end;
  begin update medication_schedules set frequency = 'weekly', days_of_week = '{1}' where interval_hours is not null; raise exception 'FAILED: weekly interval';
  exception when check_violation then raise notice 'ok: "every N hours" applies to daily schedules only'; end;
  begin update medication_schedules set interval_hours = 0 where interval_hours is not null; raise exception 'FAILED: zero interval';
  exception when check_violation then raise notice 'ok: the interval must be 1 to 24 hours'; end;
  begin update medication_schedules set frequency = 'monthly' where interval_hours is not null; raise exception 'FAILED: unknown frequency';
  exception when check_violation then raise notice 'ok: unknown frequencies are refused'; end;
  begin update medicines set strength = repeat('x', 61) where client_id = 12; raise exception 'FAILED: long strength';
  exception when check_violation then raise notice 'ok: strength is limited to 60 characters'; end;
  begin update medicines set dose_amount = '' where client_id = 12; raise exception 'FAILED: empty amount';
  exception when check_violation then raise notice 'ok: an empty dose amount is refused (null means not given)'; end;
end $$;
delete from medicines where client_id in (12, 13, 14);
-- health readings (20261119010000)
insert into vital_readings (client_id, kind, value, value2, unit, measured_at) values (21, 'blood_pressure', 124, 82, 'mmHg', '2026-11-18 08:10+05:30');
insert into vital_readings (client_id, kind, value, unit, context, measured_at) values (22, 'glucose', 104, 'mg/dL', 'fasting', '2026-11-18 07:30+05:30');
insert into vital_readings (client_id, kind, value, unit, measured_at, note) values (23, 'heart_rate', 72, 'bpm', '2026-11-18 08:10+05:30', 'After rest');
select pg_temp.expect((select count(*) from vital_readings where user_id = auth.uid()) = 3, 'a person can add their own health readings');
do $$ begin
  begin insert into vital_readings (client_id, kind, value, unit, measured_at) values (24, 'heart_rate', 72, 'mmHg', now()); raise exception 'FAILED: wrong unit';
  exception when check_violation then raise notice 'ok: a reading must use its own unit'; end;
  begin insert into vital_readings (client_id, kind, value, unit, measured_at) values (24, 'spo2', 140, '%', now()); raise exception 'FAILED: SpO2 140';
  exception when check_violation then raise notice 'ok: impossible values are refused (oxygen saturation over 100 per cent)'; end;
  begin insert into vital_readings (client_id, kind, value, unit, measured_at) values (24, 'blood_pressure', 120, 'mmHg', now()); raise exception 'FAILED: BP without diastolic';
  exception when check_violation then raise notice 'ok: blood pressure needs both numbers'; end;
  begin insert into vital_readings (client_id, kind, value, value2, unit, measured_at) values (24, 'blood_pressure', 80, 120, 'mmHg', now()); raise exception 'FAILED: BP reversed';
  exception when check_violation then raise notice 'ok: blood pressure with the numbers swapped is refused'; end;
  begin insert into vital_readings (client_id, kind, value, unit, context, measured_at) values (24, 'heart_rate', 70, 'bpm', 'fasting', now()); raise exception 'FAILED: context on HR';
  exception when check_violation then raise notice 'ok: fasting / after a meal applies to blood glucose only'; end;
  begin insert into vital_readings (client_id, kind, value, unit, measured_at, source) values (24, 'weight', 60, 'kg', now(), 'device'); raise exception 'FAILED: device source';
  exception when check_violation then raise notice 'ok: readings can only be entered by the person (no devices are connected)'; end;
end $$;
insert into consents (kind, granted) values ('ai_chat', true);
update consents set granted = false where kind = 'ai_chat';
select pg_temp.expect((select count(*) from consent_log) = 2, 'consent changes are logged');
-- the app only accepts an AI permission given after the current agreement, so re-granting must refresh the time
create temp table _before as select updated_at from consents where kind = 'ai_chat'; select pg_sleep(0.02);
insert into consents (kind, granted) values ('ai_chat', true) on conflict (user_id, kind) do update set granted = excluded.granted;
select pg_temp.expect((select updated_at from consents where kind = 'ai_chat') > (select updated_at from _before), 're-granting a permission records when it was given');
insert into storage.objects (bucket_id, name) values ('health-documents', 'aaaaaaaa-0000-0000-0000-000000000001/1/original-0.jpg');

-- A cannot write outside their own space
do $$ begin
  begin insert into consent_log (user_id, kind, granted) values (auth.uid(), 'ai_chat', true); raise exception 'FAILED: wrote consent history directly';
  exception when insufficient_privilege then raise notice 'ok: consent history cannot be written directly'; end;
  begin insert into storage.objects (bucket_id, name) values ('health-documents', 'bbbbbbbb-0000-0000-0000-000000000002/x.jpg'); raise exception 'FAILED: uploaded into another person''s folder';
  exception when insufficient_privilege then raise notice 'ok: cannot upload into another person''s folder'; end;
  begin insert into document_files (document_id, kind, page, storage_path) select id, 'cleaned', 0, 'bbbbbbbb-0000-0000-0000-000000000002/1.jpg' from documents limit 1; raise exception 'FAILED: file path outside own folder';
  exception when check_violation then raise notice 'ok: file records must point into the owner''s folder'; end;
  begin insert into medication_schedules (medicine_id, times) select id, '{25:99}' from medicines limit 1; raise exception 'FAILED: invalid time';
  exception when check_violation or unique_violation then raise notice 'ok: invalid dose times are refused'; end;
  begin insert into dose_events (medicine_id, scheduled_date, scheduled_time, status) select id, '2026-11-02', '09:00', 'Maybe' from medicines limit 1; raise exception 'FAILED: invalid status';
  exception when check_violation then raise notice 'ok: invalid dose statuses are refused'; end;
end $$;
reset role;

-- ===== Person B tries to reach A's data =====
select pg_temp.as_user('bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.expect((select count(*) from documents) = 0, 'B sees none of A''s documents');
select pg_temp.expect((select count(*) from health_profiles) = 0, 'B sees none of A''s profile');
select pg_temp.expect((select count(*) from prescription_items) = 0, 'B sees none of A''s prescription items');
select pg_temp.expect((select count(*) from lab_results) = 0, 'B sees none of A''s lab results');
select pg_temp.expect((select count(*) from medicines) + (select count(*) from dose_events) + (select count(*) from medication_schedules) = 0, 'B sees none of A''s medicines, schedules or doses');
select pg_temp.expect((select count(*) from storage.objects) = 0, 'B cannot list A''s files');
select pg_temp.expect((select count(*) from consent_log) = 0, 'B cannot read A''s consent history');
with u as (update documents set title = 'hacked' returning 1) select pg_temp.expect((select count(*) from u) = 0, 'B cannot change A''s documents');
with d as (delete from medicines returning 1) select pg_temp.expect((select count(*) from d) = 0, 'B cannot delete A''s medicines');
select pg_temp.expect((select count(*) from vital_readings) = 0, 'B sees none of A''s health readings');
with d as (delete from vital_readings returning 1) select pg_temp.expect((select count(*) from d) = 0, 'B cannot delete A''s health readings');
with u as (update vital_readings set value = 200 returning 1) select pg_temp.expect((select count(*) from u) = 0, 'B cannot change A''s health readings');
do $$ begin
  begin insert into documents (user_id, client_id, title) values ('aaaaaaaa-0000-0000-0000-000000000001', 99, 'planted'); raise exception 'FAILED: B created a document as A';
  exception when insufficient_privilege then raise notice 'ok: B cannot create records in A''s name'; end;
  begin insert into consents (user_id, kind, granted) values ('aaaaaaaa-0000-0000-0000-000000000001', 'ai_chat', true); raise exception 'FAILED: B changed A''s consent';
  exception when insufficient_privilege then raise notice 'ok: B cannot set A''s consent'; end;
  begin insert into medicines (user_id, client_id, name, dose, start_date) values ('aaaaaaaa-0000-0000-0000-000000000001', 5, 'x', 'y', current_date); raise exception 'FAILED: B added a medicine for A';
  exception when insufficient_privilege then raise notice 'ok: B cannot add medicines to A''s account'; end;
end $$;
with u as (update storage.objects set name = 'bbbbbbbb-0000-0000-0000-000000000002/stolen.jpg' returning 1) select pg_temp.expect((select count(*) from u) = 0, 'B cannot rename A''s file into B''s folder');
with u as (update consents set granted = true returning 1) select pg_temp.expect((select count(*) from u) = 0, 'B cannot change A''s consents');
with u as (update prescription_items set confirmed = true returning 1) select pg_temp.expect((select count(*) from u) = 0, 'B cannot confirm A''s prescription items');
-- B owns a document, then tries to hang a lab result on A's document id (known by guessing or a leak)
insert into documents (client_id, title) values (1, 'B''s own report');
do $$ declare a_doc uuid; begin
  reset role; select id into a_doc from documents where user_id = 'aaaaaaaa-0000-0000-0000-000000000001'; set role authenticated;
  begin insert into lab_results (document_id, test, value) values (a_doc, 'Planted', '1'); raise exception 'FAILED: B attached a result to A''s document';
  exception when foreign_key_violation then raise notice 'ok: B cannot attach data to A''s document, even knowing its id'; end;
end $$;
select pg_temp.expect((select count(*) from documents) = 1, 'B sees only their own document');
-- Even with RLS bypassed (superuser), a child row whose owner differs from its parent's owner is rejected by the (id, user_id) keys.
reset role;
do $$ declare a_doc uuid; a_rx uuid; b uuid := 'bbbbbbbb-0000-0000-0000-000000000002'; begin
  select id into a_doc from documents where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1;
  begin insert into lab_results (user_id, document_id, test, value) values (b, a_doc, 'Planted', '1'); raise exception 'FAILED: mismatched lab result accepted';
  exception when foreign_key_violation then raise notice 'ok: a lab result cannot belong to someone other than its document''s owner'; end;
  select id into a_rx from prescriptions where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' limit 1;
  if a_rx is not null then
    begin insert into prescription_items (user_id, prescription_id, name) values (b, a_rx, 'Planted'); raise exception 'FAILED: mismatched prescription item accepted';
    exception when foreign_key_violation then raise notice 'ok: a prescription item cannot belong to someone other than its prescription''s owner'; end;
  end if;
end $$;
reset role;
-- A cannot move their own file into B's folder either
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
do $$ begin
  begin update storage.objects set name = 'bbbbbbbb-0000-0000-0000-000000000002/planted.jpg' where name like 'aaaaaaaa%'; raise exception 'FAILED: A moved a file into B''s folder';
  exception when insufficient_privilege then raise notice 'ok: a file cannot be moved into another person''s folder'; end;
end $$;
reset role;

-- ===== Signed-out visitors =====
set role anon;
do $$ begin
  begin perform 1 from documents; raise exception 'FAILED: anon read documents';
  exception when insufficient_privilege then raise notice 'ok: signed-out visitors cannot read anything'; end;
end $$;
reset role;

-- ===== Deleting an account removes everything =====
select pg_temp.expect((select count(*) from documents where title = 'hacked') = 0, 'A''s data was not altered by B');
delete from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.expect((select count(*) from documents where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') + (select count(*) from medicines where user_id = 'aaaaaaaa-0000-0000-0000-000000000001')
  + (select count(*) from prescription_items where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') + (select count(*) from dose_events where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0,
  'deleting a person removes all their rows');
\echo ALL RLS TESTS PASSED
