# Doctine — architecture audit (for the Android and macOS apps)

Audited 12 Nov 2026 against branch `bolt-3d-hero` (commit `fc81e38`, the version live at app.doctine.com) and the live
Supabase project. Facts below were read from the code or queried from production read-only; nothing was changed.

## 1. What Doctine is today

| Area | Finding |
|---|---|
| Frontend | One vanilla-JavaScript single-page app, `public/index.html` (~240 KB: markup, styles and logic in one file). No framework, no bundler. Precompiled Tailwind classes plus its own CSS. |
| Admin console | Separate app in `public/admin/` (team only; not part of the mobile/desktop scope). |
| Language | JavaScript (ES2020+), server functions in Node ESM. |
| Entry points | `public/index.html` (app), `public/admin/index.html` (console), `website/` (doctine.com marketing site). |
| Routing | In-memory view state (`S.view`: home, health, reports, medicines, reminders, chat, about, settings); `#about` is the only hash route. No router library, no server routes for app screens. |
| Libraries | supabase-js **2.45.4** (pinned CDN URL with SRI), pdf.js 3.11.174 (vendored in `public/vendor`), tesseract.js 5.1.1 (CDN, on demand). |
| Server | `netlify/functions/*.mjs` (account, admin, chat, config, errors, events, monitor, scan), run on Cloudflare Pages through `_worker.js` (`tools/build-direct.mjs`). Same code also deploys to Netlify (staging). |
| Server address | `const API = window.DOCTINE_API || ''` — the app already supports a different API origin. |
| Hosting | app.doctine.com = Cloudflare Pages project `doctine-app-direct` (uploaded zip). doctine.com = website. |
| Monitoring | `/api/monitor` every 15 min (Cloudflare cron Worker `doctine-monitor-cron`) plus GitHub "Uptime" workflow. |

## 2. Accounts and sign-in

* Supabase Auth, email + password, email confirmation **on** in production (`mailer_autoconfirm=false`), Google sign-in **on**.
* Client: `createClient(url, anonKey, { persistSession, autoRefreshToken, detectSessionInUrl })` → **implicit flow**
  (tokens arrive in the URL fragment). Session stored in `localStorage` (`sb-<ref>-auth-token`).
* Password reset: fixed today (`fc81e38`): links return to `/?reset=password`, the app shows "Create a new password"
  even when signed in. Real-email verification by a person is still outstanding.
* Two-step sign-in (TOTP) is enabled in the project and enforced for the admin console; the app itself doesn't offer it
  to ordinary users yet.
* Redirect allow list: `https://app.doctine.com/**`; Site URL `https://app.doctine.com`.
* **Email sending: no custom SMTP → Supabase's built-in limit of 2 auth emails per hour for the whole project.** This
  will break sign-up/reset for real users at any volume, on every platform.
* Account deletion: `DELETE /api/account` (server, service key): removes the person's storage folder, then the auth user;
  rows go by `ON DELETE CASCADE`.

## 3. Data (production, read-only checks)

Tables (public schema), all with row-level security **on** and 4 owner policies for `authenticated` (consent_log has 1,
append-only): `health_profiles, consents, consent_log, documents, document_files, lab_results, prescriptions,
prescription_items, medicines, medication_schedules, dose_events, conversations, messages`. Team/admin data lives in a
`private` schema reachable only through `service_role` functions.

Storage: bucket `health-documents`, **private**, 15 MB per file, JPEG/PNG/WebP/PDF only; owner-only policies keyed on
the first folder = `auth.uid()`. Files are read through the authenticated SDK (`download`), never public URLs.

Automated database tests (`tests/rls.test.sql`, `tests/admin.test.sql`, …) run in CI against real PostgreSQL and cover
cross-user access to every table and to storage paths.

## 4. Features and their real state

| Feature | State in production |
|---|---|
| Health profile (name, date of birth, height, weight, blood group, allergies) | Works. No gender field (not collected; keep it that way unless needed). |
| Medical records: add manually, upload photos/PDF, originals kept, categories, search, edit, delete | Works. |
| PDF reading (text layer via pdf.js) | Works (`features.pdf_reading=true`). |
| Scan reading (OCR / AI extraction) | AI extraction is **off** (`aiAvailable=false`); on-device OCR (tesseract) exists. Extracted values are marked for checking. |
| AI assistant | **Off** (`features.ai_assistant=false`). Must stay off in the apps. |
| Medicines, schedules (daily/weekly, times, start/end), taken/skipped, history, pause/stop | Works. |
| Reminders | Browser notifications from the open page plus a minimal service worker; **they only fire while the app is open**. Native apps need real scheduled notifications. |
| Export | ZIP of all data and files, generated in the browser. |
| Help & feedback, What's new | Works (signed-in only). |
| Family profiles | "Coming soon" screen. |
| Sample data / demo accounts | Available for trying the app without an account; never mixed into account data. |

## 5. Build, test, deploy

* `npm test` (syntax, config, secret scan, server tests, gates), `bash tests/run-db-tests.sh` (real PostgreSQL),
  `node tools/run-browser-tests.mjs` (14 Playwright suites, 447 checks), CI in `.github/workflows/ci.yml`.
* `npm run build:direct` → `dist/doctine-app.zip` → uploaded to Cloudflare Pages by hand.
* The repository is **public** on GitHub. GitHub Actions is therefore free, including macOS runners.

## 6. Findings that matter for native apps

1. **The app can be packaged unchanged.** One self-contained page, a configurable API origin and pinned dependencies.
2. **The server sends no CORS headers.** A packaged app (origin `https://localhost` on Android, `tauri://localhost` on
   macOS) cannot call `/api/*` (config, account deletion, errors, events, help) until specific origins are allowed.
3. **Google sign-in cannot run inside an embedded WebView** (Google blocks it). Native apps must open the system browser
   and receive the result through a deep link.
4. **Email links** (confirmation, reset) currently point to `https://app.doctine.com`. To open the apps they need
   Android App Links (`/.well-known/assetlinks.json`) and, on macOS, a `doctine://` scheme added to the Supabase
   redirect allow list. Both are production configuration changes.
5. **Session storage** is `localStorage`. In native apps tokens must go to the Android Keystore-backed encrypted storage
   and the macOS Keychain.
6. **Reminders** need native scheduling (Android AlarmManager via local notifications, macOS UserNotifications).
7. **CSP** is set by Cloudflare `_headers`; bundled apps need it in a `<meta>` tag instead.
8. **2-emails-per-hour limit** (section 2) blocks a real launch on any platform.

## 7. What works, what's incomplete, what's broken

* Works: accounts, profile, records and files, medicines and dose tracking, export, deletion, consent, help, admin console.
* Incomplete: reminders when the app is closed; two-step sign-in for ordinary users; family profiles (labelled "coming soon").
* Broken until fixed: email volume (SMTP); password-reset real-email check still pending.
* Off by design: AI assistant and AI scan reading.
