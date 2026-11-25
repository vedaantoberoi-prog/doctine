/**
 * Doctine · runs the app's server functions on Cloudflare Pages (the same code Netlify runs, from netlify/functions).
 * /api/config, /api/account, /api/chat, /api/scan, /api/admin, /api/events, /api/monitor, /api/errors, /api/gateway, /api/assist, /api/guardian and /api/doctor are routed to their handlers; Cloudflare's settings are copied into
 * process.env, where the handlers read them; the visitor's IP comes from Cloudflare's cf-connecting-ip header.
 * Needs the nodejs_compat compatibility flag (wrangler.toml), for process and node:crypto.
 */
import config from "../../netlify/functions/config.mjs";
import account from "../../netlify/functions/account.mjs";
import chat from "../../netlify/functions/chat.mjs";
import scan from "../../netlify/functions/scan.mjs";
import admin from "../../netlify/functions/admin.mjs";
import events from "../../netlify/functions/events.mjs";
import monitor from "../../netlify/functions/monitor.mjs";
import errors from "../../netlify/functions/errors.mjs";
import gateway from "../../netlify/functions/gateway.mjs";
import assist from "../../netlify/functions/assist.mjs";
import guardian from "../../netlify/functions/guardian.mjs";
import doctor from "../../netlify/functions/doctor.mjs";
import { reportServerError } from "../../netlify/lib/monitor.mjs";
import { corsFor } from "../../netlify/lib/cors.mjs";

const ROUTES = { config, account, chat, scan, admin, events, monitor, errors, gateway, assist, guardian, doctor };
// Production answers /api only at its real addresses. Cloudflare keeps every past deployment reachable at
// <id>.doctine-app-direct.pages.dev with the production settings, so without this an old copy of the server code
// (missing later fixes) could still be used against the live database. APP_HOSTS (comma-separated) overrides the list.
const PRODUCTION_HOSTS = ["app.doctine.com", "doctine-app-direct.pages.dev"];
export function hostAllowed(request, env) {
  if (String((env && env.DOCTINE_ENV) || "").toLowerCase() !== "production") return true;
  const list = env.APP_HOSTS ? String(env.APP_HOSTS).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean) : PRODUCTION_HOSTS;
  let host = "";
  try { host = new URL(request.url).hostname.toLowerCase(); } catch { return false; }
  return list.includes(host);
}
const notFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequest({ request, env, params, waitUntil }) {
  for (const [k, v] of Object.entries(env || {})) if (typeof v === "string") process.env[k] = v;
  if (!hostAllowed(request, env)) return new Response(JSON.stringify({ error: "wrong_address", message: "Use https://app.doctine.com." }), { status: 421, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const name = [].concat(params && params.path || [])[0];
  const handler = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
  if (!handler || [].concat(params.path).length !== 1) return notFound();
  // The Doctine apps (see netlify/lib/cors.mjs): answer the browser's preflight, and label replies for them.
  const cors = corsFor(request.headers.get("origin"), name);
  if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: { ...(cors || {}), "cache-control": "no-store" } });
  let res;
  try { res = await handler(request, { ip: request.headers.get("cf-connecting-ip") || undefined, waitUntil: typeof waitUntil === "function" ? waitUntil : undefined }); }
  catch (e) { // an unhandled server error: recorded for the error tracker (kind and place only), then a plain 500
    await reportServerError("/api/" + name, e);
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  const out = new Response(res.body, res); out.headers.set("cache-control", "no-store");
  if (cors) for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}
