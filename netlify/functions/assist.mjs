/**
 * Doctine · /api/assist — the orchestrated records assistant (Intelligence Orchestrator, lib/orchestrator).
 *
 * POST { message, share_records: true|false, request_id? }
 *   → { answer: { kind, text, sections }, evidence: [...], route, usage, cache, state, request_id, policy_version, trace }
 *
 * Switched off unless ALL of the platform flags ai_assistant, ai_gateway and ai_orchestrator are on (admin console →
 * Feature switches), and never in maintenance mode. The assistant stays off for real people until a doctor has
 * reviewed it. Needs a signed-in person (Authorization: Bearer <their Supabase token>); reads use that token and the
 * public anon key, so row-level security limits everything to their rows. The service-role key is never used here.
 * One log line per request: states, timings, counts, model, tokens; never a value from anyone's records.
 */
import { json, readJson } from "../lib/ai.mjs";
import { getSettings } from "../lib/settings.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { authenticate } from "../lib/orchestrator/identity.mjs";
import { createToolGateway } from "../lib/orchestrator/tools.mjs";
import { anthropicProvider } from "../lib/orchestrator/router.mjs";
import { createBudget, createSharedBudget, createTtlStore } from "../lib/orchestrator/budget.mjs";
import { assist } from "../lib/orchestrator/orchestrate.mjs";
import { toOtel } from "../lib/orchestrator/state.mjs";
import { POLICY } from "../lib/orchestrator/policy.mjs";

const MAX_BODY = 6_000;
// per warm instance; see budget.mjs
const shared = { budget: createBudget(), cache: createTtlStore(), idem: createTtlStore({ ttlMs: 10 * 60_000 }) };

export async function orchestratorOn(env = process.env, fetchImpl = fetch) {
  const st = await getSettings({ env, fetchImpl });
  if (st.maintenance && st.maintenance.on) return false;
  if (st.source === "none") return true;                      // local development and tests: no switches exist
  return st.flags.ai_assistant === true && st.flags.ai_gateway === true && st.flags.ai_orchestrator === true;
}

/** Pilot accounts (migration 20261123070000_ai_pilot): the Founder can switch the assistant on for a few named accounts
 *  while it stays off for everyone else. Asked with the server key about the signed-in account only. Never throws. */
const pilotCache = new Map();
export async function pilotAllowed(token, { env = process.env, fetchImpl = fetch } = {}) {
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), anon = env.SUPABASE_ANON_KEY || "", key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !anon || !key || !token) return false;
  try {
    const st = await getSettings({ env, fetchImpl });
    if (st.maintenance && st.maintenance.on) return false;
    const u = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } });
    if (!u.ok) return false;
    const uid = (await u.json()).id;
    if (typeof uid !== "string" || !/^[0-9a-f-]{36}$/i.test(uid)) return false;
    const hit = pilotCache.get(uid); if (hit && hit.until > Date.now()) return hit.ok;
    const r = await fetchImpl(`${base}/rest/v1/rpc/ai_pilot_allowed`, { method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ p_user: uid }) });
    const ok = r.ok && (await r.json()) === true;
    pilotCache.set(uid, { ok, until: Date.now() + 30_000 }); if (pilotCache.size > 1000) pilotCache.clear();
    return ok;
  } catch { return false; }
}
export const _resetPilotCache = () => pilotCache.clear();

/** Stores one trace row (lib/orchestrator traces: states, timings, counts; never a value). Needs the service key; never throws. */
export function storeTrace(line, { env = process.env, fetchImpl = fetch } = {}) {
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !key || !line || !line.state) return Promise.resolve(false);
  const p = { state: line.state, outcome: line.outcome, category: line.category, route_category: line.route_category, model: line.model, degraded: line.degraded,
    tokens_in: line.tokens_in, tokens_out: line.tokens_out, cost_usd: line.cost_usd, cache: line.cache, ms: line.ms, retries: line.retries,
    policy_version: line.policy_version, release: String(env.CF_PAGES_COMMIT_SHA || env.COMMIT_REF || "").slice(0, 40), spans: (line.spans || []).slice(0, 20) };
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 3000);
  return fetchImpl(`${base}/rest/v1/rpc/record_ai_trace`, { method: "POST", signal: ac.signal,
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ p }) })
    .then((r) => r.ok).catch(() => false).finally(() => clearTimeout(t));
}

/**
 * Optional export to an outside monitoring service in OpenTelemetry's format (OTLP/HTTP JSON). Off unless
 * OTEL_EXPORTER_OTLP_ENDPOINT is set (https only); OTEL_EXPORTER_OTLP_HEADERS ("key=value,key2=value2") carries the
 * service's key. Spans hold stage names, timings and allow-listed codes only (state.mjs), never a person or a value.
 */
export function exportOtel(trace, { env = process.env, fetchImpl = fetch } = {}) {
  const ep = String(env.OTEL_EXPORTER_OTLP_ENDPOINT || "").replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+/.test(ep) || !trace || !trace._raw) return Promise.resolve(false);
  const headers = { "content-type": "application/json" };
  for (const kv of String(env.OTEL_EXPORTER_OTLP_HEADERS || "").split(",")) { const i = kv.indexOf("="); if (i > 0) headers[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim()); }
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 3000);
  return fetchImpl(ep.endsWith("/v1/traces") ? ep : ep + "/v1/traces", { method: "POST", headers, signal: ac.signal,
    body: JSON.stringify(toOtel(trace, { service: "doctine-assist", version: POLICY.version })) }).then((r) => r.ok).catch(() => false).finally(() => clearTimeout(t));
}

export default async function handler(req, context, { env = process.env, fetchImpl = fetch, provider, log = (l) => console.log(JSON.stringify(l)), stores = shared, today } = {}) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  // GET: "may I use the records assistant?" for the signed-in person only (the app asks after sign-in)
  if (req.method === "GET") {
    if (!token) return json({ available: false });
    const on = await orchestratorOn(env, fetchImpl);
    const pilot = !on && (await pilotAllowed(token, { env, fetchImpl }));
    return json({ available: on || pilot, pilot });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await orchestratorOn(env, fetchImpl)) && !(token && (await pilotAllowed(token, { env, fetchImpl }))))
    return json({ error: "switched_off", message: "This feature isn't switched on yet." }, 503);
  if (!token) return json({ error: "unauthorized", message: "Please sign in again." }, 401);
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), anon = env.SUPABASE_ANON_KEY || "";
  if (!base || !anon) return json({ error: "not_configured", message: "The records assistant isn't set up on this site." }, 503);
  const rl = await checkRate(req, context, "assist", { ai: true, env, fetchImpl });
  if (!rl.allowed) return json({ error: rl.error, retryAfter: rl.retryAfter }, rl.status);
  const parsed = await readJson(req, MAX_BODY);
  if (parsed.error) return json({ error: parsed.error === "too_large" ? "too_large" : "bad_request", message: "Send a short JSON body with a message." }, parsed.status);
  const body = parsed.body && typeof parsed.body === "object" ? parsed.body : {};

  const auditLines = [], pending = [];
  const r = await assist({ message: body.message, share_records: body.share_records === true, request_id: body.request_id, today }, {
    authenticate: () => authenticate({ token, base, anon, fetchImpl, signal: req.signal }),
    tools: createToolGateway({ audit: (a) => auditLines.push(a) }),
    provider: provider || anthropicProvider({ key: env.ANTHROPIC_API_KEY || env.AI_API_KEY || "", fetchImpl }),
    budget: stores === shared ? (stores.sharedBudget ||= createSharedBudget({ env, fetchImpl })) : stores.budget, cache: stores.cache, idem: stores.idem, env, signal: req.signal,
    onTrace: (trace) => { const p = exportOtel(trace, { env, fetchImpl }); if (context && typeof context.waitUntil === "function") context.waitUntil(p); else pending.push(p); },
    log: (line) => {
      log({ ...line, tools: auditLines.map((a) => [a.tool, a.status, a.ms]) });
      const stored = storeTrace(line, { env, fetchImpl });           // after the answer where the platform allows it
      if (context && typeof context.waitUntil === "function") context.waitUntil(stored); else pending.push(stored);
    },
  });
  if (pending.length) await Promise.all(pending);                     // no waitUntil (tests, local): finish before returning
  return json(r.body, r.status);
}

export const config = { path: "/api/assist" };
