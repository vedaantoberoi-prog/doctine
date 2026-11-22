/**
 * Doctine · gateway database access, AS THE SIGNED-IN PERSON.
 *
 * Every read goes to Supabase's REST API with the public (anon) key and the person's own sign-in token, so the
 * database's row-level security decides what is visible: only their own rows. The gateway never holds the
 * service-role key, never accepts a user id from the model or the request, and never builds SQL. Tables and columns
 * are fixed by the capability registry; filters are passed as PostgREST parameters with encoded values.
 */
export const MAX_ROWS = 1000;

export class GatewayError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function userDb({ base, anon, token, fetchImpl = fetch, timeoutMs = 4000 }) {
  base = String(base || "").replace(/\/$/, "");
  if (!base || !anon) throw new GatewayError("not_configured", "The health-records gateway isn't set up on this site.", 503);
  if (!token) throw new GatewayError("unauthorized", "Please sign in again.", 401);
  let calls = 0, rows = 0;
  async function select(table, { columns, filters = [], order, limit = MAX_ROWS } = {}) {
    if (!/^[a-z_]+$/.test(table) || !/^[a-z0-9_,*()!:.\s-]+$/i.test(columns || "")) throw new GatewayError("bad_query", "Invalid query.", 500);
    const qs = new URLSearchParams();
    qs.set("select", columns.replace(/\s+/g, ""));
    for (const [col, op, val] of filters) {
      if (!/^[a-z_]+$/.test(col) || !["eq", "gte", "lte", "in", "neq", "is"].includes(op)) throw new GatewayError("bad_query", "Invalid filter.", 500);
      qs.append(col, `${op}.${op === "in" ? "(" + [].concat(val).map((v) => `"${String(v).replace(/"/g, "")}"`).join(",") + ")" : val}`);
    }
    if (order) qs.set("order", order);
    qs.set("limit", String(Math.min(limit, MAX_ROWS)));
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(`${base}/rest/v1/${table}?${qs}`, { headers: { apikey: anon, authorization: `Bearer ${token}`, accept: "application/json" }, signal: ac.signal });
    } catch { throw new GatewayError("unavailable", "Your records couldn't be reached. Please try again.", 503); }
    finally { clearTimeout(t); }
    calls++;
    if (r.status === 401 || r.status === 403) throw new GatewayError("unauthorized", "Please sign in again.", 401);
    if (r.status === 404 || r.status === 400) {
      const body = await r.text().catch(() => "");
      // a table or column this database doesn't have yet (an older migration level): report it, don't crash
      if (/does not exist|could not find|schema cache/i.test(body)) throw new GatewayError("not_available", `This kind of record isn't available on this database yet (${table}).`, 501);
      throw new GatewayError("bad_query", "The records query was refused.", 500);
    }
    if (!r.ok) throw new GatewayError("unavailable", "Your records couldn't be reached. Please try again.", 503);
    const data = await r.json();
    if (!Array.isArray(data)) throw new GatewayError("unavailable", "Unexpected reply from the records database.", 502);
    rows += data.length;
    return data;
  }
  /** A read-only database function, called as the person (row security applies inside it). */
  async function rpc(fn, args) {
    if (!/^[a-z_]+$/.test(fn)) throw new GatewayError("bad_query", "Invalid function.", 500);
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
    let r;
    try { r = await fetchImpl(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: anon, authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(args), signal: ac.signal }); }
    catch { throw new GatewayError("unavailable", "Your records couldn't be reached. Please try again.", 503); }
    finally { clearTimeout(t); }
    calls++;
    if (r.status === 401 || r.status === 403) throw new GatewayError("unauthorized", "Please sign in again.", 401);
    if (r.status === 404) throw new GatewayError("not_available", `This search isn't available on this database yet (${fn}).`, 501);
    if (!r.ok) throw new GatewayError("unavailable", "Your records couldn't be reached. Please try again.", 503);
    const data = await r.json(); if (Array.isArray(data)) rows += data.length;
    return data;
  }
  return { select, rpc, stats: () => ({ calls, rows }) };
}
