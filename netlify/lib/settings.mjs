/**
 * Doctine · platform switches, maintenance mode and live announcements, read from the database (public.public_settings,
 * migration 20261112000000_admin_console.sql) with the server key and remembered for 20 seconds.
 * If the database is configured but can't be reached (or the migration isn't applied yet), the safe defaults below are
 * used and `source` says "default", so nothing sensitive is silently switched on. With no database at all (local
 * development and the browser tests) there are no switches to obey: `source` is "none" and the assistant isn't gated.
 */
import { serviceHeaders } from "./supabase-keys.mjs";

export const DEFAULTS = Object.freeze({
  flags: { registrations: true, document_upload: true, pdf_reading: true, sample_data: true, ai_assistant: false, ai_gateway: false, ai_orchestrator: false, ai_actions: false, guardian: false, doctor_onboarding: false, record_sharing: false },
  maintenance: { on: false, message: "" },
  announcements: [],
  whatsNew: [],
});
let cache = null, lastGood = null;
const STALE_OK_MS = 120_000; // a value really read from the database may stand in for up to 2 minutes if it can't be read now

/* Reads the switches. A new server instance's first request also pays for the connection to the database, which can
   take longer than a warm read (staging, 27 Nov 2026: the first config after a cold start fell back to "assistant
   off"). So: one retry with a longer limit; then the last value really read (if recent); only then the safe defaults,
   remembered for 2 seconds so the next request tries again. */
async function readOnce(base, key, fetchImpl, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetchImpl(`${base}/rest/v1/rpc/public_settings`, { method: "POST", headers: serviceHeaders(key, { "content-type": "application/json" }), body: "{}", signal: ac.signal });
    if (!r.ok) return null;
    const s = await r.json();
    return { flags: { ...DEFAULTS.flags, ...(s && s.flags) }, maintenance: { ...DEFAULTS.maintenance, ...(s && s.maintenance) },
      announcements: Array.isArray(s && s.announcements) ? s.announcements.slice(0, 5) : [],
      whatsNew: Array.isArray(s && s.whats_new) ? s.whats_new.slice(0, 5) : [], source: "database" };
  } catch { return null; } finally { clearTimeout(t); }
}
export async function getSettings({ env = process.env, fetchImpl = fetch, fresh = false } = {}) {
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { ...DEFAULTS, flags: { ...DEFAULTS.flags, ai_assistant: true }, source: "none" };
  if (!fresh && cache && cache.base === base && cache.until > Date.now()) return cache.value;
  let value = (await readOnce(base, key, fetchImpl, 2500)) || (await readOnce(base, key, fetchImpl, 3500));
  if (value) lastGood = { value, base, at: Date.now() };
  else if (lastGood && lastGood.base === base && Date.now() - lastGood.at < STALE_OK_MS) value = { ...lastGood.value, source: "database_recent" };
  else value = { ...DEFAULTS, source: "default" };
  cache = { value, base, until: Date.now() + (value.source === "database" ? 20_000 : 2_000) };
  return value;
}
export const _resetSettingsCache = () => { cache = null; lastGood = null; };

/** True when the admin console has switched the assistant off, or maintenance mode is on. */
export async function aiSwitchedOff(opts) {
  const st = await getSettings(opts);
  return st.flags.ai_assistant !== true || st.maintenance.on === true;
}
