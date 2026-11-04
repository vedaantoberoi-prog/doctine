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
                          'medicines','medication_schedules','dose_events','conversations','messages'])) = 12,
  'row-level security is forced on all 12 health-data tables (it applies even to the table owner)');
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
insert into consents (kind, granted) values ('ai_chat', true);
update consents set granted = false where kind = 'ai_chat';
select pg_temp.expect((select count(*) from consent_log) = 2, 'consent changes are logged');
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
