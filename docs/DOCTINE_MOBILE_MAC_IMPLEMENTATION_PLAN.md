# Doctine — Android and macOS implementation plan (with architecture decision record)

Read with `DOCTINE_ARCHITECTURE_AUDIT.md` and `DOCTINE_SECURITY_REVIEW.md`.

## ADR-001: one app, packaged natively for Android (Capacitor) and macOS (Tauri)

**Status:** proposed, awaiting approval (12 Nov 2026).

### Context
Doctine is one self-contained web app (`public/index.html`) on one Supabase project. The web app works and is well
tested (447 browser checks, database tests in CI). Users must see the same records on web, Android and Mac.

### Options considered

| Option | For | Against | Verdict |
|---|---|---|---|
| **Android: Capacitor** (current stable, version pinned when the project is created) (bundle `public/` in the app, native plugins) | Reuses the tested app as-is; real native APIs (notifications, back button, status bar, share, camera/file chooser, secure storage, App Links); one codebase for all fixes | WebView rendering; plugins must be kept current | **Chosen** |
| Android: native Kotlin/Compose | Best native feel | A second implementation of every feature, auth rule and safety text; doubles bugs and review work; months of work | Rejected for now |
| Android: React Native/Flutter | Native widgets | Same rewrite cost as native; nothing to reuse (app isn't React) | Rejected |
| Android: Capacitor pointing at the live site (`server.url`) | Instant updates | That *is* "a website in a WebView"; no offline shell; store-review risk | Rejected |
| **macOS: Tauri 2** | ~10 MB app; WebKit (system) engine; Rust core with Keychain, native menus, drag-and-drop, notifications, deep links; universal (Apple Silicon + Intel) builds; strict IPC permissions | WebKit differs slightly from Chromium (the app must be tested in WebKit — Playwright can) | **Chosen** |
| macOS: Electron | Same Chromium as tests; mature | ~150 MB; bundles a browser to patch; larger attack surface | Rejected |
| macOS: SwiftUI + WKWebView | Fully native | Second shell to build and maintain by hand | Rejected |

### Decision
Keep **one product codebase** (`public/index.html` and the server). Add a small **native bridge** (`public/native.js`,
loaded only inside the apps) that swaps browser-only pieces for native ones. Android ships with Capacitor, macOS with
Tauri. Both talk to the **same Supabase project** and the same `/api` at `https://app.doctine.com`. Builds run in
**GitHub Actions** (free for this public repository; ubuntu runners have the Android SDK, macOS runners have Xcode),
because this workspace cannot install packages or run Apple tools.

### Consequences
* A fix to the app reaches all three platforms. Native-only code is small and reviewable.
* App updates on Android/macOS need a new release (no remote code loading, by design).
* Store accounts, signing keys and certificates belong to the owner and are never in the repository.

## What the native bridge does (`public/native.js`)

| Concern | Web today | Android (Capacitor) | macOS (Tauri) |
|---|---|---|---|
| API origin | same origin | `window.DOCTINE_API = 'https://app.doctine.com'` | same |
| Session tokens | localStorage | supabase-js `storage` adapter → encrypted storage (Android Keystore) | Keychain (Rust `keyring`) via a narrow command |
| Auth flow | implicit | **PKCE** (code in query, verifier on device) | PKCE |
| Email links (confirm, reset) | `https://app.doctine.com/...` | Android App Links for `https://app.doctine.com/auth/*`; web fallback if the app isn't installed | `doctine://auth/*` (custom scheme, registered by the app) |
| Google sign-in | redirect in page | system browser (Custom Tabs) → App Link back | system browser → `doctine://` back |
| Reminders | open-page notifications | LocalNotifications (exact alarms, reschedule on boot and on schedule change) | UserNotifications via Tauri plugin |
| Back navigation | browser back | hardware back → close dialog / previous view / leave | ⌘[ and menu |
| Files | `<input type=file>` | system file chooser and camera (Capacitor WebView chooser) | Finder dialog and drag-and-drop |
| Export | download ZIP | Filesystem + Share sheet | Save dialog |
| Offline | toast | banner + retry; nothing cached beyond what the web app holds in memory | same |
| CSP | `_headers` | `<meta http-equiv>` built into the bundle | same + Tauri CSP |

No medical data is written to disk by the bridge. Signing out clears tokens and in-memory data (as the web app does).

## Server and Supabase changes needed (each needs your approval before production)

1. `/api/*` CORS for exactly `https://localhost` and `capacitor://localhost` (Android) and `tauri://localhost`
   (macOS); credentials via Bearer token only; no wildcard.
2. Supabase redirect allow list: add `https://app.doctine.com/auth/**` and `doctine://auth/**`.
3. `public/.well-known/assetlinks.json` with the release signing-key fingerprint (Android App Links).
4. `/auth/*` web pages so email links still work in a browser when the app isn't installed.
5. Custom SMTP (Resend or similar) — owner's account; strongly required before launch.

No database schema change is planned.

## Phases and what each delivers

| # | Phase | Output | Who/what it needs |
|---|---|---|---|
| 1 | Audit | three documents (done) | — |
| 2 | Architecture | this plan; approval of ADR-001 and the application ID | your decision |
| 3 | Shared foundation | `native.js`, storage adapter, PKCE switch, CORS (code + tests), CSP meta, `/auth/*` pages, WebKit test run | — |
| 4 | Android | `android/` Capacitor project, icons/splash, notifications, back, share, App Links; CI job building debug APK and unsigned AAB; emulator smoke test in CI | GitHub Actions |
| 5 | macOS | `macos/` Tauri project, menus, Keychain, drag-and-drop, notifications, deep links; CI job building a universal `.app` and unsigned DMG; launch smoke test on the macOS runner | GitHub Actions |
| 6 | Security | review of the above; token-leak checks; dependency audit | — |
| 7 | Testing | automated suites in CI + a manual test script for real devices | you or a tester with a phone/Mac |
| 8 | Release | signed APK/AAB and signed, notarised DMG | your Google Play and Apple Developer accounts, keys in GitHub secrets |
| 9 | Documentation | setup, build, release, rollback, store checklists | — |

## Honest limits

* **Signing and store release need your accounts:** Google Play Console (one-time US$25) and Apple Developer Program
  (US$99/year). Without Apple's, the DMG runs only after the user overrides Gatekeeper; without a Play account there's
  no store listing (a signed APK can still be installed directly).
* **Real-device testing** needs a person with an Android phone and a Mac; CI uses an emulator and a macOS runner.
* **Health-app declarations** (Play's health apps policy, data safety form) and DPDP review are for you and a lawyer;
  the documents will draft them, not certify them.
