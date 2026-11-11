/**
 * Doctine · /api/errors — the app reports its own errors here (POST { kind, message, location, release }).
 * No sign-in, account id, IP address or page content is stored; the database removes quoted text, numbers and email
 * addresses from the message before keeping it, and groups repeats. Rate-limited per visitor.
 */
import { json, readJson } from "../lib/ai.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { rpc } from "../lib/monitor.mjs";

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "invalid" }, 405);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json({ stored: false }, 202);
  // Only from this site's own pages.
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return json({ error: "forbidden" }, 403);
  const rl = await checkRate(req, context, "errors");
  if (!rl.allowed) return json({ error: rl.error }, rl.status);
  const parsed = await readJson(req, 2048);
  if (parsed.error) return json({ error: parsed.error }, parsed.status);
  const b = parsed.body || {}, str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const r = await rpc("report_error", { p_source: "client", p_kind: str(b.kind, 60), p_message: str(b.message, 400), p_location: str(b.location, 200), p_release: str(b.release, 40) }, 3000);
  return json({ stored: r.ok }, r.ok ? 200 : 202);
};

export const config = { path: "/api/errors" };
