/**
 * Doctine · live service checks and error reporting, shared by /api/monitor, /api/errors and /api/admin.
 * Every check is made now, by this server; nothing is assumed. Uses the server key; never exposed to browsers.
 */
import { serviceHeaders } from "./supabase-keys.mjs";
import { anthropicUrl } from "./ai.mjs";

const base = () => (process.env.SUPABASE_URL || "").replace(/\/$/, "");
async function timed(url, init, ms = 5000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); const t0 = Date.now();
  try { const r = await fetch(url, { ...init, signal: ac.signal }); return { ok: r.status < 500, status: r.status, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, status: null, ms: Date.now() - t0, error: e && e.name === "AbortError" ? "timeout" : "unreachable" }; }
  finally { clearTimeout(t); }
}

/** Checks the app itself (its version file, through the public address), the database, sign-in, storage and, when a key
 *  is configured, the AI provider (a free model-list call, no AI request). */
export async function runChecks(origin) {
  const b = base(), anon = process.env.SUPABASE_ANON_KEY || "", key = process.env.SUPABASE_SERVICE_ROLE_KEY || "", ai = process.env.ANTHROPIC_API_KEY || "";
  const [app, database, auth, storage, aiCheck] = await Promise.all([
    origin ? timed(new URL("/version.json", origin).toString(), { headers: { "cache-control": "no-cache" } }) : Promise.resolve(null),
    timed(`${b}/rest/v1/rpc/public_settings`, { method: "POST", headers: serviceHeaders(key, { "content-type": "application/json" }), body: "{}" }),
    timed(`${b}/auth/v1/health`, { headers: { apikey: anon } }),
    timed(`${b}/storage/v1/bucket/health-documents`, { headers: serviceHeaders(key) }),
    ai ? timed(anthropicUrl().replace(/\/v1\/messages$/, "/v1/models?limit=1"), { headers: { "x-api-key": ai, "anthropic-version": "2023-06-01" } }) : Promise.resolve(null),
  ]);
  if (aiCheck && (aiCheck.status === 401 || aiCheck.status === 403)) Object.assign(aiCheck, { ok: false, error: "auth_failed" });
  else if (aiCheck && aiCheck.status === 429) Object.assign(aiCheck, { ok: false, error: "rate_limited" });
  const at = new Date().toISOString();
  return [["app", "This app (app.doctine.com)", app], ["database", "Database (Data API)", database], ["auth", "Sign-in service", auth], ["storage", "File storage", storage], ["ai", "AI provider (Anthropic)", aiCheck]]
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
export const recordChecks = (checks) => rpc("record_uptime", { p_rows: checks.map(({ target, ok, status, ms, error }) => ({ target, ok, status, ms, error: error || "" })) });

/** Server-side error report: kind and where only; the database cleans the message. Never throws. */
export function reportServerError(where, err, requestId) {
  try {
    if (!base() || !process.env.SUPABASE_SERVICE_ROLE_KEY) return Promise.resolve();
    const kind = (err && err.name) || "Error", message = (err && err.message) || String(err || "");
    return rpc("report_error", { p_source: "server", p_kind: kind, p_message: message, p_location: String(where || "").slice(0, 120), p_release: (process.env.CF_PAGES_COMMIT_SHA || "").slice(0, 12),
      p_stack: String((err && err.stack) || "").slice(0, 1500), p_route: String(where || "").slice(0, 80), p_env: process.env.DOCTINE_ENV || "", p_request: requestId || "" }, 3000).catch(() => {});
  } catch { return Promise.resolve(); }
}

/** Emails new alerts through Resend when RESEND_API_KEY and ALERT_EMAIL_FROM are set. Recipients: ALERT_EMAIL_TO (all
 *  alerts) plus admins who switched on email alerts in Admin settings (alerts at or above their chosen severity). */
const RANK = { info: 0, warning: 1, critical: 2 };
export function emailConfigured() { return Boolean(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_FROM); }
export async function emailAlerts(alerts, recipients = []) {
  const key = process.env.RESEND_API_KEY, from = process.env.ALERT_EMAIL_FROM;
  if (!key || !from) return "not_configured";
  const fixed = String(process.env.ALERT_EMAIL_TO || "").split(",").map((x) => x.trim()).filter(Boolean);
  const people = new Map(fixed.map((e) => [e.toLowerCase(), { email: e, min: 0 }]));
  for (const r of recipients || []) if (r && r.email && !people.has(r.email.toLowerCase())) people.set(r.email.toLowerCase(), { email: r.email, min: RANK[r.min_severity] ?? 1 });
  if (!people.size) return "no_recipients";
  let sent = 0, failed = 0;
  for (const { email, min } of people.values()) {
    const mine = alerts.filter((a) => (RANK[a.severity] ?? 1) >= min);
    if (!mine.length) continue;
    const lines = mine.map((a) => `• [${a.severity}]${a.service ? " " + a.service + ":" : ""} ${a.message} (opened ${new Date(a.opened_at).toUTCString()})`).join("\n");
    try {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [email], subject: `Doctine alert: ${mine.length === 1 ? mine[0].message : mine.length + " new alerts"}`,
          text: `${lines}\n\nOpen the alert centre: https://app.doctine.com/admin/#/alerts\nAcknowledge, mute or resolve alerts there. Change your email settings under Admin settings.` }) });
      if (r.ok) sent++; else failed++;
    } catch { failed++; }
  }
  return sent && !failed ? "sent" : sent ? "partly_sent" : "failed";
}
