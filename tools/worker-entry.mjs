/**
 * Doctine · the app's server as a single Cloudflare Pages `_worker.js` ("advanced mode"), for deploying the app by
 * drag and drop in the Cloudflare dashboard, which doesn't accept a functions/ folder. Same handlers and routing as
 * functions/api/[[path]].js. `_routes.json` sends only /api/* here; every other request is a static file served by
 * Cloudflare with public/_headers. Built by tools/build-direct.mjs.
 */
import { onRequest } from "../functions/api/[[path]].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice(5).split("/").filter(Boolean);
      // Pass Cloudflare's waitUntil, so work after the reply (security log, analytics, stored traces) isn't cut off.
      const waitUntil = ctx && typeof ctx.waitUntil === "function" ? ctx.waitUntil.bind(ctx) : undefined;
      return onRequest({ request, env, params: path.length ? { path } : {}, waitUntil });
    }
    return env.ASSETS.fetch(request);
  },
};
