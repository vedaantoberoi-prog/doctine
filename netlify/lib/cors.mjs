/**
 * Doctine · cross-origin access for the Doctine Android and macOS apps only.
 * The apps run the same bundled web app from their own origin and call https://app.doctine.com/api/*:
 *   Android (Capacitor, androidScheme "https")  → https://localhost
 *   macOS   (Tauri on WebKit)                    → tauri://localhost
 * Exactly these origins, no wildcard and no cookies (requests carry the person's Bearer token, which a web page can't
 * read from another origin). The admin console and the monitor are never reachable cross-origin.
 */
export const APP_ORIGINS = Object.freeze(["https://localhost", "tauri://localhost"]);
const OPEN_ROUTES = new Set(["config", "account", "events", "errors", "chat", "scan"]);

/** CORS headers for this request, or null when the origin or route isn't allowed (then the browser blocks the reply). */
export function corsFor(origin, route) {
  if (!origin || !APP_ORIGINS.includes(origin) || !OPEN_ROUTES.has(route)) return null;
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "600", vary: "Origin" };
}
