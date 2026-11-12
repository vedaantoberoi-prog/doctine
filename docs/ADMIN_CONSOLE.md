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

Five roles, least privilege first. Migration `20261112030000_admin_console_v2.sql` maps the earlier roles across:
super_admin and operations → admin, developer → analyst.

| Permission | owner | admin | analyst | support | auditor |
|---|:-:|:-:|:-:|:-:|:-:|
| Dashboard headline figures | ✓ | ✓ | ✓ | ✓ | ✓ |
| Analytics and trend charts | ✓ | ✓ | ✓ | | |
| Reports (CSV, PDF) and export history | ✓ | ✓ | ✓ | | ✓ |
| View accounts | ✓ | ✓ | | ✓ | |
| Suspend / restore / end sessions | ✓ | ✓ | | | |
| Send password reset email, support notes | ✓ | ✓ | | ✓ | |
| Documents (technical metadata) | ✓ | ✓ | ✓ | | |
| Platform health, uptime, errors, incidents, alerts (view) | ✓ | ✓ | ✓ | ✓ | |
| Manage incidents, alerts and errors | ✓ | ✓ | | | |
| View and change switches, maintenance, announcements | ✓ | ✓ | | | |
| View team | ✓ | ✓ | | | ✓ |
| Appoint / change / suspend / remove admins | ✓ | | | | |
| Audit log, security events | ✓ | ✓ | | | ✓ |

The single source is `private.role_perms()` in the migration. Extra rules: nobody can suspend or change themselves;
only an owner can suspend another admin; there must always be one active owner; admins are appointed from existing
Doctine accounts only.

## What the console never shows

Record titles, providers, test values, prescriptions, diagnoses, medical history, extracted text, chat messages, files
or file links. The document view is counts, sources, sizes, file types and failure codes. A database test
(`tests/admin.test.sql`) plants marker strings in a fictional person's records and fails if any admin function returns them.

## Setting it up (owner, once) — needs your approval at each step

0. **Later migrations, in order:** `20261112010000_admin_profile_activity.sql` (applied),
   `20261112020000_private_rls.sql` and `20261112030000_admin_console_v2.sql` (the redesign). The v2 migration replaces
   `admin_users` with an 8-argument version, so the app build containing the redesigned console must be deployed
   straight after it; the old console would show an error on Users until then. Nothing in v2 deletes rows: it adds
   columns, tables, indexes and functions, and maps old role names.
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

## Monitoring, errors and alert email

- **Scheduled health round:** `.github/workflows/uptime.yml` calls `GET /api/monitor` every 15 minutes. The server itself
  checks the app (`/version.json`), the database, sign-in and storage, records the results (at most one round per
  4 minutes, whoever calls), evaluates the alert rules, and replies with counts only.
- **AI provider check:** when `ANTHROPIC_API_KEY` is set, each round lists models (no AI request, no health data) and the
  console shows Operational / Configured but failing / Disabled by switch / Not configured.
- **Maintenance windows:** a window with a start and end turns maintenance on and off at those times, enforced in the
  database (`private.maintenance_on()`), so it needs no scheduler.
- **Uptime history:** Platform health shows per-service pass rates, typical and slow response times, and a bar per
  hour or 6 hours for the last 7 days. Opening Platform health also records a round.
- **Error tracking:** the app reports uncaught errors to `/api/errors` (same-origin only, rate-limited); the Cloudflare
  router reports unhandled server errors. The database strips numbers, quoted text and email addresses from messages,
  groups by fingerprint, counts per hour, and reopens resolved errors that recur. No account or IP is stored.
- **Alert email:** with `RESEND_API_KEY`, `ALERT_EMAIL_TO` and `ALERT_EMAIL_FROM` set in Cloudflare, each new alert is
  emailed once through Resend. Without them the uptime workflow fails while there are un-emailed alerts, so GitHub
  emails the account that owns the workflow; acknowledging or resolving the alert in the console stops it.
- **PDF reports:** Reports → Download PDF builds an A4 report on the server (headline figures with comparison, funnel,
  adoption, day-by-day table). Logged like CSV exports.

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
- `tests/browser/admin-shapes.test.mjs` and `tests/admin-reports.test.mjs`: every page, drawer, dialog and report built
  from data shaped exactly like the real database output (`tests/browser/fixtures/admin-shapes.json`: field names and
  types only, captured from staging on 12 Nov 2026), empty and busy, at 1440, 390 and 320 px.
- On staging (12 Nov 2026): the v2 migration applied; the whole of `tests/admin.test.sql` (127 checks) run against
  the real project inside a transaction that was then rolled back; every database call the server makes matched exactly
  one function, executable by the server role only.
