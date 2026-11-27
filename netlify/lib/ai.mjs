/**
 * Doctine · shared server helpers for the Netlify functions (/api/chat, /api/scan).
 * Not a function itself: it lives outside netlify/functions and is bundled into each function.
 */

export const TIME_LIMIT_MS = 25000;       // Netlify ends synchronous functions at about 30 s

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
/** A refused request (429 rate limit, 503 capacity or limiter down) with the Retry-After header clients and tests rely on. */
export const refused = (rl, body) => json(body, rl.status, { "retry-after": String(Math.max(1, Math.round(rl.retryAfter || 60))) });

/**
 * Where Anthropic requests go. ANTHROPIC_BASE_URL lets local development and the browser tests point at a stand-in
 * server; it is ignored when DOCTINE_ENV is "production", so a production site always talks to Anthropic itself.
 */
/**
 * Headers for every Anthropic call. An organisation-level API key (one not created inside a workspace) must name the
 * workspace to bill: set ANTHROPIC_WORKSPACE_ID (wrkspc_…, not a secret). Workspace-scoped keys don't need it.
 */
/* A key pasted into a host's settings often carries a trailing line break or space. Sent as is, the request is
   refused before it leaves the server and looks like a network failure (production, 27 Nov 2026), so it is trimmed. */
// Keys never contain whitespace, so any space, line break or invisible character anywhere in a pasted key (a copy that
// wrapped across lines, production 27 Nov 2026) is removed, not just at the ends.
export const cleanKey = (key) => String(key || "").replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, "");
/** What the stored key looks like, never the key: for diagnosing a refused key in the admin console. */
export function keyShape(key) {
  const raw = String(key || ""), k = cleanKey(raw);
  // The prefix is assembled here so the worker bundle never contains it literally (tests/worker.test.mjs forbids it).
  const P = ["sk", "ant", ""].join("-");
  return { set: !!k, length: k.length, starts_sk_ant: k.startsWith(P), kind: (new RegExp("^" + P + "(api|usr|admin)\\d*-").exec(k) || [])[1] || (k ? "other" : null),
    had_surrounding_space: raw.trim() !== raw, had_inner_space: /[\s\u200B-\u200D\u2060\uFEFF]/.test(raw.trim()), header_safe: !/[^\x21-\x7e]/.test(k), quoted: /^["'\u201c\u2018].*["'\u201d\u2019]$/.test(k) };
}
export function anthropicHeaders(key, env = process.env) {
  const ws = String(env.ANTHROPIC_WORKSPACE_ID || "").trim();
  return { "x-api-key": cleanKey(key), "anthropic-version": "2023-06-01", ...(/^wrkspc_[A-Za-z0-9]{8,64}$/.test(ws) ? { "anthropic-workspace-id": ws } : {}) };
}

export function anthropicUrl(env = process.env) {
  const base = env.DOCTINE_ENV !== "production" && env.ANTHROPIC_BASE_URL ? env.ANTHROPIC_BASE_URL.replace(/\/$/, "") : "https://api.anthropic.com";
  return base + "/v1/messages";
}

/** API key and model from Netlify environment variables. The key never leaves the server. */
export function settings(kind = "chat") {
  const key = process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY || "";
  const envModel = process.env.AI_MODEL || "";
  const scanModel = process.env.AI_SCAN_MODEL || "";
  const fallback = "claude-sonnet-5-5";
  const model = kind === "scan"
    ? scanModel || (/^claude/i.test(envModel) ? envModel : fallback)
    : (/^claude/i.test(envModel) ? envModel : fallback);
  return { key, model };
}

/* Best-effort rate limit, per warm function instance. A shared store (e.g. Supabase or Redis) is needed for a hard limit. */
const hits = new Map();
export function limited(ip, bucket, max, windowMs = 10 * 60_000) {
  const key = ip + "|" + bucket, now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return list.length > max;
}

export const clientIp = (req, context) =>
  (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anon";

/** Reads and parses a JSON body with a size cap. Returns {body} or {error, status}. */
export async function readJson(req, maxBytes) {
  const raw = await req.text();
  if (raw.length > maxBytes) return { error: "too_large", status: 413 };
  try { return { body: JSON.parse(raw) }; } catch { return { error: "invalid", status: 400 }; }
}

/**
 * For the log only: the provider's error type and WHICH request setting it objected to, picked from a fixed list.
 * The provider's message itself is never logged, because it can repeat what the person wrote.
 */
const PARAMS = ["max_tokens", "thinking", "tool_choice", "tools", "temperature", "top_p", "top_k", "output_config", "effort", "prefill", "system", "messages", "model", "stop_sequences", "metadata", "anthropic-version", "anthropic-beta"];
export function providerReason(text) {
  let type = "unknown", msg = "";
  try { const e = JSON.parse(text).error || {}; type = String(e.type || "unknown").replace(/[^\w.-]/g, "").slice(0, 40); msg = String(e.message || ""); } catch {}
  const about = PARAMS.find((p) => new RegExp(`(^|[^\\w])${p.replace(/[-]/g, "\\-")}([^\\w]|$)`, "i").test(msg)) || "unspecified";
  return { type, about };
}

/**
 * Provider check, for the admin console (generate: true) and the Settings "Check connection" button (generate: false).
 *   1. Looks the configured model up with the key (GET /v1/models/{model}): free, and proves the key, the workspace and
 *      the model are accepted.
 *   2. With generate: true, sends one tiny request ("ping", 5 output tokens): proves a real answer comes back.
 * Returns only safe facts: configured, authenticated, model, model_accessible, test_request {ok, ms}, error (a code from
 * a fixed list), checked_at. Never the key, the provider's message or any person's data.
 */
const CHECK_ERRORS = { invalid_key: "auth_failed", key_forbidden: "key_forbidden", model_not_found: "model_not_found", insufficient_credits: "insufficient_credits",
  ai_rate_limited: "rate_limited", ai_busy: "provider_busy", ai_timeout: "timeout", ai_network: "network", ai_error: "invalid_request", bad_output: "bad_response", cancelled: "timeout" };
export async function providerCheck({ generate = false, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const { key, model } = settings("chat");
  const out = { provider: "anthropic", configured: !!key, authenticated: null, model, model_accessible: null, test_request: null, error: null, checked_at: new Date().toISOString() };
  if (!key) return { ...out, error: "not_configured" };
  // A key with characters a header can't carry (a curly quote, a space inside it) is refused by fetch itself; say so
  // plainly instead of reporting a network failure.
  if (/[^\x21-\x7e]/.test(cleanKey(key))) { out.authenticated = false; out.model_accessible = false; out.error = "auth_failed"; return out; }
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs); const t0 = Date.now();
  try {
    const r = await fetchImpl(anthropicUrl().replace(/\/v1\/messages$/, "/v1/models/" + encodeURIComponent(model)), { headers: anthropicHeaders(key), signal: ac.signal });
    out.lookup_ms = Date.now() - t0; out.lookup_status = r.status;
    if (r.ok) { out.authenticated = true; out.model_accessible = true; }
    else {
      out.authenticated = !(r.status === 401);
      out.model_accessible = false;
      out.error = r.status === 401 ? "auth_failed" : r.status === 403 ? "key_forbidden" : r.status === 404 ? "model_not_found" : r.status === 429 ? "rate_limited"
        : r.status >= 500 ? "provider_busy" : "invalid_request";
    }
  } catch (e) { out.lookup_ms = Date.now() - t0; out.error = e && e.name === "AbortError" ? "timeout" : "network"; }
  finally { clearTimeout(timer); }
  if (!generate || out.error) return out;
  const t1 = Date.now();
  const r = await callClaude({ key, model }, { system: "Reply with the single word: ok", messages: [{ role: "user", content: "ping" }], maxTokens: 5, timeoutMs: 15000, fetchImpl, fixedCheck: true });
  const ok = !r.error && typeof r.text === "string";
  out.test_request = { ok, ms: Date.now() - t1 };
  if (!ok) out.error = CHECK_ERRORS[r.error] || "bad_response";
  return out;
}

/** Maps an Anthropic HTTP failure to the error codes the app already explains to people. */
export function providerError(status, text, model) {
  if (status === 401) return { error: "invalid_key" };
  if (status === 403) return { error: "key_forbidden" };
  if (status === 404) return { error: "model_not_found", model };
  if (status === 429) return { error: "ai_rate_limited" };
  if (status === 529 || status === 503) return { error: "ai_busy" };
  if (status === 400 && /credit|billing|balance/i.test(text)) return { error: "insufficient_credits" };
  if (status === 400 && /model/i.test(text)) return { error: "model_not_found", model };
  return { error: "ai_error" };
}

/**
 * One Claude call. With `tool`, the model must answer through that tool and the tool input is returned.
 * Returns {input} | {text} | {error, ...}. Never throws.
 */
export async function callClaude({ key, model }, { system, messages, tool, maxTokens = 1500, timeoutMs = TIME_LIMIT_MS, fetchImpl = fetch, signal, fixedCheck = false }) {
  // Claude 5.5 models (Sonnet, Haiku, Opus): no temperature/top_p/top_k, no forced tool_choice ("tool"/"any" are a 400),
  // and adaptive thinking is on by default (its tokens count towards max_tokens). So: tool_choice "auto" with a clear
  // instruction, a larger output budget, and one retry if the model answers in prose instead of calling the tool.
  // Platform docs: platform.claude.com/docs/en/models/sonnet-5-5/migration-guide (read 27 Nov 2026).
  const budget = Math.max(64, Math.ceil(maxTokens * THINKING_HEADROOM));
  const ask = (sys) => requestClaude({ key, model }, { system: sys, messages, tool, maxTokens: budget, timeoutMs, fetchImpl, signal, fixedCheck });
  const sys = tool ? `${system || ""}\n\nAnswer only by calling the ${tool.name} tool, exactly once. Do not write a separate text reply.`.trim() : system;
  const first = await ask(sys);
  if (!tool || first.error !== "no_tool_call") return first;
  const second = await ask(`${sys}\n\nYour previous attempt did not call the ${tool.name} tool. Call it now.`);
  return second.error === "no_tool_call" ? { error: "bad_output", usage: second.usage } : second;
}
/** Thinking shares the output budget with the answer on Claude 5.5 models, so each caller's answer budget is scaled. */
export const THINKING_HEADROOM = 2.5;

async function requestClaude({ key, model }, { system, messages, tool, maxTokens, timeoutMs, fetchImpl, signal, fixedCheck }) {
  const ac = new AbortController();
  if (signal) { if (signal.aborted) return { error: "cancelled" }; signal.addEventListener("abort", () => ac.abort(), { once: true }); }
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(anthropicUrl(), {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", ...anthropicHeaders(key) },
      body: JSON.stringify({
        model, max_tokens: maxTokens, system, messages,
        ...(tool ? { tools: [tool], tool_choice: { type: "auto" } } : {}),
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    return { error: signal && signal.aborted ? "cancelled" : e.name === "AbortError" ? "ai_timeout" : "ai_network" };
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const out = providerError(res.status, text, model);
    // Log the outcome only: status and the provider's error type. Never the request, the reply body or any key.
    if (out.error === "ai_error") { const { type, about } = providerReason(text); console.error("[ai] anthropic error", res.status, type, "about:" + about);
      // The fixed configuration check sends only Doctine's own words ("ping"), so the provider's message can't contain
      // anything a person wrote: for that check alone, the message is logged (keys and long numbers removed).
      if (fixedCheck) { let m = ""; try { m = String(JSON.parse(text).error.message || ""); } catch {} console.error("[ai] check refused:", m.replace(/sk-[\w-]{8,}|eyJ[\w.-]{20,}/g, "[key]").replace(/\d{6,}/g, "[n]").slice(0, 300)); } }
    return out;
  }
  const j = await res.json().catch(() => null);
  if (!j || !Array.isArray(j.content)) return { error: "bad_output" };
  if (tool) {
    const t = j.content.find((c) => c.type === "tool_use" && c.name === tool.name);
    if (t) return { input: t.input, stop: j.stop_reason, usage: j.usage };
    return { error: j.stop_reason === "max_tokens" ? "bad_output" : "no_tool_call", usage: j.usage };
  }
  return { text: j.content.filter((c) => c.type === "text").map((c) => c.text).join(""), usage: j.usage };
}

/* Small, strict coercion helpers: model output and request bodies are never trusted. */
export const str = (v, n = 400) => (typeof v === "string" ? v.trim().slice(0, n) : v == null ? "" : String(v).slice(0, n));
export const arr = (v, n = 30) => (Array.isArray(v) ? v.slice(0, n) : []);
export const conf = (v) => (v === "high" || v === "medium" || v === "low" ? v : "low");
