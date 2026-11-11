# Doctine admin console

`https://app.doctine.com/admin` — the internal control centre for the Doctine team. It is part of the app (same
Supabase project, same sign-in) and adds no second database, no second user table and no admin sign-up.

## How access is decided

| Layer | What it does |
|---|---|
| Browser (`public/admin/`) | Signs in with the normal Doctine sign-in and sends the person's own token to `/api/admin`. Holds no keys beyond the public publishable key. Hides menus a role can't use — tidiness only. |
| Server (`netlify/functions/admin.mjs`, served as `/api/admin`) | Verifies the token with Supabase on every request; takes the account id from the token only (never from the request body or user metadata); requires two-step sign-in (aal2) when the admin has set it up, or for everyone with `ADMIN_REQUIRE_MFA=true`; rate-limits; calls the database with the server key. |
| Database (`supabase/migrations/20261112000000_admin_console.sql`) | Every admin function checks the caller's role in `private.admin_members` (`private.require`) and writes the audit log in the same transaction. Only `service_role` may call these functions; the `private` schema is not exposed by the Data API, so no browser can read admin tables directly. |

The audit log refuses UPDATE, DELETE and TRUNCATE for everyone, including the database owner, through a trigger.

### Roles

| Permission | owner | super_admin | operations | analyst | support | developer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Dashboard | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Analytics | ✓ | ✓ | ✓ | ✓ | | ✓ |
| CSV exports | ✓ | ✓ | ✓ | ✓ | | |
| View accounts | ✓ | ✓ | ✓ | | ✓ | |
| Suspend / restore / end sessions | ✓ | ✓ | ✓ | | | |
| Send password reset email | ✓ | ✓ | ✓ | | ✓ | |
| Support notes | ✓ | ✓ | ✓ | | ✓ | |
| Documents (technical metadata) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Platform health, incidents (view) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manage incidents and alerts | ✓ | ✓ | ✓ | | | ✓ |
| View switches | ✓ | ✓ | ✓ | | | ✓ |
| Change switches, maintenance | ✓ | ✓ | | | | |
| Announcements | ✓ | ✓ | ✓ | | | |
| View team | ✓ | ✓ | | | | |
| Appoint / change / remove admins | ✓ | | | | | |
| Audit log | ✓ | ✓ | | | | |
| Security events | ✓ | ✓ | | | | ✓ |

The single source is `private.role_perms()` in the migration. Extra rules: nobody can suspend or change themselves;
only an owner can suspend another admin; there must always be one active owner; admins are appointed from existing
Doctine accounts only.

## What the console never shows

Record titles, providers, test values, prescriptions, diagnoses, medical history, extracted text, chat messages, files
or file links. The document view is counts, sources, sizes, file types and failure codes. A database test
(`tests/admin.test.sql`) plants marker strings in a fictional person's records and fails if any admin function returns them.

## Setting it up (owner, once) — needs your approval at each step

1. **Review the migration** `supabase/migrations/20261112000000_admin_console.sql`. It only adds: a `private` schema with
   new tables, new functions, five indexes on existing tables, and one replaced storage policy
   ("health-documents: owner uploads" gains `and public.uploads_allowed()`). No existing table, column or row changes.
2. **Apply it to staging first** (Supabase → staging project → SQL editor → paste → Run). Check: `select public.public_settings();`
   as the `postgres` user returns the switches.
3. **Apply it to production** the same way, once you're happy with staging.
4. **First owner.** In the SQL editor, as `postgres`, replacing the email with your own Doctine account's email (the
   account must already exist — sign up in the app first):

   ```sql
   insert into private.admin_members (user_id, role)
   select id, 'owner' from auth.users where lower(email) = lower('YOUR-EMAIL-HERE')
   on conflict (user_id) do update set role = 'owner', status = 'active';
   select m.role, u.email from private.admin_members m join auth.users u on u.id = m.user_id;  -- check
   ```

   This is the only way an owner is created; it needs database access. The email is never stored in code.
5. **Two-step sign-in** (recommended): Supabase → Authentication → Multi-Factor → enable TOTP. The console offers to set
   it up the first time you open it if `ADMIN_REQUIRE_MFA=true` is set in Cloudflare (Settings → Variables), or from
   "Your access".
6. **Sign-up switch** (optional): Supabase → Authentication → Hooks → "Before User Created" → Postgres function →
   `public.hook_before_user_created`. Until this is selected, the "New account sign-ups" switch is labelled
   not enforced.
7. **Deploy** the app build that contains `/admin`, `/api/admin` and `/api/events`.
8. Add the rest of the team from **Admin team** (they sign up in the app first).

Undo: the console is inert without step 4. To remove it entirely: `drop schema private cascade` would also delete the
rate-limit counters, so instead drop the objects listed in the migration individually and restore the original upload
policy (`with check (bucket_id = 'health-documents' and (storage.foldername(name))[1] = auth.uid()::text)`).

## Switches: what really enforces each one

| Switch | Default | Enforced by |
|---|---|---|
| AI assistant and AI reading | **off** | Server: `/api/chat` and `/api/scan` refuse (emergency guidance still works). If the database can't be reached, it stays off. |
| Storing document files | on | Database: storage insert policy. App: stops sending files, keeps them on the device. |
| New account sign-ups | on | Database Auth hook, once enabled (step 6). |
| Reading PDFs into records | on | App only (reading happens in the browser). |
| Sample records | on | App only (sign-in screen option). |
| Maintenance mode | off | App banner; uploads refused by the database; AI refused by the server; sign-ups refused by the hook (if enabled). Saving records continues. |

Changes reach the app within about 20 seconds (server cache) on the next page load.

## Measurements

Counts of accounts, records, files, medicines and doses come from the existing tables. Feature measurements (PDF read,
search used, export, upload and reading failures) come from `/api/events` and are sent **only** for signed-in people
who switched on "Help improve Doctine" in Settings. Pre-sign-in events (sign-in and sign-up failures) are therefore not
sent by the app today; the console shows "Not recorded yet" rather than a false zero. Supabase's own Auth logs hold
sign-in failures. Events keep short codes and numbers only (the database refuses free text), are de-duplicated by key,
are deleted with the account and after about 13 months.

Metric definitions are in the console under Settings → Metric definitions.

## Tests

- `tests/admin.test.sql` (PostgreSQL, via `tests/run-db-tests.sh`): role-by-role permissions, browser and anonymous
  roles refused, no health data in any output, audit log immutable, switches enforced in the storage policy, events
  validated and de-duplicated, alert rules.
- `tests/admin-api.test.mjs`: token-only identity, refusals logged, MFA, database refusals kept, no key in replies, CSV.
- `tests/browser/admin.test.mjs`: what each role sees, confirmations with reasons, honest health and measurement labels,
  layout from 320 px.
