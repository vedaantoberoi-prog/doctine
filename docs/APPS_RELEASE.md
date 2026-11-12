# Doctine apps — build, sign and release (Android and Mac)

The apps package the same Doctine app as app.doctine.com (see `DOCTINE_MOBILE_MAC_IMPLEMENTATION_PLAN.md`). Builds
run in GitHub Actions (`.github/workflows/apps.yml`) on every push that touches `public/`, `apps/` or the build script,
and can be started by hand (Actions → Apps → Run workflow). Results are downloadable artifacts kept for 14 days.

## 1. What each build produces

| Artifact | Where | Signed? |
|---|---|---|
| `app-debug.apk` | `doctine-android` | Android debug key (install on a test phone only) |
| `app-release.aab` | `doctine-android` | Unsigned until the Android signing secrets exist; Google Play needs it signed with your upload key |
| `app-release*.apk` | `doctine-android` | As above |
| Emulator screenshots and checks | `doctine-android-emulator` | — |
| `Doctine_<version>_universal.dmg` | `doctine-macos` | Ad-hoc only until Apple signing secrets exist; Gatekeeper will warn |

## 2. Local development (optional)

Requirements: Node 22, and for Android: JDK 21 + Android Studio (SDK 35+); for Mac: Xcode command-line tools + Rust.

```bash
# Android
cd apps/android && npm ci && npm run prepare:android && npm run build:debug
#   → android/app/build/outputs/apk/debug/app-debug.apk  (or open apps/android/android in Android Studio)
# Mac
cd apps/macos && npm ci && npm run web && npm run icons && npx tauri dev     # run
npx tauri build --target universal-apple-darwin --bundles app,dmg            # build
```

The apps need no environment variables: they read the public Supabase settings from `https://app.doctine.com/api/config`
like the website. No secret is ever packaged (the build fails if one looks present).

## 3. Settings outside the code (owner's approval needed; not yet done)

1. **Supabase → Authentication → URL Configuration → Redirect URLs:** add `doctine://auth/callback`. Without it, email
   links and Google sign-in started in an app fall back to the website instead of returning to the app.
2. **Deploy the server change** (CORS for the apps) with the next app.doctine.com release.
3. **Custom SMTP** (Supabase → Authentication → Emails → SMTP Settings) — built-in email allows 2 messages per hour.

## 4. Android release signing (one-time, by the owner)

Create the upload key on your own computer (never in the repository, never shared in chat):

```bash
keytool -genkeypair -v -keystore doctine-upload.jks -alias doctine -keyalg RSA -keysize 4096 -validity 10000
base64 -i doctine-upload.jks | pbcopy          # macOS: copies the key as text
```

GitHub → repository → Settings → Secrets and variables → Actions → New repository secret:
`DOCTINE_ANDROID_KEYSTORE_B64` (the copied text), `DOCTINE_ANDROID_KEYSTORE_PASSWORD`, `DOCTINE_ANDROID_KEY_ALIAS`
(`doctine`), `DOCTINE_ANDROID_KEY_PASSWORD`. Keep the `.jks` file and passwords in a password manager: losing them
means asking Google for an upload-key reset. Use **Play App Signing** (Google holds the app-signing key).

## 5. Google Play submission checklist

- [ ] Play Console developer account (one-time US$25; identity verification; organisation account recommended).
- [ ] App created with package `com.doctine.app` (permanent).
- [ ] Signed `app-release.aab` uploaded to **Internal testing** first; then closed testing (new personal accounts
      need 12 testers for 14 days before production).
- [ ] **Health apps declaration** (Policy → App content): Doctine is a personal health record; it does not diagnose or
      treat; not a medical device.
- [ ] **Data safety form**: collects name, email, health info, files; encrypted in transit; user can request deletion
      (in-app account deletion); no data sold; no ads; analytics only if the person opts in.
- [ ] Privacy policy URL: `https://www.doctine.com/privacy` (must match what the app does).
- [ ] Account deletion URL (Play requires a web link too): a page explaining in-app deletion and a contact.
- [ ] Permissions justification: notifications and exact alarms (dose reminders the person turns on).
- [ ] Content rating questionnaire; target audience 18+.
- [ ] Store listing: icon (512 px, from `apps/assets/icon-only.png`), feature graphic 1024×500, at least 2 phone
      screenshots, short and full description without medical claims.
- [ ] Reviewer access: a test account with fictional data (create it on production only with your approval).

**Installing outside Google Play (APK):** Google's Android developer verification applies to apps installed outside
Play: enforced from 30 Sep 2026 in Brazil, Indonesia, Singapore and Thailand, planned worldwide (including India) in
2027. After that, a directly installed Doctine APK must come from a verified developer (the Play Console identity, or
the free "limited distribution" account for up to 20 devices). Installing over USB with `adb` stays possible for
testing. Check Google's current timeline before relying on direct APK distribution.

## 6. Mac signing and notarisation checklist

Direct download (DMG) needs a **Developer ID Application** certificate and notarisation, or macOS shows "Apple could not
verify Doctine". The Mac App Store is a separate path (App Sandbox, App Store review, Apple handles distribution and
updates); it is not set up here.

- [ ] Apple Developer Program membership (US$99/year), Team ID.
- [ ] Create a *Developer ID Application* certificate (Xcode → Settings → Accounts, or developer.apple.com), export it as
      `.p12` with a password.
- [ ] An app-specific password for your Apple ID (appleid.apple.com) for notarisation.
- [ ] GitHub secrets: `APPLE_CERTIFICATE` (base64 of the .p12), `APPLE_CERTIFICATE_PASSWORD`,
      `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Doctine (TEAMID)`), `APPLE_ID`, `APPLE_PASSWORD`,
      `APPLE_TEAM_ID`. The Tauri bundler then signs with the hardened runtime and notarises.
- [ ] Verify on a Mac: `spctl -a -vv /Applications/Doctine.app` → "accepted, source=Notarized Developer ID";
      `xcrun stapler validate Doctine.dmg`.
- [ ] Until then (unsigned test build): right-click Doctine.app → Open → Open, or System Settings → Privacy &
      Security → "Open Anyway". Keychain may ask once for permission after an update.

## 7. Versions

`version` in `apps/android/package.json` and `apps/macos/src-tauri/tauri.conf.json` (keep them equal). Android's
`versionCode` is the GitHub run number. Raise the version for every store release.

## 8. Rollback

* App code is the website's code at the same commit: fix forward on the web, then ship a new app version.
* Android: Play Console → release → halt rollout / roll back to the previous release. Directly installed APKs can't be
  pulled back; publish a fixed version.
* Mac: replace the DMG on the download page with the previous version (keep old DMGs).
* Server: the CORS change is additive; removing it only stops the apps from reaching `/api/*`.
