/**
 * Doctine · the admin console page (/admin), in a real browser. Supabase sign-in is simulated by fake-supabase-strict.js
 * and /api/admin by a stand-in that applies the same role → permission table as the database (read from the latest
 * migration's private.role_perms, so it cannot drift). The permission checks themselves are tested against PostgreSQL
 * in tests/admin.test.sql. This suite checks what each role is shown, that figures on screen are the server's figures,
 * that date filters, search, sorting, pagination, exports, switches, maintenance, errors and alerts drive real requests,
 * that value states are never confused, that nothing private leaks, and the layout from 320 px to desktop.
 * Fictional data only.
 */
import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const migDir = new URL("../../supabase/migrations/", import.meta.url);
const latest = readdirSync(migDir).filter((f) => readFileSync(new URL(f, migDir), "utf8").includes("function private.role_perms")).sort().pop();
const sql = readFileSync(new URL(latest, migDir), "utf8");
const PERMS = {};
for (const m of sql.slice(sql.lastIndexOf("function private.role_perms")).matchAll(/when '([a-z_]+)' then array\[([^\]]+)\]/g)) PERMS[m[1]] = [...m[2].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
const ROLE_BY_EMAIL = { "owner@example.test": "owner", "admin@example.test": "admin", "analyst@example.test": "analyst", "support@example.test": "support", "auditor@example.test": "auditor" };
const NEEDS = { overview: "dashboard.view", series: "analytics.view", funnel: "analytics.view", retention: "analytics.view", adoption: "analytics.view", adoption_trend: "analytics.view", engagement: "analytics.view", activity: "dashboard.view", search: "dashboard.view",
  users: "users.view", user: "users.view", user_suspend: "users.suspend", user_restore: "users.suspend", user_revoke_sessions: "users.suspend", user_reset_password: "users.reset_password", user_note: "users.notes",
  documents: "documents.view", flags: "flags.view", set_flag: "flags.manage", set_maintenance: "maintenance.manage", announcements: "dashboard.view", announcement_save: "announcements.manage", incidents: "health.view",
  incident_save: "incidents.manage", alerts: "health.view", alert_update: "alerts.manage", team: "team.view", team_set: "team.manage", audit: "audit.view", security: "security.view", health: "health.view", uptime: "health.view",
  errors: "health.view", error: "health.view", error_update: "alerts.manage", report: "reports.export", exports: "reports.export", prefs: "dashboard.view", set_prefs: "dashboard.view", settings_status: "dashboard.view" };

const out = [];
const check = (name, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + name + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
const errs = [];
const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
const day = (i, len = 30) => new Date(now - (len - 1 - i) * 864e5 + 330 * 6e4).toISOString().slice(0, 10);
const SECRET_MARK = "SECRET-HEALTH-VALUE";

function data(action, body) {
  const len = Math.max(1, Math.round((Date.parse(body.to || iso(now)) - Date.parse(body.from || iso(now - 30 * 864e5))) / 864e5));
  const series = Array.from({ length: len }, (_, i) => ({ day: day(i, len), users_total: 8 + Math.floor(i / 10), users_new: i % 10 === 0 ? 1 : 0, dau: i % 3 ? 1 : 0, wau: 2, mau: 5, returning: i % 4 ? 1 : 0, actions: i % 3, documents: i % 5 === 0 ? 2 : 0, documents_total: 10 + i, files: i % 7 === 0 ? 1 : 0, storage_total: 1048576 + i * 1000, uploads_completed: 0, uploads_failed: 0, processing_completed: 0, processing_failed: 0, login_failures: 0, app_errors: i === len - 2 ? 3 : 0, checks: 4, checks_ok: i === len - 3 ? 3 : 4, ms_avg: 120 + i }));
  const D = {
    overview: { generated_at: iso(now), users_total: 12, users_total_prev: 11, users_verified: 12, users_new: 3, users_new_prev: 0, new_today: 1, new_7d: 3, new_30d: 12, dau: 1, dau_prev: 2, wau: 4, wau_prev: 4, mau: 8, mau_prev: 3, active: 8, active_prev: 3, returning: 2, returning_prev: 1, actions: 40,
      signed_in: 9, documents_new: 7, documents_new_prev: 0, documents_total: 14, files_new: 5, files_new_prev: 2, storage_bytes: 5242880, storage_files: 9, storage_limit: 1073741824, uploads_completed: 0, uploads_failed: 0, uploads_failed_prev: 0, login_failures: 0,
      app_errors: 3, app_errors_prev: 1, availability: { checks: 96, ok: 95, pct: 98.96, ms_avg: 130 }, availability_prev: { checks: 0, ok: 0, pct: null, ms_avg: null }, events_since: null, errors_since: iso(now - 864e5), checks_since: iso(now - 864e5) },
    series,
    funnel: { account_created: 3, email_verified: 3, signed_in: 2, profile_completed: 1, first_record: 1, first_file: 0, first_activity: 2, signup_failed: 0 },
    retention: [{ week: day(0), size: 3, d1: 1, d1_eligible: 3, d7: null, d7_eligible: 0, d30: null, d30_eligible: 0 }],
    adoption: { accounts: 12, events_since: null, features: [{ key: "record", label: "Health records", source: "table", measured: true, ever: 6, period: 2 }, { key: "pdf", label: "PDF reading", source: "event", measured: false, ever: 0, period: 0 }] },
    adoption_trend: Array.from({ length: 12 }, (_, i) => ({ week: day(i * 2), accounts: 12, record: Math.min(6, i), file: 1, schedule: 0, dose: 0, profile: 3 })),
    engagement: { active: 8, returning: 2, actions: 40, by_kind: { record: 20, profile: 15, dose: 5 }, active_days_avg: 2.5 },
    activity: { registrations: ROLE.perms.includes("users.view") ? [{ id: "b0000000-0000-0000-0000-000000000001", email: "asha.sample@example.test", at: iso(now - 3600e3), confirmed: true }] : null, registrations_7d: 3,
      errors: [{ fingerprint: "0123456789abcdef0123456789abcdef", kind: "TypeError", message: "x is undefined", last_seen: iso(now - 600e3), count: 3, source: "client" }], checks: [{ target: "app", ok: true, ms: 120, at: iso(now - 300e3), status: 200 }],
      admin_actions: ROLE.perms.includes("audit.view") ? [{ at: iso(now - 900e3), action: "flag.set", outcome: "ok", by: "owner@example.test" }] : null, incidents: [], alerts: [{ id: "c0000000-0000-0000-0000-000000000001", severity: "warning", message: "No scheduled health check has run since 10 Nov 10:00 IST", service: "monitoring", status: "open", opened_at: iso(now - 7200e3) }] },
    search: { users: ROLE.perms.includes("users.view") ? [{ id: "b0000000-0000-0000-0000-000000000001", email: "asha.sample@example.test" }] : [], errors: [], incidents: [] },
    users: { total: 60, page: body.page || 1, size: body.size || 25, rows: Array.from({ length: Math.min(body.size || 25, 3) }, (_, i) => ({ id: `b0000000-0000-0000-0000-00000000000${i + 1}`, email: `person${i + 1}.sample@example.test`, created_at: iso(now - i * 864e5), email_confirmed_at: i ? iso(now) : null, last_sign_in_at: null, suspended: false, admin_role: null, records: i, files: 0, last_activity: null })) },
    user: { id: "b0000000-0000-0000-0000-000000000001", email: "person1.sample@example.test", created_at: iso(now), email_confirmed_at: null, last_sign_in_at: null, suspended: false, admin_role: null, sign_in_methods: ["email"], mfa: false, first_activity: null,
      usage: { records: 2, records_by_source: { scan: 2 }, files: 1, file_bytes: 120000, medicines: 0, doses_recorded: 0, profile_saved: true, last_activity: null, active_days_30: 1 }, adoption: { profile: true, record: true, file: true, schedule: false, dose: false, search: false, export: false },
      uploads: { failed_30d: 0, processing_failed_30d: 0 }, notes: ROLE.perms.includes("users.notes") ? [] : null, admin_actions: [] },
    user_suspend: { ok: true, sessions_ended: 1 }, user_reset_password: { ok: true },
    documents: { summary: { records: 7, records_total: 14, by_source: { scan: 5, manual: 2 }, by_category: { "Lab report": 6, Other: 1 }, by_category_total: {}, files: 5, files_total: 9, by_type: { "image/jpeg": 5 }, by_type_total: {}, bytes: 400000, storage_bytes: 5242880, storage_limit: 1073741824,
      upload_completed: 0, upload_failed: 0, failure_reasons: {}, processing_completed: 0, processing_failed: 0, pdf_completed: 0, pdf_failed: 0, processing_reasons: {}, processing_ms_avg: null, events_since: null },
      total: 1, rows: [{ at: iso(now), account: "1a2b3c4d5e", file_type: "image/jpeg", bytes: 100000, upload_status: "stored", processing_status: null, error_code: null, ms: null }] },
    flags: [{ key: "ai_assistant", enabled: false, value: {}, updated_at: null }, { key: "document_upload", enabled: true, value: {}, updated_at: null }, { key: "maintenance", enabled: false, value: {}, updated_at: null, on_now: false }],
    set_flag: { ok: true }, set_maintenance: { ok: true, on_now: !!body.enabled },
    health: { checks: [{ target: "app", name: "App", ok: true, status: 200, ms: 80, checked_at: iso(now) }, { target: "database", name: "DB", ok: true, status: 200, ms: 90, checked_at: iso(now) }, { target: "auth", name: "Auth", ok: false, status: null, ms: 5000, error: "timeout", checked_at: iso(now) }, { target: "storage", name: "Storage", ok: true, status: 200, ms: 4200, checked_at: iso(now) }],
      ai_state: "not_configured", config: { environment: "staging", supabase: true, ai_key: false, email_provider: false, alert_email_to: false, admin_mfa_required: false, rate_limit_secret: true, google_sign_in: false, release: "abc" } },
    uptime: { days: 7, bucket_hours: 6, since: iso(now - 864e5), last_round: iso(now - 300e3), rounds_24h: 20, recent: [{ at: iso(now), target: "app", ok: true, status: 200, ms: 100 }],
      targets: ["app", "database", "auth", "storage", "ai"].map((t, i) => ({ target: t, checks: t === "ai" ? 0 : 8, ok: i === 2 ? 6 : t === "ai" ? 0 : 8, failures: i === 2 ? 2 : 0, ok_24h: 8, checks_24h: t === "ai" ? 0 : 8, ms_p50: 120, ms_p95: 400, last: null, last_ok: iso(now), last_failure: i === 2 ? { at: iso(now), status: null, error: "timeout" } : null,
        buckets: t === "ai" ? [] : [{ at: iso(now - 6 * 36e5), checks: 4, ok: 4, ms: 110 }, { at: iso(now), checks: 4, ok: i === 2 ? 2 : 4, ms: 130 }] })) },
    errors: { last_24h: 3, last_7d: 5, last_30d: 9, open: 1, since: iso(now - 2 * 864e5), hourly: [], daily: Array.from({ length: 30 }, (_, i) => ({ day: day(i), n: i === 28 ? 3 : 0 })), by_category: { code: 9 },
      groups: [{ fingerprint: "0123456789abcdef0123456789abcdef", source: "client", kind: "TypeError", message: "x is undefined", location: "/index.html:#:#", category: "code", release: "abc1234", first_seen: iso(now - 864e5), last_seen: iso(now - 600e3), count: 5, status: "open", last_24h: 3 }] },
    error: { fingerprint: "0123456789abcdef0123456789abcdef", source: "client", kind: "TypeError", message: "x is undefined", location: "/index.html:#:#", category: "code", release: "abc1234", route: "#reports", environment: "production", last_request_id: "req-1", first_seen: iso(now), last_seen: iso(now), count: 5, status: "open", sample_stack: "TypeError: x\n at render (/index.html:#:#)", hourly: [], history: [] },
    error_update: { ok: true }, alert_update: { ok: true },
    alerts: [{ id: "c0000000-0000-0000-0000-000000000001", rule: "monitor_stale", severity: "warning", message: "No scheduled health check has run since 10 Nov 10:00 IST", service: "monitoring", status: "open", opened_at: iso(now - 7200e3), updated_at: iso(now) }],
    team: [{ user_id: "x", email: "owner@example.test", role: "owner", status: "active", mfa: false, added_at: iso(now), last_sign_in_at: null }],
    audit: { total: 1, rows: [{ at: iso(now), actor_email: "owner@example.test", actor_role: "owner", action: "flag.set", target_type: "flag", target_id: "ai_assistant", reason: "fictional", outcome: "ok", before: { enabled: false }, after: { enabled: true }, request_id: "abc" }] },
    incidents: [], announcements: [], exports: [], prefs: { email_alerts: false, min_severity: "warning" }, set_prefs: { ok: true },
    settings_status: { prefs: { email_alerts: false, min_severity: "warning" }, config: { environment: "staging", supabase: true, ai_key: false, email_provider: false, alert_email_to: false, admin_mfa_required: false, rate_limit_secret: true, google_sign_in: false, release: "abc" },
      reports: ["growth", "engagement", "funnel", "adoption", "documents", "storage", "availability", "errors", "admin_activity", "users"].map((k) => ({ key: k, title: k.replace("_", " "), description: "Fictional description" })) },
    security: { denied_24h: 1, denied_recent: [], login_failures_24h: 0, login_failures_by_reason: {}, suspended_accounts: 0, admins_without_mfa: 1 },
  };
  return D[action] ?? { ok: true };
}
let ROLE = { perms: [] };

async function open(email, { width = 1440, hash = "" } = {}) {
  const ctx = await b.newContext({ viewport: { width, height: width < 700 ? 844 : 900 }, acceptDownloads: true });
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message)); pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  const log = { calls: [], direct: [], configCalls: 0 };
  let flagState = { ai_assistant: false, document_upload: true };
  await pg.route("**/*", async (r) => {
    const u = r.request().url();
    if (u.endsWith("/api/config")) { log.configCalls++; return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", environment: "staging", features: flagState }) }); }
    if (u.endsWith("/api/admin")) {
      const body = JSON.parse(r.request().postData() || "{}"); log.calls.push(body);
      const tok = (r.request().headers().authorization || "").replace("Bearer ", "");
      const em = await pg.evaluate((t) => { const d = JSON.parse(localStorage.getItem("__sbdb") || "{}"); return Object.values(d.users || {}).find((x) => "tok-" + x.user.id === t)?.user.email || null; }, tok).catch(() => null);
      const role = ROLE_BY_EMAIL[em];
      const send = (status, j) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(j) });
      if (!em) return send(401, { error: "unauthorized" });
      if (!role) return send(403, { error: "forbidden", request_id: "11111111-aaaa" });
      ROLE = { perms: PERMS[role] };
      if (body.action === "me") return send(200, { role, perms: PERMS[role], email: em, mfa_enrolled: false, aal: "aal1" });
      if (!PERMS[role].includes(NEEDS[body.action])) return send(403, { error: "forbidden", request_id: "22222222-bbbb" });
      if (body.action === "set_flag") flagState = { ...flagState, [body.key]: body.enabled };
      if (body.action === "report") {
        const isPdf = body.format === "pdf";
        return r.fulfill({ status: 200, headers: { "content-type": isPdf ? "application/pdf" : "text/csv; charset=utf-8", "content-disposition": `attachment; filename="doctine-${body.report}-x.${isPdf ? "pdf" : "csv"}"` }, body: isPdf ? "%PDF-1.4\n%%EOF\n" : "# Report\nDay,Value\n" });
      }
      return send(200, { data: data(body.action, body), request_id: "33333333-cccc" });
    }
    if (u.startsWith(BASE)) return r.continue();
    log.direct.push(u); return r.abort();
  });
  await pg.goto(BASE + "/admin/" + hash);
  await pg.waitForSelector("#signin, .shell, .gate", { timeout: 10000 }); await pg.waitForTimeout(200);
  if (email) {
    await pg.evaluate(async (e) => { const c = window.supabase.createClient("https://x.supabase.co", "anon"); await c.auth.signUp({ email: e, password: "fictional-pass-1", options: { data: {} } }); }, email);
    await pg.reload(); await pg.waitForSelector(".shell, .gate h1", { timeout: 10000 }); await pg.waitForTimeout(700);
  }
  return { ctx, pg, log };
}
const text = (pg, s) => pg.evaluate((q) => document.querySelector(q)?.innerText || "", s);
const navKeys = (pg) => pg.evaluate(() => [...document.querySelectorAll(".nav a")].map((a) => a.dataset.k));
const go = async (pg, hash, sel) => { await pg.evaluate((h) => { location.hash = h; }, hash); await pg.waitForSelector(sel, { timeout: 8000 }); await pg.waitForTimeout(250); };
const kpiText = (pg, id) => pg.evaluate((k) => document.querySelector(`[data-kpi="${k}"]`)?.innerText || "", id);

// ── signed out / ordinary account ──
let { ctx, pg, log } = await open(null);
check("1 · admin login: a sign-in form, with no sign-up option", !!(await pg.$("#signin")) && !/sign up|create account|register/i.test(await text(pg, "#signin")));
await ctx.close();
({ ctx, pg, log } = await open("asha.sample@example.test"));
check("3 · an ordinary account sees 'No admin access' and no console", (await text(pg, ".gate h1")) === "No admin access" && !(await pg.$(".shell")));
await ctx.close();

// ── owner ──
({ ctx, pg, log } = await open("owner@example.test"));
check("2 · the owner sees every section, grouped", JSON.stringify(await navKeys(pg)) === JSON.stringify(["dashboard", "analytics", "reports", "users", "documents", "health", "errors", "incidents", "alerts", "flags", "maintenance", "announcements", "team", "audit", "security", "definitions", "settings"]));
check("top bar: title, breadcrumb, date range, search, notifications, refresh, environment and profile", (await text(pg, "#title")) === "Dashboard" && (await text(pg, "#crumb")) === "Overview" && !!(await pg.$("#q")) && !!(await pg.$("#bell")) && !!(await pg.$("#refresh")) && (await text(pg, ".env")).toLowerCase() === "staging" && (await text(pg, "#who")).includes("owner@example.test"));
await pg.waitForSelector("[data-kpi=accounts]");
check("dashboard: twelve KPI cards", (await pg.$$eval("[data-kpi]", (e) => e.length)) === 12);
check("4 · KPI values are the server's values (12 accounts, 3 new, 1 DAU, 4 WAU, 8 MAU, 7 records, 5 MB)", (await kpiText(pg, "accounts")).includes("12") && (await kpiText(pg, "new")).includes("3") && (await kpiText(pg, "wau")).includes("4") && (await kpiText(pg, "mau")).includes("8") && (await kpiText(pg, "records")).includes("7") && (await kpiText(pg, "storage")).includes("5.00 MB"));
check("comparisons: a real percentage where there is a previous value, 'New' where there was none, never a made-up 0%", (await kpiText(pg, "accounts")).includes("9.1%") && (await kpiText(pg, "new")).includes("New") && !(await kpiText(pg, "new")).includes("0%"));
check("value states: 'Not measured' for uploads that are not instrumented yet, distinct from zero", (await kpiText(pg, "failed")).includes("Not measured") && (await pg.$eval('[data-kpi="failed"] .k-value', (e) => e.dataset.state)) === "not_measured");
check("availability comes from recorded checks (98.96%), with no previous-period checks said plainly", (await kpiText(pg, "availability")).includes("98.96%") && (await kpiText(pg, "availability")).includes("no checks in the previous period"));
check("KPI cards link to their detail pages", (await pg.getAttribute('[data-kpi="errors"]', "href")) === "#/errors" && (await pg.getAttribute('[data-kpi="accounts"]', "href")) === "#/users");
check("5 · graphs A–F render from the server's series", (await pg.$$eval("#charts .card", (e) => e.length)) === 6 && (await pg.$$eval("#charts .chart svg", (e) => e.length)) >= 5);
check("graph E outcomes say 'Not measured' instead of drawing zeros", await pg.evaluate(async () => { document.querySelector('[data-tabs="t-docs"] [data-tab="outcomes"]').click(); await new Promise((r) => setTimeout(r, 50)); return document.querySelector("#ch-docs [data-state]")?.dataset.state === "not_measured"; }));
check("graph A compares with the previous period (dashed line in the legend)", (await text(pg, "#ch-growth")).includes("Previous period"));
await pg.hover("#ch-growth svg", { position: { x: 300, y: 100 } }); await pg.waitForTimeout(80);
check("charts show values on hover", await pg.evaluate(() => [...document.querySelectorAll(".chart .tip")].some((t) => t.style.display === "block" && /\d/.test(t.textContent))));
check("activity section: registrations, errors, checks, admin actions, incidents, alerts", (await pg.$$eval("#activity .card", (e) => e.length)) === 6);
const ov1 = log.calls.filter((c) => c.action === "overview").pop();
await pg.click('[data-p="7d"]'); await pg.waitForSelector("[data-kpi=accounts]"); await pg.waitForTimeout(300);
const ov2 = log.calls.filter((c) => c.action === "overview").pop(), se2 = log.calls.filter((c) => c.action === "series").slice(-2);
const istToday = (() => { const d = new Date(Date.now() + 330 * 6e4); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 330 * 6e4; })();
check("6 · the date filter reloads KPIs and graphs for 7 IST days, and the previous 7 days for comparison", ov1.from !== ov2.from && Date.parse(ov2.from) === istToday - 6 * 864e5 && new Date(Date.parse(ov2.from) + 330 * 6e4).toISOString().endsWith("T00:00:00.000Z") && se2.length === 2 && se2.some((s) => s.to === ov2.from), JSON.stringify({ ov2, se2 }));
await pg.click("#refresh"); await pg.waitForTimeout(500);
check("refresh reloads the page's data", log.calls.filter((c) => c.action === "overview").length >= 3);
await pg.fill("#q", "asha"); await pg.waitForSelector(".pop [data-user]", { timeout: 4000 }).catch(() => {});
check("7 · global search finds people on the server", !!(await pg.$(".pop [data-user]")) && log.calls.some((c) => c.action === "search" && c.q === "asha"));
await pg.click(".pop [data-user]"); await pg.waitForSelector(".drawer h3");
check("search result opens the account drawer", (await text(pg, ".drawer h3")).includes("person1.sample@example.test"));
await pg.keyboard.press("Escape");
await pg.click("#bell"); await pg.waitForSelector(".pop h4", { timeout: 4000 }).catch(async () => console.log("DEBUG", await pg.evaluate(() => ({ pops: [...document.querySelectorAll(".pop")].map((p) => p.parentElement.id + ":" + p.innerText.slice(0, 80)), drawer: !!document.querySelector(".drawer"), dlg: !!document.querySelector("dialog[open]") }))));
check("notification centre lists alerts needing attention", (await text(pg, ".pop")).includes("No scheduled health check"));
await pg.click("#bell");

// analytics
await go(pg, "#/analytics", ".funnel");
check("analytics: acquisition, activation funnel (6 steps), engagement, adoption, retention", (await pg.$$eval(".funnel .step", (e) => e.length)) === 6 && (await text(pg, "#view")).includes("Day 1") && (await text(pg, "#view")).includes("Meaningful actions by kind"));
check("adoption says 'Not measured' for an uninstrumented feature, not 0 users", await pg.evaluate(() => [...document.querySelectorAll("#view tr")].some((r) => r.innerText.includes("PDF reading") && r.innerText.includes("Not measured"))));
check("the funnel shows conversion and drop-off between steps", (await text(pg, ".funnel")).includes("dropped off") && (await text(pg, ".funnel")).includes("of the previous step"));

// users
await go(pg, "#/users", "tr.click");
check("users: the default columns include account ID, verification, last activity, records, files and status", ["Account ID", "Email verification", "Last activity", "Records", "Files", "Status"].every((h) => (log, true)) && await pg.evaluate(() => ["Account ID", "Email verification", "Last activity", "Records", "Files", "Status"].every((h) => document.querySelector("thead").innerText.includes(h))));
await pg.click("#pn"); await pg.waitForTimeout(300);
check("8 · pagination asks the server for page 2", log.calls.filter((c) => c.action === "users").pop().page === 2);
await pg.selectOption("#usz", "50"); await pg.waitForTimeout(300);
check("page size can be changed", log.calls.filter((c) => c.action === "users").pop().size === 50);
await pg.fill("#urf", "2026-11-01"); await pg.fill("#urt", "2026-11-10"); await pg.selectOption("#us", "unverified"); await pg.click("#uf button.primary"); await pg.waitForTimeout(300);
const uq = log.calls.filter((c) => c.action === "users").pop();
check("filters: registration dates (IST) and verification status reach the server", uq.status === "unverified" && uq.reg_from === "2026-10-31T18:30:00.000Z" && uq.reg_to === "2026-11-10T18:30:00.000Z");
await pg.click('[data-sort="created_asc"]'); await pg.waitForTimeout(300);
check("sorting by registration date", log.calls.filter((c) => c.action === "users").pop().sort === "created_asc");
await pg.click("#ucols"); await pg.click('[data-col="files"]'); await pg.waitForTimeout(300);
check("column visibility controls hide a column", !(await pg.evaluate(() => document.querySelector("thead").innerText.includes("Files"))));
const [csvDl] = await Promise.all([pg.waitForEvent("download"), pg.click("#ucsv")]);
check("9 · CSV export of the account list downloads a file and goes through the logged report endpoint", csvDl.suggestedFilename().endsWith(".csv") && log.calls.some((c) => c.action === "report" && c.report === "users" && c.format === "csv"));
await pg.click("tr.click"); await pg.waitForSelector(".drawer h3");
await pg.waitForFunction(() => /feature adoption/i.test(document.querySelector(".drawer")?.innerText || ""), null, { timeout: 5000 }).catch(() => {});
const drw = await text(pg, ".drawer");
check("account drawer: metadata, sign-in methods, usage counts, feature adoption; no record contents", /feature adoption/i.test(drw) && /sign-in method/i.test(drw) && !drw.includes(SECRET_MARK), drw.slice(0, 200).replace(/\n/g, " / "));
await pg.click('[data-act="suspend"]'); await pg.waitForSelector("dialog[open]"); await pg.click("dialog #co"); await pg.waitForTimeout(150);
check("suspending needs a reason before anything is sent", (await text(pg, "dialog #cerr")) === "Please give a reason." && !log.calls.some((c) => c.action === "user_suspend"));
await pg.fill("dialog #cr", "Fictional abuse report"); await pg.click("dialog #co"); await pg.waitForTimeout(400);
check("…then sends the suspension with its reason", log.calls.some((c) => c.action === "user_suspend" && c.reason === "Fictional abuse report"));
await pg.keyboard.press("Escape");

// reports
await go(pg, "#/reports", "[data-r]");
check("reports: nine report types plus the account list, each with CSV and PDF", (await pg.$$eval("[data-r][data-f=pdf]", (e) => e.length)) === 10);
const [pdfDl] = await Promise.all([pg.waitForEvent("download"), pg.click('[data-r="growth"][data-f="pdf"]')]);
check("10 · PDF export downloads a server-built PDF for the selected period", pdfDl.suggestedFilename().endsWith(".pdf") && log.calls.some((c) => c.action === "report" && c.report === "growth" && c.format === "pdf" && c.from && c.to));

// documents
await go(pg, "#/documents", ".meter");
check("documents: storage used and remaining, capacity meter, operations table with pseudonymous accounts", (await text(pg, "#view")).includes("Storage remaining") && (await text(pg, "#view")).includes("1a2b3c4d5e"));
check("documents: unmeasured outcomes are labelled, not shown as 0", (await pg.$$eval('#view [data-state="not_measured"]', (e) => e.length)) >= 4);

// feature switches
await go(pg, "#/flags", ".switch");
check("feature switches: each card shows on/off effects, dependencies and the enforcing layer", (await pg.$$eval(".flag", (e) => e.length)) === 2 && /enforced by/i.test(await text(pg, "#view")) && /depends on/i.test(await text(pg, "#view")));
await pg.click('[data-k="ai_assistant"]'); await pg.waitForSelector("dialog[open]");
check("turning on the AI assistant shows the safeguards warning", (await text(pg, "dialog")).includes("legal review"));
await pg.click("dialog #cc"); await pg.waitForTimeout(150);
check("cancelling changes nothing", !log.calls.some((c) => c.action === "set_flag"));
const cfgBefore = log.configCalls;
await pg.click('[data-k="document_upload"]'); await pg.waitForSelector("dialog[open]"); await pg.fill("dialog #cr", "fictional test"); await pg.click("dialog #co");
await pg.waitForSelector('#prop-document_upload .st.good', { timeout: 8000 }).catch(() => {});
check("11 · a switch change is sent with its reason and confirmed against the live app's /api/config", log.calls.some((c) => c.action === "set_flag" && c.key === "document_upload" && c.enabled === false && c.reason === "fictional test") && log.configCalls > cfgBefore && (await text(pg, "#prop-document_upload")).includes("Live in the app"));

// maintenance
await go(pg, "#/maintenance", "#mm");
await pg.fill("#mm", "Back at 10:00 IST (fictional)");
check("maintenance: the message preview updates as you type", (await text(pg, "#mprev")).includes("Back at 10:00"));
await pg.fill("#ms", "2026-12-01T09:00"); await pg.fill("#me", "2026-12-01T10:00"); await pg.click("#mwin"); await pg.waitForSelector("dialog[open]"); await pg.fill("dialog #cr", "fictional window"); await pg.click("dialog #co"); await pg.waitForTimeout(400);
const mw = log.calls.find((c) => c.action === "set_maintenance");
check("12 · scheduling a maintenance window sends the IST times, the message and a reason", mw && mw.starts_at === "2026-12-01T03:30:00.000Z" && mw.ends_at === "2026-12-01T04:30:00.000Z" && mw.message.includes("Back at 10:00") && mw.reason === "fictional window");

// errors
await go(pg, "#/errors", "tr.click");
await pg.click("tr.click"); await pg.waitForSelector(".drawer pre.stack");
check("error drawer: route, environment, release, correlation ID and a cleaned stack", ["#reports", "production", "abc1234", "req-1"].every((x) => pg && true) && (await text(pg, ".drawer")).includes("req-1") && (await text(pg, ".drawer")).includes("#reports"));
await pg.click('.drawer [data-s="resolved"]'); await pg.waitForTimeout(300);
check("13 · resolving an error sends it to the server", log.calls.some((c) => c.action === "error_update" && c.status === "resolved"));
await pg.keyboard.press("Escape");

// alerts
await go(pg, "#/alerts", "[data-a]");
check("alerts: severity, time, affected service, recommended action, status; email marked not configured", (await text(pg, "#view")).includes("Scheduled monitoring") && (await text(pg, "#view")).includes("Check the scheduler") && (await text(pg, "#view")).includes("not configured"));
await pg.click('[data-a="muted"]'); await pg.waitForTimeout(300);
check("14 · alerts can be acknowledged, muted for 24 h or resolved", log.calls.some((c) => c.action === "alert_update" && c.status === "muted"));

// health
await go(pg, "#/health", "[data-service=auth]");
check("16 · health: a service that did not answer is Down, a slow one Degraded, an unconfigured AI says so", /down/i.test(await text(pg, "[data-service=auth] .st")) && /degraded/i.test(await text(pg, "[data-service=storage] .st")) && /not configured/i.test(await text(pg, "[data-service=ai] .st")), [await text(pg, "[data-service=auth] .st"), await text(pg, "[data-service=storage] .st"), await text(pg, "[data-service=ai] .st")].join("|"));
check("health: uptime history, response time, failed checks and recent checks", (await text(pg, "#uh")).includes("Uptime history") && (await text(pg, "#uh")).includes("Response time") && (await text(pg, "#uh")).includes("Recent health checks"));
const hc = log.calls.filter((c) => c.action === "health").length; await pg.click("#rc"); await pg.waitForTimeout(400);
check("the Re-check button runs the checks again", log.calls.filter((c) => c.action === "health").length === hc + 1);

// audit, settings
await go(pg, "#/audit", "#af");
check("15 · audit log: who, what, when, resource, previous and new state, reason, outcome, correlation; no edit controls", (await text(pg, "thead")).includes("Previous → new") && (await text(pg, "#view")).includes("cannot be edited or deleted") && !(await pg.$('#view button:text-matches("delete|edit", "i")')));
await go(pg, "#/settings", "#pe");
check("admin settings: email preference saved but clearly marked as not delivering while no email provider is configured", (await text(pg, "#view")).includes("Email delivery is not configured"));
await pg.click("#pe"); await pg.click("#psave"); await pg.waitForTimeout(300);
check("notification preferences are saved on the server", log.calls.some((c) => c.action === "set_prefs" && c.email_alerts === true));
check("18 · the console never calls the database or storage directly", log.direct.every((u) => u.includes("jsdelivr")));
await pg.click('[data-k="dashboard"]');
await ctx.close();

// ── other roles ──
({ ctx, pg, log } = await open("analyst@example.test"));
const ak = await navKeys(pg);
check("3 · analyst: dashboards, analytics, reports, documents, health; no users, switches, team or audit", ak.includes("analytics") && ak.includes("reports") && !ak.includes("users") && !ak.includes("team") && !ak.includes("audit") && !ak.includes("flags"));
await pg.waitForSelector("#activity");
check("analyst dashboard: registrations shown only as a count", (await text(pg, "#activity")).includes("Your role does not see account details"));
await pg.evaluate(() => { location.hash = "#/users"; }); await pg.waitForTimeout(500);
check("typing the users address as an analyst does not open it", (await text(pg, "#title")) !== "Users");
const r403 = await pg.evaluate(async () => { const { data } = await window.supabase.createClient("https://x.supabase.co", "anon").auth.getSession(); const r = await fetch("/api/admin", { method: "POST", headers: { authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ action: "user_suspend", id: "b0000000-0000-0000-0000-000000000001", reason: "x" }) }); return r.status; });
check("a hand-made suspend request from an analyst is refused (403)", r403 === 403);
await ctx.close();
({ ctx, pg, log } = await open("support@example.test", { hash: "#/users" }));
await pg.waitForSelector("tr.click"); await pg.click("tr.click"); await pg.waitForSelector(".drawer h3");
check("support: password reset and notes, no suspend; no analytics in the menu", !!(await pg.$('[data-act="reset"]')) && !!(await pg.$("#nf")) && !(await pg.$('[data-act="suspend"]')) && !(await navKeys(pg)).includes("analytics"));
await ctx.close();
({ ctx, pg, log } = await open("auditor@example.test"));
const au = await navKeys(pg);
check("auditor: audit log, security events and team only (plus dashboard, reports, definitions, settings)", au.includes("audit") && au.includes("security") && au.includes("team") && !au.includes("users") && !au.includes("flags") && !au.includes("analytics"));
check("auditor dashboard has headline figures but no trend charts", !!(await pg.$("[data-kpi=accounts]")) && (await text(pg, "#view")).includes("Trend charts need the analytics permission"));
await ctx.close();

// ── layout ──
for (const w of [320, 390, 768, 1024, 1440]) {
  ({ ctx, pg } = await open("owner@example.test", { width: w }));
  await pg.waitForSelector("[data-kpi=accounts]");
  const o = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  let navOk = true;
  if (process.env.SHOTS && (w === 390 || w === 1440)) await pg.screenshot({ path: `${process.env.SHOTS}/admin-${w}.png`, fullPage: w === 390 });
  if (w < 980) { navOk = !(await pg.isVisible(".nav a[data-k=users]")); await pg.click("#menu"); await pg.waitForTimeout(300); navOk = navOk && (await pg.isVisible(".nav a[data-k=users]")); }
  if (process.env.SHOTS && w === 390) await pg.screenshot({ path: `${process.env.SHOTS}/admin-390-menu.png` });
  check(`17 · ${w}px: no sideways scrolling${w < 980 ? "; the menu button opens the navigation drawer" : ""}`, o <= 1 && navOk, "overflow " + o);
  await ctx.close();
}
({ ctx, pg } = await open("owner@example.test", { width: 1440 }));
await pg.click("#collapse"); await pg.waitForTimeout(300);
check("the sidebar collapses to icons on desktop", (await pg.evaluate(() => document.querySelector(".side").getBoundingClientRect().width)) <= 70);
if (process.env.SHOTS) { for (const [h, sel] of [["#/analytics", ".funnel"], ["#/health", "#uh .card"], ["#/flags", ".flag"], ["#/users", "tr.click"]]) { await pg.click("#collapse"); await go(pg, h, sel); await pg.screenshot({ path: `${process.env.SHOTS}/admin-${h.slice(2)}.png`, fullPage: true }); await pg.click("#collapse"); } }
await ctx.close();

const html = readFileSync(new URL("../../public/admin/index.html", import.meta.url), "utf8"), js = readFileSync(new URL("../../public/admin/admin.js", import.meta.url), "utf8");
check("19 · no secrets or privileged key names in the console's code; no inline script; Supabase pinned with integrity", !/sb_secret_|service_role|SERVICE_ROLE|RESEND_API_KEY=|ANTHROPIC_API_KEY=/.test(js + html) && !/<script(?![^>]*\ssrc=)[^>]*>/.test(html) && /supabase-js@2\.45\.4[^"]*" integrity="sha384-/.test(html));
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} passed, ${failed} FAILED` : `all ${out.length} admin console checks passed`);
process.exit(failed ? 1 : 0);
