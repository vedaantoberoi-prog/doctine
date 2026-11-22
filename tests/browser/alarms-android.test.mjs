/**
 * Doctine · dose alarms in the Android app. Capacitor's LocalNotifications is simulated with a pending list, permissions
 * that can be granted or refused, Android 12+'s "Alarms & reminders" setting, and notification button presses that are
 * held until a listener is added (as Capacitor does when a press launches the app). The real plugin runs on a phone /
 * emulator; this checks what Doctine asks it to do. Supabase is simulated (fake-supabase-strict.js). Fictional people.
 */
import { chromium } from "playwright";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fake = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const WWW = mkdtempSync(join(tmpdir(), "doctine-www-"));
execFileSync(process.execPath, [new URL("../../tools/build-app-web.mjs", import.meta.url).pathname, WWW], { stdio: "pipe" });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".webmanifest": "application/manifest+json", ".mjs": "text/javascript" };
const out = []; const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };

const capacitor = `(() => {
  const L = {}, ls = (k, d) => JSON.parse(localStorage.getItem(k) || d), put = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const log = (k, v) => { const a = ls("__nat", "[]"); a.push([k, v]); put("__nat", a); };
  const sec = ls("__secure", "{}"), saveSec = () => put("__secure", sec);
  window.__fire = (ev, data) => (L[ev] || []).forEach((f) => f(data));
  const on = (ev, fn) => { (L[ev] = L[ev] || []).push(fn);
    // Capacitor keeps a button press that launched the app until the page adds its listener
    if (ev === "localNotificationActionPerformed") { const held = ls("__held", "[]"); localStorage.removeItem("__held"); held.forEach((d) => setTimeout(() => fn(d), 0)); }
    return Promise.resolve({ remove() {} }); };
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android", Plugins: {
    DoctineSecure: { async get({ key }) { return { value: key in sec ? sec[key] : null }; }, async set({ key, value }) { sec[key] = value; saveSec(); }, async remove({ key }) { delete sec[key]; saveSec(); } },
    App: { addListener: on, async getLaunchUrl() { return { url: null }; }, exitApp() {} },
    Browser: { async open() {}, async close() {} }, Share: { async share() {} }, StatusBar: { async setStyle() {} }, SplashScreen: { async hide() {} },
    Filesystem: { async stat() { return { type: "directory" }; }, async writeFile(o) { return { uri: "file:///cache/" + o.path }; }, async rmdir() {} },
    LocalNotifications: {
      async checkPermissions() { const p = localStorage.getItem("__perm") || "prompt"; return { display: p }; },
      async requestPermissions() { log("notif.request", 1); const p = localStorage.getItem("__perm") === "denied" ? "denied" : "granted"; localStorage.setItem("__perm", p); return { display: p }; },
      async createChannel(c) { log("notif.channel", c); }, async registerActionTypes(t) { log("notif.actions", t); },
      async checkExactNotificationSetting() { return { exact_alarm: localStorage.getItem("__exact") || "granted" }; },
      async changeExactNotificationSetting() { log("notif.exactSettings", 1); return { exact_alarm: "granted" }; },
      async getPending() { return { notifications: ls("__pending", "[]") }; },
      async cancel({ notifications }) { const ids = notifications.map((n) => n.id); put("__pending", ls("__pending", "[]").filter((n) => !ids.includes(n.id))); },
      async schedule({ notifications }) { const p = ls("__pending", "[]").filter((n) => !notifications.some((x) => x.id === n.id));
        notifications.forEach((n) => p.push({ id: n.id, title: n.title, body: n.body, channelId: n.channelId, actionTypeId: n.actionTypeId, extra: n.extra, at: new Date(n.schedule.at).toISOString(), idle: n.schedule.allowWhileIdle }));
        put("__pending", p); log("notif.schedule", notifications.length); },
      addListener: on } } };
})();`;
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript(capacitor); await ctx.addInitScript(fake);
const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u === "https://app.doctine.com/api/config") return r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": new URL(BASE).origin }, body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", googleSignIn: false }) });
  if (u.startsWith(BASE)) { const p = new URL(u).pathname, f = join(WWW, p === "/" ? "index.html" : decodeURIComponent(p.slice(1)));
    return existsSync(f) ? r.fulfill({ status: 200, contentType: TYPES[extname(f)] || "application/octet-stream", body: readFileSync(f) }) : r.fulfill({ status: 404, body: "" }); }
  return r.abort(); });
const W = (ms) => pg.waitForTimeout(ms);
const nat = () => pg.evaluate(() => JSON.parse(localStorage.getItem("__nat") || "[]"));
const pending = () => pg.evaluate(() => JSON.parse(localStorage.getItem("__pending") || "[]"));
const view = () => pg.textContent("#view");
const resync = async () => { await pg.evaluate(() => { _asig = ""; alarmSync(); }); await W(1200); };

await pg.goto(BASE + "/index.html"); await W(1200);
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Tara Iyer"); await pg.fill("input[name=email]", "tara.alarms@example.com"); await pg.fill("input[name=pw]", "tara-pass-1234"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(1000);
check("a fictional account opens in the Android app", await pg.evaluate(() => !!S.email && !S.sample));

// three medicines, three times a day; one says how to take it
await pg.evaluate(() => {
  const d = today();
  S.meds.push({ id: 801, name: "Fictional Metformin", dose: "1 tablet", strength: "500 mg", status: "active", start: d, end: "", freq: "daily", days: [], times: ["08:00", "14:00", "21:00"], instructions: "After food. Avoid alcohol." },
    { id: 802, name: "Fictional Vitamin D3", dose: "1 sachet", status: "active", start: d, end: "", freq: "daily", days: [], times: ["07:30", "13:30", "20:30"] },
    { id: 803, name: "Fictional Antacid", dose: "10 ml", status: "active", start: d, end: "", freq: "daily", days: [], times: ["09:15", "15:15", "22:15"] },
    { id: 804, name: "Fictional Paracetamol", dose: "1 tablet", status: "active", start: d, end: "", freq: "as_needed", days: [], times: [] });
  go("medicines"); });
await W(1500);
check("nothing is asked or scheduled before the person turns alarms on", !(await nat()).some(([k]) => k === "notif.request" || k === "notif.schedule") && (await pending()).length === 0);
check("Medicines offers alarms right where medicines are added", !!(await pg.$(".mx-alarm #alarmenable")) && (await view()).includes("Get an alarm when a dose is due"));
check("…and promises medicine names stay hidden on the lock screen", (await view()).includes("hidden on the lock screen"));

await pg.click(".mx-alarm #alarmenable"); await W(1500);
const p1 = await pending(), now = Date.now(), maxAt = Math.max(...p1.map((n) => Date.parse(n.at)));
check("turning them on asks for notification permission once", (await nat()).filter(([k]) => k === "notif.request").length === 1);
check("Android gets alarms for about 30 days, not just the iPhone-sized 60", p1.length > 200 && p1.length <= 400, `${p1.length} pending`);
check("…all in the future, none beyond 30 days", p1.every((n) => Date.parse(n.at) > now) && maxAt <= now + 31 * 864e5);
check("…each with Taken / Snooze buttons, the dose channel and allowed while the phone is idle", p1.every((n) => n.actionTypeId === "DOSE" && n.channelId === "doses" && n.idle === true && /@\d\d:\d\d@\d{4}-\d\d-\d\d$/.test(n.extra.key)));
check("…none for an 'only when needed' medicine", !p1.some((n) => n.title.includes("Paracetamol")));
check("the alarm text says how to take it (first instruction only)", p1.some((n) => n.title === "Time for Fictional Metformin" && n.body.includes("After food") && !n.body.includes("alcohol")));
const ch = (await nat()).find(([k]) => k === "notif.channel");
check("the channel is high priority and private on the lock screen", !!ch && ch[1].importance === 5 && ch[1].visibility === 0 && ch[1].vibration === true);
check("once on, the Medicines prompt goes away", !(await pg.$(".mx-alarm")));

// a dose taken in the app removes its alarm
const firstKey = p1.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0].extra.key;
await pg.evaluate((k) => { S.doses[k] = "Taken"; render(); }, firstKey); await W(1500);
check("logging a dose as taken removes that alarm", !(await pending()).some((n) => n.extra && n.extra.key === firstKey));

// test alarm: a real notification in 10 seconds that survives re-planning
await pg.evaluate(() => go("settings")); await W(300);
check("Settings has a 10-second test alarm in the phone app", (await pg.textContent("#alarmtest")).includes("10 seconds"));
await pg.click("#alarmtest"); await W(600);
const t = (await pending()).find((n) => n.id === 2147480001);
check("the test alarm is a real phone notification about 10 seconds away", !!t && Math.abs(Date.parse(t.at) - Date.now() - 10000) < 3000 && t.channelId === "doses");
check("…and the page says to lock the phone to check it rings with Doctine closed", (await view()).includes("Lock your phone"));
await resync();
check("re-planning the dose alarms doesn't cancel the test alarm", (await pending()).some((n) => n.id === 2147480001));

// Android 12+: "Alarms & reminders" refused
await pg.evaluate(() => { localStorage.setItem("__exact", "denied"); go("medicines"); }); await resync();
check("if Android refuses on-time alarms, Medicines says alarms may ring late", (await view()).includes("Alarms may ring late") && !!(await pg.$(".mx-alarm #alarmexact")));
await pg.click(".mx-alarm #alarmexact"); await W(400);
check("…with a button straight to that setting", (await nat()).some(([k]) => k === "notif.exactSettings"));
await pg.evaluate(() => localStorage.setItem("__exact", "granted")); await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await W(1500);
check("coming back with it allowed clears the warning", !(await pg.$(".mx-alarm")));

// notifications blocked in phone settings
await pg.evaluate(() => localStorage.setItem("__perm", "denied")); await resync();
check("if notifications are blocked, Medicines says alarms can't ring and how to fix it", (await view()).includes("Alarms can’t ring") && (await view()).includes("Settings → Apps → Doctine → Notifications"));
check("…and no alarms are left pending that would never show", (await pending()).filter((n) => n.id !== 2147480001).length === 0);
await pg.evaluate(() => localStorage.setItem("__perm", "granted")); await pg.click(".mx-alarm #alarmenable"); await W(1500);
check("'Check again' after allowing them re-sets the alarms", (await pending()).length > 200 && !(await pg.$(".mx-alarm")));

// pressing Taken / Snooze on a notification while Doctine is open
const keys = (await pending()).filter((n) => n.extra).map((n) => n.extra.key);
await pg.evaluate((k) => window.__fire("localNotificationActionPerformed", { actionId: "taken", notification: { extra: { key: k } } }), keys[0]); await W(1500);
check("'Taken' on a notification marks that dose taken and removes its alarm", (await pg.evaluate((k) => S.doses[k], keys[0])) === "Taken" && !(await pending()).some((n) => n.extra && n.extra.key === keys[0]));
// the notification being snoozed is for a dose today (keys[1] may already be tomorrow's late in the evening)
const snk = await pg.evaluate((k) => k.replace(/@[0-9-]+$/, "@" + today()), keys[1]);
await pg.evaluate((k) => window.__fire("localNotificationActionPerformed", { actionId: "snooze", notification: { extra: { key: k } } }), snk); await W(1500);
const sn = await pg.evaluate((k) => S.doses[k], snk), sp = (await pending()).find((n) => n.extra && n.extra.key === snk);
check("'Snooze 10 min' sets a new alarm about 10 minutes from now", /^Snoozed until \d\d:\d\d$/.test(sn || "") && !!sp && Math.abs(Date.parse(sp.at) - Date.now() - 6e5) < 90e3, sn);
{ const r = await pg.evaluate(() => { const m = { id: 9, name: "Late", times: ["23:55"], freq: "daily", start: "2026-01-01", status: "active" }, d = "2026-03-10";
    const pl = DoctineAlarms.plan([m], { ["9@23:55@" + d]: "Snoozed until 00:05" }, new Date(2026, 2, 10, 23, 57), { days: 1 }); return pl.length ? pl[0].at.toString() : ""; });
  check("a dose snoozed past midnight still rings, just after midnight the next day", /Mar 11 2026 00:05/.test(r), r); }
await pg.evaluate((k) => window.__fire("localNotificationActionPerformed", { actionId: "taken", notification: { extra: { key: "not-a-dose" } } }), null); await W(300);
check("a press with a malformed or unknown dose is ignored", (await pg.evaluate(() => Object.keys(S.doses).every((k) => /^\d+@\d\d:\d\d@\d{4}-\d\d-\d\d$/.test(k)))));
await W(2500); // let the changes reach the (simulated) database

// a press that launches the app: it arrives before the account has loaded and must not be lost
const k3 = keys[2];
await pg.evaluate((k) => localStorage.setItem("__held", JSON.stringify([{ actionId: "taken", notification: { extra: { key: k } } }])), k3);
await pg.reload(); await W(2500);
check("'Taken' that opened the app is applied once the account has loaded", (await pg.evaluate(() => !!S.email)) && (await pg.evaluate((k) => S.doses[k], k3)) === "Taken");
check("…and it's saved, so it is still taken after the next restart", await (async () => { await W(2500); await pg.reload(); await W(2500); return (await pg.evaluate((k) => S.doses[k], k3)) === "Taken"; })());
await pg.evaluate(() => localStorage.setItem("__held", JSON.stringify([{ actionId: "tap", notification: { extra: { key: Object.keys(S.doses)[0] } } }])));
await pg.reload(); await W(2500);
check("tapping the notification itself opens Medicines", (await pg.evaluate(() => S.view)) === "medicines");

// reminders page tells the truth in the app
await pg.evaluate(() => go("reminders")); await W(300);
check("the Reminders page says alarms ring with Doctine closed (not the browser-only warning)", (await view()).includes("ring even when Doctine is closed") && !(await view()).includes("only while Doctine is open in your browser"));
// sample account: nothing touches the phone's alarms
check("no JavaScript errors", errs.length === 0, errs.join(" | "));
console.log(out.filter((l) => l.startsWith("PASS")).length + "/" + out.length + " passed");
await b.close(); process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
