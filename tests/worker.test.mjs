/**
 * Doctine · the drag-and-drop build of the app (tools/build-direct.mjs): its bundled _worker.js run in Node the way
 * Cloudflare Pages calls it, plus the folder's routing and headers. Build first: node tools/build-direct.mjs
 */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
const dir = new URL("../dist/doctine-app/", import.meta.url);
if (!existsSync(new URL("_worker.js", dir))) { console.log("worker: dist/doctine-app not built; run node tools/build-direct.mjs"); process.exit(1); }
const worker = (await import(new URL("_worker.js", dir).href)).default;

let passed = 0; const t = async (name, fn) => { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { console.log("  ✗ " + name + ": " + e.message); process.exitCode = 1; } };
const assets = []; const ASSETS = { fetch: async (req) => { assets.push(new URL(req.url).pathname); return new Response("static", { status: 200 }); } };
const env = { DOCTINE_ENV: "production", SUPABASE_URL: "https://x.supabase.co/", SUPABASE_ANON_KEY: "sb_publishable_anon-public", SUPABASE_SERVICE_ROLE_KEY: "service-secret", AUTH_GOOGLE: "true", RATE_LIMIT_SECRET: "r".repeat(40), ASSETS };
const call = (path, init = {}) => worker.fetch(new Request("https://app.doctine.com" + path, { headers: { "cf-connecting-ip": "203.0.113.9", ...(init.headers || {}) }, ...init }), env);

await t("/api/config answers with the public settings and never the service key", async () => {
  const r = await call("/api/config"); const j = await r.json();
  assert.equal(j.supabaseUrl, "https://x.supabase.co"); assert.equal(j.googleSignIn, true); assert.ok(!JSON.stringify(j).includes("service-secret")); assert.equal(r.headers.get("cache-control"), "no-store");
});
await t("unknown, empty and nested /api routes are 404", async () => {
  for (const p of ["/api/nope", "/api/", "/api", "/api/config/extra", "/api/__proto__"]) assert.equal((await call(p)).status, 404, p);
});
await t("account deletion refuses a request without a sign-in", async () => { assert.equal((await call("/api/account", { method: "DELETE" })).status, 401); });
await t("an emergency message gets fixed 112 guidance with no AI key", async () => {
  const r = await call("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "my father has crushing chest pain and cannot breathe" }] }) });
  assert.match(JSON.stringify(await r.json()), /112/);
});
await t("everything else is handed to the static files", async () => {
  assets.length = 0; for (const p of ["/", "/index.html", "/apix", "/vendor/pdfjs-3.11.174/pdf.js"]) await call(p);
  assert.deepEqual(assets, ["/", "/index.html", "/apix", "/vendor/pdfjs-3.11.174/pdf.js"]);
});
await t("only /api/* runs the worker; the static files keep the security headers, and the build is stamped", async () => {
  assert.deepEqual(JSON.parse(readFileSync(new URL("_routes.json", dir), "utf8")), { version: 1, include: ["/api/*"], exclude: [] });
  const h = readFileSync(new URL("_headers", dir), "utf8"); assert.match(h, /Content-Security-Policy: script-src 'self'/); assert.match(h, /X-Robots-Tag: noindex/);
  assert.match(JSON.parse(readFileSync(new URL("version.json", dir), "utf8")).commit, /^[0-9a-f]{40}$/);
});
await t("the bundle contains no secret values", async () => {
  const src = readFileSync(new URL("_worker.js", dir), "utf8"); assert.ok(!/sk-ant-|service_role"\s*:|eyJhbGciOi/.test(src));
});
console.log(`${passed} worker tests passed`);
