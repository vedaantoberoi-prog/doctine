/**
 * Doctine · model routing and the provider abstraction.
 *
 * Category A is deterministic (no model). B, C and D are model tiers chosen from the request and the evidence, each
 * configured by environment variable (defaults in the policy). When the chosen model can't be used (no key, provider
 * down, model missing, rate-limited, timed out) the router never falls back to a weaker model; the orchestrator gives
 * the deterministic evidence answer and says so (`degraded`). Providers are plain objects { name, call(model, req) },
 * so another processor can be added later, after its own privacy review.
 */
import { callClaude } from "../ai.mjs";
import { POLICY } from "./policy.mjs";

export const UNAVAILABLE = new Set(["not_configured", "invalid_key", "key_forbidden", "model_not_found", "ai_rate_limited", "ai_busy", "insufficient_credits", "ai_timeout", "ai_network", "ai_error"]);

export function anthropicProvider({ key = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY || "", fetchImpl = fetch } = {}) {
  return {
    name: "anthropic", configured: !!key,
    async call(model, { system, messages, tool, maxTokens, timeoutMs, signal }) {
      if (!key) return { error: "not_configured" };
      return callClaude({ key, model }, { system, messages, tool, maxTokens, timeoutMs, fetchImpl, signal });
    },
  };
}

export function modelFor(cat, env = process.env) {
  const r = POLICY.routing[cat];
  if (!r || !r.env) return null;
  const v = env[r.env];
  return v && /^claude[-\w.]*$/i.test(v) ? v : r.default;
}

/** Picks the category for one request from its classification and evidence. Pure. */
export function route(cls, inv, { env = process.env } = {}) {
  if (!cls || cls.category === "emergency") return { category: "A", reason: "emergency guidance is fixed text" };
  if (cls.category !== "record_question" && cls.category !== "general_health") return { category: "A", reason: "refusal or clarification is fixed text" };
  if (cls.category === "general_health") return { category: "A", reason: "general questions go to the existing assistant (/api/chat)" };
  if (!inv || !inv.evidence || !inv.evidence.length || inv.sufficiency.verdict === "none") return { category: "A", reason: "nothing found: no model needed to say so" };
  const units = inv.series.some((s) => s.groups.length > 1), many = inv.series.length > 3 || inv.evidence.length > 20;
  const cat = inv.conflicts.length || units || many ? "D" : inv.series.length <= 1 && inv.evidence.length <= 6 ? "B" : "C";
  return { category: cat, model: modelFor(cat, env), reason: cat === "D" ? "conflicts, unit changes or a long history" : cat === "B" ? "one short, conflict-free series" : "a record comparison" };
}
