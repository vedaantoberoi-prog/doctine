/**
 * Doctine · the app as it runs inside the Android app: window.Capacitor and its plugins are simulated here (the real
 * native code is built and run on an emulator by .github/workflows/apps.yml). Checks the web side of the integration:
 * the server address, PKCE and the encrypted session store, email links (confirmation, reset, expired) and Google
 * sign-in through the system browser, the back button, exports through the share sheet, reminders only after the
 * person turns them on (and private on the lock screen), external links in the system browser, the offline notice.
 * Supabase is simulated (fake-supabase-strict.js). Fictional people only.
 */
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fake = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
// Serve exactly what the apps package (tools/build-app-web.mjs), with its own <meta> security policy and no website headers.
const WWW = mkdtempSync(join(tmpdir(), "doctine-www-"));
execFileSync(process.execPath, [new URL("../../tools/build-app-web.mjs", import.meta.url).pathname, WWW], { stdio: "pipe" });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".webmanifest": "application/manifest+json", ".mjs": "text/javascript" };
const out = []; const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
// Capacitor as the Android app provides it (before any page script runs)
const capacitor = `(() => {
  const L = {}, log = (k, v) => { const a = JSON.parse(localStorage.getItem("__nat") || "[]"); a.push([k, v]); localStorage.setItem("__nat", JSON.stringify(a)); };
  const sec = JSON.parse(localStorage.getItem("__secure") || "{}"), saveSec = () => localStorage.setItem("__secure", JSON.stringify(sec));
  window.__fire = (ev, data) => (L[ev] || []).forEach((f) => f(data));
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android", Plugins: {
    DoctineSecure: { async get({ key }) { log("secure.get", key); return { value: key in sec ? sec[key] : null }; }, async set({ key, value }) { log("secure.set", key); sec[key] = value; saveSec(); }, async remove({ key }) { log("secure.remove", key); delete sec[key]; saveSec(); } },
    App: { addListener(ev, fn) { (L[ev] = L[ev] || []).push(fn); return Promise.resolve({ remove() {} }); }, async getLaunchUrl() { return { url: sessionStorage.getItem("__launch") || null }; }, exitApp() { log("exitApp", 1); } },
    Browser: { async open({ url }) { log("browser.open", url); }, async close() { log("browser.close", 1); } },
    Filesystem: { async writeFile(o) { log("fs.write", o.path + "|" + o.directory); return { uri: "file:///cache/" + o.path }; }, async rmdir(o) { log("fs.rmdir", o.path); } },
    Share: { async share(o) { log("share", o.url); } }, StatusBar: { async setStyle() {} }, SplashScreen: { async hide() { log("splash.hide", 1); } },
    LocalNotifications: { async checkPermissions() { return { display: "prompt" }; }, async requestPermissions() { log("notif.request", 1); return { display: "granted" }; },
      async createChannel(c) { log("notif.channel", c.visibility); }, async registerActionTypes() {}, async checkExactNotificationSetting() { return { exact_alarm: "granted" }; },
      async getPending() { return { notifications: [] }; }, async cancel() {}, async schedule(o) { log("notif.schedule", o.notifications.length); }, addListener() { return Promise.resolve({ remove() {} }); } } } };
})();`;
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript(capacitor); await ctx.addInitScript(fake);
const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(e.message)); pg.on("dialog", (d) => d.accept());
const configHits = [];
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u === "https://app.doctine.com/api/config") { configHits.push(u); return r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": new URL(BASE).origin }, body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", googleSignIn: true }) }); }
  if (u.startsWith(BASE)) { const p = new URL(u).pathname, f = join(WWW, p === "/" ? "index.html" : decodeURIComponent(p.slice(1)));
    return existsSync(f) ? r.fulfill({ status: 200, contentType: TYPES[extname(f)] || "application/octet-stream", body: readFileSync(f) }) : r.fulfill({ status: 404, body: "" }); }
  return r.abort(); });
const W = (ms) => pg.waitForTimeout(ms);
const nat = () => pg.evaluate(() => JSON.parse(localStorage.getItem("__nat") || "[]"));
const h1 = () => pg.textContent(".au-card h1").catch(() => "");
const appOpen = () => pg.evaluate(() => !document.getElementById("app").classList.contains("hidden") && !!S.email);
const link = async (url) => { await pg.evaluate((u) => window.__fire("appUrlOpen", { url: u }), url); await W(900); };

await pg.goto(BASE + "/index.html"); await W(1200);
check("inside the app, the server is https://app.doctine.com (the page's own origin is the app's)", configHits.length > 0 && (await pg.evaluate(() => API)) === "https://app.doctine.com");
const o = await pg.evaluate(() => window.__sbOpts);
check("sign-in uses PKCE, doesn't read tokens from the address, and keeps the session in the encrypted store", o.flowType === "pkce" && o.detectSessionInUrl === false && o.customStorage === true);
check("the splash screen is hidden once the page has loaded", (await nat()).some(([k]) => k === "splash.hide"));

// register: the confirmation link must come back into the app
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Ira Sen"); await pg.fill("input[name=email]", "ira.native@example.com"); await pg.fill("input[name=pw]", "ira-pass-1234"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(800);
check("after creating an account, the session goes to the encrypted store (not plain storage)", (await nat()).some(([k, v]) => k === "secure.set" && /^sb-.+-auth-token$/.test(v)) && !(await pg.evaluate(() => Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k)))));
check("…and the account opens", await appOpen());
// back button: from a sub-screen to Overview, then out of the app
await pg.evaluate(() => go("medicines")); await W(200);
await pg.evaluate(() => window.__fire("backButton")); await W(200);
check("Android back: from Medicines to Overview", (await pg.evaluate(() => S.view)) === "home");
await pg.evaluate(() => window.__fire("backButton")); await W(200);
check("Android back on Overview leaves the app", (await nat()).some(([k]) => k === "exitApp"));
// alarms: nothing scheduled or asked until the person turns them on
await pg.evaluate(() => { S.meds.push({ id: 77, name: "Fictional tablet", dose: "1 tablet", status: "active", start: "2026-01-01", end: "", freq: "daily", days: [], times: ["23:59"] }); render(); }); await W(1200);
check("reminders: no permission prompt and nothing scheduled before the person turns them on", !(await nat()).some(([k]) => k === "notif.request" || k === "notif.schedule"));
await pg.evaluate(() => go("settings")); await W(300);
check("Settings offers 'Turn on alarms' and says reminders are not medical advice", !!(await pg.$("#alarmenable")) && (await pg.textContent("#view")).includes("not medical advice"));
await pg.click("#alarmenable"); await W(800);
const nl = await nat();
check("after turning them on: permission asked, alarms scheduled, and the channel hides medicine names on the lock screen", nl.some(([k]) => k === "notif.request") && nl.some(([k, v]) => k === "notif.schedule" && v >= 1) && nl.some(([k, v]) => k === "notif.channel" && v === 0));
// export through the share sheet
await pg.evaluate(() => exportZip()); await W(1500);
check("export goes to the share sheet from the app's private cache", (await nat()).some(([k, v]) => k === "fs.write" && /^exports\/doctine-export-.*\.zip\|CACHE$/.test(v)) && (await nat()).some(([k]) => k === "share"));
// external links leave the app
await pg.evaluate(() => { const a = document.createElement("a"); a.href = "https://www.doctine.com/privacy"; a.id = "ext"; a.textContent = "x"; document.body.appendChild(a); }); await pg.click("#ext"); await W(200);
check("links to other sites open in the system browser", (await nat()).some(([k, v]) => k === "browser.open" && v === "https://www.doctine.com/privacy") && (await pg.evaluate(() => location.href)).startsWith(BASE));
// offline notice
await ctx.setOffline(true); await W(300);
check("offline: a notice says changes are saved when back online", (await pg.textContent("#doctine-offline").catch(() => "")).includes("offline"));
await ctx.setOffline(false); await W(300);
check("…and it goes when the connection returns", !(await pg.$("#doctine-offline")));

// sign out, then a password reset requested in the app comes back as doctine://
await pg.evaluate(() => document.getElementById("out").click()); await W(500);
check("signing out removes the session from the encrypted store and clears temporary exports", (await nat()).some(([k]) => k === "secure.remove") && (await nat()).some(([k, v]) => k === "fs.rmdir" && v === "exports"));
await pg.click("[data-auth=forgot]"); await W(150); await pg.fill("#ff [name=email]", "ira.native@example.com"); await pg.click("#ff button.pri"); await W(400);
check("a reset requested in the app returns to the app (doctine://auth/callback?next=reset)", (await pg.evaluate(() => JSON.parse(localStorage.getItem("__resetCalls")).pop().redirectTo)) === "doctine://auth/callback?next=reset");
await pg.evaluate(() => { const C = JSON.parse(localStorage.getItem("__sbcodes") || "{}"); C["code-reset-1"] = { email: "ira.native@example.com", recovery: true }; localStorage.setItem("__sbcodes", JSON.stringify(C)); });
await link("doctine://auth/callback?next=reset&code=code-reset-1");
check("opening the reset link: 'Create a new password', and the account does not open", (await h1()) === "Create a new password" && !(await appOpen()));
check("…and the in-app browser is closed", (await nat()).some(([k]) => k === "browser.close"));
await pg.fill("#npf [name=pw]", "ira-new-pass-5678"); await pg.fill("#npf [name=pw2]", "ira-new-pass-5678"); await pg.click("#npf button.pri"); await W(700);
check("the new password saves", (await h1()) === "Password updated" && (await pg.evaluate(() => window.__sbdb.users["ira.native@example.com"].password)) === "ira-new-pass-5678");
await link("doctine://auth/callback?next=reset&code=code-reset-1");
check("the same link again: refused, 'That link didn’t work'", (await h1()) === "That link didn’t work" && !(await appOpen()));
await link("doctine://auth/callback?next=reset&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
check("an expired reset link: 'This link has expired'", (await h1()) === "This link has expired");
await link("https://evil.example/auth/callback?code=x");
check("links that aren't doctine://auth/callback are ignored", (await h1()) === "This link has expired");
// Google sign-in: system browser, then back with a code
await pg.click(".au-card [data-auth=login]"); await W(200);
if (await pg.$("#gack")) { await pg.check("#gack"); await pg.click("#google"); await W(400); }
const oc = (await pg.evaluate(() => JSON.parse(localStorage.getItem("__oauthCalls") || "[]"))).pop();
check("Google sign-in opens the system browser (Google refuses embedded web views) and returns to doctine://", !!oc && oc.skip && oc.redirectTo === "doctine://auth/callback" && (await nat()).some(([k, v]) => k === "browser.open" && v.startsWith("https://x.supabase.co/auth/v1/authorize")));
await pg.evaluate(() => { const C = JSON.parse(localStorage.getItem("__sbcodes") || "{}"); C["code-signin-1"] = { email: "ira.native@example.com" }; localStorage.setItem("__sbcodes", JSON.stringify(C)); });
await link("doctine://auth/callback?code=code-signin-1");
check("…and the returning sign-in link opens the account", await appOpen());

// a reset link that launches the app wins over the saved session
await pg.evaluate(() => { const C = JSON.parse(localStorage.getItem("__sbcodes") || "{}"); C["code-reset-2"] = { email: "ira.native@example.com", recovery: true }; localStorage.setItem("__sbcodes", JSON.stringify(C)); sessionStorage.setItem("__launch", "doctine://auth/callback?next=reset&code=code-reset-2"); });
await pg.reload(); await W(1500);
check("a reset link that starts the app opens 'Create a new password', not the saved session", (await h1()) === "Create a new password" && !(await appOpen()));
const ov = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check("390 px: no sideways scrolling", ov <= 1, "overflow " + ov);
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} passed, ${failed} FAILED` : `${out.length}/${out.length} passed`);
process.exit(failed ? 1 : 0);
