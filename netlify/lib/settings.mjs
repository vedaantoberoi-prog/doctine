/**
 * Doctine · platform switches, maintenance mode and live announcements, read from the database (public.public_settings,
 * migration 20261112000000_admin_console.sql) with the server key and remembered for 20 seconds.
 * If the database is configured but can't be reached (or the migration isn't applied yet), the safe defaults below are
 * used and `source` says "default", so nothing sensitive is silently switched on. With no database at all (local
 * development and the browser tests) there are no switches to obey: `source` is "none" and the assistant isn't gated.
 */
import { serviceHeaders } from "./supabase-keys.mjs";

export const DEFAULTS = Object.freeze({
  flags: { registrations: true, document_upload: true, pdf_reading: true, sample_data: true, ai_assistant: false },
  maintenance: { on: false, message: "" },
  announcements: [],
});
let cache = null;

export async function getSettings({ env = process.env, fetchImpl = fetch, fresh = false } = {}) {
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { ...DEFAULTS, flags: { ...DEFAULTS.flags, ai_assistant: true }, source: "none" };
  if (!fresh && cache && cache.base === base && cache.until > Date.now()) return cache.value;
  let value = { ...DEFAULTS, source: "default" };
  {
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1500);
      const r = await fetchImpl(`${base}/rest/v1/rpc/public_settings`, { method: "POST", headers: serviceHeaders(key, { "content-type": "application/json" }), body: "{}", signal: ac.signal }).finally(() => clearTimeout(t));
      if (r.ok) {
        const s = await r.json();
        value = { flags: { ...DEFAULTS.flags, ...(s && s.flags) }, maintenance: { ...DEFAULTS.maintenance, ...(s && s.maintenance) },
          announcements: Array.isArray(s && s.announcements) ? s.announcements.slice(0, 5) : [], source: "database" };
      }
    } catch { /* keep defaults */ }
  }
  cache = { value, base, until: Date.now() + (value.source === "database" ? 20_000 : 5_000) };
  return value;
}
export const _resetSettingsCache = () => { cache = null; };

/** True when the admin console has switched the assistant off, or maintenance mode is on. */
export async function aiSwitchedOff(opts) {
  const st = await getSettings(opts);
  return st.flags.ai_assistant !== true || st.maintenance.on === true;
}
