/**
 * Doctine · the app's server as a single Cloudflare Pages `_worker.js` ("advanced mode"), for deploying the app by
 * drag and drop in the Cloudflare dashboard, which doesn't accept a functions/ folder. Same handlers and routing as
 * functions/api/[[path]].js. `_routes.json` sends only /api/* here; every other request is a static file served by
 * Cloudflare with public/_headers. Built by tools/build-direct.mjs.
 */
import { onRequest } from "../functions/api/[[path]].js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice(5).split("/").filter(Boolean);
      return onRequest({ request, env, params: path.length ? { path } : {} });
    }
    return env.ASSETS.fetch(request);
  },
};
