/**
 * Doctine · /api/admin — the internal admin console's only door to data (POST, JSON { action, ...arguments }).
 *
 * 1. Who is asking comes from their own Supabase sign-in token, checked with Supabase on every request (never from the
 *    request body, user metadata or anything the browser can edit).
 * 2. Whether they may do it is decided in the database: every admin function checks the person's leadership role
 *    (Founder or Co-Founder) and their individual permissions in private.admin_members (migration
 *    20261112040000_leadership.sql) and writes the audit log in the same transaction. This file only routes; it cannot
 *    grant anything the database would refuse.
 * 3. Two-step sign-in (aal2) is required for every admin action, for everyone. Before that, a signed-in person can only
 *    ask who they are, set up two-step sign-in in the browser, and accept an invitation addressed to their verified email.
 * Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY. The service key never leaves the server.
 */
import { randomUUID, createHash } from "node:crypto";
import { serviceHeaders } from "../lib/supabase-keys.mjs";
import { json, readJson } from "../lib/ai.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { _resetSettingsCache } from "../lib/settings.mjs";
import { runChecks, recordChecks, reportServerError } from "../lib/monitor.mjs";
import { buildReport, toCsv, toPdf, REPORTS } from "../lib/reports.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400000;
const s = (v, n = 300) => (typeof v === "string" ? v.trim().slice(0, n) : "");
// A missing or empty date is "no date" (null). new Date(null) would be 1 January 1970, which once filtered every account out.
const iso = (v) => { if (v == null || v === "" || typeof v === "boolean") return null; const d = new Date(v); return isFinite(d) ? d.toISOString() : null; };
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
  if (code === "22023" || code === "22P02" || code === "22007" || code === "23514" || code === "23505" || code === "23502") throw httpError(400, "invalid");
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
const flagOn = (f, k) => (f.find((x) => x.key === k) || {}).enabled === true;
export function configStatus() {
  const e = process.env;
  return {
    environment: e.DOCTINE_ENV || "unset",
    supabase: Boolean(e.SUPABASE_URL && e.SUPABASE_ANON_KEY && e.SUPABASE_SERVICE_ROLE_KEY),
    ai_key: Boolean(e.ANTHROPIC_API_KEY),
    email_provider: Boolean(e.RESEND_API_KEY && e.ALERT_EMAIL_FROM),
    alert_email_to: Boolean(e.ALERT_EMAIL_TO),
    admin_mfa_required: true, // enforced for every admin by this server (no setting can turn it off)
    rate_limit_secret: Boolean(e.RATE_LIMIT_SECRET),
    google_sign_in: /^true$/i.test(e.AUTH_GOOGLE || ""),
    release: (e.CF_PAGES_COMMIT_SHA || "").slice(0, 12) || null,
  };
}
async function healthChecks(uid, origin) {
  const [checks, flags] = await Promise.all([runChecks(origin), rpc("admin_flags", { p_actor: uid }).catch(() => [])]);
  await recordChecks(checks); // also adds to the uptime history (at most one round per 4 minutes)
  const ai = checks.find((c) => c.target === "ai");
  const aiState = !process.env.ANTHROPIC_API_KEY ? "not_configured" : !flagOn(flags, "ai_assistant") ? (ai && ai.ok ? "disabled_responding" : "disabled_failing") : ai && ai.ok ? "responding" : "failing";
  return { checks, ai_state: aiState, config: configStatus() };
}

/* ─────────────── reports: CSV or PDF, built on the server, every export logged ─────────────── */
async function runReport(uid, b, rid) {
  const kind = s(b.report, 20), format = b.format === "pdf" ? "pdf" : "csv", p = period(b);
  if (!REPORTS[kind]) throw httpError(400, "invalid_report");
  const log = (outcome, detail) => rpc("admin_log_action", { p_actor: uid, p_perm: "reports.export", p_action: "report.export", p_target_type: "report", p_target_id: kind, p_reason: null,
    p_detail: { report: kind, format, from: p.p_from, to: p.p_to, ...detail }, p_outcome: outcome, p_request: rid });
  await log("requested", {}); // checks reports.export before any figure is read
  let report;
  try { report = await buildReport(kind, uid, p, rpc); }
  catch (e) { await log("failed", { error: e.error || "error" }).catch(() => {}); throw e; }
  const me = await rpc("admin_me", { p_actor: uid });
  const body = format === "pdf" ? toPdf(report, p, me) : toCsv(report, p, me);
  await log("ok", { bytes: body.length });
  return { filename: `doctine-${kind.replace("_", "-")}-${p.p_from.slice(0, 10)}-to-${p.p_to.slice(0, 10)}.${format}`, content_type: format === "pdf" ? "application/pdf" : "text/csv", body };
}

/* ─────────────── actions ─────────────── */
const ACTIONS = {
  me: async () => null, // handled below
  accept_invite: async () => null, // handled below (only for people who are not yet members)
  overview: (uid, b) => rpc("admin_overview", { p_actor: uid, ...period(b) }),
  series: (uid, b) => rpc("admin_series", { p_actor: uid, ...period(b) }),
  retention: (uid, b) => rpc("admin_retention", { p_actor: uid, p_weeks: Math.min(Math.max(int(b.weeks, 8), 1), 26) }),
  funnel: (uid, b) => rpc("admin_funnel", { p_actor: uid, ...period(b) }),
  adoption: (uid, b) => rpc("admin_adoption", { p_actor: uid, ...period(b) }),
  adoption_trend: (uid, b) => rpc("admin_adoption_trend", { p_actor: uid, p_weeks: Math.min(Math.max(int(b.weeks, 12), 2), 52) }),
  engagement: (uid, b) => rpc("admin_engagement", { p_actor: uid, ...period(b) }),
  activity: (uid) => rpc("admin_activity", { p_actor: uid }),
  search: (uid, b) => rpc("admin_search", { p_actor: uid, p_q: s(b.q, 80) }),
  users: (uid, b) => rpc("admin_users", { p_actor: uid, p_q: s(b.q, 120) || null, p_status: s(b.status, 20) || null, p_sort: s(b.sort, 20) || null, p_page: int(b.page, 1), p_size: int(b.size, 25),
    p_from: iso(b.reg_from), p_to: iso(b.reg_to) }),
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
  set_flag: async (uid, b, rid) => { if (b.key === "maintenance") throw httpError(400, "invalid"); const r = await rpc("admin_set_flag", { p_actor: uid, p_key: s(b.key, 40), p_enabled: b.enabled === true, p_message: null, p_reason: s(b.reason, 500), p_request: rid }); _resetSettingsCache(); return r; },
  set_maintenance: async (uid, b, rid) => {
    const r = await rpc("admin_set_maintenance", { p_actor: uid, p_enabled: b.enabled === true, p_message: s(b.message, 300) || null, p_starts: iso(b.starts_at), p_ends: iso(b.ends_at), p_reason: s(b.reason, 500), p_request: rid });
    _resetSettingsCache(); return r;
  },
  announcements: (uid) => rpc("admin_announcements", { p_actor: uid }),
  announcement_save: (uid, b, rid) => {
    const d = b.data || {}, out = {};
    if (d.id) out.id = uuid(d.id);
    for (const k of ["kind", "title", "body", "status", "audience"]) if (typeof d[k] === "string") out[k] = d[k].slice(0, k === "body" ? 600 : 120);
    for (const k of ["starts_at", "ends_at"]) if (k in d) out[k] = d[k] ? iso(d[k]) : "";
    return rpc("admin_announcement_save", { p_actor: uid, p_data: out, p_request: rid });
  },
  incidents: (uid) => rpc("admin_incidents", { p_actor: uid }),
  incident_save: (uid, b, rid) => {
    const d = b.data || {}, out = {};
    if (d.id) out.id = uuid(d.id);
    for (const [k, n] of [["title", 160], ["status", 20], ["severity", 20], ["impact", 600], ["notes", 2000], ["update_note", 2000], ["assigned_email", 254]]) if (typeof d[k] === "string") out[k] = d[k].slice(0, n);
    return rpc("admin_incident_save", { p_actor: uid, p_data: out, p_request: rid });
  },
  alerts: (uid, b) => rpc("admin_alerts", { p_actor: uid, p_evaluate: b.evaluate !== false }),
  alert_update: (uid, b, rid) => rpc("admin_alert_update", { p_actor: uid, p_id: uuid(b.id), p_status: s(b.status, 20), p_request: rid }),
  team: (uid) => rpc("admin_team", { p_actor: uid }),
  perm_catalog: (uid) => rpc("admin_perm_catalog", { p_actor: uid }),
  invite: (uid, b, rid, req) => invite(uid, b, rid, req),
  invite_revoke: (uid, b, rid) => rpc("admin_invite_revoke", { p_actor: uid, p_id: uuid(b.id), p_reason: s(b.reason, 500), p_request: rid }),
  member_set: (uid, b, rid) => rpc("admin_member_set", { p_actor: uid, p_user: uuid(b.id), p_status: s(b.status, 20), p_permissions: b.permissions === undefined || b.permissions === null ? null : perms(b.permissions),
    p_reason: s(b.reason, 500), p_request: rid }),
  session: (uid, b, rid, req, token) => {
    const sid = String(claims(token).session_id || ""); if (!sid) throw httpError(400, "invalid");
    return rpc("admin_log_session", { p_actor: uid, p_event: b.event === "sign_out" ? "sign_out" : "sign_in", p_session: createHash("sha256").update(sid).digest("hex").slice(0, 16), p_request: rid });
  },
  page_denied: async (uid, b, rid) => { await rpc("admin_log_denied", { p_actor: uid, p_action: "page:" + s(b.page, 30).replace(/[^a-z_]/g, ""), p_request: rid }); return { ok: true }; },
  product_overview: (uid, b) => rpc("admin_product_overview", { p_actor: uid, ...period(b) }),
  data_overview: (uid, b) => rpc("admin_data_overview", { p_actor: uid, ...period(b) }),
  support_list: (uid, b) => rpc("admin_support", { p_actor: uid, p_status: s(b.status, 20) || null, p_mine: b.mine === true, p_page: int(b.page, 1) }),
  support_item: (uid, b, rid) => rpc("admin_support_item", { p_actor: uid, p_id: uuid(b.id), p_request: rid }),
  support_update: (uid, b, rid) => {
    const d = b.data || {}, out = {};
    for (const [k, n] of [["status", 20], ["priority", 20], ["assigned_email", 254]]) if (typeof d[k] === "string") out[k] = d[k].slice(0, n);
    return rpc("admin_support_update", { p_actor: uid, p_id: uuid(b.id), p_data: out, p_request: rid });
  },
  support_message: (uid, b, rid) => rpc("admin_support_message", { p_actor: uid, p_id: uuid(b.id), p_body: s(b.body, 2000), p_internal: b.internal === true, p_request: rid }),
  feedback: (uid, b) => rpc("admin_feedback", { p_actor: uid, p_status: s(b.status, 20) || null, p_kind: s(b.kind, 20) || null, p_page: int(b.page, 1) }),
  feedback_update: (uid, b, rid) => rpc("admin_feedback_update", { p_actor: uid, p_id: uuid(b.id), p_status: s(b.status, 20), p_request: rid }),
  work: (uid, b) => rpc("admin_work", { p_actor: uid, p_type: s(b.type, 20) || null, p_status: s(b.status, 20) || null, p_page: int(b.page, 1) }),
  work_save: (uid, b, rid) => {
    const d = b.data || {}, out = {};
    if (d.id) out.id = uuid(d.id);
    if (d.source_feedback) out.source_feedback = uuid(d.source_feedback);
    for (const [k, n] of [["type", 20], ["title", 160], ["description", 4000], ["status", 20], ["priority", 20], ["severity", 20], ["category", 40], ["assigned_email", 254]]) if (typeof d[k] === "string") out[k] = d[k].slice(0, n);
    return rpc("admin_work_save", { p_actor: uid, p_data: out, p_request: rid });
  },
  content: (uid, b) => rpc("admin_content", { p_actor: uid, p_type: s(b.type, 20) || null }),
  content_save: (uid, b, rid) => {
    const d = b.data || {}, out = {};
    if (d.id) out.id = uuid(d.id);
    for (const [k, n] of [["type", 20], ["title", 160], ["body", 20000], ["clinical_note", 500]]) if (typeof d[k] === "string") out[k] = d[k].slice(0, n);
    if (typeof d.clinical === "boolean") out.clinical = d.clinical;
    return rpc("admin_content_save", { p_actor: uid, p_data: out, p_action: s(b.op, 20), p_request: rid });
  },
  audit: (uid, b) => rpc("admin_audit", { p_actor: uid, p_admin: s(b.admin, 120) || null, p_action: s(b.filter_action, 64) || null, p_target: s(b.target, 80) || null, p_from: iso(b.from), p_to: iso(b.to), p_page: int(b.page, 1), p_size: int(b.size, 50) }),
  security: (uid) => rpc("admin_security", { p_actor: uid }),
  health: async (uid, b, rid, req) => { await rpc("admin_incidents", { p_actor: uid }); return healthChecks(uid, new URL(req.url).origin); }, // the incidents call checks health.view
  uptime: (uid, b) => rpc("admin_uptime", { p_actor: uid, p_days: Math.min(Math.max(int(b.days, 7), 1), 90) }),
  errors: (uid, b) => rpc("admin_errors", { p_actor: uid, p_status: s(b.status, 20) || null }),
  error: (uid, b) => { if (!/^[0-9a-f]{32}$/.test(b.id || "")) throw httpError(400, "invalid_id"); return rpc("admin_error", { p_actor: uid, p_fp: b.id }); },
  error_update: (uid, b, rid) => { if (!/^[0-9a-f]{32}$/.test(b.id || "")) throw httpError(400, "invalid_id"); return rpc("admin_error_update", { p_actor: uid, p_fp: b.id, p_status: s(b.status, 20), p_request: rid }); },
  prefs: (uid) => rpc("admin_prefs", { p_actor: uid }),
  set_prefs: (uid, b, rid) => rpc("admin_set_prefs", { p_actor: uid, p_email_alerts: b.email_alerts === true, p_min_severity: s(b.min_severity, 10) || "warning", p_request: rid }),
  settings_status: async (uid) => { const prefs = await rpc("admin_prefs", { p_actor: uid }); return { prefs, config: configStatus(), reports: Object.entries(REPORTS).map(([k, v]) => ({ key: k, ...v })) }; },
  exports: (uid) => rpc("admin_exports", { p_actor: uid }),
  report: (uid, b, rid) => runReport(uid, b, rid),
  // older names, kept for compatibility
  pdf: (uid, b, rid) => runReport(uid, { ...b, report: b.report || "growth", format: "pdf" }, rid),
  export: (uid, b, rid) => runReport(uid, { ...b, report: ({ summary: "growth", daily: "engagement", audit: "admin_activity" })[b.report] || b.report, format: "csv" }, rid),
};

const perms = (v) => { if (!Array.isArray(v) || v.length > 60 || v.some((x) => typeof x !== "string" || !/^[a-z_]+\.[a-z_]+$/.test(x))) throw httpError(400, "invalid"); return v; };

/* Founder only (checked by the database first): record the invitation, then send Supabase's invitation email to an email
   with no account yet. Someone who already has a Doctine account is told to sign in at /admin, where they accept. */
async function invite(uid, b, rid, req) {
  const email = s(b.email, 254).toLowerCase();
  const r = await rpc("admin_invite_create", { p_actor: uid, p_email: email, p_permissions: perms(b.permissions || []), p_reason: s(b.reason, 500), p_request: rid });
  if (!r || !r.ok) return r;
  let delivery = "existing_account";
  if (!r.existing_account) {
    const { base, service } = env();
    const to = new URL("/admin/", new URL(req.url).origin).toString();
    const res = await call(`${base}/auth/v1/invite?redirect_to=${encodeURIComponent(to)}`, { method: "POST", headers: serviceHeaders(service, { "content-type": "application/json" }), body: JSON.stringify({ email, data: {} }) });
    delivery = res.ok ? "email_sent" : "email_failed";
    if (!res.ok) console.error("[admin] invite email", res.status);
  }
  await rpc("admin_invite_delivery", { p_actor: uid, p_id: r.id, p_delivery: delivery, p_request: rid });
  return { ok: true, id: r.id, delivery };
}

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

    // 2. Are they in the leadership team? (The database decides; nothing from the browser is trusted.)
    const me = await rpc("admin_me", { p_actor: uid });
    if (!me || !me.role) {
      // Not a member. The only thing they can do is see, and accept, an invitation to their own verified email.
      if (me && me.invite && action === "me") return json({ role: null, invite: me.invite, request_id: rid });
      if (me && me.invite && action === "accept_invite") {
        const out = await rpc("admin_invite_accept", { p_actor: uid, p_id: uuid(b.id), p_request: rid });
        return json({ data: out, request_id: rid }, out && out.ok ? 200 : 403);
      }
      await rpc("admin_log_denied", { p_actor: uid, p_action: action, p_request: rid }).catch(() => {});
      return json({ error: "forbidden", suspended: !!(me && me.suspended), request_id: rid }, 403);
    }
    // 3. Two-step sign-in, always.
    const aal = claims(token).aal;
    if (aal !== "aal2") {
      if (action !== "me") return json({ error: "mfa_required", request_id: rid }, 403);
      return json({ ...me, mfa_required: true, mfa_enrolled: !!me.mfa_enrolled, request_id: rid });
    }
    if (action === "me") return json({ ...me, aal, request_id: rid });

    const out = await ACTIONS[action](uid, b, rid, req, token);
    if (out && out.content_type) return new Response(out.body, { status: 200, headers: { "content-type": out.content_type + (out.content_type.startsWith("text/") ? "; charset=utf-8" : ""), "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store", "x-request-id": rid } });
    return json({ data: out, request_id: rid });
  } catch (e) {
    if (e && e.status) return json({ error: e.error, request_id: rid }, e.status);
    console.error("[admin]", action, e && e.name);
    await reportServerError("/api/admin " + action, e, rid);
    return json({ error: "server_error", request_id: rid }, 502);
  }
};

export const config = { path: "/api/admin" };
