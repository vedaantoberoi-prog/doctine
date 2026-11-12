/**
 * Doctine · the admin console driven by data shaped exactly like the real database functions' output.
 * fixtures/admin-shapes.json holds field names and types only (no values), captured on 12 Nov 2026 from every admin_*
 * function on the staging project inside a rolled-back transaction. Values here are fictional. Every page, drawer and
 * dialog is opened with an empty and a busy data set at 1440, 390 and 320 px; the suite fails on any page error, any
 * "undefined", "NaN", "Invalid Date", "[object Object]" or "Infinity" on screen, any sideways scrolling, or a page
 * that falls back to "Unavailable".
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const SH = JSON.parse(readFileSync(new URL("./fixtures/admin-shapes.json", import.meta.url), "utf8"));
// The Founder's permissions: every key in the catalogue, read from the migration that defines it.
const MIG = readFileSync(new URL("../../supabase/migrations/20261112050000_names_and_database_overview.sql", import.meta.url), "utf8");
const PERMS = [...MIG.slice(MIG.indexOf("function private.perm_catalog"), MIG.indexOf("$$;", MIG.indexOf("function private.perm_catalog"))).matchAll(/\('([a-z_.]+)', '[^']+', '[^']+', (?:true|false), (?:true|false)\)/g)].map((m) => m[1]);
const now = Date.now();
let ctr = 0;
const STR = (k, path) => {
  ctr++;
  if (/(^|_)(at|since|seen|day|week|hour|from|to|last_round|last_ok|generated_at)$/.test(k) || /_at$/.test(k)) return new Date(now - (ctr % 20) * 36e5 * (k === "day" || k === "week" ? 24 : 1)).toISOString();
  if (k === "id" || k === "user_id" || k === "assigned_to") return "b0000000-0000-0000-0000-0000000000" + String(10 + (ctr % 80)).padStart(2, "0");
  if (k === "fingerprint") return "0123456789abcdef0123456789abcd" + String(ctr % 90 + 10);
  if (/email|^by$/.test(k)) return `person${ctr % 7}.sample@example.test`;
  if (k === "role" || k === "actor_role" || k === "admin_role") return "co_founder";
  if (k === "title") return "Co-Founder";
  if (k === "state") return "pending";
  if (k === "key" && path.includes("perm_catalog")) return PERMS[ctr % PERMS.length];
  if (k === "group") return ["Overview", "Product", "Founder only"][ctr % 3];
  if (k === "area") return "medicines";
  if (k === "priority") return "normal";
  if (k === "type") return path.includes("content") ? "release_note" : "bug";
  if (k === "account") return "9f3a1c2b";
  if (k === "ref") return path.includes("support") ? "S-" + ctr : "B-" + ctr;
  if (k === "status") return path.includes("alerts") ? "open" : path.includes("incidents") || path.includes("after") ? "investigating" : path.includes("team") ? "active" : path.includes("error") ? "open" : path.includes("announcements") ? "published"
    : path.includes("support") ? "new" : path.includes("work") ? "todo" : path.includes("content") ? "draft" : path.includes("feedback") ? "new" : "ok";
  if (k === "severity") return path.includes("incidents") || path.includes("work") ? "major" : "warning";
  if (k === "target" || k === "service") return ["app", "database", "auth", "storage"][ctr % 4];
  if (k === "source") return path.includes("adoption") ? "table" : "client";
  if (k === "kind") return path.includes("announcements") ? "product" : path.includes("feedback") ? "idea" : "TypeError";
  if (k === "audience") return "all";
  if (k === "category") return path.includes("support") ? "sign_in" : path.includes("work") ? "reminders" : "code";
  if (k === "min_severity") return "warning";
  if (k === "timezone") return "Asia/Kolkata";
  if (k === "outcome") return "ok";
  if (k === "rule") return "down_app";
  if (k === "sample_stack") return "TypeError: x\n at f (/index.html:#:#)";
  return "Fictional " + k + " " + ctr;
};
function fill(shape, mode, k = "", path = "") {
  if (Array.isArray(shape)) return mode === "empty" ? [] : Array.from({ length: 3 }, () => fill(shape[0], mode, k, path));
  if (shape === "[]") return [];
  if (shape && typeof shape === "object") { const o = {}; for (const [kk, v] of Object.entries(shape)) o[kk] = fill(v, mode, kk, path + "." + kk); return o; }
  if (shape === "number") return mode === "empty" ? 0 : 3 + (ctr++ % 5);
  if (shape === "boolean") return mode === "busy";
  if (shape === "null") return null;
  return STR(k, path);
}
function make(mode) {
  ctr = 0; const D = {};
  for (const [k, v] of Object.entries(SH)) D[k] = fill(v, mode, k, k);
  D.flags = ["ai_assistant", "document_upload", "pdf_reading", "registrations", "sample_data", "maintenance"].map((key, i) => ({ key, enabled: i % 2 === 0 && key !== "ai_assistant", value: key === "maintenance" && mode === "busy" ? { message: "Fictional", starts_at: new Date(now + 864e5).toISOString(), ends_at: new Date(now + 2 * 864e5).toISOString() } : {}, on_now: false, updated_at: mode === "busy" ? new Date(now).toISOString() : null, updated_by: mode === "busy" ? "owner@example.test" : null }));
  if (mode === "busy") { D.adoption.features = [["profile", "table", true], ["record", "table", true], ["file", "table", true], ["pdf", "event", false], ["schedule", "table", true], ["dose", "table", true], ["search", "event", false], ["export", "event", false]].map(([key, source, measured], i) => ({ key, label: "Feature " + key, source, measured, ever: measured ? i : 0, period: measured ? 1 : 0 }));
    D.uptime.targets = ["app", "database", "auth", "storage"].map((t, i) => ({ ...D.uptime.targets[0], target: t, ok: i === 2 ? 1 : 3, failures: i === 2 ? 2 : 0, last_failure: i === 2 ? { at: new Date(now).toISOString(), status: null, error: "timeout" } : null }));
    D.retention = [{ week: new Date(now - 40 * 864e5).toISOString().slice(0, 10), size: 4, d1: 2, d1_eligible: 4, d7: 1, d7_eligible: 4, d30: 0, d30_eligible: 4 }, ...D.retention];
    D.series = Array.from({ length: 30 }, (_, i) => ({ ...D.series[0], day: new Date(now - (29 - i) * 864e5).toISOString().slice(0, 10), users_new: i % 4, ms_avg: i % 3 ? 120 + i : null }));
    D.errors.daily = D.series.map((s) => ({ day: s.day, n: s.users_new }));
    D.documents.rows = [{ at: new Date(now).toISOString(), account: "1a2b3c4d5e", file_type: "application/pdf", bytes: 2e6, upload_status: "stored", processing_status: "failed", error_code: "pdf_unreadable", ms: 900 }];
    D.documents.summary.by_type = { "image/jpeg": 4, "application/pdf": 2 }; D.documents.summary.by_category = { "Lab report": 3 }; D.documents.summary.failure_reasons = { too_large: 1 }; D.documents.summary.events_since = new Date(now - 5 * 864e5).toISOString();
    D.exports = [{ at: new Date(now).toISOString(), by: "owner@example.test", report: "growth", format: "pdf", outcome: "ok", period_from: new Date(now - 30 * 864e5).toISOString(), period_to: new Date(now).toISOString() }];
    D.user.notes = [{ at: new Date(now).toISOString(), by: "owner@example.test", note: "Fictional note" }]; D.user.admin_actions = [{ at: new Date(now).toISOString(), action: "user.note", by: "owner@example.test", outcome: "ok" }]; D.user.sign_in_methods = ["email", "google"];
    D.security.denied_recent = [{ at: new Date(now).toISOString(), actor_email: "x@example.test", action: "user_suspend", request_id: "r1" }]; D.security.login_failures_by_reason = { invalid_credentials: 2 };
    D.error.history = [{ at: new Date(now).toISOString(), by: "owner@example.test", status: "resolved" }];
    D.audit.rows[0].before = { enabled: false };
  }
  D.me = { role: "founder", title: "Founder", perms: PERMS, email: "owner@example.test", mfa_enrolled: true, aal: "aal2" };
  D.perm_catalog.permissions = PERMS.map((key, i) => ({ key, group: ["Overview", "Product", "Governance"][i % 3], label: "Fictional permission " + key, standard: i % 2 === 0, founder_only: ["team.manage", "security.manage", "ai.manage"].includes(key) }));
  if (mode === "busy") { D.team.members[0] = { ...D.team.members[0], role: "founder", title: "Founder", permissions: ["*"] }; D.content.rows[1] = { ...D.content.rows[1], type: "education", clinical: true, status: "approved" }; D.work.rows[1] = { ...D.work.rows[1], type: "feature", severity: null }; }
  D.health = { checks: ["app", "database", "auth", "storage"].map((t, i) => ({ target: t, name: t, ok: mode !== "busy" || i !== 2, status: 200, ms: 100, checked_at: new Date(now).toISOString(), error: i === 2 && mode === "busy" ? "timeout" : undefined })), ai_state: mode === "busy" ? "disabled_responding" : "not_configured",
    config: { environment: "production", supabase: true, ai_key: mode === "busy", email_provider: false, alert_email_to: false, admin_mfa_required: false, rate_limit_secret: true, google_sign_in: true, release: "abc" } };
  D.settings_status = { prefs: D.prefs, config: D.health.config, reports: ["growth", "engagement", "funnel", "adoption", "documents", "storage", "availability", "errors", "admin_activity", "users"].map((k) => ({ key: k, title: k, description: "x" })) };
  return D;
}
const errs = [], bad = [];
const b = await chromium.launch();
for (const mode of ["empty", "busy"]) {
  const D = make(mode);
  for (const width of [1440, 390, 320]) {
    const ctx = await b.newContext({ viewport: { width, height: 900 } }); await ctx.addInitScript({ content: fakeSrc });
    const pg = await ctx.newPage(); const tag = `${mode}@${width}`;
    pg.on("pageerror", (e) => errs.push(`${tag} ${pg.url().split("#")[1] || ""}: ${e.message}`));
    pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(`${tag} console: ${m.text()}`); });
    await pg.route("**/*", async (r) => {
      const u = r.request().url();
      if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", environment: "production", features: {} }) });
      if (u.endsWith("/api/admin")) { const body = JSON.parse(r.request().postData() || "{}");
        if (body.action === "me") return r.fulfill({ contentType: "application/json", body: JSON.stringify(D.me) });
        if (body.action === "report") return r.fulfill({ status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="x.csv"' }, body: "a,b\n" });
        const data = D[body.action] ?? { ok: true };
        return r.fulfill({ contentType: "application/json", body: JSON.stringify({ data, request_id: "r" }) }); }
      if (u.startsWith(BASE)) return r.continue(); return r.abort();
    });
    await pg.goto(BASE + "/admin/");
    await pg.waitForSelector("#signin, .shell", { timeout: 10000 });
    await pg.evaluate(async () => { const c = window.supabase.createClient("https://x.supabase.co", "anon"); await c.auth.signUp({ email: "owner@example.test", password: "fictional-pass-1", options: { data: {} } }); });
    await pg.reload(); await pg.waitForSelector(".shell", { timeout: 10000 });
    const click = async (sel, where) => { const el = await pg.$(sel); if (!el) { bad.push(`${tag} ${where}: control ${sel} missing`); return false; } await el.click(); await pg.waitForTimeout(400); return true; };
    const scan = async (where) => {
      const t = await pg.evaluate(() => document.body.innerText);
      for (const w of ["undefined", "NaN", "Invalid Date", "[object Object]", "null%", "Infinity"]) if (t.includes(w)) bad.push(`${tag} ${where}: "${w}" … ${t.slice(Math.max(0, t.indexOf(w) - 60), t.indexOf(w) + 30).replace(/\n/g, " / ")}`);
      const o = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (o > 1) bad.push(`${tag} ${where}: horizontal overflow ${o}px`);
      { const u = await pg.$("[data-state=unavailable]"); if (u) bad.push(`${tag} ${where}: shows unavailable: ${await u.innerText()}`); }
    };
    const pages = ["dashboard", "analytics", "reports", "users", "documents", "health", "errors", "incidents", "alerts", "support", "feedback", "work", "content", "flags", "maintenance", "announcements", "team", "audit", "security", "definitions", "settings"];
    const closeDialogs = () => pg.evaluate(() => document.querySelectorAll("dialog").forEach((d) => { d.close?.(); d.remove(); }));
    for (const p of pages) {
      await pg.evaluate((h) => { location.hash = "#/" + h; }, p); await pg.waitForTimeout(700);
      if (width === 1440) for (const [tab, i] of await pg.$$eval("[data-tab]", (e) => e.map((x, i) => [x.dataset.tab, i]))) { await pg.evaluate((i) => document.querySelectorAll("[data-tab]")[i].click(), i); await pg.waitForTimeout(40); }
      await scan(p);
      if (p === "users" && mode === "busy") { if (await click("tr.click", p)) await scan("user drawer"); await pg.keyboard.press("Escape"); }
      if (p === "errors" && mode === "busy") { if (await click("tr.click", p)) await scan("error drawer"); await pg.keyboard.press("Escape"); }
      if (p === "incidents") { if (mode === "busy") { if (await click("tr.click", p)) await scan("incident drawer"); await pg.keyboard.press("Escape"); }
        if (await click("#ni", p)) await scan("new incident dialog"); await pg.keyboard.press("Escape"); await pg.evaluate(() => document.querySelectorAll("dialog").forEach((d) => { d.close?.(); d.remove(); })); }
      if (p === "announcements") { if (await click("#na", p)) await scan("new announcement dialog"); await pg.evaluate(() => document.querySelectorAll("dialog").forEach((d) => { d.close?.(); d.remove(); }));
        if (mode === "busy") { if (await click("#view [data-id]", p)) await scan("edit announcement"); await pg.evaluate(() => document.querySelectorAll("dialog").forEach((d) => { d.close?.(); d.remove(); })); } }
      if (p === "team") { if (await click("#tinv", p)) await scan("invite dialog"); await closeDialogs(); if (mode === "busy") { if (await click("[data-manage]", p)) await scan("manage Co-Founder drawer"); await pg.keyboard.press("Escape"); } }
      if (p === "support" && mode === "busy") { if (await click("tr[data-sup]", p)) await scan("support request drawer"); await pg.keyboard.press("Escape"); }
      if (p === "feedback" && mode === "busy") { if (await click("[data-fwork]", p)) await scan("feedback to item dialog"); await closeDialogs(); }
      if (p === "work") { if (await click("#wnew", p)) await scan("new item dialog"); await closeDialogs(); if (mode === "busy") { if (await click("tr[data-w]", p)) await scan("edit item dialog"); await closeDialogs(); } }
      if (p === "content") { if (await click("#cnew", p)) await scan("new content dialog"); await closeDialogs(); if (mode === "busy") { for (const sel of ["tr[data-c] >> nth=0", "tr[data-c] >> nth=1"]) { if (await click(sel, p)) await scan("content editor"); await closeDialogs(); } } }
    }
    await pg.click("#bell"); await pg.waitForTimeout(400); await scan("notifications"); await pg.click("#bell").catch(() => {});
    if (width === 1440) { await pg.fill("#q", "fictional"); await pg.waitForTimeout(600); await scan("search"); }
    for (const p of ["today", "7d", "90d", "month", "lastmonth"]) { await pg.evaluate((h) => { location.hash = "#/dashboard"; }); await pg.waitForTimeout(200); const btn = await pg.$(`[data-p="${p}"]`); if (btn) { await btn.click(); await pg.waitForTimeout(500); await scan("dashboard " + p); } }
    await ctx.close();
  }
}
await b.close();
const problems = [...new Set(errs), ...new Set(bad)];
for (const mode of ["empty", "busy"]) for (const w of [1440, 390, 320]) {
  const tag = `${mode}@${w}`, mine = problems.filter((x) => x.startsWith(tag + " "));
  console.log(`${mine.length ? "FAIL" : "PASS"} ${mode} data at ${w}px: every page, drawer, dialog, date range and the search and notification menus render without errors, placeholders or sideways scrolling${mine.length ? "  — " + mine.slice(0, 3).join(" | ") : ""}`);
}
console.log(problems.length ? `${problems.length} problems FAILED` : "all admin console real-shape checks passed (2 data sets × 3 widths × 21 pages, drawers and dialogs)");
process.exit(problems.length ? 1 : 0);
