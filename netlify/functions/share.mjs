/**
 * Doctine · /api/share: a person shares parts of their own record with one verified doctor, for 1, 7 or 30 days, and can
 * stop at any time. Behind the `record_sharing` switch (off by default, Founder only).
 *
 *   GET                                  my shares (active first), every opening by a doctor, and the form's choices
 *   POST {action:"lookup", code}         the verified doctor behind a code: name, registration number, council
 *   POST {action:"create", code, scopes, days, purpose, note, confirm:true}
 *   POST {action:"revoke", id}           stop a share now
 *
 * The person is always the one in the sign-in token. Doctors read shared records through /api/doctor, and every
 * opening is logged where the person can see it. See docs/DOCTOR_NETWORK.md.
 */
import { json, readJson, refused } from "../lib/ai.mjs";
import { getSettings } from "../lib/settings.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { serviceHeaders } from "../lib/supabase-keys.mjs";
import { SCOPES, PURPOSES, DAYS, CODE, cleanCode, cleanShare } from "../lib/doctors/sharing.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sharingOn(env = process.env, fetchImpl = fetch) {
  const st = await getSettings({ env, fetchImpl });
  if (st.source === "none") return true;
  return st.flags.record_sharing === true;
}

const userCache = new Map();
export async function verifiedUser(token, { env, fetchImpl }) {
  if (!token || token.length > 4096) return null;
  const hit = userCache.get(token); if (hit && hit.until > Date.now()) return hit.uid;
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), anon = env.SUPABASE_ANON_KEY || "";
  if (!base || !anon) return null;
  try {
    const r = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    if (typeof u.id !== "string" || !UUID.test(u.id) || u.is_anonymous) return null;
    userCache.set(token, { uid: u.id, until: Date.now() + 60_000 }); if (userCache.size > 2000) userCache.delete(userCache.keys().next().value);
    return u.id;
  } catch { return null; }
}
export const _resetShareCache = () => userCache.clear();

export function rpcClient({ env, fetchImpl }) {
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !key) return null;
  return async function rpc(name, args) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: "POST", signal: ac.signal, headers: serviceHeaders(key, { "content-type": "application/json" }), body: JSON.stringify(args) });
      const text = await r.text();
      if (!r.ok) {
        let code = "db_error", message = ""; try { const j = JSON.parse(text); message = String(j.message || "").slice(0, 200);
          code = j.code === "P0002" ? "not_found" : j.code === "42501" ? "forbidden" : ["22023", "23514", "22P02", "23505"].includes(j.code) ? "invalid" : j.code === "PGRST202" || j.code === "42883" ? "not_installed" : "db_error"; } catch {}
        throw Object.assign(new Error(name + " " + r.status), { code, message });
      }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(t); }
  };
}

const OPTIONS = { scopes: SCOPES, purposes: PURPOSES, days: DAYS };

export default async function handler(req, context, { env = process.env, fetchImpl = fetch, log = (l) => console.log(JSON.stringify(l)) } = {}) {
  const t0 = Date.now();
  const done = (action, res, extra = {}) => { log({ fn: "share", action, status: res.status, ms: Date.now() - t0, ...extra }); return res; };
  if (req.method !== "GET" && req.method !== "POST") return done("method", json({ error: "method_not_allowed" }, 405));
  if (!(await sharingOn(env, fetchImpl))) return done("off", json({ error: "switched_off", message: "Sharing with a doctor isn't available yet." }, 503));
  const rpc = rpcClient({ env, fetchImpl });
  if (!rpc) return done("no_store", json({ error: "not_configured" }, 503));
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const uid = await verifiedUser(token, { env, fetchImpl });
  if (!uid) return done("auth", json({ error: "unauthorized", message: "Please sign in again." }, 401));
  const rate = await checkRate(req, context, "share", { env, fetchImpl });
  if (!rate.allowed) return done("rate", refused(rate, { error: rate.error, retry_after: rate.retryAfter }));
  try {
    if (req.method === "GET") return done("list", json({ ...(await rpc("share_list", { p_patient: uid })), options: OPTIONS }));
    const parsed = await readJson(req, 8_000);
    if (parsed.error) return done("body", json({ error: "invalid" }, parsed.status));
    const b = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body) ? parsed.body : {};
    if (b.action === "lookup") {
      if (!CODE.test(String(b.code || "")) || cleanCode(b.code).length !== 10) return done("lookup", json({ error: "invalid", message: "That code doesn't look right. It has 10 letters and numbers." }, 400));
      return done("lookup", json({ doctor: await rpc("share_lookup", { p_patient: uid, p_code: cleanCode(b.code) }) }));
    }
    if (b.action === "create") {
      const c = cleanShare(b);
      if (!c.ok) return done("create", json({ error: "invalid", message: c.error }, 400));
      const { code, ...rest } = c.share;
      await rpc("share_create", { p_patient: uid, p_code: code, p: rest });
      return done("create", json({ ok: true, ...(await rpc("share_list", { p_patient: uid })) }), { scopes: rest.scopes.length, days: rest.days });
    }
    if (b.action === "revoke") {
      if (!UUID.test(String(b.id || ""))) return done("revoke", json({ error: "invalid" }, 400));
      await rpc("share_revoke", { p_patient: uid, p_id: b.id });
      return done("revoke", json({ ok: true, ...(await rpc("share_list", { p_patient: uid })) }));
    }
    return done("unknown", json({ error: "invalid_action" }, 400));
  } catch (e) {
    const code = (e && e.code) || "server_error";
    if (code === "not_found") return done("db", json({ error: "not_found", message: "No verified doctor has that code. Check it with your doctor." }, 404));
    if (code === "invalid") return done("db", json({ error: "invalid", message: /already sharing|at most|please confirm|1, 7 or 30/i.test(e.message || "") ? e.message : "That wasn't accepted." }, 400));
    if (code === "not_installed") return done("db", json({ error: "not_configured", message: "Sharing isn't set up on this site yet." }, 503));
    return done("error", json({ error: "server_error" }, 500), { code });
  }
}

export const config = { path: "/api/share" };
