/** Doctine · functions/api/[[path]].js (the app's server on Cloudflare Pages), run in Node with a simulated Pages context. */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
const { onRequest } = await import("../functions/api/[[path]].js");

let passed = 0; const t = async (name, fn) => { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { console.log("  ✗ " + name + ": " + e.message); process.exitCode = 1; } };
const env = { DOCTINE_ENV: "production", SUPABASE_URL: "https://x.supabase.co/", SUPABASE_ANON_KEY: "sb_publishable_anon-public", SUPABASE_SERVICE_ROLE_KEY: "service-secret", AUTH_GOOGLE: "true", RATE_LIMIT_SECRET: "r".repeat(64) };
const call = (path, init = {}, e = env) => onRequest({ request: new Request("https://app.doctine.com/api/" + path, { headers: { "cf-connecting-ip": "203.0.113.9", ...(init.headers || {}) }, ...init }), env: e, params: { path: path.split("/") } });

await t("/api/config returns the public settings from Cloudflare's environment, and never the service key", async () => {
  const r = await call("config"); const j = await r.json(); const raw = JSON.stringify(j);
  assert.equal(j.supabaseUrl, "https://x.supabase.co"); assert.equal(j.supabaseAnonKey, "sb_publishable_anon-public"); assert.equal(j.environment, "production"); assert.equal(j.googleSignIn, true);
  assert.ok(!raw.includes("service-secret")); assert.equal(r.headers.get("cache-control"), "no-store");
});
await t("unknown and nested routes are 404, not passed to a handler", async () => {
  for (const p of ["nope", "config/extra", "__proto__", "constructor"]) assert.equal((await call(p)).status, 404, p);
});
await t("/api/account refuses a request without a sign-in token", async () => {
  const r = await call("account", { method: "DELETE" }); assert.ok([401, 403].includes(r.status), "status " + r.status);
});
await t("/api/chat without an AI key says the assistant isn't configured (no AI call)", async () => {
  const r = await call("chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "What is HbA1c?" }] }) }, { ...env, RATE_LIMIT_REQUIRE_SHARED: "false", SUPABASE_SERVICE_ROLE_KEY: "" });
  const j = await r.json(); assert.ok(j.error === "not_configured" || j.ai_unavailable === "not_configured", JSON.stringify(j).slice(0, 160));
});
await t("an emergency message still gets fixed 112 guidance without an AI key", async () => {
  const r = await call("chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "my father has crushing chest pain and cannot breathe" }] }) }, { ...env, RATE_LIMIT_REQUIRE_SHARED: "false", SUPABASE_SERVICE_ROLE_KEY: "" });
  const j = await r.json(); assert.ok(/112/.test(JSON.stringify(j)), JSON.stringify(j).slice(0, 200));
});
console.log(`${passed} cloudflare-adapter tests passed`);
