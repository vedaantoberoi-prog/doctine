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
import { createBudget, createTtlStore } from "../lib/orchestrator/budget.mjs";
import { assist } from "../lib/orchestrator/orchestrate.mjs";

const MAX_BODY = 6_000;
// per warm instance; see budget.mjs
const shared = { budget: createBudget(), cache: createTtlStore(), idem: createTtlStore({ ttlMs: 10 * 60_000 }) };

export async function orchestratorOn(env = process.env, fetchImpl = fetch) {
  const st = await getSettings({ env, fetchImpl });
  if (st.maintenance && st.maintenance.on) return false;
  if (st.source === "none") return true;                      // local development and tests: no switches exist
  return st.flags.ai_assistant === true && st.flags.ai_gateway === true && st.flags.ai_orchestrator === true;
}

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

export default async function handler(req, context, { env = process.env, fetchImpl = fetch, provider, log = (l) => console.log(JSON.stringify(l)), stores = shared, today } = {}) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await orchestratorOn(env, fetchImpl))) return json({ error: "switched_off", message: "This feature isn't switched on yet." }, 503);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
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
    budget: stores.budget, cache: stores.cache, idem: stores.idem, env, signal: req.signal,
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
