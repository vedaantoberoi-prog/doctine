/**
 * Doctine · shared server helpers for the Netlify functions (/api/chat, /api/scan).
 * Not a function itself: it lives outside netlify/functions and is bundled into each function.
 */

export const TIME_LIMIT_MS = 25000;       // Netlify ends synchronous functions at about 30 s

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });

/**
 * Where Anthropic requests go. ANTHROPIC_BASE_URL lets local development and the browser tests point at a stand-in
 * server; it is ignored when DOCTINE_ENV is "production", so a production site always talks to Anthropic itself.
 */
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
export async function callClaude({ key, model }, { system, messages, tool, maxTokens = 1500, timeoutMs = TIME_LIMIT_MS, fetchImpl = fetch }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(anthropicUrl(), {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: maxTokens, temperature: 0.2, system, messages,
        ...(tool ? { tools: [tool], tool_choice: { type: "tool", name: tool.name } } : {}),
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    return { error: e.name === "AbortError" ? "ai_timeout" : "ai_network" };
  }
  clearTimeout(timer);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const out = providerError(res.status, text, model);
    // Log the outcome only: status and the provider's error type. Never the request, the reply body or any key.
    if (out.error === "ai_error") { let type = "unknown"; try { type = String(JSON.parse(text).error.type || "unknown").replace(/[^\w.-]/g, "").slice(0, 40); } catch {} console.error("[ai] anthropic error", res.status, type); }
    return out;
  }
  const j = await res.json().catch(() => null);
  if (!j || !Array.isArray(j.content)) return { error: "bad_output" };
  if (tool) {
    const t = j.content.find((c) => c.type === "tool_use" && c.name === tool.name);
    return t ? { input: t.input, stop: j.stop_reason } : { error: "bad_output" };
  }
  return { text: j.content.filter((c) => c.type === "text").map((c) => c.text).join("") };
}

/* Small, strict coercion helpers: model output and request bodies are never trusted. */
export const str = (v, n = 400) => (typeof v === "string" ? v.trim().slice(0, n) : v == null ? "" : String(v).slice(0, n));
export const arr = (v, n = 30) => (Array.isArray(v) ? v.slice(0, n) : []);
export const conf = (v) => (v === "high" || v === "medium" || v === "low" ? v : "low");
