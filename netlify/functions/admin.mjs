/**
 * Doctine · /api/admin — the internal admin console's only door to data (POST, JSON { action, ...arguments }).
 *
 * 1. Who is asking comes from their own Supabase sign-in token, checked with Supabase on every request (never from the
 *    request body, user metadata or anything the browser can edit).
 * 2. Whether they may do it is decided in the database: every admin function (migration 20261112000000_admin_console.sql)
 *    checks the person's role in private.admin_members and writes the audit log in the same transaction. This file
 *    only routes; it cannot grant anything the database would refuse.
 * 3. If the person has two-step sign-in set up (or ADMIN_REQUIRE_MFA=true), the token must be a two-step (aal2) one.
 * Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. The service key never leaves the server.
 */
import { randomUUID } from "node:crypto";
import { serviceHeaders } from "../lib/supabase-keys.mjs";
import { json, readJson } from "../lib/ai.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { _resetSettingsCache } from "../lib/settings.mjs";
import { runChecks, recordChecks, reportServerError } from "../lib/monitor.mjs";
import { makePdf } from "../lib/pdf.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const s = (v, n = 300) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const iso = (v) => { const d = new Date(v); return isFinite(d) ? d.toISOString() : null; };
const int = (v, d) => (Number.isFinite(+v) ? Math.floor(+v) : d);
const uuid = (v) => { if (typeof v !== "string" || !UUID.test(v)) throw httpError(400, "invalid_id"); return v; };
const period = (b) => {
  const to = iso(b.to) || new Date().toISOString(), from = iso(b.from) || new Date(Date.parse(to) - 7 * DAY).toISOString();
  if (Date.parse(from) >= Date.parse(to) || Date.parse(to) - Date.parse(from) > 400 * DAY) throw httpError(400, "invalid_period");
  return { p_from: from, p_to: to };
};
function httpError(status, error) { return Object.assign(new Error(error), { status, error }); }

async function call(url, init = {}, ms = 10000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

function env() {
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  return { base, anon: process.env.SUPABASE_ANON_KEY || "", service: process.env.SUPABASE_SERVICE_ROLE_KEY || "" };
}

/** Calls a database function with the server key. Database refusals come back as HTTP errors. */
async function rpc(fn, args) {
  const { base, service } = env();
  const r = await call(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: serviceHeaders(service, { "content-type": "application/json" }), body: JSON.stringify(args) });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (r.ok) return body;
  const code = body && body.code;
  if (code === "42501") throw httpError(403, "forbidden");
  if (code === "22023" || code === "22P02" || code === "22007" || code === "23514") throw httpError(400, "invalid");
  if (code === "P0002") throw httpError(404, "not_found");
  if (code === "PGRST202" || code === "42883") throw httpError(503, "not_installed");
  console.error("[admin] rpc", fn, r.status, code || "");
  throw httpError(502, "database_error");
}

/** The JWT's claims. Only read AFTER Supabase has accepted the same token, so they are trustworthy. */
function claims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString()); } catch { return {}; }
}

/* ─────────────── platform checks (measured now, never assumed) ─────────────── */
async function healthChecks(origin) {
  const { base, service } = env();
  const checks = await runChecks(origin);
  await recordChecks(checks); // also adds to the uptime history (at most one round per 4 minutes)
  return {
    checks,
    configured: {
      ai_provider: Boolean(process.env.ANTHROPIC_API_KEY),
      shared_rate_limits: Boolean(base && service),
      scheduled_checks: "Every 15 minutes: the GitHub uptime workflow calls /api/monitor, which checks, records and evaluates alerts",
      error_tracking: "Doctine's own: app and server errors, grouped, without personal data",
      alert_email: process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_TO && process.env.ALERT_EMAIL_FROM ? "Resend: " + String(process.env.ALERT_EMAIL_TO).split(",").length + " recipient(s)" : null,
    },
    environment: process.env.DOCTINE_ENV || "unset",
  };
}

/* ─────────────── CSV exports (no health information, ever) ─────────────── */
const csvCell = (v) => { const t = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); const safe = /^[=+\-@\t\r]/.test(t) ? "'" + t : t; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
const csv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";

async function exportReport(uid, b, rid) {
  const kind = s(b.report, 20), p = period(b);
  const log = (outcome, detail) => rpc("admin_log_action", { p_actor: uid, p_perm: "reports.export", p_action: "report.export", p_target_type: "report", p_target_id: kind, p_reason: null, p_detail: detail, p_outcome: outcome, p_request: rid });
  let body, name;
  if (kind === "daily") {
    const rows = await rpc("admin_series", { p_actor: uid, ...p });
    body = csv(rows, ["day", "users_total", "users_new", "dau", "wau", "mau", "documents", "uploads_failed", "processing_failed", "login_failures", "app_errors"]);
  } else if (kind === "summary") {
    const o = await rpc("admin_overview", { p_actor: uid, ...p });
    const rows = Object.entries(o).filter(([, v]) => typeof v !== "object" || v === null).map(([measure, value]) => ({ measure, value }));
    body = csv(rows, ["measure", "value"]);
  } else if (kind === "users") {
    const all = []; for (let page = 1; page <= 50; page++) { const r = await rpc("admin_users", { p_actor: uid, p_q: null, p_status: null, p_sort: "created_asc", p_page: page, p_size: 100 }); all.push(...r.rows); if (all.length >= r.total || !r.rows.length) break; }
    body = csv(all, ["id", "email", "created_at", "email_confirmed_at", "last_sign_in_at", "last_activity", "suspended", "admin_role", "records", "files"]);
  } else if (kind === "audit") {
    const r = await rpc("admin_audit", { p_actor: uid, p_admin: null, p_action: null, p_target: null, p_from: p.p_from, p_to: p.p_to, p_page: 1, p_size: 200 });
    body = csv(r.rows, ["at", "actor_email", "actor_role", "action", "target_type", "target_id", "reason", "outcome", "request_id"]);
  } else throw httpError(400, "invalid_report");
  name = `doctine-${kind}-${p.p_from.slice(0, 10)}-to-${p.p_to.slice(0, 10)}.csv`;
  await log("ok", { report: kind, from: p.p_from, to: p.p_to, bytes: body.length });
  return { filename: name, content_type: "text/csv", body };
}

/* ─────────────── PDF report: the dashboard and its daily figures, built on the server ─────────────── */
const IST = 330 * 60000;
const ist = (v) => { const d = new Date(Date.parse(v) + IST); return d.toISOString().slice(0, 16).replace("T", " ") + " IST"; };
const fmt = (v) => (v == null ? "-" : typeof v === "number" ? v.toLocaleString("en-IN") : String(v));
const mb = (b) => (b == null ? "-" : (b / 1048576).toFixed(1) + " MB");
async function pdfReport(uid, b, rid) {
  const p = period(b);
  // the permission check comes first: admin_log_action refuses anyone without reports.export
  await rpc("admin_log_action", { p_actor: uid, p_perm: "reports.export", p_action: "report.export", p_target_type: "report", p_target_id: "pdf", p_reason: null, p_detail: { report: "pdf", from: p.p_from, to: p.p_to }, p_outcome: "requested", p_request: rid });
  const [o, series, me] = await Promise.all([rpc("admin_overview", { p_actor: uid, ...p }), rpc("admin_series", { p_actor: uid, ...p }), rpc("admin_me", { p_actor: uid })]);
  let funnel = null, adoption = null;
  if ((me.perms || []).includes("analytics.view")) [funnel, adoption] = await Promise.all([rpc("admin_funnel", { p_actor: uid, ...p }), rpc("admin_adoption", { p_actor: uid, ...p })]);
  const chg = (a, b2) => (b2 ? `${a >= b2 ? "+" : ""}${Math.round(((a - b2) / b2) * 100)}% vs ${fmt(b2)}` : b2 === 0 ? (a ? "new" : "no change") : "");
  const blocks = [
    { h: "Headline figures" },
    { table: { cols: ["Measure", "Value", "Compared with the previous period"], align: ["", "r", ""], rows: [
      ["Total accounts", fmt(o.users_total), `${fmt(o.users_verified)} with email confirmed`],
      ["New accounts", fmt(o.users_new), chg(o.users_new, o.users_new_prev)],
      ["Active people in period", fmt(o.active), chg(o.active, o.active_prev)],
      ["Returning people", fmt(o.returning), ""],
      ["Daily / 7-day / 30-day active (now)", `${fmt(o.dau)} / ${fmt(o.wau)} / ${fmt(o.mau)}`, ""],
      ["Signed in during period", fmt(o.signed_in), ""],
      ["Records added", fmt(o.documents_new), chg(o.documents_new, o.documents_new_prev)],
      ["Records in total", fmt(o.documents_total), ""],
      ["Document storage", mb(o.storage_bytes), `${fmt(o.storage_files)} files`],
      ["Failed uploads", fmt(o.uploads_failed), o.events_since ? "" : "not recorded yet"],
      ["App errors reported", fmt(o.app_errors), o.events_since ? "" : "not recorded yet"],
    ] } },
  ];
  if (funnel) blocks.push({ h: "Sign-up funnel (accounts created in the period)" }, { table: { cols: ["Step", "People"], align: ["", "r"], rows: [["Account created", fmt(funnel.account_created)], ["Email confirmed", fmt(funnel.email_verified)], ["Signed in", fmt(funnel.signed_in)], ["First qualifying activity", fmt(funnel.first_activity)]] } });
  if (adoption) blocks.push({ h: "Feature adoption" }, { table: { cols: ["Feature", "People, ever", "In period"], align: ["", "r", "r"], rows: adoption.features.map((f) => [f.label, fmt(f.ever), fmt(f.period)]) } });
  blocks.push({ h: "Day by day" }, { table: { cols: ["Day", "Accounts", "New", "Active", "Records", "Failed uploads"], align: ["", "r", "r", "r", "r", "r"], rows: series.map((d) => [d.day, fmt(d.users_total), fmt(d.users_new), fmt(d.dau), fmt(d.documents), fmt(d.uploads_failed)]) } });
  blocks.push({ h: "Definitions" }, { p: "Active means did something with their records (added or changed a record, file, dose, medicine or profile, searched, exported or used the assistant); signing in alone does not count. Days are calendar days in India Standard Time. The previous period is the same length immediately before. This report contains no health information." });
  const body = makePdf({ title: "Doctine platform report", subtitle: `${ist(p.p_from)} to ${ist(p.p_to)} · generated ${ist(new Date().toISOString())} for ${me.email || "an admin"} (${me.role})`, blocks });
  await rpc("admin_log_action", { p_actor: uid, p_perm: "reports.export", p_action: "report.export", p_target_type: "report", p_target_id: "pdf", p_reason: null, p_detail: { report: "pdf", from: p.p_from, to: p.p_to, bytes: body.length }, p_outcome: "ok", p_request: rid });
  return { filename: `doctine-report-${p.p_from.slice(0, 10)}-to-${p.p_to.slice(0, 10)}.pdf`, content_type: "application/pdf", body };
}

/* ─────────────── actions ─────────────── */
const ACTIONS = {
  me: async () => null, // handled below
  overview: (uid, b) => rpc("admin_overview", { p_actor: uid, ...period(b) }),
  series: (uid, b) => rpc("admin_series", { p_actor: uid, ...period(b) }),
  retention: (uid, b) => rpc("admin_retention", { p_actor: uid, p_weeks: Math.min(Math.max(int(b.weeks, 8), 1), 26) }),
  funnel: (uid, b) => rpc("admin_funnel", { p_actor: uid, ...period(b) }),
  adoption: (uid, b) => rpc("admin_adoption", { p_actor: uid, ...period(b) }),
  users: (uid, b) => rpc("admin_users", { p_actor: uid, p_q: s(b.q, 120) || null, p_status: s(b.status, 20) || null, p_sort: s(b.sort, 20) || null, p_page: int(b.page, 1), p_size: int(b.size, 25) }),
  user: (uid, b) => rpc("admin_user", { p_actor: uid, p_user: uuid(b.id) }),
  user_note: (uid, b, rid) => rpc("admin_user_action", { p_actor: uid, p_user: uuid(b.id), p_action: "note", p_reason: null, p_note: s(b.note, 1000), p_request: rid }),
  user_revoke_sessions: (uid, b, rid) => rpc("admin_user_action", { p_actor: uid, p_user: uuid(b.id), p_action: "revoke_sessions", p_reason: s(b.reason, 500), p_note: null, p_request: rid }),
  user_suspend: (uid, b, rid) => setSuspended(uid, b, rid, true),
  user_restore: (uid, b, rid) => setSuspended(uid, b, rid, false),
  user_reset_password: async (uid, b, rid) => {
    const id = uuid(b.id), { base, anon } = env();
    const req = await rpc("admin_log_action", { p_actor: uid, p_perm: "users.reset_password", p_action: "user.reset_password", p_target_type: "user", p_target_id: id, p_reason: s(b.reason, 500) || null, p_detail: null, p_outcome: "requested", p_request: rid });
    if (!req.email) throw httpError(404, "not_found");
    // Supabase's own reset email (the same one people get from "Forgot password"); no password is seen or set here.
    const r = await call(`${base}/auth/v1/recover`, { method: "POST", headers: { apikey: anon, "content-type": "application/json" }, body: JSON.stringify({ email: req.email }) });
    await rpc("admin_log_action", { p_actor: uid, p_perm: "users.reset_password", p_action: "user.reset_password", p_target_type: "user", p_target_id: id, p_reason: null, p_detail: { status: r.status }, p_outcome: r.ok ? "ok" : "failed", p_request: rid });
    return { ok: r.ok, error: r.ok ? undefined : r.status === 429 ? "email_rate_limited" : "email_failed" };
  },
  documents: (uid, b) => rpc("admin_documents", { p_actor: uid, ...period(b), p_page: int(b.page, 1), p_size: int(b.size, 25) }),
  flags: (uid) => rpc("admin_flags", { p_actor: uid }),
  set_flag: async (uid, b, rid) => { const r = await rpc("admin_set_flag", { p_actor: uid, p_key: s(b.key, 40), p_enabled: b.enabled === true, p_message: s(b.message, 300) || null, p_reason: s(b.reason, 500), p_request: rid }); _resetSettingsCache(); return r; },
  announcements: (uid) => rpc("admin_announcements", { p_actor: uid }),
  announcement_save: (uid, b, rid) => {
    const d = b.data || {}, out = {};
    if (d.id) out.id = uuid(d.id);
    for (const k of ["kind", "title", "body", "status"]) if (typeof d[k] === "string") out[k] = d[k].slice(0, k === "body" ? 600 : 120);
    for (const k of ["starts_at", "ends_at"]) if (k in d) out[k] = d[k] ? iso(d[k]) : "";
    return rpc("admin_announcement_save", { p_actor: uid, p_data: out, p_request: rid });
  },
  incidents: (uid) => rpc("admin_incidents", { p_actor: uid }),
  incident_save: (uid, b, rid) => {
    const d = b.data || {}, out = {};
    if (d.id) out.id = uuid(d.id);
    for (const [k, n] of [["title", 160], ["status", 20], ["impact", 600], ["notes", 2000]]) if (typeof d[k] === "string") out[k] = d[k].slice(0, n);
    return rpc("admin_incident_save", { p_actor: uid, p_data: out, p_request: rid });
  },
  alerts: (uid, b) => rpc("admin_alerts", { p_actor: uid, p_evaluate: b.evaluate !== false }),
  alert_update: (uid, b, rid) => rpc("admin_alert_update", { p_actor: uid, p_id: uuid(b.id), p_status: s(b.status, 20), p_request: rid }),
  team: (uid) => rpc("admin_team", { p_actor: uid }),
  team_set: (uid, b, rid) => rpc("admin_team_set", { p_actor: uid, p_email: s(b.email, 254), p_role: s(b.role, 20) || null, p_status: s(b.status, 20) || "active", p_reason: s(b.reason, 500), p_request: rid }),
  audit: (uid, b) => rpc("admin_audit", { p_actor: uid, p_admin: s(b.admin, 120) || null, p_action: s(b.filter_action, 64) || null, p_target: s(b.target, 80) || null, p_from: iso(b.from), p_to: iso(b.to), p_page: int(b.page, 1), p_size: int(b.size, 50) }),
  security: (uid) => rpc("admin_security", { p_actor: uid }),
  health: async (uid, b, rid, req) => { await rpc("admin_incidents", { p_actor: uid }); return healthChecks(new URL(req.url).origin); }, // the incidents call checks health.view
  uptime: (uid, b) => rpc("admin_uptime", { p_actor: uid, p_days: Math.min(Math.max(int(b.days, 7), 1), 90) }),
  errors: (uid, b) => rpc("admin_errors", { p_actor: uid, p_status: s(b.status, 20) || null }),
  error_update: (uid, b, rid) => { if (!/^[0-9a-f]{32}$/.test(b.id || "")) throw httpError(400, "invalid_id"); return rpc("admin_error_update", { p_actor: uid, p_fp: b.id, p_status: s(b.status, 20), p_request: rid }); },
  pdf: (uid, b, rid) => pdfReport(uid, b, rid),
  export: (uid, b, rid) => exportReport(uid, b, rid),
};

async function setSuspended(uid, b, rid, on) {
  const id = uuid(b.id), { base, service } = env();
  const r = await rpc("admin_user_action", { p_actor: uid, p_user: id, p_action: on ? "suspend" : "restore", p_reason: s(b.reason, 500), p_note: null, p_request: rid });
  if (!r || !r.ok) return r;
  // Supabase's supported way to block sign-in: ban_duration on the Auth admin API.
  const res = await call(`${base}/auth/v1/admin/users/${id}`, { method: "PUT", headers: serviceHeaders(service, { "content-type": "application/json" }), body: JSON.stringify({ ban_duration: on ? "876000h" : "none" }) });
  await rpc("admin_log_action", { p_actor: uid, p_perm: "users.suspend", p_action: on ? "user.suspend" : "user.restore", p_target_type: "user", p_target_id: id, p_reason: null, p_detail: { status: res.status, sessions_ended: r.sessions_ended }, p_outcome: res.ok ? "ok" : "failed", p_request: rid });
  return { ok: res.ok, sessions_ended: r.sessions_ended, error: res.ok ? undefined : "auth_update_failed" };
}

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "invalid" }, 405);
  const { base, anon, service } = env();
  if (!base || !anon || !service) return json({ error: "not_configured" }, 503);
  const rl = await checkRate(req, context, "admin");
  if (!rl.allowed) return json({ error: rl.error }, rl.status);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.length > 4096) return json({ error: "unauthorized" }, 401);

  const parsed = await readJson(req, 16 * 1024);
  if (parsed.error) return json({ error: parsed.error }, parsed.status);
  const b = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body) ? parsed.body : {};
  const action = s(b && b.action, 40);
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, action)) return json({ error: "invalid_action" }, 400);
  const rid = randomUUID();

  try {
    // 1. Who is this? Supabase checks the token itself (expired, signed out and banned tokens are refused).
    const who = await call(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } }, 5000);
    if (!who.ok) return json({ error: "unauthorized" }, 401);
    const user = await who.json();
    const uid = user && UUID.test(user.id || "") ? user.id : null;
    if (!uid) return json({ error: "unauthorized" }, 401);

    // 2. Are they on the admin team? (The database decides; nothing from the browser is trusted.)
    const me = await rpc("admin_me", { p_actor: uid });
    if (!me || !me.role) {
      await rpc("admin_log_denied", { p_actor: uid, p_action: action, p_request: rid }).catch(() => {});
      return json({ error: "forbidden", request_id: rid }, 403);
    }
    // 3. Two-step sign-in, where the person has set it up (always, with ADMIN_REQUIRE_MFA=true).
    const aal = claims(token).aal;
    const mustMfa = me.mfa_enrolled || /^true$/i.test(process.env.ADMIN_REQUIRE_MFA || "");
    if (mustMfa && aal !== "aal2") {
      if (action !== "me") return json({ error: "mfa_required", request_id: rid }, 403);
      return json({ ...me, mfa_required: true, mfa_enrolled: !!me.mfa_enrolled, request_id: rid });
    }
    if (action === "me") return json({ ...me, aal, request_id: rid });

    const out = await ACTIONS[action](uid, b, rid, req);
    if (out && out.content_type) return new Response(out.body, { status: 200, headers: { "content-type": out.content_type + (out.content_type.startsWith("text/") ? "; charset=utf-8" : ""), "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store", "x-request-id": rid } });
    return json({ data: out, request_id: rid });
  } catch (e) {
    if (e && e.status) return json({ error: e.error, request_id: rid }, e.status);
    console.error("[admin]", action, e && e.name);
    await reportServerError("/api/admin " + action, e);
    return json({ error: "server_error", request_id: rid }, 502);
  }
};

export const config = { path: "/api/admin" };
