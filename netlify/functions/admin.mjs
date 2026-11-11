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
async function probe(name, url, init) {
  const t0 = Date.now();
  try {
    const r = await call(url, init, 5000);
    return { name, checked_at: new Date().toISOString(), ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
  } catch (e) { return { name, checked_at: new Date().toISOString(), ok: false, status: null, ms: Date.now() - t0, error: e.name === "AbortError" ? "timeout" : "unreachable" }; }
}
async function healthChecks() {
  const { base, anon, service } = env();
  const [db, auth, storage] = await Promise.all([
    probe("Database (Data API)", `${base}/rest/v1/rpc/public_settings`, { method: "POST", headers: serviceHeaders(service, { "content-type": "application/json" }), body: "{}" }),
    probe("Sign-in service", `${base}/auth/v1/health`, { headers: { apikey: anon } }),
    probe("File storage", `${base}/storage/v1/bucket/health-documents`, { headers: serviceHeaders(service) }),
  ]);
  return {
    checks: [db, auth, storage],
    configured: {
      ai_provider: Boolean(process.env.ANTHROPIC_API_KEY),
      shared_rate_limits: Boolean(base && service),
      external_uptime_monitor: "GitHub Actions workflow .github/workflows/uptime.yml (every 15 minutes; history is in GitHub, not shown here)",
      error_tracking: "not configured",
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
  health: async (uid) => { await rpc("admin_incidents", { p_actor: uid }); return healthChecks(); }, // the incidents call checks health.view
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

    const out = await ACTIONS[action](uid, b, rid);
    if (out && out.content_type) return new Response(out.body, { status: 200, headers: { "content-type": out.content_type + "; charset=utf-8", "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store", "x-request-id": rid } });
    return json({ data: out, request_id: rid });
  } catch (e) {
    if (e && e.status) return json({ error: e.error, request_id: rid }, e.status);
    console.error("[admin]", action, e && e.name);
    return json({ error: "server_error", request_id: rid }, 502);
  }
};

export const config = { path: "/api/admin" };
