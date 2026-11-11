/**
 * Doctine · /api/admin and /api/events, with Supabase simulated. The permission rules themselves are tested against a
 * real PostgreSQL in tests/admin.test.sql; these tests check the web server around them: identity comes only from the
 * sign-in token, refusals are logged, two-step sign-in is required where set up, database refusals stay refusals, and the
 * server key never appears in any reply. Fictional data only.
 */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import admin from "../netlify/functions/admin.mjs";
import events from "../netlify/functions/events.mjs";
import { _resetTokenCache } from "../netlify/lib/ratelimit.mjs";

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); } };

const SECRET = "sb_secret_TEST_ONLY_not_real";
Object.assign(process.env, { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_x", SUPABASE_SERVICE_ROLE_KEY: SECRET });
const jwt = (claims) => "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const PEOPLE = {
  [jwt({ sub: "owner", aal: "aal1" })]: "a0000000-0000-0000-0000-000000000001",
  [jwt({ sub: "owner2", aal: "aal2" })]: "a0000000-0000-0000-0000-000000000001",
  [jwt({ sub: "analyst", aal: "aal1" })]: "a0000000-0000-0000-0000-000000000004",
  [jwt({ sub: "user", aal: "aal1" })]: "b0000000-0000-0000-0000-000000000001",
};
const ROLES = { "a0000000-0000-0000-0000-000000000001": "owner", "a0000000-0000-0000-0000-000000000004": "analyst" };
let mfaEnrolled = false, calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, body, headers: init.headers || {} });
  if (url.endsWith("/auth/v1/user")) { const t = String(init.headers.authorization || "").replace("Bearer ", ""); return PEOPLE[t] ? new Response(JSON.stringify({ id: PEOPLE[t], user_metadata: { role: "owner" } })) : new Response("{}", { status: 401 }); }
  if (url.endsWith("/rpc/rate_limit_hit")) return new Response(JSON.stringify([{ allowed: true, hits: 1, reset_at: new Date(Date.now() + 6e5).toISOString() }]));
  if (url.endsWith("/rpc/admin_me")) { const r = ROLES[body.p_actor]; return new Response(JSON.stringify(r ? { role: r, perms: [], mfa_enrolled: mfaEnrolled } : { role: null })); }
  if (url.endsWith("/rpc/admin_log_denied")) return new Response("null");
  // The database refuses analysts the user list, exactly as private.require does.
  if (url.endsWith("/rpc/admin_users")) return ROLES[body.p_actor] === "owner" ? new Response(JSON.stringify({ total: 1, rows: [{ id: "b0000000-0000-0000-0000-000000000001", email: "asha.sample@example.test" }] })) : new Response(JSON.stringify({ code: "42501", message: "forbidden" }), { status: 403 });
  if (url.endsWith("/rpc/admin_user_action")) return new Response(JSON.stringify({ ok: true, apply_ban: "on", sessions_ended: 2 }));
  if (url.includes("/auth/v1/admin/users/")) return new Response("{}", { status: 200 });
  if (url.endsWith("/rpc/admin_log_action")) return new Response(JSON.stringify({ ok: true }));
  if (url.endsWith("/rpc/admin_series")) return new Response(JSON.stringify([{ day: "2026-11-11", users_total: 3, users_new: 1, dau: 1, wau: 1, mau: 1, documents: 0 }, { day: "=HYPERLINK(1)", users_total: 3 }]));
  if (url.endsWith("/rpc/record_event")) return body.p_props && Object.values(body.p_props).some((v) => typeof v === "string" && /\s/.test(v)) ? new Response(JSON.stringify({ code: "22023" }), { status: 400 }) : new Response("true");
  return new Response("{}", { status: 404 });
};
const post = (fn, token, body, ip = "10.1.1.1") => fn(new Request("https://app.doctine.test/api/admin", { method: "POST", headers: token ? { authorization: "Bearer " + token } : {}, body: JSON.stringify(body) }), { ip });
const tok = (sub) => Object.keys(PEOPLE).find((k) => JSON.parse(Buffer.from(k.split(".")[1], "base64url")).sub === sub);
const replies = [];
const read = async (r) => { const t = await r.text(); replies.push(t); try { return { status: r.status, j: JSON.parse(t), t }; } catch { return { status: r.status, j: null, t }; } };

console.log("admin console server");
await test("no sign-in token: 401, and the database is never asked", async () => {
  calls = []; _resetTokenCache(); const { status } = await read(await post(admin, null, { action: "overview" }));
  assert.equal(status, 401); assert.ok(!calls.some((c) => c.url.includes("/rpc/admin_")));
});
await test("a forged or expired token: 401", async () => {
  const { status } = await read(await post(admin, jwt({ sub: "owner", role: "service_role", aal: "aal2" }), { action: "overview" })); assert.equal(status, 401);
});
await test("an ordinary account is refused (403) and the refusal is logged, even with role=owner in its metadata", async () => {
  calls = []; const { status, j } = await read(await post(admin, tok("user"), { action: "users" }));
  assert.equal(status, 403); assert.equal(j.error, "forbidden"); assert.ok(calls.some((c) => c.url.endsWith("/rpc/admin_log_denied")));
  assert.ok(!calls.some((c) => c.url.endsWith("/rpc/admin_users")), "the data function is never reached");
});
await test("the acting account comes from the token, never from the request body", async () => {
  calls = []; await read(await post(admin, tok("analyst"), { action: "users", p_actor: "a0000000-0000-0000-0000-000000000001", actor: "a0000000-0000-0000-0000-000000000001" }));
  const c = calls.find((x) => x.url.endsWith("/rpc/admin_users")); assert.equal(c.body.p_actor, "a0000000-0000-0000-0000-000000000004");
});
await test("a database refusal stays a refusal: analyst asking for the user list gets 403", async () => {
  const { status, j } = await read(await post(admin, tok("analyst"), { action: "users" })); assert.equal(status, 403); assert.equal(j.error, "forbidden");
});
await test("the owner gets the user list", async () => {
  const { status, j } = await read(await post(admin, tok("owner"), { action: "users", q: "sample" })); assert.equal(status, 200); assert.equal(j.data.total, 1);
});
await test("an admin with two-step sign-in set up must use it (aal2)", async () => {
  mfaEnrolled = true;
  let { status, j } = await read(await post(admin, tok("owner"), { action: "overview" })); assert.equal(status, 403); assert.equal(j.error, "mfa_required");
  ({ status, j } = await read(await post(admin, tok("owner"), { action: "me" }))); assert.equal(status, 200); assert.equal(j.mfa_required, true);
  ({ status, j } = await read(await post(admin, tok("owner2"), { action: "series" }))); assert.equal(status, 200);
  mfaEnrolled = false;
});
await test("ADMIN_REQUIRE_MFA=true requires two-step sign-in for every admin", async () => {
  process.env.ADMIN_REQUIRE_MFA = "true";
  const { status, j } = await read(await post(admin, tok("analyst"), { action: "series" })); assert.equal(status, 403); assert.equal(j.error, "mfa_required");
  delete process.env.ADMIN_REQUIRE_MFA;
});
await test("suspending uses Supabase's Auth admin API (ban) and records the outcome", async () => {
  calls = []; const { status, j } = await read(await post(admin, tok("owner"), { action: "user_suspend", id: "b0000000-0000-0000-0000-000000000001", reason: "fictional" }));
  assert.equal(status, 200); assert.equal(j.data.ok, true);
  const ban = calls.find((c) => c.url.includes("/auth/v1/admin/users/b0000000")); assert.equal(ban.body.ban_duration, "876000h");
  assert.ok(calls.some((c) => c.url.endsWith("/rpc/admin_log_action") && c.body.p_outcome === "ok"));
});
await test("bad ids, unknown actions, oversized bodies and GET are refused", async () => {
  assert.equal((await read(await post(admin, tok("owner"), { action: "user", id: "1 or 1=1" }))).status, 400);
  assert.equal((await read(await post(admin, tok("owner"), { action: "drop_tables" }))).status, 400);
  assert.equal((await read(await post(admin, tok("owner"), { action: "users", q: "x".repeat(20000) }))).status, 413);
  assert.equal((await admin(new Request("https://d/api/admin"), {})).status, 405);
});
await test("CSV export: a file, no health columns, and cells cannot run as spreadsheet formulas", async () => {
  const r = await post(admin, tok("owner"), { action: "export", report: "daily", from: "2026-11-01T00:00:00Z", to: "2026-11-12T00:00:00Z" });
  assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition"), /attachment; filename="doctine-daily-/);
  const t = await r.text(); replies.push(t); assert.match(t.split("\n")[0], /^day,users_total,users_new,dau/); assert.match(t, /\n'=HYPERLINK\(1\),3/);
});
await test("the server key is never in any reply", async () => { assert.ok(replies.length > 10); for (const t of replies) assert.ok(!t.includes(SECRET)); });

console.log("measurement events");
const ev = (token, body, ip) => events(new Request("https://d/api/events", { method: "POST", headers: token ? { authorization: "Bearer " + token } : {}, body: JSON.stringify(body) }), { ip });
await test("a signed-in event is stored against the account from the token", async () => {
  calls = []; const r = await ev(tok("user"), { name: "record_exported", props: { format: "pdf" }, key: "exp-1", user_id: "someone-else" }, "10.2.0.1");
  assert.equal(r.status, 200); assert.equal(calls.find((c) => c.url.endsWith("/rpc/record_event")).body.p_user, "b0000000-0000-0000-0000-000000000001");
});
await test("signed-out visitors may only report sign-in failures and errors", async () => {
  assert.equal((await ev(null, { name: "record_exported", props: {}, key: "k" }, "10.2.0.2")).status, 401);
  assert.equal((await ev(null, { name: "login_failure", props: { reason: "invalid_credentials" }, key: "k" }, "10.2.0.3")).status, 200);
});
await test("free text is refused", async () => {
  assert.equal((await ev(tok("user"), { name: "document_upload_failed", props: { reason: "Haemoglobin 13.1" }, key: "k2" }, "10.2.0.4")).status, 400);
});

console.log(failed ? `${passed} admin server tests passed, ${failed} FAILED` : `${passed} admin server tests passed`);
process.exit(failed ? 1 : 0);
