/**
 * Doctine · /api/doctor: a doctor's own application to join the Doctine doctor network (phase 1: identity, credentials,
 * verification). Behind the `doctor_onboarding` switch (off by default, Founder only).
 *
 *   GET                                       the person's application, its status and history, and the form's choices
 *   POST {action:"save", profile}             save details (only while the application can be edited)
 *   POST {action:"upload", kind, file_name, data}   add a credential file (base64; PDF, JPEG or PNG, at most 5 MB)
 *   POST {action:"remove_document", id}       take a file off the application (the file and its record are kept)
 *   POST {action:"submit"}                    submit for verification (the database checks it is complete)
 *
 * The person is always the one in the sign-in token, never an id from the request. Files go to the private storage bucket
 * `practitioner-credentials`, which browsers can't reach; reviewers open them through the admin console, where every
 * opening is logged. The file's type is read from its bytes, not trusted from its name. Nothing here shows a doctor to
 * patients, and there are no consultations: see docs/DOCTOR_NETWORK.md.
 */
import { createHash, randomUUID } from "node:crypto";
import { json, readJson } from "../lib/ai.mjs";
import { getSettings } from "../lib/settings.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { serviceHeaders } from "../lib/supabase-keys.mjs";
import { cleanProfile, sniffMime, extFor, DOCUMENT_KINDS, MAX_FILE_BYTES, STATUS_TEXT, COUNCILS, SPECIALTIES, LANGUAGES, MODES } from "../lib/doctors/verification.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4096;   // a 5 MB file as base64, plus the rest of the request
export const BUCKET = "practitioner-credentials";

export async function onboardingOn(env = process.env, fetchImpl = fetch) {
  const st = await getSettings({ env, fetchImpl });
  if (st.source === "none") return true;                        // local development and tests: no switches exist
  return st.flags.doctor_onboarding === true;
}

const userCache = new Map();
async function verifiedUser(token, { env, fetchImpl }) {
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
export const _resetDoctorCache = () => userCache.clear();

function store({ env, fetchImpl }) {
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !key) return null;
  async function rpc(name, args) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: "POST", signal: ac.signal, headers: serviceHeaders(key, { "content-type": "application/json" }), body: JSON.stringify(args) });
      const text = await r.text();
      if (!r.ok) {
        let code = "db_error", message = ""; try { const j = JSON.parse(text); message = String(j.message || "").slice(0, 200);
          code = j.code === "P0002" ? "not_found" : ["22023", "23514", "22P02", "23505"].includes(j.code) ? "invalid" : j.code === "PGRST202" || j.code === "42883" ? "not_installed" : "db_error"; } catch {}
        throw Object.assign(new Error(name + " " + r.status), { code, message });
      }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(t); }
  }
  async function put(path, bytes, mime) {
    const r = await fetchImpl(`${base}/storage/v1/object/${BUCKET}/${path}`, { method: "POST", headers: serviceHeaders(key, { "content-type": mime, "x-upsert": "false", "cache-control": "no-store" }), body: bytes });
    if (!r.ok) throw Object.assign(new Error("storage " + r.status), { code: "storage_error" });
  }
  async function drop(path) {
    await fetchImpl(`${base}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers: serviceHeaders(key, { "content-type": "application/json" }), body: JSON.stringify({ prefixes: [path] }) }).catch(() => {});
  }
  return { rpc, put, drop };
}

const OPTIONS = { councils: COUNCILS, specialties: SPECIALTIES, languages: LANGUAGES, modes: MODES, document_kinds: DOCUMENT_KINDS, status_text: STATUS_TEXT, max_file_bytes: MAX_FILE_BYTES };

export default async function handler(req, context, { env = process.env, fetchImpl = fetch, log = (l) => console.log(JSON.stringify(l)) } = {}) {
  const t0 = Date.now();
  const done = (action, res, extra = {}) => { log({ fn: "doctor", action, status: res.status, ms: Date.now() - t0, ...extra }); return res; };
  if (req.method !== "GET" && req.method !== "POST") return done("method", json({ error: "method_not_allowed" }, 405));
  if (!(await onboardingOn(env, fetchImpl))) return done("off", json({ error: "switched_off", message: "Doctor sign-up isn't open yet." }, 503));
  const db = store({ env, fetchImpl });
  if (!db) return done("no_store", json({ error: "not_configured", message: "This site isn't connected to its database." }, 503));

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const uid = await verifiedUser(token, { env, fetchImpl });
  if (!uid) return done("auth", json({ error: "unauthorized", message: "Please sign in again." }, 401));
  const rate = await checkRate(req, context, "doctor", { env, fetchImpl });
  if (!rate.allowed) return done("rate", json({ error: rate.error, retry_after: rate.retryAfter }, rate.status));

  try {
    if (req.method === "GET") return done("status", json({ available: true, application: await db.rpc("practitioner_get", { p_user: uid }), options: OPTIONS }));

    const parsed = await readJson(req, MAX_BODY);
    if (parsed.error) return done("body", json({ error: parsed.error === "too_large" ? "too_large" : "invalid", message: parsed.error === "too_large" ? "Files can be at most 5 MB." : undefined }, parsed.status));
    const body = parsed.body && typeof parsed.body === "object" && !Array.isArray(parsed.body) ? parsed.body : {};
    const action = String(body.action || "");

    if (action === "save") {
      const c = cleanProfile(body.profile);
      if (!c.ok) return done(action, json({ error: "invalid", fields: c.errors }, 400));
      return done(action, json({ application: await db.rpc("practitioner_save", { p_user: uid, p: c.profile }) }));
    }
    if (action === "upload") {
      const kind = String(body.kind || "");
      if (!Object.prototype.hasOwnProperty.call(DOCUMENT_KINDS, kind)) return done(action, json({ error: "invalid", message: "Choose what the document is." }, 400));
      const data = typeof body.data === "string" ? body.data.replace(/^data:[^,]*,/, "") : "";
      if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) return done(action, json({ error: "invalid", message: "The file didn't arrive." }, 400));
      const bytes = Buffer.from(data, "base64");
      if (!bytes.length) return done(action, json({ error: "invalid", message: "The file is empty." }, 400));
      if (bytes.length > MAX_FILE_BYTES) return done(action, json({ error: "too_large", message: "Files can be at most 5 MB." }, 413));
      const mime = sniffMime(bytes.subarray(0, 16));
      if (!mime) return done(action, json({ error: "unsupported_type", message: "Upload a PDF, JPEG or PNG." }, 415));
      const name = (String(body.file_name || "document").replace(/[^\w .()-]+/g, "_").trim() || "document").slice(0, 160);
      const path = `${uid}/${randomUUID()}.${extFor(mime)}`;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await db.put(path, bytes, mime);
      try { await db.rpc("practitioner_document_add", { p_user: uid, p: { kind, path, file_name: name, mime, size_bytes: bytes.length, sha256 } }); }
      catch (e) { await db.drop(path); throw e; }                 // nothing half-saved: the file goes if its record didn't
      return done(action, json({ application: await db.rpc("practitioner_get", { p_user: uid }) }), { kind, bytes: bytes.length });
    }
    if (action === "remove_document") {
      if (!UUID.test(String(body.id || ""))) return done(action, json({ error: "invalid" }, 400));
      await db.rpc("practitioner_document_remove", { p_user: uid, p_id: body.id });
      return done(action, json({ application: await db.rpc("practitioner_get", { p_user: uid }) }));
    }
    if (action === "submit") {
      const r = await db.rpc("practitioner_submit", { p_user: uid });
      if (r && r.ok === false) return done(action, json({ error: r.error || "incomplete", missing: r.missing || [] }, 400));
      return done(action, json({ application: await db.rpc("practitioner_get", { p_user: uid }) }));
    }
    return done("unknown", json({ error: "invalid_action" }, 400));
  } catch (e) {
    const code = (e && e.code) || "server_error";
    if (code === "invalid") return done("db", json({ error: "invalid", message: e.message && /can not|cannot|at most|qualification/i.test(e.message) ? e.message : "That wasn't accepted." }, 400));
    if (code === "not_found") return done("db", json({ error: "not_found" }, 404));
    if (code === "not_installed") return done("db", json({ error: "not_configured", message: "Doctor sign-up isn't set up on this site yet." }, 503));
    if (code === "storage_error") return done("storage", json({ error: "storage_error", message: "The file couldn't be stored. Please try again." }, 502));
    return done("error", json({ error: "server_error" }, 500), { code });
  }
}

export const config = { path: "/api/doctor" };
