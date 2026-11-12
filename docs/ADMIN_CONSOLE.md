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

### Leadership roles and permissions

Two roles, from migration `20261112040000_leadership.sql`. There is exactly one **Founder** (a unique index enforces it),
and any number of **Co-Founders**, each holding an individual list of permissions chosen by the Founder. Every admin
function checks the permission in the database (`private.require`), so hiding a button is never the protection.
Earlier roles were mapped without losing access: owner → Founder; admin, analyst, support and auditor → Co-Founders with
presets of the same name.

| Area | Permission | Key | Founder | Co-Founder |
|---|---|---|:-:|:-:|
| Overview | Dashboard (aggregate figures) | `dashboard.view` | ✓ | ✓ by default |
| Overview | Analytics and charts | `analytics.view` | ✓ | ✓ by default |
| Overview | Reports and exports (CSV, PDF) | `reports.export` | ✓ | if granted |
| Accounts | Account list and basic account details | `users.view` | ✓ | ✓ by default |
| Accounts | Internal notes on accounts | `users.notes` | ✓ | if granted |
| Accounts | Send password-reset emails | `users.reset_password` | ✓ | if granted |
| Accounts | Suspend and restore accounts | `users.suspend` | ✓ | if granted |
| Operations | Document and storage statistics | `documents.view` | ✓ | ✓ by default |
| Operations | Platform health, errors, incidents and alerts (view) | `health.view` | ✓ | ✓ by default |
| Operations | Open and update incidents | `incidents.manage` | ✓ | if granted |
| Operations | Acknowledge alerts, resolve errors | `alerts.manage` | ✓ | if granted |
| Support | View support requests | `support.view` | ✓ | if granted |
| Support | Assign and prioritise support requests | `support.assign` | ✓ | if granted |
| Support | Reply, add internal notes, change status | `support.respond` | ✓ | if granted |
| Product | View product feedback and feature requests | `feedback.view` | ✓ | ✓ by default |
| Product | Triage feedback, manage feature requests and tasks | `feedback.manage` | ✓ | ✓ by default |
| Product | View bugs | `bugs.view` | ✓ | ✓ by default |
| Product | Create, categorise and update bugs | `bugs.manage` | ✓ | ✓ by default |
| Content | View content and drafts | `content.view` | ✓ | ✓ by default |
| Content | Draft announcements, release notes and content | `content.edit` | ✓ | ✓ by default |
| Content | Publish announcements and content | `content.publish` | ✓ | if granted |
| Content | Record clinical review of medical content | `content.clinical_review` | ✓ | if granted |
| Content | View release notes | `releases.view` | ✓ | ✓ by default |
| Content | Publish release notes | `releases.manage` | ✓ | if granted |
| Platform control | View feature switches | `flags.view` | ✓ | if granted |
| Platform control | Change feature switches (not the AI switch) | `flags.manage` | ✓ | if granted |
| Platform control | Maintenance mode and windows | `maintenance.manage` | ✓ | if granted |
| Governance | See the leadership team | `team.view` | ✓ | if granted |
| Governance | Read the audit log | `audit.view` | ✓ | if granted |
| Governance | Security events | `security.view` | ✓ | if granted |
| Founder only | Invite, remove and set permissions of Co-Founders | `team.manage` | ✓ | never (Founder only) |
| Founder only | Security policy and leadership sessions | `security.manage` | ✓ | never (Founder only) |
| Founder only | The AI assistant switch | `ai.manage` | ✓ | never (Founder only) |

The standard Co-Founder set (least privilege) is the "✓ by default" rows: aggregate dashboards and analytics, account
list, document and health statistics, product feedback and bugs, content and release-note drafting. Presets in the
Leadership page: Standard, Product, Support lead, Analytics only, Auditor, Operations (every grantable permission).

Rules enforced in the database: nobody can change their own membership or permissions; nobody can change, suspend or
remove the Founder; only the Founder can act on another leadership member's account; Founder-only permissions are
rejected even if sent directly; a suspended member has no permissions at all. Two-step sign-in (aal2) is required by the
server for every admin action, for everyone.

### Invitations

1. The Founder enters an email, a permission preset (adjustable) and a reason. The database records the invitation
   (`private.admin_invites`, expires after 7 days).
2. For an email with no Doctine account, the server calls Supabase's invite API (`/auth/v1/invite`, redirect back to
   `/admin/`); Supabase emails a link that creates the account. For an existing account, no email is sent: they sign in at
   `/admin`.
3. Signed in with that **verified** email, the person sees "You're invited" as Co-Founder, sets a password if the account
   is new, and accepts. Only then do they become a member. Anyone else, an expired or revoked invitation, or a suspended
   former member is refused (and the refusal is recorded).
4. They set up two-step sign-in, then land on their Co-Founder dashboard.

Supabase's built-in email sends at most 2 emails an hour; for more, set up custom SMTP (for example Resend) in Supabase →
Authentication → Emails. While new sign-ups are paused by the switch, a pending invitee can still create their account.

## What the console never shows

Record titles, providers, test values, prescriptions, diagnoses, medical history, extracted text, chat messages, files
or file links. The document view is counts, sources, sizes, file types and failure codes. A database test
(`tests/admin.test.sql`) plants marker strings in a fictional person's records and fails if any admin function returns them.

## Setting it up (Founder, once) — needs your approval at each step

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
4. **The Founder.** (Already done in production.) In the SQL editor, as `postgres`, replacing the email with your own Doctine account's email (the
   account must already exist — sign up in the app first):

   ```sql
   insert into private.admin_members (user_id, role)
   select id, 'founder' from auth.users where lower(email) = lower('YOUR-EMAIL-HERE')
   on conflict (user_id) do update set role = 'founder', status = 'active';
   select m.role, u.email from private.admin_members m join auth.users u on u.id = m.user_id;  -- check
   ```

   This is the only way a Founder is created; it needs database access. The email is never stored in code. There can
   only be one: changing the Founder means updating that row in SQL, which no console action can do.
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
- `tests/browser/help.test.mjs`: the app's Help and feedback (support requests, replies, feedback, What's new), and that one
  person's requests never show for the next person on the same browser.
- `tests/browser/admin.test.mjs`: what each role sees, confirmations with reasons, honest health and measurement labels,
  layout from 320 px.
- `tests/browser/admin-shapes.test.mjs` and `tests/admin-reports.test.mjs`: every page, drawer, dialog and report built
  from data shaped exactly like the real database output (`tests/browser/fixtures/admin-shapes.json`: field names and
  types only, captured from staging on 12 Nov 2026), empty and busy, at 1440, 390 and 320 px.
- On staging (12 Nov 2026): the v2 migration applied; the whole of `tests/admin.test.sql` (127 checks) run against
  the real project inside a transaction that was then rolled back; every database call the server makes matched exactly
  one function, executable by the server role only.
