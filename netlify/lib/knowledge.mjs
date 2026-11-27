/**
 * Doctine · medical knowledge retrieval — an interface for later, with nothing connected by default.
 *
 * Doctine does NOT have a medical knowledge database today. With no provider configured, retrieve() returns no
 * passages and the assistant answers from the AI model's general knowledge, saying so in the app.
 *
 * Contract (any future source implements this):
 *   retrieve({ query, mode }) → { provider, status, version, passages: [{ id, title, publisher, url, published, text, source_id }] }
 *   - version:   the knowledge index version the service reports (e.g. "2026-11-01"), kept for audit; "" if none.
 *   - source_id: the service's own stable id for the passage (for audit and corrections), optional.
 *   - id:   "K1", "K2"… assigned here; the assistant may cite only these ids.
 *   - url:  https only, on a domain in KNOWLEDGE_ALLOWED_DOMAINS (reputable publishers you have chosen).
 *   - text: the passage the answer may rely on (trimmed to 1,500 characters).
 *   A failure or timeout returns status "unavailable" and no passages; the assistant still answers.
 *
 * Providers (KNOWLEDGE_PROVIDER):
 *   "none" (default) — no retrieval.
 *   "http"           — POST {query, mode, limit} to KNOWLEDGE_URL (optional KNOWLEDGE_TOKEN as a Bearer token);
 *                      the service replies { index_version?, passages: [{ title, publisher, url, published?, text, source_id? }] }.
 *                      KNOWLEDGE_URL must be https. Replies over 200 KB or not in this shape are ignored.
 *                      This is how a search service over licensed or public-domain guidance (for example WHO, ICMR,
 *                      MoHFW, NHS or NIH pages you have permission to use) would be connected.
 *   "supabase"       — Doctine's own store (migration 20261130000000_knowledge.sql): sources loaded with
 *                      tools/knowledge-ingest.mjs, searched with Postgres full-text search, and ONLY those a reviewing
 *                      doctor approved in the admin console. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server only).
 *                      At most two passages from one source. See docs/EVIDENCE_SOURCES.md.
 */
import { str, arr } from "./ai.mjs";
import { understand } from "./evidence/query.mjs";
import { serviceHeaders } from "./supabase-keys.mjs";

const DEFAULT_DOMAINS = "who.int,icmr.gov.in,mohfw.gov.in,nhs.uk,nih.gov,medlineplus.gov,cdc.gov";

function allowedHost(url, domains) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (/^[\d.]+$/.test(host) || host.includes(":")) return false;                 // no raw IP addresses
    return domains.some((d) => host === d || host.endsWith("." + d));
  } catch { return false; }
}
const MAX_REPLY_BYTES = 200_000;

export async function retrieve({ query, mode = "general", limit = 4 }, { env = process.env, fetchImpl = fetch } = {}) {
  const provider = (env.KNOWLEDGE_PROVIDER || "none").toLowerCase();
  if (provider === "none" || !query) return { provider: "none", status: "off", version: "", passages: [] };
  if (provider === "supabase") return searchStore({ query, limit }, { env, fetchImpl });
  if (provider !== "http" || !env.KNOWLEDGE_URL || !/^https:\/\//i.test(env.KNOWLEDGE_URL)) return { provider, status: "misconfigured", version: "", passages: [] };
  const domains = (env.KNOWLEDGE_ALLOWED_DOMAINS || DEFAULT_DOMAINS).split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(env.KNOWLEDGE_TIMEOUT_MS) || 4000);
  try {
    const r = await fetchImpl(env.KNOWLEDGE_URL, {
      method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json", ...(env.KNOWLEDGE_TOKEN ? { authorization: "Bearer " + env.KNOWLEDGE_TOKEN } : {}) },
      body: JSON.stringify({ query: str(query, 500), mode, limit }),
    });
    if (!r.ok) return { provider, status: "unavailable", version: "", passages: [] };
    const raw = await r.text();
    if (raw.length > MAX_REPLY_BYTES) return { provider, status: "invalid_response", version: "", passages: [] };
    let j = null; try { j = JSON.parse(raw); } catch { /* fall through */ }
    if (!j || typeof j !== "object" || !Array.isArray(j.passages)) return { provider, status: "invalid_response", version: "", passages: [] };
    const seen = new Set();
    const passages = arr(j.passages, 20)
      .map((p) => ({ title: str(p && p.title, 160), publisher: str(p && p.publisher, 80), url: str(p && p.url, 500), published: str(p && p.published, 20), text: str(p && p.text, 1500), source_id: str(p && p.source_id, 80) }))
      .filter((p) => p.title && p.text && p.publisher && allowedHost(p.url, domains) && !seen.has(p.url) && seen.add(p.url))
      .slice(0, limit)
      .map((p, i) => ({ id: "K" + (i + 1), ...p }));
    return { provider, status: passages.length ? "ok" : "no_results", version: str(j.index_version, 40), passages };
  } catch {
    return { provider, status: "unavailable", version: "", passages: [] };
  } finally { clearTimeout(timer); }
}

/**
 * The person's words → a full-text query that matches ANY of the meaningful terms (everyday words expanded to the
 * medical terms they may mean), so a long question still finds the passages that share its key words.
 */
export function searchText(query) {
  const plan = understand(query);
  const terms = [...new Set([...plan.terms, ...plan.words])].map((t) => String(t).replace(/["()<>:&|!\\-]/g, " ").replace(/\s+/g, " ").trim()).filter((t) => t.length >= 3).slice(0, 14);
  return terms.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" or ");
}

async function searchStore({ query, limit }, { env, fetchImpl }) {
  const provider = "supabase";
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { provider, status: "misconfigured", version: "", passages: [] };
  const q = searchText(query);
  if (!q) return { provider, status: "no_results", version: "", passages: [] };
  const domains = (env.KNOWLEDGE_ALLOWED_DOMAINS || DEFAULT_DOMAINS).split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(env.KNOWLEDGE_TIMEOUT_MS) || 3000);
  try {
    const r = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, "")}/rest/v1/rpc/knowledge_search`, {
      method: "POST", signal: ac.signal, headers: serviceHeaders(env.SUPABASE_SERVICE_ROLE_KEY, { "content-type": "application/json", accept: "application/json" }),
      body: JSON.stringify({ p_query: q, p_limit: Math.min(8, limit * 2) }),
    });
    if (r.status === 404) return { provider, status: "not_installed", version: "", passages: [] };
    if (!r.ok) return { provider, status: "unavailable", version: "", passages: [] };
    const raw = await r.text();
    if (raw.length > MAX_REPLY_BYTES) return { provider, status: "invalid_response", version: "", passages: [] };
    let rows = null; try { rows = JSON.parse(raw); } catch { /* fall through */ }
    if (!Array.isArray(rows)) return { provider, status: "invalid_response", version: "", passages: [] };
    const perSource = new Map();
    const passages = rows
      .map((x) => ({ title: str(x && x.title, 160), publisher: str(x && x.publisher, 80), url: str(x && x.url, 500), published: str(x && x.published, 20),
        licence: str(x && x.licence, 200), section: str(x && x.heading, 160), text: str(x && x.content, 1500), source_id: str(x && x.source_id, 80), version: str(x && x.version, 40) }))
      .filter((p) => p.title && p.text && p.publisher && allowedHost(p.url, domains))
      .filter((p) => { const n = perSource.get(p.source_id) || 0; perSource.set(p.source_id, n + 1); return n < 2; })
      .slice(0, limit)
      .map((p, i) => ({ id: "K" + (i + 1), ...p }));
    return { provider, status: passages.length ? "ok" : "no_results", version: [...new Set(passages.map((p) => p.version))].join(",").slice(0, 40), passages };
  } catch {
    return { provider, status: "unavailable", version: "", passages: [] };
  } finally { clearTimeout(timer); }
}
