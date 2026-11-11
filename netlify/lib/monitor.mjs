/**
 * Doctine · live service checks and error reporting, shared by /api/monitor, /api/errors and /api/admin.
 * Every check is made now, by this server; nothing is assumed. Uses the server key; never exposed to browsers.
 */
import { serviceHeaders } from "./supabase-keys.mjs";

const base = () => (process.env.SUPABASE_URL || "").replace(/\/$/, "");
async function timed(url, init, ms = 5000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); const t0 = Date.now();
  try { const r = await fetch(url, { ...init, signal: ac.signal }); return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, status: null, ms: Date.now() - t0, error: e && e.name === "AbortError" ? "timeout" : "unreachable" }; }
  finally { clearTimeout(t); }
}

/** Checks the app itself (its version file, through the public address), the database, sign-in and storage. */
export async function runChecks(origin) {
  const b = base(), anon = process.env.SUPABASE_ANON_KEY || "", key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const [app, database, auth, storage] = await Promise.all([
    origin ? timed(new URL("/version.json", origin).toString(), { headers: { "cache-control": "no-cache" } }) : Promise.resolve(null),
    timed(`${b}/rest/v1/rpc/public_settings`, { method: "POST", headers: serviceHeaders(key, { "content-type": "application/json" }), body: "{}" }),
    timed(`${b}/auth/v1/health`, { headers: { apikey: anon } }),
    timed(`${b}/storage/v1/bucket/health-documents`, { headers: serviceHeaders(key) }),
  ]);
  const at = new Date().toISOString();
  return [["app", "This app (app.doctine.com)", app], ["database", "Database (Data API)", database], ["auth", "Sign-in service", auth], ["storage", "File storage", storage]]
    .filter(([, , r]) => r).map(([target, name, r]) => ({ target, name, checked_at: at, ...r }));
}

export async function rpc(fn, args, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`${base()}/rest/v1/rpc/${fn}`, { method: "POST", headers: serviceHeaders(process.env.SUPABASE_SERVICE_ROLE_KEY || "", { "content-type": "application/json" }), body: JSON.stringify(args), signal: ac.signal });
    const j = await r.json().catch(() => null);
    return r.ok ? { ok: true, data: j } : { ok: false, status: r.status, code: j && j.code };
  } catch { return { ok: false, status: 0 }; } finally { clearTimeout(t); }
}

/** Records a round of checks (the database ignores rounds closer than 4 minutes apart). */
export const recordChecks = (checks) => rpc("record_uptime", { p_rows: checks.map(({ target, ok, status, ms }) => ({ target, ok, status, ms })) });

/** Server-side error report: kind and where only; the database cleans the message. Never throws. */
export function reportServerError(where, err) {
  try {
    if (!base() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return Promise.resolve();
    const kind = (err && err.name) || "Error", message = (err && err.message) || String(err || "");
    return rpc("report_error", { p_source: "server", p_kind: kind, p_message: message, p_location: String(where || "").slice(0, 120), p_release: (process.env.CF_PAGES_COMMIT_SHA || "").slice(0, 12) }, 3000).catch(() => {});
  } catch { return Promise.resolve(); }
}

/** Emails new alerts through Resend when RESEND_API_KEY, ALERT_EMAIL_TO and ALERT_EMAIL_FROM are set. */
export async function emailAlerts(alerts) {
  const key = process.env.RESEND_API_KEY, to = process.env.ALERT_EMAIL_TO, from = process.env.ALERT_EMAIL_FROM;
  if (!key || !to || !from) return "not_configured";
  const lines = alerts.map((a) => `• [${a.severity}] ${a.message} (opened ${new Date(a.opened_at).toUTCString()})`).join("\n");
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: to.split(",").map((x) => x.trim()).filter(Boolean), subject: `Doctine alert: ${alerts.length === 1 ? alerts[0].message : alerts.length + " new alerts"}`,
        text: `${lines}\n\nOpen the alert centre: https://app.doctine.com/admin/#/alerts\nAcknowledge or resolve alerts there.` }) });
    return r.ok ? "sent" : "failed";
  } catch { return "failed"; }
}
