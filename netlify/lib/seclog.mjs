/**
 * Doctine · security request log (migration 20261128000000_security_log.sql): one line per /api request, kept 370 days
 * in the production database in Mumbai, for CERT-In (180 days in India) and DPDP rule 6 (one year, from 13 May 2027).
 *
 * A line holds: route, method, status, duration, the visitor's IP, a 16-character hash of the user agent, the host,
 * the environment, the release, and the account id the request's token CLAIMS (read from the token without
 * verifying it; the handler verifies it separately). Never bodies, query strings, health data, names, emails or tokens.
 * Recording never delays or breaks a request: it runs after the reply (Cloudflare waitUntil), with a 3-second limit,
 * and every error is swallowed. SECURITY_LOG=off turns it off.
 */
import { createHash } from "node:crypto";
import { serviceHeaders } from "./supabase-keys.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The account id a bearer token claims, or null. Not verification: for investigation only. */
export function claimedUid(authorization) {
  const tok = String(authorization || "").replace(/^Bearer\s+/i, "");
  const part = tok.split(".")[1];
  if (!part || part.length > 4096) return null;
  try { const sub = JSON.parse(Buffer.from(part, "base64url").toString()).sub; return typeof sub === "string" && UUID.test(sub) ? sub.toLowerCase() : null; }
  catch { return null; }
}

export function clientIp(headers) {
  const h = (n) => headers.get(n) || "";
  const ip = h("cf-connecting-ip") || h("x-nf-client-connection-ip") || h("x-forwarded-for").split(",")[0];
  return /^[0-9a-f.:]{3,45}$/i.test(ip.trim()) ? ip.trim() : null;
}

/** One log line for a request and its result. */
export function securityLine(request, { route, status, ms, env = process.env }) {
  const ua = request.headers.get("user-agent") || "";
  let host = null; try { host = new URL(request.url).hostname.toLowerCase().slice(0, 120); } catch {}
  return {
    route: String(route || "").slice(0, 40), method: String(request.method || "").toUpperCase(), status: Number(status) || 0,
    ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null, ip: clientIp(request.headers),
    ua_hash: ua ? createHash("sha256").update(ua).digest("hex").slice(0, 16) : null,
    claimed_uid: claimedUid(request.headers.get("authorization")), host,
    env: String(env.DOCTINE_ENV || "").slice(0, 20) || null, release: String(env.CF_PAGES_COMMIT_SHA || env.COMMIT_REF || "").slice(0, 12) || null,
  };
}

export function securityLogOn(env = process.env) {
  return String(env.SECURITY_LOG || "").toLowerCase() !== "off" && !!env.SUPABASE_URL && !!env.SUPABASE_SERVICE_ROLE_KEY;
}

/** Sends lines to the database. Resolves to true/false; never throws. */
export async function recordSecurity(lines, { env = process.env, fetchImpl = fetch } = {}) {
  if (!securityLogOn(env) || !lines || !lines.length) return false;
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 3000);
  try {
    const r = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, "")}/rest/v1/rpc/security_log_add`, {
      method: "POST", signal: ac.signal, headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { "content-type": "application/json" }), body: JSON.stringify({ p_rows: lines.slice(0, 50) }) });
    return r.ok;
  } catch { return false; } finally { clearTimeout(t); }
}
