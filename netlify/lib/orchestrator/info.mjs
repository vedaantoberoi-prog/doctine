/**
 * Doctine · what the admin console's "AI infrastructure" page shows: configuration only. Policy version and hash,
 * switches, the state machine, tool permission levels, model routing (model names and whether a provider key is set,
 * never the key), limits, and where traces go. No health data, no account, no conversation content.
 */
import { POLICY, POLICY_HASH, PROMPT_VERSION } from "./policy.mjs";
import { STATES, TRANSITIONS } from "./state.mjs";
import { createToolGateway } from "./tools.mjs";
import { modelFor } from "./router.mjs";
import { priceOf } from "./budget.mjs";

export function infrastructure({ env = process.env, flags = {} } = {}) {
  const keySet = !!(env.ANTHROPIC_API_KEY || env.AI_API_KEY);
  return {
    policy: { version: POLICY.version, hash: POLICY_HASH, prompt_version: PROMPT_VERSION, status: POLICY.status },
    switches: { ai_assistant: flags.ai_assistant === true, ai_gateway: flags.ai_gateway === true, ai_orchestrator: flags.ai_orchestrator === true,
      note: "/api/assist answers only when all three are on." },
    provider: { name: "anthropic", key_configured: keySet, confirmations_secret_configured: !!env.ORCHESTRATOR_SECRET },
    routing: ["A", "B", "C", "D"].map((c) => { const m = modelFor(c, env); return { category: c, name: POLICY.routing[c].name, model: m, when: POLICY.routing[c].when, price_known: m ? !!priceOf(m, env) : null }; }),
    fallback: POLICY.routing.fallback,
    states: STATES, transitions: TRANSITIONS,
    tools: createToolGateway({ secret: "" }).list(),
    write_tools_enabled: POLICY.tools.write_tools_enabled,
    limits: POLICY.limits,
    observability: { traces: "one JSON log line per request (route \"assist\"): states, timings, counts, model, tokens; OpenTelemetry export shape in lib/orchestrator/state.mjs",
      stored_in_database: false },
    release_gate: "tests/orchestrator.test.mjs and tools/ai-policy-gate.mjs run before every deploy; a policy change needs a new version in docs/ai-policy/manifest.json",
  };
}
