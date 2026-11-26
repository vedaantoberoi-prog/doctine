-- Doctine · doctor network phase 1 (20261126000000_doctor_onboarding.sql), run by run-db-tests.sh. Fictional people only.
\set ON_ERROR_STOP on
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not ok then raise exception 'FAILED: %', what; end if; raise notice 'ok: %', what; end $$;
create or replace function pg_temp.raises(sql text, state text, what text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then if sqlstate = state then raise notice 'ok: %', what; return; end if; raise exception 'FAILED: % (got %: %)', what, sqlstate, sqlerrm; end;
  raise exception 'FAILED: % (was allowed)', what;
end $$;

-- Fictional accounts: two doctors, a reviewer (doctors.view + doctors.verify), a viewer (doctors.view) and a Co-Founder without either.
insert into auth.users (id, email, email_confirmed_at) values
  ('f1000000-0000-0000-0000-0000000000a1', 'dr.asha.fictional@example.test', now()), ('f1000000-0000-0000-0000-0000000000b1', 'dr.ravi.fictional@example.test', now()),
  ('f1000000-0000-0000-0000-0000000000c1', 'reviewer@example.test', now()), ('f1000000-0000-0000-0000-0000000000c2', 'viewer@example.test', now()),
  ('f1000000-0000-0000-0000-0000000000c3', 'other.cofounder@example.test', now()) on conflict do nothing;
insert into private.admin_members (user_id, role, status, permissions) values
  ('f1000000-0000-0000-0000-0000000000c1', 'co_founder', 'active', array['dashboard.view', 'doctors.view', 'doctors.verify']),
  ('f1000000-0000-0000-0000-0000000000c2', 'co_founder', 'active', array['dashboard.view', 'doctors.view']),
  ('f1000000-0000-0000-0000-0000000000c3', 'co_founder', 'active', private.perm_preset('admin')) on conflict (user_id) do update set permissions = excluded.permissions, status = 'active';
\set A '''f1000000-0000-0000-0000-0000000000a1'''
\set B '''f1000000-0000-0000-0000-0000000000b1'''
\set R '''f1000000-0000-0000-0000-0000000000c1'''
\set V '''f1000000-0000-0000-0000-0000000000c2'''
\set P '''f1000000-0000-0000-0000-0000000000c3'''

-- switch, permissions, storage, grants
select pg_temp.expect((select enabled = false from private.feature_flags where key = 'doctor_onboarding'), 'the doctor_onboarding switch exists and is off');
select pg_temp.raises(format($q$select public.admin_set_flag(%L, 'doctor_onboarding', true, null, 'trying', 'r1')$q$, 'f1000000-0000-0000-0000-0000000000c3'), '42501', 'a Co-Founder with flags.manage cannot switch doctor sign-up on (Founder only)');
select pg_temp.expect((select count(*) from private.perm_catalog() where key in ('doctors.view', 'doctors.verify') and not founder_only and not standard) = 2, 'doctors.view and doctors.verify are grantable and not in the standard set');
select pg_temp.expect(not ('doctors.verify' = any (private.perm_preset('admin'))), 'the admin preset does not include doctors.verify');
select pg_temp.expect((select public = false and file_size_limit = 5242880 from storage.buckets where id = 'practitioner-credentials'), 'the credentials bucket is private, 5 MB');
select pg_temp.expect(not exists (select 1 from pg_policies where schemaname = 'storage' and policyname ilike '%practitioner%'), 'browsers get no storage policy for credentials');
select pg_temp.expect(not has_function_privilege('authenticated', 'public.practitioner_get(uuid)', 'execute') and not has_function_privilege('anon', 'public.practitioner_save(uuid, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.admin_practitioner_transition(uuid, uuid, text, text, jsonb, text)', 'execute') and has_function_privilege('service_role', 'public.practitioner_submit(uuid)', 'execute'),
  'only the server can call the doctor functions');
select pg_temp.expect((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('private.practitioners'::regclass, 'private.practitioner_documents'::regclass, 'private.practitioner_events'::regclass)), 'row security is on and forced');
select pg_temp.expect(not has_table_privilege('authenticated', 'private.practitioners', 'select') and not has_table_privilege('anon', 'private.practitioner_documents', 'select'), 'browsers cannot read the tables');

-- the doctor's application
select pg_temp.expect((public.practitioner_get(:A)->>'status') = 'NOT_STARTED' and (public.practitioner_get(:A)->>'exists')::boolean = false, 'a new doctor starts at NOT_STARTED');
select pg_temp.expect((public.practitioner_save(:A, '{"full_name":"Dr Asha Fictional","registration_number":"mmc/2010/12345","registration_council":"Maharashtra Medical Council","registration_year":"2010","qualifications":[{"degree":"MBBS","institution":"Fictional Medical College","year":2009}],"specialties":["General physician"],"languages":["English","Hindi"],"consultation_modes":["video"],"declaration":true}')->>'registration_number') = 'MMC/2010/12345', 'details save (registration number upper-cased)');
select pg_temp.raises(format($q$select public.practitioner_save(%L, '{"qualifications":[{"degree":"MBBS","institution":"X","year":2009}]}')$q$, 'f1000000-0000-0000-0000-0000000000a1'), '22023', 'a qualification needs a real institution');
select pg_temp.raises(format($q$select public.practitioner_save(%L, '{"consultation_modes":["teleportation"]}')$q$, 'f1000000-0000-0000-0000-0000000000a1'), '23514', 'only text, audio and video modes');
select public.practitioner_save(:A, '{"full_name":"Dr Asha Fictional","registration_number":"MMC/2010/12345","registration_council":"Maharashtra Medical Council","registration_year":"2010","qualifications":[{"degree":"MBBS","institution":"Fictional Medical College","year":2009}],"specialties":["General physician"],"languages":["English","Hindi"],"consultation_modes":["video"],"declaration":true}');
select pg_temp.expect((public.practitioner_submit(:A)->>'ok')::boolean = false and (public.practitioner_submit(:A)->'missing') ? 'doc:photo_id', 'cannot submit without the three documents');
select pg_temp.raises(format($q$select public.practitioner_document_add(%L, '{"kind":"photo_id","path":"f1000000-0000-0000-0000-0000000000b1/x.pdf","file_name":"x.pdf","mime":"application/pdf","size_bytes":10,"sha256":"%s"}')$q$, 'f1000000-0000-0000-0000-0000000000a1', repeat('a', 64)), '22023', 'a file must be in the doctor''s own folder');
select pg_temp.raises(format($q$select public.practitioner_document_add(%L, '{"kind":"photo_id","path":"f1000000-0000-0000-0000-0000000000a1/x.exe","file_name":"x.exe","mime":"application/x-msdownload","size_bytes":10,"sha256":"%s"}')$q$, 'f1000000-0000-0000-0000-0000000000a1', repeat('a', 64)), '23514', 'only PDF, JPEG and PNG');
select pg_temp.raises(format($q$select public.practitioner_document_add(%L, '{"kind":"photo_id","path":"f1000000-0000-0000-0000-0000000000a1/big.pdf","file_name":"big.pdf","mime":"application/pdf","size_bytes":6000000,"sha256":"%s"}')$q$, 'f1000000-0000-0000-0000-0000000000a1', repeat('a', 64)), '23514', 'at most 5 MB');
do $$ declare k text; i int := 0; begin
  foreach k in array array['registration_certificate', 'degree_certificate', 'photo_id', 'other'] loop
    i := i + 1;
    perform public.practitioner_document_add('f1000000-0000-0000-0000-0000000000a1', jsonb_build_object('kind', k, 'path', 'f1000000-0000-0000-0000-0000000000a1/f' || i || '.pdf', 'file_name', k || '.pdf', 'mime', 'application/pdf', 'size_bytes', 1000 + i, 'sha256', repeat(i::text, 64)));
  end loop;
end $$;
select pg_temp.expect((public.practitioner_document_remove(:A, (select id from private.practitioner_documents where user_id = :A and kind = 'other'))->>'ok')::boolean, 'a document can be taken off the application');
select pg_temp.expect(jsonb_array_length(public.practitioner_get(:A)->'documents') = 3 and (select count(*) from private.practitioner_documents where user_id = :A) = 4, 'removed documents are hidden from the doctor but kept');
select pg_temp.expect((public.practitioner_submit(:A)->>'status') = 'DOCUMENTS_SUBMITTED', 'a complete application submits');
select pg_temp.raises(format($q$select public.practitioner_save(%L, '{"full_name":"Changed"}')$q$, 'f1000000-0000-0000-0000-0000000000a1'), '22023', 'details are locked once submitted');
select pg_temp.raises(format($q$select public.practitioner_document_add(%L, '{"kind":"other","path":"f1000000-0000-0000-0000-0000000000a1/late.pdf","file_name":"late.pdf","mime":"application/pdf","size_bytes":10,"sha256":"%s"}')$q$, 'f1000000-0000-0000-0000-0000000000a1', repeat('b', 64)), '22023', 'documents are locked once submitted');
select pg_temp.raises(format($q$select public.practitioner_submit(%L)$q$, 'f1000000-0000-0000-0000-0000000000a1'), '22023', 'cannot submit twice');

-- the verification queue
select pg_temp.raises(format($q$select public.admin_practitioners(%L, null)$q$, 'f1000000-0000-0000-0000-0000000000c3'), '42501', 'a Co-Founder without doctors.view cannot see applications');
select pg_temp.raises(format($q$select public.admin_practitioners(%L, null)$q$, 'f1000000-0000-0000-0000-0000000000a1'), '42501', 'a doctor is not staff');
select pg_temp.expect((public.admin_practitioners(:V, null)->'counts'->>'DOCUMENTS_SUBMITTED')::int >= 1, 'a viewer sees the queue');
select pg_temp.expect((public.admin_practitioner(:V, :A, 't1')->>'can_verify')::boolean = false, 'a viewer is told they cannot verify');
select pg_temp.raises(format($q$select public.admin_practitioner_transition(%L, %L, 'UNDER_REVIEW', null, null, 't2')$q$, 'f1000000-0000-0000-0000-0000000000c2', 'f1000000-0000-0000-0000-0000000000a1'), '42501', 'doctors.view alone cannot change a status');
select pg_temp.raises(format($q$select public.admin_practitioner_transition(%L, %L, 'VERIFIED', 'x', '{"register":"nmr","register_name":"National Medical Register","checked_on":"%s","matched":{"name":true,"registration_number":true,"council":true,"active":true,"photo_id":true}}', 't3')$q$,
  'f1000000-0000-0000-0000-0000000000c1', 'f1000000-0000-0000-0000-0000000000a1', current_date), '22023', 'cannot verify without a review first');
select pg_temp.expect((public.admin_practitioner_transition(:R, :A, 'UNDER_REVIEW', null, null, 't4')->>'status') = 'UNDER_REVIEW', 'a reviewer starts the review');
select pg_temp.raises(format($q$select public.admin_practitioner_transition(%L, %L, 'VERIFIED', 'ok', null, 't5')$q$, 'f1000000-0000-0000-0000-0000000000c1', 'f1000000-0000-0000-0000-0000000000a1'), '22023', 'no verification without evidence');
select pg_temp.raises(format($q$select public.admin_practitioner_transition(%L, %L, 'VERIFIED', 'ok', '{"register":"nmr","register_name":"National Medical Register","checked_on":"%s","matched":{"name":true,"registration_number":true,"council":true,"active":true}}', 't6')$q$,
  'f1000000-0000-0000-0000-0000000000c1', 'f1000000-0000-0000-0000-0000000000a1', current_date), '22023', 'the photo ID match is required');
select pg_temp.raises(format($q$select public.admin_practitioner_transition(%L, %L, 'VERIFIED', 'ok', '{"register":"nmr","register_name":"National Medical Register","checked_on":"%s","matched":{"name":true,"registration_number":true,"council":true,"active":true,"photo_id":true}}', 't7')$q$,
  'f1000000-0000-0000-0000-0000000000c1', 'f1000000-0000-0000-0000-0000000000a1', current_date - 60), '22023', 'a register check older than 30 days does not count');
select pg_temp.raises(format($q$select public.admin_practitioner_transition(%L, %L, 'VERIFIED', 'ok', '{"register":"a friend","register_name":"Word of mouth","checked_on":"%s","matched":{"name":true,"registration_number":true,"council":true,"active":true,"photo_id":true}}', 't8')$q$,
  'f1000000-0000-0000-0000-0000000000c1', 'f1000000-0000-0000-0000-0000000000a1', current_date), '22023', 'only the NMR or a State Medical Council register');
select pg_temp.expect((public.admin_practitioner_transition(:R, :A, 'VERIFIED', 'Registration checked on the register',
  jsonb_build_object('register', 'state_council', 'register_name', 'Maharashtra Medical Council', 'checked_on', current_date, 'register_reference', 'fictional record 12345',
    'matched', '{"name":true,"registration_number":true,"council":true,"active":true,"photo_id":true}'::jsonb), 't9')->>'status') = 'VERIFIED', 'a reviewer verifies with full evidence');
select pg_temp.expect((select verified_by = :R and expires_at between now() + interval '364 days' and now() + interval '367 days' from private.practitioners where user_id = :A), 'verified by the reviewer, for 12 months');
select pg_temp.expect((select evidence->>'register_name' = 'Maharashtra Medical Council' and (evidence->'matched'->>'photo_id')::boolean from private.practitioner_events where user_id = :A and to_status = 'VERIFIED'), 'the evidence is recorded with the change');
select pg_temp.expect((select count(*) from private.admin_audit_log where actor = :R and action = 'doctor.status' and target_id = :A) = 2, 'every status change is in the audit log');
select pg_temp.expect(public.practitioner_get(:A)->'history'->0->>'actor_email' is null, 'the doctor does not see reviewers'' emails or evidence');
select pg_temp.expect((public.admin_practitioner(:V, :A, 't10')->'history'-> -1->>'actor_email') = 'reviewer@example.test', 'staff see who made each change');
select pg_temp.expect((public.admin_practitioner_document(:V, :A, (select id from private.practitioner_documents where user_id = :A and kind = 'photo_id'), 't11')->>'path') like 'f1000000-0000-0000-0000-0000000000a1/%', 'a viewer can open a credential file');
select pg_temp.expect((select count(*) from private.admin_audit_log where action = 'doctor.document_open' and actor = :V) = 1, 'opening a file is audited');
select pg_temp.raises(format($q$select public.admin_practitioner_document(%L, %L, %L, 't12')$q$, 'f1000000-0000-0000-0000-0000000000c2', 'f1000000-0000-0000-0000-0000000000b1', (select id from private.practitioner_documents where user_id = 'f1000000-0000-0000-0000-0000000000a1' limit 1)), 'P0002', 'a file is only found under its own doctor');

-- history is append-only
select pg_temp.raises(format($q$update private.practitioner_events set reason = 'rewritten' where user_id = %L$q$, 'f1000000-0000-0000-0000-0000000000a1'), '42501', 'the history cannot be edited');
select pg_temp.raises(format($q$delete from private.practitioner_events where user_id = %L$q$, 'f1000000-0000-0000-0000-0000000000a1'), '42501', 'the history cannot be deleted');

-- suspension, reinstatement, reasons
select pg_temp.raises(format($q$select public.admin_practitioner_transition(%L, %L, 'SUSPENDED', 'short', null, 't13')$q$, 'f1000000-0000-0000-0000-0000000000c1', 'f1000000-0000-0000-0000-0000000000a1'), '22023', 'a suspension needs a real reason');
select public.admin_practitioner_transition(:R, :A, 'SUSPENDED', 'Fictional complaint under investigation', null, 't14');
select pg_temp.expect((public.practitioner_get(:A)->>'status_reason') = 'Fictional complaint under investigation', 'the doctor sees the suspension reason');
create temp table t_exp as select expires_at from private.practitioners where user_id = :A;
select public.admin_practitioner_transition(:R, :A, 'VERIFIED', 'Investigation closed, register re-checked', null, 't15');
select pg_temp.expect((select p.status = 'VERIFIED' and p.expires_at = t.expires_at and p.status_reason is null from private.practitioners p, t_exp t where p.user_id = :A), 'reinstating keeps the original expiry and clears the reason');

-- nobody reviews their own application
select public.practitioner_save(:R, '{"full_name":"Reviewer Fictional"}');
update private.practitioners set status = 'DOCUMENTS_SUBMITTED' where user_id = :R;
select pg_temp.raises(format($q$select public.admin_practitioner_transition(%L, %L, 'UNDER_REVIEW', null, null, 't16')$q$, 'f1000000-0000-0000-0000-0000000000c1', 'f1000000-0000-0000-0000-0000000000c1'), '42501', 'a reviewer cannot review their own application');
select pg_temp.expect((public.admin_practitioner(:R, :R, 't17')->>'can_verify')::boolean = false, 'and is told so');

-- 12-month expiry and re-verification
update private.practitioners set expires_at = now() - interval '1 minute' where user_id = :A;
select pg_temp.expect((public.practitioner_get(:A)->>'status') = 'EXPIRED_REQUIRES_REVERIFICATION', 'verification lapses after 12 months, on the next read');
select pg_temp.expect((select by_kind = 'system' from private.practitioner_events where user_id = :A order by id desc limit 1), 'the lapse is recorded as automatic');
select pg_temp.expect((public.practitioner_get(:A)->>'editable')::boolean, 'an expired application can be updated');
select pg_temp.expect((public.practitioner_submit(:A)->>'status') = 'DOCUMENTS_SUBMITTED', 'and resubmitted for a fresh check');
select pg_temp.expect((select expires_at is null and verified_at is not null from private.practitioners where user_id = :A), 'resubmission clears the expiry and keeps when it was last verified');

-- rejection and resubmission
select public.admin_practitioner_transition(:R, :A, 'REJECTED', 'The registration number does not match the register', null, 't18');
select pg_temp.expect((public.practitioner_get(:A)->>'editable')::boolean and (public.practitioner_get(:A)->>'status_reason') like 'The registration number%', 'a rejected doctor sees why and can correct it');

-- account deletion removes the application and its history (and only then)
delete from auth.users where id = :R;
select pg_temp.expect((select count(*) from private.practitioner_events where actor is null and by_kind = 'staff' and user_id = :A) >= 4, 'deleting a reviewer''s account keeps the history, without their id');
delete from auth.users where id = :A;
select pg_temp.expect(not exists (select 1 from private.practitioners where user_id = :A) and not exists (select 1 from private.practitioner_events where user_id = :A), 'deleting the account removes the application and its history');
select 'doctor tests PASSED';
