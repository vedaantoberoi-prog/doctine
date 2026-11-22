#!/usr/bin/env node
/**
 * Doctine · turns the project Capacitor generates (`npx cap add android`) into the Doctine app. Safe to run again.
 * - registers the encrypted session store (native/DoctineSecurePlugin.java) in MainActivity;
 * - email and Google sign-in links: doctine://auth/callback opens the app (PKCE makes an intercepted link useless);
 * - permissions: notifications and exact alarms for dose reminders only (no camera, location, contacts or storage
 *   permission: the system file picker and camera app are used through the WebView's chooser);
 * - no backups of app data (health app: the session must not be copied to cloud backups or another phone);
 * - a small monochrome notification icon; version from package.json and DOCTINE_VERSION_CODE;
 * - release signing read from environment variables (never stored in the repository).
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const app = fileURLToPath(new URL("..", import.meta.url));
const A = join(app, "android", "app");
const SRC = join(A, "src", "main"), JAVA = join(SRC, "java", "com", "doctine", "app");
if (!existsSync(SRC)) { console.error("customize: run `npx cap add android` first"); process.exit(1); }
const edit = (f, fn) => { const s = readFileSync(f, "utf8"), t = fn(s); if (t !== s) writeFileSync(f, t); };
const must = (cond, what) => { if (!cond) { console.error("customize: could not " + what); process.exit(1); } };

// 1. Java: encrypted session store, registered before Capacitor starts.
mkdirSync(JAVA, { recursive: true });
copyFileSync(join(app, "native", "DoctineSecurePlugin.java"), join(JAVA, "DoctineSecurePlugin.java"));
writeFileSync(join(JAVA, "MainActivity.java"), `package com.doctine.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DoctineSecurePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);

// 2. Manifest.
edit(join(SRC, "AndroidManifest.xml"), (s) => {
  const perms = ["android.permission.POST_NOTIFICATIONS", "android.permission.SCHEDULE_EXACT_ALARM", "android.permission.RECEIVE_BOOT_COMPLETED"];
  for (const p of perms) if (!s.includes(`"${p}"`)) s = s.replace(/<\/manifest>/, `    <uses-permission android:name="${p}" />\n</manifest>`);
  s = s.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
  if (!s.includes("android:allowBackup")) s = s.replace(/<application\b/, '<application android:allowBackup="false"');
  if (!s.includes("dataExtractionRules")) s = s.replace(/<application\b/, '<application android:dataExtractionRules="@xml/data_extraction_rules" android:fullBackupContent="false"');
  if (!s.includes('android:scheme="doctine"')) {
    const filter = `
            <!-- Doctine: email links (confirm, password reset) and Google sign-in return here -->
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="doctine" android:host="auth" android:path="/callback" />
            </intent-filter>
`;
    const i = s.indexOf('android:name=".MainActivity"'); must(i > 0, "find MainActivity in the manifest");
    const end = s.indexOf("</activity>", i); must(end > 0, "find the end of MainActivity");
    s = s.slice(0, end) + filter.trimStart().replace(/^/, "    ") + "        " + s.slice(end);
  }
  return s;
});

// 3. Resources: no-backup rules, notification icon, app name.
mkdirSync(join(SRC, "res", "xml"), { recursive: true });
writeFileSync(join(SRC, "res", "xml", "data_extraction_rules.xml"), `<?xml version="1.0" encoding="utf-8"?>
<!-- Doctine: nothing is backed up to the cloud or copied to a new device (health app). -->
<data-extraction-rules>
    <cloud-backup><exclude domain="root" /><exclude domain="sharedpref" /><exclude domain="database" /><exclude domain="file" /><exclude domain="external" /></cloud-backup>
    <device-transfer><exclude domain="root" /><exclude domain="sharedpref" /><exclude domain="database" /><exclude domain="file" /><exclude domain="external" /></device-transfer>
</data-extraction-rules>
`);
mkdirSync(join(SRC, "res", "drawable"), { recursive: true });
writeFileSync(join(SRC, "res", "drawable", "ic_stat_doctine.xml"), `<?xml version="1.0" encoding="utf-8"?>
<!-- Doctine "D" for the status bar (Android draws it in one colour). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="32" android:viewportHeight="32">
    <path android:fillColor="#00000000" android:strokeColor="#FFFFFFFF" android:strokeWidth="2.6" android:strokeLineCap="round" android:strokeLineJoin="round"
        android:pathData="M11.5,8.5v15h4.2c4.2,0 6.8,-3 6.8,-7.5s-2.6,-7.5 -6.8,-7.5z" />
    <path android:fillColor="#FFFFFFFF" android:pathData="M24,7.6m-2.3,0a2.3,2.3 0,1 1,4.6 0a2.3,2.3 0,1 1,-4.6 0" />
</vector>
`);
edit(join(SRC, "res", "values", "strings.xml"), (s) => s.replace(/<string name="app_name">[^<]*<\/string>/, '<string name="app_name">Doctine</string>')
  .replace(/<string name="title_activity_main">[^<]*<\/string>/, '<string name="title_activity_main">Doctine</string>'));

// 4. Gradle: version and release signing from the environment.
const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
const gradle = existsSync(join(A, "build.gradle")) ? join(A, "build.gradle") : join(A, "build.gradle.kts");
must(gradle.endsWith(".gradle"), "find app/build.gradle (Groovy)");
edit(gradle, (s) => {
  s = s.replace(/versionCode\s+\d+/, 'versionCode Integer.parseInt(System.getenv("DOCTINE_VERSION_CODE") ?: "1")')
       .replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
  if (!s.includes("DOCTINE_KEYSTORE")) {
    s = s.replace(/android\s*\{/, `android {
    signingConfigs {
        release {
            // Doctine: release signing only when the CI secrets are present; never stored in the repository.
            if (System.getenv("DOCTINE_KEYSTORE")) {
                storeFile file(System.getenv("DOCTINE_KEYSTORE"))
                storePassword System.getenv("DOCTINE_KEYSTORE_PASSWORD")
                keyAlias System.getenv("DOCTINE_KEY_ALIAS")
                keyPassword System.getenv("DOCTINE_KEY_PASSWORD")
            }
        }
    }`);
    s = s.replace(/buildTypes\s*\{\s*release\s*\{/, `buildTypes {
        release {
            if (System.getenv("DOCTINE_KEYSTORE")) signingConfig signingConfigs.release`);
  }
  must(s.includes("DOCTINE_KEYSTORE") && s.includes("DOCTINE_VERSION_CODE"), "set version and signing in build.gradle");
  return s;
});
console.log("customize: Doctine Android project ready (" + pkg.version + ")");
