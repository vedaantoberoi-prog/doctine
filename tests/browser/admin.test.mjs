/**
 * Doctine · the admin console page (/admin), in a real browser. Supabase sign-in is simulated by fake-supabase-strict.js
 * and /api/admin by a stand-in that applies the same role → permission table as the database
 * (private.role_perms in supabase/migrations/20261112000000_admin_console.sql). The real permission checks are tested
 * against PostgreSQL in tests/admin.test.sql; this suite checks what each role is shown, that actions ask for
 * confirmation and a reason, that refusals are shown as refusals, that nothing is shown as healthy without a check,
 * that the page never talks to the database directly, and the layout from 320px to desktop. Fictional data only.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const sql = readFileSync(new URL("../../supabase/migrations/20261112000000_admin_console.sql", import.meta.url), "utf8");

// The role table, read from the migration itself so this stand-in can't drift from the database.
const PERMS = {};
for (const m of sql.matchAll(/when '([a-z_]+)' then array\[([^\]]+)\]/g)) PERMS[m[1]] = [...m[2].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
const ROLE_BY_EMAIL = { "owner@example.test": "owner", "analyst@example.test": "analyst", "support@example.test": "support", "ops@example.test": "operations" };
const NEEDS = { overview: "dashboard.view", series: "analytics.view", funnel: "analytics.view", retention: "analytics.view", adoption: "analytics.view", users: "users.view", user: "users.view",
  user_suspend: "users.suspend", user_restore: "users.suspend", user_revoke_sessions: "users.suspend", user_reset_password: "users.reset_password", user_note: "users.notes",
  documents: "documents.view", flags: "flags.view", set_flag: "flags.manage", announcements: "dashboard.view", announcement_save: "announcements.manage", incidents: "health.view",
  incident_save: "incidents.manage", uptime: "health.view", errors: "health.view", error_update: "alerts.manage", pdf: "reports.export", alerts: "health.view", alert_update: "alerts.manage", team: "team.view", team_set: "team.manage", audit: "audit.view", security: "security.view", health: "health.view", export: "reports.export" };

const out = [];
const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
const errs = [];
const day = (i) => new Date(Date.now() - (6 - i) * 864e5).toISOString().slice(0, 10);

async function open(email, { width = 1440, hash = "" } = {}) {
  const ctx = await b.newContext({ viewport: { width, height: width < 700 ? 844 : 900 } });
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message)); pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  const log = { calls: [], direct: [] };
  await pg.route("**/*", async (r) => {
    const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", environment: "staging" }) });
    if (u.endsWith("/api/admin")) {
      const body = JSON.parse(r.request().postData() || "{}"); log.calls.push(body);
      const tok = (r.request().headers().authorization || "").replace("Bearer ", "");
      const em = await pg.evaluate((t) => { const d = JSON.parse(localStorage.getItem("__sbdb") || "{}"); return Object.values(d.users || {}).find((x) => "tok-" + x.user.id === t)?.user.email || null; }, tok).catch(() => null);
      const role = ROLE_BY_EMAIL[em];
      const send = (status, j) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(j) });
      if (!em) return send(401, { error: "unauthorized" });
      if (!role) return send(403, { error: "forbidden", request_id: "11111111-aaaa" });
      if (body.action === "me") return send(200, { role, perms: PERMS[role], email: em, mfa_enrolled: false, aal: "aal1" });
      if (!PERMS[role].includes(NEEDS[body.action])) return send(403, { error: "forbidden", request_id: "22222222-bbbb" });
      const D = {
        overview: { generated_at: new Date().toISOString(), users_total: 11, users_verified: 9, users_new: 3, users_new_prev: 2, new_today: 1, new_7d: 3, new_30d: 11, dau: 1, wau: 3, mau: 6, active: 3, active_prev: 3, returning: 2, signed_in: 4, documents_new: 5, documents_new_prev: 0, documents_total: 14, storage_bytes: 5242880, storage_files: 9, uploads_failed: 0, login_failures: 2, app_errors: 0, events_since: null },
        series: Array.from({ length: 7 }, (_, i) => ({ day: day(i), users_total: 8 + (i > 3 ? 3 : 0), users_new: i === 4 ? 3 : 0, dau: i % 2, wau: 2, mau: 5, documents: i, uploads_failed: 0, processing_failed: 0, login_failures: i === 6 ? 2 : 0, app_errors: 0 })),
        funnel: { account_created: 3, email_verified: 2, signed_in: 2, first_activity: 1, signup_failed: 0 },
        retention: [{ week: day(0), size: 3, d1: 1, d1_eligible: 3, d7: null, d7_eligible: 0, d30: null, d30_eligible: 0 }],
        adoption: { accounts: 11, features: [{ key: "record", label: "Record added", ever: 6, period: 2 }], events_since: null },
        users: { total: 1, page: 1, size: 25, rows: [{ id: "b0000000-0000-0000-0000-000000000001", email: "asha.sample@example.test", created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString(), last_sign_in_at: null, suspended: false, admin_role: null, records: 2, files: 1, last_activity: null }] },
        user: { id: "b0000000-0000-0000-0000-000000000001", email: "asha.sample@example.test", created_at: new Date().toISOString(), email_confirmed_at: null, last_sign_in_at: null, suspended: false, admin_role: null, usage: { records: 2, records_by_source: { scan: 2 }, files: 1, file_bytes: 120000, medicines: 0, doses_recorded: 0, profile_saved: true, last_activity: null, active_days_30: 1 }, uploads: { failed_30d: 0, processing_failed_30d: 0 }, notes: PERMS[role].includes("users.notes") ? [] : null, admin_actions: [] },
        user_suspend: { ok: true, sessions_ended: 1 }, user_reset_password: { ok: true },
        documents: { summary: { records: 5, records_total: 14, by_source: { scan: 3, manual: 2 }, by_category: { "Lab report": 4, Other: 1 }, files: 4, by_type: { "image/jpeg": 4 }, bytes: 400000, storage_bytes: 5242880, upload_completed: 0, upload_failed: 0, failure_reasons: {}, processing_completed: 0, processing_failed: 0, processing_ms_avg: null, events_since: null }, total: 1, rows: [{ id: "d0000000-0000", account: "1a2b3c4d", created_at: new Date().toISOString(), source: "scan", pages: 1, files: 1, bytes: 100000, types: ["image/jpeg"] }] },
        flags: [{ key: "ai_assistant", enabled: false, value: {}, updated_at: null }, { key: "document_upload", enabled: true, value: {}, updated_at: null }, { key: "maintenance", enabled: false, value: {}, updated_at: null }],
        set_flag: { ok: true },
        health: { checks: [{ name: "Database (Data API)", ok: true, status: 200, ms: 80, checked_at: new Date().toISOString() }, { name: "Sign-in service", ok: false, status: null, ms: 5000, error: "timeout", checked_at: new Date().toISOString() }], configured: { ai_provider: false, shared_rate_limits: true, scheduled_checks: "Every 15 minutes", error_tracking: "Doctine's own", alert_email: null }, environment: "staging" },
        uptime: { days: 7, since: new Date(Date.now() - 864e5).toISOString(), targets: ["app", "database", "auth", "storage"].map((t, i) => ({ target: t, checks: i === 2 ? 0 : 8, ok: i === 1 ? 6 : 8, checks_24h: i === 2 ? 0 : 8, ok_24h: i === 1 ? 6 : 8, ms_p50: 120, ms_p95: 400, last: i === 2 ? null : { at: new Date().toISOString(), ok: i !== 1, status: i === 1 ? 503 : 200, ms: 100 }, buckets: i === 2 ? [] : [{ at: new Date(Date.now() - 6 * 36e5).toISOString(), checks: 4, ok: 4, ms: 110 }, { at: new Date().toISOString(), checks: 4, ok: i === 1 ? 2 : 4, ms: 130 }] })) },
        errors: { last_24h: 3, last_7d: 5, since: new Date(Date.now() - 2 * 864e5).toISOString(), hourly: Array.from({ length: 48 }, (_, i) => ({ hour: new Date(Date.now() - (47 - i) * 36e5).toISOString(), n: i === 40 ? 3 : 0 })), groups: [{ fingerprint: "0123456789abcdef0123456789abcdef", source: "client", kind: "TypeError", message: "Cannot read properties of undefined (reading …)", location: "/index.html:#:#", release: "abc1234", first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), count: 5, status: "open", last_24h: 3 }] },
        team: [{ user_id: "x", email: "owner@example.test", role: "owner", status: "active", mfa: false, added_at: new Date().toISOString(), last_sign_in_at: null }],
        audit: { total: 1, rows: [{ at: new Date().toISOString(), actor_email: "owner@example.test", actor_role: "owner", action: "flag.set", target_type: "flag", target_id: "ai_assistant", reason: "fictional", outcome: "ok", before: { enabled: false }, after: { enabled: true }, request_id: "abc" }] },
        alerts: [], incidents: [], announcements: [], security: { denied_24h: 1, denied_recent: [], login_failures_24h: 2, login_failures_by_reason: {}, suspended_accounts: 0, admins_without_mfa: 1 },
      };
      return send(200, { data: D[body.action] ?? { ok: true }, request_id: "33333333-cccc" });
    }
    if (u.startsWith(BASE)) return r.continue();
    log.direct.push(u); return r.abort();
  });
  await pg.goto(BASE + "/admin/" + hash);
  await pg.waitForSelector("#signin, .shell, .gate", { timeout: 10000 }); await pg.waitForTimeout(300);
  if (email) {
    await pg.evaluate(async (e) => { const c = window.supabase.createClient("https://x.supabase.co", "anon"); await c.auth.signUp({ email: e, password: "fictional-pass-1", options: { data: {} } }); }, email);
    await pg.reload(); await pg.waitForSelector(".shell, .gate h1", { timeout: 10000 }); await pg.waitForTimeout(500);
  }
  return { ctx, pg, log };
}
const text = (pg, s) => pg.evaluate((q) => document.querySelector(q)?.innerText || "", s);
const navKeys = (pg) => pg.evaluate(() => [...document.querySelectorAll(".nav a")].map((a) => a.dataset.k));

// ── signed out ──
let { ctx, pg, log } = await open(null);
check("signed out: a sign-in form, with no sign-up option", !!(await pg.$("#signin")) && !/sign up|create account|register/i.test(await text(pg, "#signin")));
check("the page asks the server, not the database: only /api/config so far", log.calls.length === 0 && log.direct.every((u) => u.includes("jsdelivr")));
await ctx.close();

// ── an ordinary account ──
({ ctx, pg, log } = await open("asha.sample@example.test"));
check("an ordinary account sees 'No admin access' and no console", (await text(pg, ".gate h1")) === "No admin access" && !(await pg.$(".shell")));
await ctx.close();

// ── owner ──
({ ctx, pg, log } = await open("owner@example.test"));
check("the owner sees every section", JSON.stringify(await navKeys(pg)) === JSON.stringify(["dashboard", "analytics", "reports", "users", "documents", "health", "errors", "incidents", "alerts", "flags", "maintenance", "announcements", "team", "audit", "security", "definitions", "access"]));
check("dashboard: KPI tiles and four trend charts from the server's numbers", (await pg.$$eval(".kpi", (e) => e.length)) >= 12 && (await pg.$$eval(".chart svg", (e) => e.length)) === 4 && (await text(pg, "#view")).includes("11"));
if (process.env.SHOTS) await pg.screenshot({ path: process.env.SHOTS + "/admin-dashboard.png", fullPage: true });
check("measurements the app has not sent yet are labelled, not shown as a clean zero", (await text(pg, "#view")).includes("Not recorded yet"));
check("availability comes from recorded checks (8 of 8 in the last 24 hours)", (await text(pg, "#view")).includes("8 of 8 scheduled checks passed"));
check("the period and time zone are stated", (await text(pg, "#filters")).includes("India Standard Time"));
await pg.hover(".chart svg", { position: { x: 300, y: 80 } }); await pg.waitForTimeout(100);
check("hovering a chart shows that day's values", await pg.evaluate(() => [...document.querySelectorAll(".chart .tip")].some((t) => t.style.display === "block" && /\d/.test(t.textContent))));
await pg.click('[data-p="30d"]'); await pg.waitForTimeout(400);
const ov = log.calls.filter((c) => c.action === "overview").pop();
check("choosing 30 days asks for 30 IST calendar days", ov && Math.round((Date.parse(ov.to) - Date.parse(ov.from)) / 864e5) >= 29 && new Date(Date.parse(ov.from) + 330 * 6e4).toISOString().endsWith("T00:00:00.000Z"));
await pg.goto(BASE + "/admin/#/users"); await pg.waitForSelector("tr.click");
await pg.click("tr.click"); await pg.waitForSelector(".drawer h3");
check("account detail shows account facts and counts, and says nothing of record contents", /usage \(counts only\)/i.test(await text(pg, ".drawer")) && !(await pg.$(".drawer [data-title]")));
await pg.click('[data-act="suspend"]'); await pg.waitForSelector("dialog[open]");
await pg.click("dialog #co"); await pg.waitForTimeout(150);
check("suspending asks for confirmation and will not go ahead without a reason", (await text(pg, "dialog #cerr")) === "Please give a reason." && !log.calls.some((c) => c.action === "user_suspend"));
await pg.fill("dialog #cr", "Fictional abuse report"); await pg.click("dialog #co"); await pg.waitForTimeout(500);
check("…then sends the suspension with the reason", log.calls.some((c) => c.action === "user_suspend" && c.reason === "Fictional abuse report" && c.id === "b0000000-0000-0000-0000-000000000001"));
await pg.keyboard.press("Escape");
await pg.goto(BASE + "/admin/#/flags"); await pg.waitForSelector(".switch");
if (process.env.SHOTS) await pg.screenshot({ path: process.env.SHOTS + "/admin-flags.png", fullPage: true });
check("each switch says what enforces it; the assistant is marked sensitive and starts off", (await text(pg, "#view")).includes("Enforced by:") && (await text(pg, "#view")).includes("Sensitive") && (await pg.getAttribute('[data-k="ai_assistant"]', "aria-checked")) === "false");
await pg.click('[data-k="ai_assistant"]'); await pg.waitForSelector("dialog[open]");
await pg.click("dialog #cc"); await pg.waitForTimeout(150);
check("cancelling the confirmation changes nothing", !log.calls.some((c) => c.action === "set_flag") && (await pg.getAttribute('[data-k="ai_assistant"]', "aria-checked")) === "false");
await pg.click('[data-k="document_upload"]'); await pg.waitForSelector("dialog[open]"); await pg.fill("dialog #cr", "fictional test"); await pg.click("dialog #co"); await pg.waitForTimeout(400);
check("confirming sends the change with its reason to the server", log.calls.some((c) => c.action === "set_flag" && c.key === "document_upload" && c.enabled === false && c.reason === "fictional test"));
await pg.goto(BASE + "/admin/#/health"); await pg.waitForSelector("#hc table");
const ht = await text(pg, "#hc");
check("health: a service that did not answer is shown as not responding", ht.includes("Timed out"));
check("health: unconfigured things say so ('Not configured', 'Email not configured')", ht.includes("Not configured") && ht.includes("Email not configured"));
await pg.waitForSelector("#uh svg");
const uh = await text(pg, "#uh");
check("uptime history: per service share of passed checks, and 'No checks yet' where there are none", uh.includes("75% of 8 checks passed") && uh.includes("No checks yet"));
await pg.goto(BASE + "/admin/#/errors"); await pg.waitForSelector("[data-ef]");
check("errors: grouped with counts, first and last seen, without values", (await text(pg, "#view")).includes("TypeError") && (await text(pg, "#view")).includes("Errors, last 24 hours"));
await pg.click('[data-ef][data-s="resolved"]'); await pg.waitForTimeout(300);
check("resolving an error sends it to the server", log.calls.some((c) => c.action === "error_update" && c.status === "resolved"));
await pg.goto(BASE + "/admin/#/reports"); await pg.waitForSelector("[data-pdf]");
check("reports offer a server-built PDF", !!(await pg.$("[data-pdf]")));
await pg.goto(BASE + "/admin/#/documents"); await pg.waitForSelector(".callout");
check("documents: says it shows technical information only", (await text(pg, "#view")).includes("Titles, providers, values, extracted text and files are never shown"));
await pg.goto(BASE + "/admin/#/audit"); await pg.waitForSelector("#af");
check("audit log is read-only: no edit or delete controls", (await text(pg, "#view")).includes("cannot be edited or deleted") && !(await pg.$('#view button:text-matches("delete|edit", "i")')));
check("the console never calls the database or storage directly", log.direct.every((u) => u.includes("jsdelivr")));
await ctx.close();

// ── analyst ──
({ ctx, pg, log } = await open("analyst@example.test"));
const ak = await navKeys(pg);
check("an analyst sees dashboards, analytics and exports, but not users, switches, team or audit", ak.includes("analytics") && ak.includes("reports") && !ak.includes("users") && !ak.includes("team") && !ak.includes("audit") && !ak.includes("flags"));
await pg.goto(BASE + "/admin/#/users"); await pg.waitForTimeout(500);
check("typing the users address as an analyst does not open it", (await text(pg, "#title")) !== "Users");
const r403 = await pg.evaluate(async () => { const { data } = await window.supabase.createClient("https://x.supabase.co", "anon").auth.getSession(); const r = await fetch("/api/admin", { method: "POST", headers: { authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ action: "user_suspend", id: "b0000000-0000-0000-0000-000000000001", reason: "x" }) }); return r.status; });
check("and a hand-made suspend request from an analyst is refused (403)", r403 === 403);
await ctx.close();

// ── support ──
({ ctx, pg, log } = await open("support@example.test", { hash: "#/users" }));
await pg.waitForSelector("tr.click"); await pg.click("tr.click"); await pg.waitForSelector(".drawer h3");
check("support can send a password reset and write notes, but has no suspend button", !!(await pg.$('[data-act="reset"]')) && !!(await pg.$("#nf")) && !(await pg.$('[data-act="suspend"]')));
await ctx.close();

// ── layout ──
for (const w of [320, 390, 768, 1024, 1440]) {
  ({ ctx, pg } = await open("owner@example.test", { width: w }));
  const o = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (process.env.SHOTS && w === 390) await pg.screenshot({ path: process.env.SHOTS + "/admin-390.png", fullPage: true });
  let navOk = true;
  if (w < 900) { navOk = !(await pg.isVisible(".nav a[data-k=users]")); await pg.click("#menu"); await pg.waitForTimeout(300); navOk = navOk && (await pg.isVisible(".nav a[data-k=users]")); }
  check(`${w}px: no sideways scrolling${w < 900 ? "; the menu button opens the navigation" : ""}`, o <= 1 && navOk, "overflow " + o);
  await ctx.close();
}

const html = readFileSync(new URL("../../public/admin/index.html", import.meta.url), "utf8");
check("the page has no inline script (it runs under a stricter policy) and pins the Supabase library with an integrity hash", !/<script(?![^>]*\ssrc=)[^>]*>/.test(html) && /supabase-js@2\.45\.4[^"]*" integrity="sha384-/.test(html));
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} passed, ${failed} FAILED` : `all ${out.length} admin console checks passed`);
process.exit(failed ? 1 : 0);
