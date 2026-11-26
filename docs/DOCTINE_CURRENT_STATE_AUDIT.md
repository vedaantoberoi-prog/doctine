# Doctine — current state audit

This document is the maintained source of truth for what Doctine is and does right now. Update it with every release or
change to a switch. The earlier `DOCTINE_ARCHITECTURE_AUDIT.md` (12 Nov, written for packaging the native apps) is kept
as history.

Last verified **26 Nov 2026, 19:05 IST**, against the live systems, read-only unless stated. The PDF "Doctine Redesign Preview" was
not attached to the session and was not read.

## 1. What is live

| Item | Verified state | How |
|---|---|---|
| Production app | app.doctine.com serves commit **5af48ea** (Cloudflare Pages `doctine-app-direct`, deployment `9e581498`), released 26 Nov with the owner's approval | Cloudflare API; `version.json`; `/api/monitor` ok |
| Rollback target | `a05172f6` (commit 6a61f34). It refuses API calls at its own address (421). | Cloudflare API, live probe |
| Other Cloudflare deployments | None. All older ones were deleted, the last on 26 Nov (61fc245e had no address guard). | Cloudflare API, 404 probe |
| `main` | 5af48ea, the same as production | git |
| Staging | doctine-staging.netlify.app, auto-deployed from `main`, on its own database | Netlify, `/api/config` |
| Production database | Supabase `ggqctflfwpfkemgehizq`: 56 tables (public and private), row-level security on all of them, 66 policies, 177 functions | catalogue query |
| Staging database | Supabase `hmlxqmhqfaxfgbizcjyg`, identical fingerprint of policies, functions, grants and buckets | catalogue hash comparison |
| Migration history | There is no `supabase_migrations` table: migrations are applied by hand. Both databases match a database built from the repository's 25 migrations exactly: 177 functions with security mode, 601 columns and policies. | SHA-256 of sorted catalogue lists, computed locally and on both databases |
| Production accounts | 16 (none new in 7 days); 4 admin team members, all with two-step sign-in | read-only counts |
| Repository | Public on GitHub. No open Dependabot or secret-scanning alerts. | GitHub |
| Open pull requests | None | GitHub |

### Production switches (`private.feature_flags`)

| On | Off |
|---|---|
| registrations, document_upload, pdf_reading, sample_data, guardian | ai_gateway, ai_assistant, ai_orchestrator, ai_actions, doctor_onboarding, record_sharing, maintenance |

### Production secret names (values never read)

Cloudflare `doctine-app-direct` production: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`RATE_LIMIT_SECRET`, `RATE_LIMIT_REQUIRE_SHARED`, `GUARDIAN_LINK_SECRET`, `AUTH_GOOGLE`, `AI_DAILY_REQUEST_CAP`,
`DOCTINE_ENV`. The preview environment holds `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `AI_DAILY_REQUEST_CAP` and
`DOCTINE_ENV` (no service key). There is **no AI key**, so AI cannot run in production even if switched on.
GitHub Actions secrets used by the backup: `SUPABASE_DB_PASSWORD` and `BACKUP_PASSPHRASE`.

### Production sign-in settings (Supabase Auth)

Email confirmation is on, Google sign-in is on, and password minimum is 8. **No custom SMTP: 2 emails an hour for the whole project.**
Leaked-password check is off (it needs a paid plan). TOTP is available. No CAPTCHA. Sessions have no time limit.

## 2. Feature inventory

Status words follow the directive:
- Implemented and verified
- Implemented but not fully verified
- Partially implemented
- Designed/documented only
- Not implemented
- Blocked (credential, payment, legal approval or external provider)
- Unknown

| Feature | Purpose | Front end · API · Database | Security and admin controls | Tests | Staging · Production | Status | Known gaps |
|---|---|---|---|---|---|---|---|
| Accounts and sign-in | Email and password, Google, reset, deletion | `index.html` · Supabase Auth, `/api/account` · `auth` | Own-row RLS; deletion purges both storage buckets | functions (85), reset suite, browser | On · On | **Implemented but not fully verified** | 2 emails/hour without SMTP (**blocked**: owner's email account). The real-email reset check by a person is still outstanding. |
| Health profile and history | Conditions, allergies, surgeries, family history, with change log | app · Supabase REST · `health_profiles`, `health_records`, `health_record_changes` | Owner RLS; history is append-only | rls.test.sql, browser | On · On | **Implemented and verified** | — |
| Medical records and files | Upload photos and PDFs, keep originals, categories, search | app · storage · `documents`, `document_files`, `document_pages` | Private bucket, owner folders, 15 MB, type list | rls.test.sql, live cross-user test on 26 Nov | On · On | **Implemented and verified** | File bytes are not in any backup (see §3) |
| PDF reading | Text layer, read on the device | app (pdf.js) | Stays on the device | browser | On · On (`pdf_reading`) | **Implemented and verified** | — |
| AI scan reading | Extract values from photos | `/api/scan` | Needs separate consent and the AI key | functions | Staging only, failing without a key · Off | **Blocked** (AI key, doctor review) | Gate 6 fails on staging: there is no AI key |
| Medicines and reminders | Schedules, taken/skipped, history | app · `medicines`, `medication_schedules`, `dose_events` | Owner RLS | browser, rls | On · On | **Partially implemented** | Reminders fire only while the app is open |
| Vitals | Weight, BP and others | app · `vital_readings` | Owner RLS | browser | On · On | **Implemented and verified** | — |
| Export and deletion | ZIP of all data; delete the account | app · `/api/account` | Deletion covers rows and both buckets | functions | On · On | **Implemented but not fully verified** | No test on a real production account (by design) |
| AI assistant (gateway, orchestrator, evidence) | Answers grounded in the person's records and cited sources | `/api/chat`, orchestrator, evidence index | Off; consent; daily cap; 77-case evaluation; doctor review gate | gateway (25), orchestrator (48), evidence, grader | Built · Off, no key | **Blocked** (AI key and doctor sign-off) | See DOCTINE_AI_ARCHITECTURE_AND_LEARNING_ROADMAP.md |
| Guardian | Check-ins and alerts to trusted contacts | app · `/api/guardian` · `private.guardian_*` | Signed contact links (24 h), consent links (7 days), no data in logs | guardian (51), DB suite | Off · **On**, 0 contacts, 1 incident | **Partially implemented** | No messaging provider: alerts go out only when the person shares them from their own phone (**blocked**: provider contract, DLT templates). A test-clock bug was fixed in #42. |
| Doctor onboarding | Doctors apply; the team verifies against NMR/state council | `/doctor/` · `/api/doctor` · `private.practitioners*`, credentials bucket | Founder-only switch; evidence required; never self-granted; logged | doctor (17), DB, browser (26), admin | Off · Off (migration applied) | **Implemented but not fully verified** | Legal review before it opens (**blocked**: legal approval) |
| Record sharing with a doctor | The patient shares chosen parts, for 1, 7 or 30 days, with a verified doctor | app view · `/api/share`, `/api/doctor` · `record_shares`, `record_access_log` | Only active share and VERIFIED doctor; every opening logged for the patient | sharing (11), DB, browser (14) | Off · Off (migration applied) | **Implemented but not fully verified** | Never exercised live: switched off by instruction. Legal review needed (**blocked**). |
| Consultations, prescriptions, payments | Future doctor system | — | — | — | — | **Designed/documented only** (DOCTOR_NETWORK.md) | Must not start before legal and operational approval |
| Admin console | Team control plane; never shows medical contents | `/admin/` · `/api/admin` · `private.admin_*` | Invitation only, MFA always, permissions per member, append-only audit log | admin-api (25), admin browser (123) | On · On | **Implemented and verified** | A readiness view for the three proofs is not built yet |
| Help, feedback, support | Messages to the team | app · `support_*` functions | Caller-only functions (another person's request returns "not found", tested 26 Nov) | functions | On · On | **Implemented and verified** | — |
| Security request log | 370-day log of every API request, kept in India | Cloudflare adapter · `security_log_add` · `private.security_log` | Append-only; no grants; never bodies or tokens | DB (security_log), adapter, worker | Applied · **On**, lines verified arriving 26 Nov | **Implemented and verified** | Sign-ins at Supabase Auth are not covered |
| Rate limiting | Abuse and cost control | shared limiter, `private.rate_limits` | Fails closed when the shared limiter is required | functions | On · On | **Implemented and verified** | — |
| Monitoring | Uptime and database checks every 15 min | `/api/monitor`, cron Worker, GitHub Uptime | No data in the checks | uptime workflow | On · On | **Implemented and verified** | — |
| Backups and restore | Nightly encrypted dump; weekly restore drill; nightly file copy (needs `STORAGE_BACKUP_KEY`) | `backup.yml`, `restore-drill.yml`, `tools/restore-drill.sh` | AES-256; only pass/fail logged | restore-drill.test.sh in CI | — · Green on 26 Nov; drill passed on the real backup | **Implemented and verified** (database) · **Blocked** (files: owner secret) | Sign-in has never been restored into a new project |
| Android and macOS apps | Native packaging | `apps.yml` | Keystore and Keychain plan | apps workflow green | Built in CI · Not released | **Partially implemented** | Store listings, signing, SMTP and deep links |
| Family profiles | Several people under one account | "Coming soon" screen | — | — | — | **Not implemented** | — |

## 3. Known risks and owner decisions

1. **Email (high).** Without custom SMTP, sign-up confirmation and password reset fail beyond 2 emails an hour.
2. **File backups (high for a health app).** Uploaded photos and PDFs are not in any backup. Options: Supabase Pro
   (daily backups, point-in-time recovery), or a storage sync job, which needs a service-role secret in GitHub.
3. **Guardian is on in production but cannot send alerts itself.** The app says so to the person. To change that, you
   need a messaging provider under contract (DLT-registered SMS templates or WhatsApp Business).
4. **Leaked-password check** needs a paid Supabase plan.
5. **Public repository.** No secrets are in it, but fixes are visible before they ship. Making it private changes GitHub
   Actions billing (macOS runners are costly) and stops free secret scanning. This is the owner's decision; nothing was changed.
6. **Doctor network and sharing** need a lawyer's review (Telemedicine Practice Guidelines, DPDP Act) before any switch
   goes on.

## 4. How to re-verify this page

- Live version: Cloudflare API `pages/projects/doctine-app-direct` (canonical deployment), or open
  `https://app.doctine.com` → About.
- Switches: `select key, enabled from private.feature_flags` (read-only), or the admin console → Switches.
- Isolation and parity: the queries in `DOCTINE_SECURITY_AND_INCIDENT_REVIEW.md` (26 Nov section).
- Backups: Actions → **Backup restore drill**. The job summary lists every check.
