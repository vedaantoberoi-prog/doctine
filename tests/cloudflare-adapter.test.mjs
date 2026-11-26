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
await t("/api/admin and /api/events are routed, and refuse requests without a sign-in token", async () => {
  const a = await call("admin", { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"overview"}' });
  assert.ok([401, 503].includes(a.status), "admin status " + a.status);
  const e = await call("events", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"record_exported","props":{},"key":"k"}' });
  assert.ok([401, 202].includes(e.status), "events status " + e.status);
});
await t("/api/chat without an AI key says the assistant isn't configured (no AI call)", async () => {
  const r = await call("chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "What is HbA1c?" }] }) }, { ...env, RATE_LIMIT_REQUIRE_SHARED: "false", SUPABASE_SERVICE_ROLE_KEY: "" });
  const j = await r.json(); assert.ok(j.error === "not_configured" || j.ai_unavailable === "not_configured", JSON.stringify(j).slice(0, 160));
});
await t("an emergency message still gets fixed 112 guidance without an AI key", async () => {
  const r = await call("chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "my father has crushing chest pain and cannot breathe" }] }) }, { ...env, RATE_LIMIT_REQUIRE_SHARED: "false", SUPABASE_SERVICE_ROLE_KEY: "" });
  const j = await r.json(); assert.ok(/112/.test(JSON.stringify(j)), JSON.stringify(j).slice(0, 200));
});
await t("the Doctine apps (https://localhost, tauri://localhost) may call the app's API; preflight answered", async () => {
  for (const o of ["https://localhost", "tauri://localhost"]) {
    const p = await call("config", { method: "OPTIONS", headers: { origin: o, "access-control-request-method": "GET" } });
    assert.equal(p.status, 204); assert.equal(p.headers.get("access-control-allow-origin"), o); assert.match(p.headers.get("access-control-allow-headers"), /authorization/);
    const r = await call("config", { headers: { origin: o } }); assert.equal(r.headers.get("access-control-allow-origin"), o); assert.equal(r.headers.get("vary"), "Origin");
  }
});
await t("…but no other origin, never a wildcard, no cookies, and never the admin console or the monitor", async () => {
  for (const o of ["https://evil.example", "http://localhost", "null", "https://localhost.evil.example"]) {
    const p = await call("config", { method: "OPTIONS", headers: { origin: o } }); assert.equal(p.status, 403, o); assert.equal(p.headers.get("access-control-allow-origin"), null, o);
    assert.equal((await call("config", { headers: { origin: o } })).headers.get("access-control-allow-origin"), null, o);
  }
  for (const route of ["admin", "monitor"]) {
    const p = await call(route, { method: "OPTIONS", headers: { origin: "tauri://localhost" } }); assert.equal(p.status, 403, route);
    const r = await call(route, { method: "POST", headers: { origin: "https://localhost", "content-type": "application/json" }, body: '{"action":"me"}' }); assert.equal(r.headers.get("access-control-allow-origin"), null, route);
  }
  const r = await call("config", { headers: { origin: "https://localhost" } }); assert.notEqual(r.headers.get("access-control-allow-origin"), "*"); assert.equal(r.headers.get("access-control-allow-credentials"), null);
});
await t("production answers /api only at app.doctine.com and doctine-app-direct.pages.dev, not at an old deployment's own address", async () => {
  const at = (host, e = env) => onRequest({ request: new Request(`https://${host}/api/config`, { headers: { "cf-connecting-ip": "203.0.113.9" } }), env: e, params: { path: ["config"] } });
  assert.equal((await at("app.doctine.com")).status, 200);
  assert.equal((await at("APP.DOCTINE.COM")).status, 200);
  assert.equal((await at("doctine-app-direct.pages.dev")).status, 200);
  for (const h of ["9efabcab.doctine-app-direct.pages.dev", "f625d0a8.doctine-app-direct.pages.dev", "evil.example", "app.doctine.com.evil.example"]) {
    const r = await at(h); assert.equal(r.status, 421, h); const j = await r.json(); assert.equal(j.error, "wrong_address"); assert.ok(!JSON.stringify(j).includes("supabase"), h);
  }
  assert.equal((await at("9efabcab.doctine-app-direct.pages.dev", { ...env, APP_HOSTS: "9efabcab.doctine-app-direct.pages.dev" })).status, 200, "APP_HOSTS overrides the list");
  assert.equal((await at("staging.example", { ...env, DOCTINE_ENV: "staging" })).status, 200, "non-production sites are not restricted");
});
await t("every request leaves one security-log line after the reply: route, status, IP, claimed account; never the body or token", async () => {
  const { claimedUid, securityLine } = await import("../netlify/lib/seclog.mjs");
  const sent = [], realFetch = globalThis.fetch, waits = [];
  globalThis.fetch = async (url, init) => { if (String(url).endsWith("/rpc/security_log_add")) { sent.push(JSON.parse(init.body)); return new Response("1"); } return realFetch(url, init); };
  try {
    const payload = Buffer.from(JSON.stringify({ sub: "a1000000-0000-4000-8000-000000000001", role: "authenticated" })).toString("base64url");
    const tok = "x." + payload + ".sig";
    const go = (host, path, init = {}) => onRequest({ request: new Request(`https://${host}/api/${path}`, { headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "Fictional/1.0", authorization: "Bearer " + tok, ...(init.headers || {}) }, ...init }),
      env, params: { path: path.split("/") }, waitUntil: (p) => waits.push(p) });
    await go("app.doctine.com", "account", { method: "DELETE" });
    await go("9efabcab.doctine-app-direct.pages.dev", "config");
    await go("app.doctine.com", "no<script>pe");
    await Promise.all(waits);
    assert.equal(sent.length, 3);
    const [a, b, c] = sent.map((x) => x.p_rows[0]);
    assert.equal(a.route, "account"); assert.equal(a.method, "DELETE"); assert.ok(a.status >= 400, "refused: " + a.status); assert.equal(a.ip, "203.0.113.9");
    assert.equal(a.claimed_uid, "a1000000-0000-4000-8000-000000000001"); assert.match(a.ua_hash, /^[0-9a-f]{16}$/); assert.equal(a.host, "app.doctine.com"); assert.equal(a.env, "production");
    assert.equal(b.route, "wrong_address:config"); assert.equal(b.status, 421); assert.equal(c.route, "unknown"); assert.equal(c.status, 404);
    const raw = JSON.stringify(sent); assert.ok(!raw.includes(tok) && !raw.includes("sig") && !raw.includes("Fictional") && !raw.includes("script"), "no token, raw user agent or path text");
    assert.equal(claimedUid("Bearer not-a-jwt"), null); assert.equal(claimedUid(""), null);
    assert.equal(securityLine(new Request("https://h/api/x", { headers: { "x-forwarded-for": "evil, 1.2.3.4" } }), { route: "x", status: 200 }).ip, null, "junk IPs are dropped");
  } finally { globalThis.fetch = realFetch; }
});
await t("the security log is skipped without the server key, with SECURITY_LOG=off, and never breaks a request when the database fails", async () => {
  const { recordSecurity } = await import("../netlify/lib/seclog.mjs");
  assert.equal(await recordSecurity([{ route: "x" }], { env: { SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "" } }), false);
  assert.equal(await recordSecurity([{ route: "x" }], { env: { SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k", SECURITY_LOG: "off" } }), false);
  assert.equal(await recordSecurity([{ route: "x" }], { env: { SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k" }, fetchImpl: async () => { throw new Error("down"); } }), false);
  const waits = []; const r = await onRequest({ request: new Request("https://app.doctine.com/api/config"), env, params: { path: ["config"] }, waitUntil: (p) => waits.push(p) });
  assert.equal(r.status, 200);
});
console.log(`${passed} cloudflare-adapter tests passed`);
