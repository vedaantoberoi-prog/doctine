/** Doctine · the prepared Vercel staging entry (api/[...path].mjs) and vercel.json, run in Node. Nothing is deployed. */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const entry = (await import("../api/[...path].mjs")).default;
let passed = 0; const t = async (name, fn) => { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { console.log("  ✗ " + name + ": " + e.message); process.exitCode = 1; } };
const STAGING = { DOCTINE_ENV: "staging", SUPABASE_URL: "https://hmlxqmhqfaxfgbizcjyg.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_staging-public", AUTH_GOOGLE: "false" };
const withEnv = async (env, fn) => { const old = { ...process.env }; Object.assign(process.env, env); try { return await fn(); } finally { for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); } };

await t("/api/config answers through the Vercel entry with the staging project only", () => withEnv(STAGING, async () => {
  const r = await entry.fetch(new Request("https://doctine-staging.vercel.app/api/config", { headers: { "x-real-ip": "203.0.113.7" } }));
  const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.environment, "staging"); assert.equal(j.supabaseUrl, STAGING.SUPABASE_URL);
  assert.ok(!JSON.stringify(j).includes("ggqctflfwpfkemgehizq"), "never the production project");
}));
await t("unknown and nested routes are 404; POST bodies reach the handler", () => withEnv(STAGING, async () => {
  assert.equal((await entry.fetch(new Request("https://x.vercel.app/api/nope"))).status, 404);
  assert.equal((await entry.fetch(new Request("https://x.vercel.app/api/config/extra"))).status, 404);
  const r = await entry.fetch(new Request("https://x.vercel.app/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "my father has crushing chest pain and cannot breathe" }] }) }));
  assert.match(JSON.stringify(await r.json()), /112/);
}));
await t("a visitor can't spoof the client IP with a cf-connecting-ip header", async () => {
  const src = readFileSync(new URL("../api/[...path].mjs", import.meta.url), "utf8");
  assert.match(src, /headers\.delete\("cf-connecting-ip"\)/); assert.match(src, /x-real-ip/);
});
await t("vercel.json: Mumbai region, staging-only CSP, security headers, no secrets", async () => {
  const raw = readFileSync(new URL("../vercel.json", import.meta.url), "utf8"), c = JSON.parse(raw);
  assert.deepEqual(c.regions, ["bom1"]);
  const all = c.headers.find((h) => h.source === "/(.*)").headers, get = (k) => (all.find((h) => h.key === k) || {}).value || "";
  assert.match(get("Content-Security-Policy"), /connect-src [^;]*https:\/\/hmlxqmhqfaxfgbizcjyg\.supabase\.co/); assert.doesNotMatch(raw, /ggqctflfwpfkemgehizq/);
  for (const k of ["X-Frame-Options", "Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) assert.ok(get(k), k);
  assert.equal(get("X-Robots-Tag"), "noindex, nofollow");
  assert.doesNotMatch(raw, /sb_secret|service_role|eyJhbGci|nfp_/);
  const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  assert.ok(toml.includes(get("Content-Security-Policy")), "same CSP as the current Netlify staging site");
});
console.log(`${passed} vercel-adapter tests passed`);
