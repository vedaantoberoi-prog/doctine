/**
 * Doctine · the app's server on Vercel (prepared for a STAGING project only; not connected, not deployed).
 * One catch-all function runs the same router as production on Cloudflare (functions/api/[[path]].js), so the handlers,
 * routes and checks are identical. Vercel's own client-IP header (x-real-ip) is passed on as the one the router reads;
 * a cf-connecting-ip header sent by a visitor is discarded first, so it can't be spoofed through Vercel.
 * The Vercel project must hold ONLY staging settings (DOCTINE_ENV=staging, the staging Supabase project, no production
 * secrets) for both its Production and Preview environments. See docs/STAGING_HOSTING.md.
 */
import { onRequest } from "../functions/api/[[path]].js";

export const config = { maxDuration: 30 };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const headers = new Headers(request.headers);
    headers.delete("cf-connecting-ip");
    const ip = (request.headers.get("x-real-ip") || "").trim();
    if (ip) headers.set("cf-connecting-ip", ip);
    const init = { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, duplex: "half" };
    return onRequest({ request: new Request(request.url, init), env: process.env, params: path.length ? { path } : {} });
  },
};
