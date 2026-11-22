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

  const auditLines = [];
  const r = await assist({ message: body.message, share_records: body.share_records === true, request_id: body.request_id, today }, {
    authenticate: () => authenticate({ token, base, anon, fetchImpl, signal: req.signal }),
    tools: createToolGateway({ audit: (a) => auditLines.push(a) }),
    provider: provider || anthropicProvider({ key: env.ANTHROPIC_API_KEY || env.AI_API_KEY || "", fetchImpl }),
    budget: stores.budget, cache: stores.cache, idem: stores.idem, env, signal: req.signal,
    log: (line) => log({ ...line, tools: auditLines.map((a) => [a.tool, a.status, a.ms]) }),
  });
  return json(r.body, r.status);
}

export const config = { path: "/api/assist" };
