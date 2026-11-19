/**
 * Doctine · /api/events — first-party product measurements (POST { name, props, key }).
 * Only event names and short property codes allowed by public.record_event are stored; free text is refused by the
 * database. Never send document contents, values, names, search terms, messages, passwords or tokens here.
 * The account, if any, comes from the person's own sign-in token. Retries with the same key are counted once.
 * Respects the person's analytics choice: the app only sends events when they have not turned analytics off.
 */
import { serviceHeaders } from "../lib/supabase-keys.mjs";
import { json, readJson } from "../lib/ai.mjs";
import { checkRate } from "../lib/ratelimit.mjs";

// Every event needs a signed-in account: anonymous reports could be used to inflate failure counts and trigger false
// alerts. (App errors go to /api/errors, which has its own limits and stores no account.)
const ANON_OK = new Set();

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "invalid" }, 405);
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, ""), anon = process.env.SUPABASE_ANON_KEY, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !anon || !service) return json({ ok: false, stored: false, reason: "not_configured" }, 202);
  const rl = await checkRate(req, context, "events");
  if (!rl.allowed) return json({ error: rl.error }, rl.status);
  const parsed = await readJson(req, 2048);
  if (parsed.error) return json({ error: parsed.error }, parsed.status);
  const b = parsed.body || {};
  const name = typeof b.name === "string" ? b.name.slice(0, 40) : "";
  const key = typeof b.key === "string" ? b.key.slice(0, 80) : "";
  const props = b.props && typeof b.props === "object" && !Array.isArray(b.props) ? b.props : {};

  let uid = null;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token && token.length < 4096) {
    try {
      const r = await fetch(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } });
      if (r.ok) { const u = await r.json(); if (u && /^[0-9a-f-]{36}$/i.test(u.id || "")) uid = u.id; }
    } catch { /* treated as signed out */ }
  }
  if (!uid && !ANON_OK.has(name)) return json({ error: "unauthorized" }, 401);
  try {
    const r = await fetch(`${base}/rest/v1/rpc/record_event`, { method: "POST", headers: serviceHeaders(service, { "content-type": "application/json" }),
      body: JSON.stringify({ p_user: uid, p_name: name, p_props: props, p_dedupe: key }) });
    if (r.ok) return json({ ok: true, stored: await r.json() === true });
    const e = await r.json().catch(() => ({}));
    return json({ error: e && e.code === "22023" ? "invalid_event" : "not_stored" }, e && e.code === "22023" ? 400 : 202);
  } catch { return json({ ok: false, stored: false }, 202); }
};

export const config = { path: "/api/events" };
