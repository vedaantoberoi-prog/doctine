/**
 * Doctine · runs the app's server functions on Cloudflare Pages (the same code Netlify runs, from netlify/functions).
 * /api/config, /api/account, /api/chat, /api/scan, /api/admin and /api/events are routed to their handlers; Cloudflare's settings are copied into
 * process.env, where the handlers read them; the visitor's IP comes from Cloudflare's cf-connecting-ip header.
 * Needs the nodejs_compat compatibility flag (wrangler.toml), for process and node:crypto.
 */
import config from "../../netlify/functions/config.mjs";
import account from "../../netlify/functions/account.mjs";
import chat from "../../netlify/functions/chat.mjs";
import scan from "../../netlify/functions/scan.mjs";
import admin from "../../netlify/functions/admin.mjs";
import events from "../../netlify/functions/events.mjs";

const ROUTES = { config, account, chat, scan, admin, events };
const notFound = () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequest({ request, env, params }) {
  for (const [k, v] of Object.entries(env || {})) if (typeof v === "string") process.env[k] = v;
  const name = [].concat(params && params.path || [])[0];
  const handler = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
  if (!handler || [].concat(params.path).length !== 1) return notFound();
  const res = await handler(request, { ip: request.headers.get("cf-connecting-ip") || undefined });
  const out = new Response(res.body, res); out.headers.set("cache-control", "no-store");
  return out;
}
