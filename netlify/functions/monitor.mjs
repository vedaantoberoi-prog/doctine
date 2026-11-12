/**
 * Doctine · /api/monitor — the scheduled health round (GET or POST, no sign-in needed).
 * Called every 15 minutes by .github/workflows/uptime.yml. This server checks the app, database, sign-in and storage
 * itself and records the results (nothing the caller sends is used), evaluates the alert rules, and emails new alerts
 * when email is configured (RESEND_API_KEY, ALERT_EMAIL_TO, ALERT_EMAIL_FROM). The reply holds counts only.
 * Calling it more often changes nothing: the database records at most one round per 4 minutes.
 */
import { json } from "../lib/ai.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { runChecks, recordChecks, rpc, emailAlerts } from "../lib/monitor.mjs";

export default async (req, context) => {
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "invalid" }, 405);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "not_configured" }, 503);
  const rl = await checkRate(req, context, "monitor");
  if (!rl.allowed) return json({ error: rl.error }, rl.status);
  const checks = await runChecks(new URL(req.url).origin);
  const rec = await recordChecks(checks);
  const run = await rpc("monitor_run", {});
  let email = "not_configured", unnotified = 0;
  if (run.ok) {
    const pending = run.data.to_notify || [];
    if (pending.length) {
      email = await emailAlerts(pending, run.data.recipients);
      if (email === "sent" || email === "partly_sent") await rpc("monitor_mark_notified", { p_ids: pending.map((a) => a.id), p_via: "email" });
      else unnotified = pending.length;
    } else email = "nothing_new";
  }
  return json({
    checked: checks.map(({ target, ok }) => ({ target, ok })),
    recorded: rec.ok ? rec.data === true : false,
    open_alerts: run.ok ? run.data.open : null,
    unnotified_alerts: unnotified, // alerts that could not be emailed: the GitHub workflow fails on these, so GitHub emails the owner
    email,
    alerts_ok: run.ok,
  });
};

export const config = { path: "/api/monitor" };
