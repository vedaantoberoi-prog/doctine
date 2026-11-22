# Doctine — security review (baseline before the Android and macOS apps)

12 Nov 2026. Scope: the live web app, its server functions and the Supabase project, plus the risks the native apps add.
Production was inspected read-only.

## Verified now

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

## Open issues (before a public launch on any platform)

1. **High — email delivery:** built-in Supabase email (2 per hour, whole project). Sign-up confirmation and password
   reset will fail for real users. Fix: custom SMTP with a verified sending domain (SPF/DKIM).
2. **Medium — password policy:** 8-character minimum, no character rules, leaked-password check depends on the
   Supabase plan. Consider enabling leaked-password protection (Auth → Providers → Email).
3. **Medium — two-step sign-in for ordinary users** is not offered in the app. Optional, but expected for health data.
4. **Low — public repository:** fine for code (no secrets in it), but every security fix is visible before it ships.
   Keep secrets only in Cloudflare/GitHub secret stores.

## New risks from native apps and how the plan handles them

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

## Privacy and law (needs legal review, not claimed as compliance)

India's Digital Personal Data Protection Act 2023 and the DPDP Rules 2025 (notified 14 Nov 2025, obligations phased in over 18 months, so the main duties apply from about May 2027) apply (notice, consent, purpose limitation,
erasure, breach notification, a contact for grievances). Doctine has consent records, export and deletion. Before store
launch, a lawyer should review the privacy policy against the Rules, the Play "health apps" declaration and data safety
form, and Apple's privacy nutrition label.
