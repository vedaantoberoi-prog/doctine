/**
 * Doctine · /api/gateway — the Agent Execution Gateway (prototype, off by default).
 *
 * POST { op: "search", query, limit? }        → the capabilities that fit, with their schemas and examples
 * POST { op: "execute", plan }                → run a read-only plan for the signed-in person (see lib/gateway/executor.mjs)
 * POST { op: "tools" }                        → the two tool definitions a model would be given
 *
 * Needs a signed-in person (Authorization: Bearer <their Supabase token>). Reads use that token and the public anon key,
 * so the database's row-level security limits everything to their own rows; the service-role key is never used here.
 * Switched off unless the platform flag `ai_gateway` is on (admin console → Feature switches), and in maintenance mode.
 * Audit: one log line per call with the step names, timings and row counts, never any values; the person is a hash.
 */
import { createHash } from "node:crypto";
import { json, readJson } from "../lib/ai.mjs";
import { getSettings } from "../lib/settings.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { userDb, GatewayError } from "../lib/gateway/db.mjs";
import { executeWorkflow } from "../lib/gateway/executor.mjs";
import { searchCapabilities } from "../lib/gateway/registry.mjs";
import { gatewayTools } from "../lib/gateway/tools.mjs";

const MAX_BODY = 8_000;

export async function gatewayOn(env = process.env, fetchImpl = fetch) {
  const st = await getSettings({ env, fetchImpl });
  if (st.maintenance && st.maintenance.on) return false;
  return st.source === "none" ? true : st.flags.ai_gateway === true;
}

export default async function handler(req, context, { env = process.env, fetchImpl = fetch, log = (l) => console.log(JSON.stringify(l)) } = {}) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await gatewayOn(env, fetchImpl))) return json({ error: "switched_off", message: "This feature isn't switched on yet." }, 503);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized", message: "Please sign in again." }, 401);
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), anon = env.SUPABASE_ANON_KEY || "";
  if (!base || !anon) return json({ error: "not_configured", message: "The health-records gateway isn't set up on this site." }, 503);

  // Who is this? (Supabase checks the token; the id is used only for the audit hash and the rate limit.)
  let uid = null;
  try {
    const r = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } });
    if (r.ok) { const u = await r.json(); uid = u && typeof u.id === "string" && /^[0-9a-f-]{36}$/i.test(u.id) ? u.id : null; }
  } catch { /* falls through to unauthorized */ }
  if (!uid) return json({ error: "unauthorized", message: "Please sign in again." }, 401);

  const rl = await checkRate(req, context, "gateway", { env, fetchImpl });
  if (!rl.allowed) return json({ error: rl.error, retryAfter: rl.retryAfter }, rl.status);

  const parsed = await readJson(req, MAX_BODY);
  if (parsed.error) return json({ error: parsed.error === "too_large" ? "too_large" : "bad_request", message: "Send a short JSON body with an op." }, parsed.status);
  const body = parsed.body;
  if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Send JSON with an op." }, 400);
  const who = createHash("sha256").update("gw:" + uid).digest("hex").slice(0, 16);
  const audit = (entry) => log({ at: new Date().toISOString(), route: "gateway", who, ...entry });

  try {
    if (body.op === "tools") return json({ tools: gatewayTools() });
    if (body.op === "search") { const out = searchCapabilities(body.query, { limit: body.limit }); audit({ kind: "search", found: out.capabilities.map((c) => c.name) }); return json(out); }
    if (body.op === "execute") {
      const db = userDb({ base, anon, token, fetchImpl });
      return json(await executeWorkflow(body.plan, { db, audit }));
    }
    return json({ error: "bad_request", message: "op must be search, execute or tools." }, 400);
  } catch (e) {
    if (e instanceof GatewayError) return json({ error: e.code, message: e.message, step: e.step }, e.status);
    throw e;
  }
}

export const config = { path: "/api/gateway" };
