# Doctine — security and incident review

This is the canonical security review, formerly `DOCTINE_SECURITY_REVIEW.md`. The newest review comes first.
Personal emails and ids are redacted: admins are shown only as a 6-character hash.

## 26 Nov 2026 — the three proofs asked for before any new AI or doctor feature

### Proof 1: one patient cannot reach another's records or files, and an unverified doctor cannot either

Result: **passed**. No gap found.

| Check | Where | Result |
|---|---|---|
| Two synthetic accounts, real sign-in tokens, over HTTP. Patient B tried to read, list, change, delete and re-own patient A's rows in all 19 patient tables. | staging | Every read returned 0 of A's rows; B saw only B's own rows. Insert-as-A, re-owning, and child rows on A's document were refused (403/409). Update and delete touched 0 rows, and A's record was unchanged. |
| The same accounts against storage. B tried to read, sign, list, delete, move, copy and upload into A's folder; A tried the doctor-credentials bucket. | staging | All refused (404/403). Listing showed only B's own folder. There is no public URL, and the doctor bucket is closed to patients. |
| Forged tokens: bad signature, a changed `sub`, an unsigned token. | staging | All 401 |
| Database functions a signed-in person can call. Doctor and sharing functions (`practitioner_get`, `doctor_share_record`) | staging + production | Not callable (42501). They run only from the server, with the user from the verified token. The 11 callable public functions all use the caller's own id or row-level security. `support_reply` on another person's request returned "not found". |
| Private schema | staging + production | No grants and no schema use for `anon` or `authenticated`. Refused over HTTP (406). |
| Role simulation inside rolled-back transactions, for every real account (16 in production, 5 in staging). Each was compared against the rows it owns. | production, read-only | 0 rows of anyone else visible; every account saw all of its own. Signed-out visitors were refused at the privilege level. |
| Parity check: a hash of every policy, function and grant, with bucket settings | production vs staging | Identical: 66 policies, 177 functions, 56 tables, with row-level security on all of them. This is why the staging HTTP results apply to production. |
| Doctor and sharing endpoints with no token or a forged one | staging | 503 (switched off). Access is checked again behind the switch: 606 database checks in CI. |

Not tested live: a verified doctor with an active share. Doctor sign-up and sharing stay off by instruction. That path is covered only by `tests/doctor.test.sql` and `tests/sharing.test.sql`. The synthetic accounts, rows, files and support request were deleted afterwards, and the cleanup was verified at 0 remaining.

### Proof 2: old Cloudflare deployment addresses cannot get around production's controls

Result: **one real gap, now closed.**

- **Confirmed and fixed.** Deployment `61fc245e` (commit 3607bff, 25 Nov) was older than the address guard. It was still reachable at its own `*.pages.dev` address with the production keys. Its `/api/config` and `/api/monitor` answered 200. Patient data still needed sign-in (`/api/guardian` and `/api/admin` returned 401), but it ran older code without the fixes made since. With the owner's approval it was deleted, along with `c1ac7e39`, to keep only the latest two. Its address now answers 404.
- Verified 421 `wrong_address` on every API route for `d6903f04` (the rollback target) and `2308df1b` (current), at their own addresses.
- The `doctine-app` project (GitHub-built) has no environment variables. Its 25 preview builds were never built ("Deployment Not Found"), and its main address only redirects to app.doctine.com.
- The `doctine-monitor-cron` worker has no bindings and no `workers.dev` address. The old Netlify site `fabulous-mermaid-f39b30` no longer exists.
- Remaining low risk: the `doctine-app-direct` preview environment holds the production Supabase address and public key, but not the service key, and it has no preview deployments. The release runbook now says to delete old deployments after each release.

### Proof 3: a real backup restores, not just a green backup job

Result: **gaps found and fixed; the newest real production backup then restored and passed every check** (restore drill run 45800576737, 26 Nov, on backup run 45800174258: 55 tables restored with no errors, counts matching production, references and record owners intact, row-level security correct on the restored copy).

- **Confirmed.** The nightly backup did not include the `private` schema: Guardian contacts and deliveries, doctor applications, record shares and their access log, the admin audit log, switches. None of these could have been restored from any backup made before 26 Nov. Fixed in PR #39.
- **Confirmed.** The first backup that included the private schema failed its own self-check. A pipe broke once the dump grew, so a green job was in fact the only kind it could produce while the dump stayed small. Fixed in PR #40: the check now decrypts to a file and compares SHA-256 with the dump.
- The old drill (22 Nov, passed) restored only the public tables and checked only row counts. The new drill (`tools/restore-drill.sh`, weekly) does more:
  - it restores public and private data into a database built from the migrations;
  - it compares counts with production;
  - it checks every reference, and that every record belongs to an account;
  - it checks row-level security on the restored copy.

  `tests/restore-drill.test.sh` in CI shows the drill fails when a schema is missing, when rows are missing, or when a rule leaks.
- **Still not covered (decision for the owner).** The file bytes in the `health-documents` and `practitioner-credentials` buckets are not in any backup. A full restore of sign-in into a new Supabase project has never been rehearsed. Options: Supabase Pro (daily backups, point-in-time recovery), or a storage sync job, which needs a service-role secret in GitHub.

### Evidence review: has anything already happened?

| Question | Finding | Category |
|---|---|---|
| Admin actions by anyone not on the team | None. All 4 members are founders or co-founders with MFA; there are 0 actions by non-members. | No evidence found |
| Leftover admin invitations | 7 sent on 12 Nov: 3 accepted, 3 revoked, 1 pending that expired on 19 Nov. None is still usable. | No evidence found |
| Refused console attempts (`denied:me`) | 3, on 11–12 Nov, from 2 signed-in non-admin accounts. The console showed them nothing. | No evidence found (normal) |
| Data reached through the unguarded old deployment | Cloudflare keeps no per-request logs on this plan, and the auth audit table is empty (Supabase now keeps sign-in logs in its log service, with short retention on Free). Sign-in was still required for patient data there. | Unable to determine |
| Sign-ins from unexpected places | `auth.audit_log_entries` is empty, and the Free plan's log retention is too short to look back. 16 accounts, none created in the last 7 days, all confirmed, no anonymous accounts. | Unable to determine |
| Old deployment exposed with production keys | Yes, 25–26 Nov, now removed | Confirmed (exposure, no evidence of misuse) |

## 12 Nov 2026 — baseline before the Android and macOS apps

12 Nov 2026. Scope: the live web app, its server functions and the Supabase project, plus the risks the native apps add.
Production was inspected read-only.

### Verified now

| Check | Result | How |
|---|---|---|
| Row-level security on every public table | On for all 13 tables, owner-only policies for `authenticated`; `anon` has none | live catalogue query |
| Cross-user access (rows and storage paths) | Refused | `tests/rls.test.sql` in CI (real PostgreSQL) |
| Storage bucket | Private, 15 MB limit, JPEG/PNG/WebP/PDF only, owner-folder policies | live query |
| Service-role key | Server only; secret scan and gitleaks clean; bundle test checks no secret values | `npm test`, gitleaks |
| Admin console | Separate, MFA always, invitation-only, never shows health data | admin test suites |
| Tokens in logs | Fixed today: error reports no longer carry the URL fragment; the server drops non-route values | `fc81e38` |
| Password reset | Fixed today; Supabase handles tokens (one use, 1 hour) | reset-password suite (35 checks) |
| Analytics | Off until the person opts in; event properties are whitelisted, never health data | existing tests |
| AI | Off in production; sending records to AI requires explicit, separate consent | config + consent code |

### Open issues (before a public launch on any platform)

1. **High — email delivery:** built-in Supabase email (2 per hour, whole project). Sign-up confirmation and password
   reset will fail for real users. Fix: custom SMTP with a verified sending domain (SPF/DKIM).
2. **Medium — password policy:** 8-character minimum, no character rules, leaked-password check depends on the
   Supabase plan. Consider enabling leaked-password protection (Auth → Providers → Email).
3. **Medium — two-step sign-in for ordinary users** is not offered in the app. Optional, but expected for health data.
4. **Low — public repository:** fine for code (no secrets in it), but every security fix is visible before it ships.
   Keep secrets only in Cloudflare/GitHub secret stores.

### New risks from native apps and how the plan handles them

| Risk | Control |
|---|---|
| Tokens in plain files | Android encrypted storage (Keystore) and macOS Keychain; never `localStorage` files, never logs |
| Deep-link hijacking | Android App Links (verified domain, not a custom scheme); PKCE so an intercepted code is useless without the device's verifier; macOS custom scheme accepted only for `doctine://auth/callback` with PKCE |
| Remote code in the app | All code bundled and pinned; no `server.url`; CSP meta; Tauri capabilities restrict IPC to named commands |
| WebView file access | No `file://` access beyond the bundle; downloads go through the system share/save dialog |
| Cached medical files | None written to disk; previews stay in memory; sign-out clears memory and tokens |
| CORS | Exact app origins only, no wildcard, Bearer tokens (no cookies) |
| Dependencies | Versions pinned; `npm audit` and `cargo audit` in CI |
| Signing keys | Never in Git; GitHub encrypted secrets; documented rotation |
| Crash/analytics SDKs | None added; existing opt-in measurements only |

### Privacy and law (needs legal review, not claimed as compliance)

India's Digital Personal Data Protection Act 2023 and the DPDP Rules 2025 (notified 14 Nov 2025, obligations phased in over 18 months, so the main duties apply from about May 2027) apply (notice, consent, purpose limitation,
erasure, breach notification, a contact for grievances). Doctine has consent records, export and deletion. Before store
launch, a lawyer should review the privacy policy against the Rules, the Play "health apps" declaration and data safety
form, and Apple's privacy nutrition label.
