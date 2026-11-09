/**
 * Doctine · shared rate limiting for the Netlify functions.
 *
 * Shared mode (production): counters live in Supabase (migration 20261104020000_rate_limits.sql), so every function
 * instance sees the same counts. Called with the service-role key, server-side only.
 *   - signed-in people are limited per account (their sign-in token is checked with Supabase);
 *   - everyone else is limited per IP address;
 *   - a daily cap on all AI requests together protects the Anthropic bill.
 * Subjects are HMAC-hashed before storage, so the database holds no raw user ids or IP addresses.
 *
 * Fallback: if Supabase isn't configured or the limiter can't be reached within 1.5 s, the in-memory limiter is used.
 * That is best-effort only (each function instance counts separately) and is reported as mode "local".
 * Set RATE_LIMIT_REQUIRE_SHARED=true to refuse AI requests instead when the shared limiter is unavailable.
 */
import { serviceHeaders } from "./supabase-keys.mjs";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { limited as localLimited, clientIp } from "./ai.mjs";

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? Math.floor(+v) : d);

/** Limits per route. Each entry: [bucket suffix, max requests, window seconds]. Override with RATE_LIMIT_<ROUTE>_<WHO>. */
export function limitsFor(route, who, env = process.env) {
  const o = (k, d) => num(env[`RATE_LIMIT_${route.toUpperCase()}_${who.toUpperCase()}_${k}`], d);
  const table = {
    chat: { user: [["10m", o("10M", 60), 600], ["1d", o("1D", 400), 86400]], ip: [["10m", o("10M", 20), 600], ["1d", o("1D", 100), 86400]] },
    scan: { user: [["1h", o("1H", 30), 3600], ["1d", o("1D", 150), 86400]], ip: [["1h", o("1H", 8), 3600], ["1d", o("1D", 30), 86400]] },
    explain: { user: [["10m", o("10M", 40), 600]], ip: [["10m", o("10M", 15), 600]] },
    account: { user: [["1h", o("1H", 5), 3600]], ip: [["1h", o("1H", 10), 3600]] },
    test: { user: [["10m", 10, 600]], ip: [["10m", 10, 600]] },
    eval: { eval: [["1h", o("1H", 300), 3600]] },
  };
  return (table[route] || table.chat)[who];
}

/* Sign-in tokens are checked with Supabase once and remembered briefly, so a busy chat doesn't re-check every message. */
const tokenCache = new Map();
async function userFromToken(token, env, fetchImpl) {
  if (!token || token.length > 4096) return null;
  const hit = tokenCache.get(token);
  if (hit && hit.until > Date.now()) return hit.uid;
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), anon = env.SUPABASE_ANON_KEY;
  if (!base || !anon) return null;
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` }, signal: ac.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const u = await r.json();
    const uid = u && typeof u.id === "string" && /^[0-9a-f-]{36}$/i.test(u.id) ? u.id : null;
    if (uid) { tokenCache.set(token, { uid, until: Date.now() + 5 * 60_000 }); if (tokenCache.size > 2000) tokenCache.delete(tokenCache.keys().next().value); }
    return uid;
  } catch { return null; }
}

function hashSubject(s, env) {
  const key = env.RATE_LIMIT_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || "doctine-local";
  return createHmac("sha256", key).update(s).digest("hex").slice(0, 40);
}

async function sharedHit(bucket, subject, limit, windowSec, env, fetchImpl) {
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1500);
  try {
    const r = await fetchImpl(`${base}/rest/v1/rpc/rate_limit_hit`, {
      method: "POST", signal: ac.signal,
      headers: serviceHeaders(key, { "content-type": "application/json" }),
      body: JSON.stringify({ p_bucket: bucket, p_subject: subject, p_limit: limit, p_window_seconds: windowSec }),
    });
    if (!r.ok) throw new Error("limiter " + r.status);
    const rows = await r.json();
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row.allowed !== "boolean") throw new Error("limiter reply");
    return { allowed: row.allowed, resetAt: row.reset_at };
  } finally { clearTimeout(t); }
}

/**
 * Checks (and counts) one request. `route` is chat | scan | explain | account | test.
 * `ai: true` also counts it against the daily AI budget (AI_DAILY_REQUEST_CAP, default 3000).
 * Returns { allowed, error?, status?, retryAfter?, mode: "shared" | "local", who: "user" | "ip" }.
 */
export async function checkRate(req, context, route, { ai = false, env = process.env, fetchImpl = fetch } = {}) {
  if (route !== "account" && evalAccess(req, env)) route = "eval";
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const uid = route !== "eval" && token ? await userFromToken(token, env, fetchImpl) : null;
  const who = route === "eval" ? "eval" : uid ? "user" : "ip";
  const subjectRaw = route === "eval" ? "eval" : uid ? "u:" + uid : "ip:" + clientIp(req, context);
  const rules = limitsFor(route, who, env);
  const cap = num(env.AI_DAILY_REQUEST_CAP, 3000);
  const shared = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);

  if (shared) {
    try {
      const subject = hashSubject(subjectRaw, env);
      for (const [suffix, max, win] of rules) {
        const r = await sharedHit(`${route}-${who}-${suffix}`, subject, max, win, env, fetchImpl);
        if (!r.allowed) return { allowed: false, error: "rate_limited", status: 429, retryAfter: Math.max(1, Math.ceil((Date.parse(r.resetAt) - Date.now()) / 1000)), mode: "shared", who };
      }
      if (ai) {
        const r = await sharedHit("ai-all-1d", "all", cap, 86400, env, fetchImpl);
        if (!r.allowed) return { allowed: false, error: "capacity", status: 503, retryAfter: Math.max(1, Math.ceil((Date.parse(r.resetAt) - Date.now()) / 1000)), mode: "shared", who };
      }
      return { allowed: true, mode: "shared", who };
    } catch (e) {
      console.error("[ratelimit] shared limiter unavailable:", e && e.message);
      if (String(env.RATE_LIMIT_REQUIRE_SHARED).toLowerCase() === "true") return { allowed: false, error: "limiter_unavailable", status: 503, retryAfter: 30, mode: "unavailable", who };
    }
  }
  // Best-effort fallback: per function instance only.
  for (const [suffix, max, win] of rules) if (localLimited(subjectRaw, `${route}-${who}-${suffix}`, max, win * 1000)) return { allowed: false, error: "rate_limited", status: 429, retryAfter: win, mode: "local", who };
  if (ai && localLimited("all", "ai-all-1d", cap, 86400_000)) return { allowed: false, error: "capacity", status: 503, retryAfter: 3600, mode: "local", who };
  return { allowed: true, mode: "local", who };
}

/**
 * Evaluation access (staging only). A request carrying the header `x-doctine-eval-token` gets the separate "eval"
 * limit instead of the public ones — but only when ALL of these hold:
 *   - DOCTINE_ENV is exactly "staging" or "eval" (never "production", never unset);
 *   - EVAL_ACCESS_TOKEN is set on that site and is at least 32 characters;
 *   - the header matches it (constant-time comparison).
 * Anything else is treated as an ordinary request with the ordinary limits. It never skips the daily AI budget.
 */
export function evalAccess(req, env = process.env) {
  const sent = req.headers.get("x-doctine-eval-token") || "";
  if (!sent) return false;
  const envName = String(env.DOCTINE_ENV || "").toLowerCase();
  const secret = env.EVAL_ACCESS_TOKEN || "";
  if (envName !== "staging" && envName !== "eval") { console.warn("[eval] evaluation token sent to a non-evaluation environment; ignored"); return false; }
  if (secret.length < 32) { console.warn("[eval] EVAL_ACCESS_TOKEN is missing or too short; evaluation access is off"); return false; }
  const a = createHash("sha256").update(sent).digest(), b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/** For tests only. */
export const _resetTokenCache = () => tokenCache.clear();
