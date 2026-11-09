/**
 * Doctine · /api/account  DELETE — permanently deletes the signed-in person's account.
 * 1. Confirms who is asking from their own sign-in token (never from the request body).
 * 2. Removes every file under their folder in the private bucket.
 * 3. Deletes the auth user; the database removes all their rows through ON DELETE CASCADE.
 * Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (server only, never sent to browsers).
 */
import { serviceHeaders } from "../lib/supabase-keys.mjs";
import { json } from "../lib/ai.mjs";
import { checkRate } from "../lib/ratelimit.mjs";

const BUCKET = "health-documents";

async function call(url, init = {}, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

export default async (req, context) => {
  if (req.method !== "DELETE") return json({ error: "invalid" }, 405);
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const anon = process.env.SUPABASE_ANON_KEY || "";
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !anon || !service) {
    return json({ error: "not_configured", missing: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]), message: "Account deletion isn’t set up on this site yet. Nothing was removed." }, 503);
  }
  const rl = await checkRate(req, context, "account");
  if (!rl.allowed) return json({ error: rl.error, message: "Too many attempts. Please wait and try again." }, rl.status);

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized", message: "Please sign in again." }, 401);

  try {
    // 1. Who is this?
    const who = await call(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } });
    if (!who.ok) return json({ error: "unauthorized", message: "Please sign in again." }, 401);
    const user = await who.json();
    const uid = user && user.id;
    if (!uid || !/^[0-9a-f-]{36}$/i.test(uid)) return json({ error: "unauthorized", message: "Please sign in again." }, 401);
    const admin = serviceHeaders(service, { "content-type": "application/json" });

    // 2. Every file under their folder, page by page ({uid}/{record}/{file}; deeper folders are followed too).
    const PAGE = 1000;
    const listPage = async (prefix, offset) => {
      const r = await call(`${base}/storage/v1/object/list/${BUCKET}`, { method: "POST", headers: admin, body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: "name", order: "asc" } }) });
      if (!r.ok) throw new Error("storage list " + r.status);
      const rows = await r.json();
      if (!Array.isArray(rows)) throw new Error("storage list: unexpected reply");
      return rows;
    };
    const collect = async (prefix, depth = 0) => {
      if (depth > 4) throw new Error("storage list: folders nested too deeply");
      const out = [];
      for (let offset = 0; ; offset += PAGE) {
        const rows = await listPage(prefix, offset);
        for (const e of rows) {
          if (!e || typeof e.name !== "string" || !e.name || e.name.includes("..")) continue;
          if (e.id) out.push(`${prefix}/${e.name}`); else out.push(...await collect(`${prefix}/${e.name}`, depth + 1));
        }
        if (rows.length < PAGE) break;
      }
      return out;
    };
    const paths = await collect(uid);
    if (paths.some((p) => !p.startsWith(uid + "/"))) throw new Error("refusing to delete outside the person's folder");
    let removed = 0;
    for (let i = 0; i < paths.length; i += 500) {
      const batch = paths.slice(i, i + 500);
      const r = await call(`${base}/storage/v1/object/${BUCKET}`, { method: "DELETE", headers: admin, body: JSON.stringify({ prefixes: batch }) });
      if (!r.ok) return json({ error: "delete_failed", files_removed: removed, files_total: paths.length,
        message: `Some of your files couldn’t be removed (${removed} of ${paths.length} done). Your account was NOT deleted. Please try again.` }, 502);
      removed += batch.length;
    }
    // Check nothing is left before the account goes (a file left behind would have no owner afterwards).
    const left = await collect(uid);
    if (left.length) return json({ error: "delete_failed", files_removed: removed, files_left: left.length,
      message: `${left.length} file${left.length === 1 ? "" : "s"} could not be removed. Your account was NOT deleted. Please try again.` }, 502);

    // 3. The account; rows go with it.
    const del = await call(`${base}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: admin });
    if (!del.ok) throw new Error("auth delete " + del.status);
    return json({ deleted: true, files_removed: removed });
  } catch (e) {
    console.error("[account] delete failed", e && e.message);
    return json({ error: "delete_failed", message: "Your account couldn’t be deleted. Please try again; if it keeps failing, contact support." }, 502);
  }
};

export const config = { path: "/api/account" };
