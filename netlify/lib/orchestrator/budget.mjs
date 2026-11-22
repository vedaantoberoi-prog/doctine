/**
 * Doctine · token and cost accounting, per-person budgets, the answer cache and request idempotency.
 *
 * All three stores are per warm server instance (best effort, like the existing in-memory rate limiter); the hard rate
 * limit stays the database one (ratelimit.mjs). Prices are never guessed: a model's cost is counted only when its price
 * per million tokens is configured (AI_PRICES='{"model":[in,out]}'); tokens are always counted.
 *
 * Cache keys are per person by construction: hash(subject, policy version, model, normalised question, evidence
 * fingerprint). The fingerprint covers every evidence id, value, date and document, so a new, corrected or deleted
 * record changes the key (version-aware invalidation) and a cached answer can never be served to anyone else or
 * against changed records.
 */
import { createHash } from "node:crypto";
import { POLICY } from "./policy.mjs";

const KNOWN_PRICES = { "claude-sonnet-5-5": [2, 10] };   // US$ per million tokens, as used by tools/bench-live.mjs
export function priceOf(model, env = process.env) {
  let extra = {}; try { extra = JSON.parse(env.AI_PRICES || "{}"); } catch { extra = {}; }
  const p = extra[model] || KNOWN_PRICES[model];
  return Array.isArray(p) && p.length === 2 && p.every((x) => x > 0) ? p : null;
}

export function createBudget({ now = Date.now, dailyTokens = POLICY.limits.daily_tokens_per_person } = {}) {
  const used = new Map();
  const day = () => new Date(now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // IST day
  const k = (subject) => subject + "|" + day();
  return {
    remaining: (subject) => Math.max(0, dailyTokens - (used.get(k(subject)) || 0)),
    allows: (subject, estimate = 0) => (used.get(k(subject)) || 0) + estimate <= dailyTokens,
    record(subject, model, usage = {}, env) {
      const i = +usage.input_tokens || 0, o = +usage.output_tokens || 0;
      used.set(k(subject), (used.get(k(subject)) || 0) + i + o);
      if (used.size > 10000) for (const key of used.keys()) if (!key.endsWith(day())) used.delete(key);
      const p = priceOf(model, env);
      return { tokens_in: i, tokens_out: o, cost_usd: p ? +((i * p[0] + o * p[1]) / 1e6).toFixed(6) : null };
    },
  };
}

export const fingerprint = (inv) => createHash("sha256").update(JSON.stringify((inv && inv.evidence || []).map((e) => [e.id, e.document_id, e.date, e.page, e.original_text, e.verification]))
  + JSON.stringify(inv && inv.conflicts || []) + JSON.stringify(inv && inv.missing || [])).digest("hex").slice(0, 24);
export const cacheKey = ({ subject, model, question, inv }) => createHash("sha256")
  .update([subject, POLICY.version, model, String(question || "").toLowerCase().replace(/\s+/g, " ").trim(), fingerprint(inv)].join("\u0000")).digest("hex");

export function createTtlStore({ ttlMs = POLICY.limits.cache_ttl_s * 1000, max = 2000, now = Date.now } = {}) {
  const m = new Map();
  return {
    get(key) { const e = m.get(key); if (!e) return undefined; if (e.until < now()) { m.delete(key); return undefined; } return e.value; },
    set(key, value) { m.set(key, { value, until: now() + ttlMs }); if (m.size > max) m.delete(m.keys().next().value); },
    delete(key) { m.delete(key); },
    get size() { return m.size; },
  };
}
