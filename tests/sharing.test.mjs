/**
 * Doctine · patient-controlled record sharing: the request rules (netlify/lib/doctors/sharing.mjs), /api/share and the
 * doctor's side of /api/doctor, with Supabase simulated. The access rules themselves (active share, verified doctor,
 * only the shared parts, every opening logged) are tested on PostgreSQL in tests/sharing.test.sql. Fictional data only.
 */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SCOPES, PURPOSES, DAYS, cleanShare, cleanCode } from "../netlify/lib/doctors/sharing.mjs";
import share, { _resetShareCache } from "../netlify/functions/share.mjs";
import doctor, { _resetDoctorCache } from "../netlify/functions/doctor.mjs";
import { _resetSettingsCache } from "../netlify/lib/settings.mjs";
import { _resetTokenCache, limitsFor } from "../netlify/lib/ratelimit.mjs";

let passed = 0, failed = 0; const results = [];
const test = async (name, fn) => { try { await fn(); passed++; results.push({ name, status: "passed" }); console.log("  ✓ " + name); } catch (e) { failed++; results.push({ name, status: "failed", error: String(e && e.message).slice(0, 300) }); console.log("  ✗ " + name + "\n      " + (e && e.stack || e).toString().split("\n").slice(0, 4).join("\n      ")); } };

console.log("sharing rules");
await test("the parts, purposes and durations match the database's lists", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261127000000_record_sharing.sql", import.meta.url), "utf8");
  const scopes = sql.match(/scopes <@ array\[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(scopes.sort(), Object.keys(SCOPES).sort());
  const purposes = sql.match(/purpose in \(([^)]+)\)/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(purposes.sort(), Object.keys(PURPOSES).sort());
  assert.match(sql, /days not in \(1, 7, 30\)/); assert.deepEqual([...DAYS], [1, 7, 30]);
});
await test("a share request needs a well-formed code, at least one known part, 1/7/30 days, a purpose and a real confirmation", () => {
  const ok = cleanShare({ code: "abcd-efgh-jk", scopes: ["medicines", "medicines", "allergies"], days: "7", purpose: "consultation", confirm: true, note: "  fever  " });
  assert.ok(ok.ok, ok.error); assert.equal(ok.share.code, "ABCDEFGHJK"); assert.deepEqual(ok.share.scopes, ["medicines", "allergies"]); assert.equal(ok.share.days, 7); assert.equal(ok.share.note, "fever");
  for (const bad of [{ code: "ABCDEFGHIO" }, { scopes: [] }, { scopes: ["everything"] }, { days: 90 }, { purpose: "marketing" }, { confirm: "true" }])
    assert.equal(cleanShare({ code: "ABCDEFGHJK", scopes: ["medicines"], days: 7, purpose: "consultation", confirm: true, ...bad }).ok, false, JSON.stringify(bad));
  assert.equal(cleanCode(" ab-cd "), "ABCD");
});
await test("lookups are rate-limited more tightly than ordinary use", () => {
  const u = limitsFor("share", "user", {}), d = limitsFor("doctor", "user", {});
  assert.ok(u[0][1] <= 60 && u[0][1] < d[0][1]);
});

console.log("/api/share and the doctor's side of /api/doctor (Supabase simulated)");
const SECRET = "sb_secret_TEST_ONLY_not_real";
const env = { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_x", SUPABASE_SERVICE_ROLE_KEY: SECRET, RATE_LIMIT_SECRET: "r".repeat(40) };
const PAT = "f6000000-0000-0000-0000-0000000000a1", DOC = "f6000000-0000-0000-0000-0000000000d1";
const TOKENS = { "tok-p": PAT, "tok-d": DOC };
function sim({ sharing = true, onboarding = true } = {}) {
  const db = { calls: [] };
  const ok = (v) => new Response(JSON.stringify(v)); const err = (code, status = 400, message = "") => new Response(JSON.stringify({ code, message }), { status });
  const fetchImpl = async (url, init = {}) => {
    url = String(url); const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null; db.calls.push({ url, body });
    if (url.endsWith("/auth/v1/user")) { const t = String((init.headers || {}).authorization || "").replace("Bearer ", ""); return TOKENS[t] ? ok({ id: TOKENS[t] }) : new Response("{}", { status: 401 }); }
    if (url.endsWith("/rpc/public_settings")) return ok({ flags: { record_sharing: sharing, doctor_onboarding: onboarding }, maintenance: { on: false }, announcements: [] });
    if (url.endsWith("/rpc/rate_limit_hit")) return ok([{ allowed: true, hits: 1, reset_at: new Date(Date.now() + 6e5).toISOString() }]);
    if (url.endsWith("/rpc/share_list")) return ok({ shares: [], access: [] });
    if (url.endsWith("/rpc/share_lookup")) return body.p_code === "ABCDEFGHJK" ? ok({ name: "Dr Meera Fictional", registration_number: "DMC/12345", verified: true }) : err("P0002", 404);
    if (url.endsWith("/rpc/share_create")) return body.p.scopes.includes("labs") ? err("22023", 400, "you are already sharing with this doctor; stop that share first to change it") : ok({ ok: true, id: "x" });
    if (url.endsWith("/rpc/share_revoke")) return ok({ ok: true });
    if (url.endsWith("/rpc/practitioner_get")) return ok({ status: "VERIFIED" });
    if (url.endsWith("/rpc/practitioner_share_code")) return ok({ code: "ABCDEFGHJK" });
    if (url.endsWith("/rpc/doctor_shares")) return ok([{ id: "s1", patient: { name: "Asha Patient Fictional" } }]);
    if (url.endsWith("/rpc/doctor_share_record")) return body.p_scope === "labs" ? err("42501", 403, "that part was not shared") : ok({ scope: body.p_scope, data: { items: [] } });
    return new Response("{}", { status: 404 });
  };
  return { db, fetchImpl };
}
const replies = [];
const call = async (fn, s, { token = "tok-p", method = "POST", body } = {}) => {
  _resetSettingsCache(); _resetTokenCache(); _resetShareCache(); _resetDoctorCache();
  const req = new Request("https://app.doctine.test/api/x", { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const r = await fn(req, { ip: "203.0.113.8" }, { env, fetchImpl: s.fetchImpl, log: () => {} });
  const t = await r.text(); replies.push(t); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j };
};
const rpcCalls = (s, name) => s.db.calls.filter((c) => c.url.endsWith("/rpc/" + name));

await test("switched off: /api/share refuses everything, and the doctor's sharing actions too", async () => {
  const s = sim({ sharing: false });
  const r = await call(share, s, { method: "GET" }); assert.equal(r.status, 503); assert.equal(r.j.error, "switched_off");
  assert.equal((await call(doctor, s, { token: "tok-d", body: { action: "patients" } })).status, 503);
  assert.equal(rpcCalls(s, "doctor_shares").length + rpcCalls(s, "share_list").length, 0);
});
await test("not signed in: 401", async () => { assert.equal((await call(share, sim(), { token: null, method: "GET" })).status, 401); });
await test("GET lists my shares with the form's choices", async () => {
  const s = sim(); const r = await call(share, s, { method: "GET" });
  assert.equal(r.status, 200); assert.ok(r.j.options.scopes.medicines && r.j.options.days.includes(30)); assert.equal(rpcCalls(s, "share_list")[0].body.p_patient, PAT);
});
await test("lookup: a malformed code never reaches the database; a good one is cleaned first", async () => {
  const s = sim();
  assert.equal((await call(share, s, { body: { action: "lookup", code: "x'; drop" } })).status, 400);
  assert.equal(rpcCalls(s, "share_lookup").length, 0);
  const r = await call(share, s, { body: { action: "lookup", code: "abcde-fghjk" } }); assert.equal(r.status, 200); assert.equal(r.j.doctor.registration_number, "DMC/12345");
  assert.equal(rpcCalls(s, "share_lookup")[0].body.p_code, "ABCDEFGHJK");
  const nf = await call(share, s, { body: { action: "lookup", code: "ZZZZZZZZZZ" } }); assert.equal(nf.status, 404); assert.match(nf.j.message, /No verified doctor/);
});
await test("create: refused without confirmation; the person comes from the token; database refusals are explained", async () => {
  const s = sim();
  assert.equal((await call(share, s, { body: { action: "create", code: "ABCDEFGHJK", scopes: ["medicines"], days: 7, purpose: "consultation" } })).status, 400);
  assert.equal(rpcCalls(s, "share_create").length, 0);
  const r = await call(share, s, { body: { action: "create", code: "ABCDEFGHJK", scopes: ["medicines", "allergies"], days: 7, purpose: "consultation", confirm: true, p_patient: DOC } });
  assert.equal(r.status, 200); const c = rpcCalls(s, "share_create")[0].body; assert.equal(c.p_patient, PAT); assert.equal(c.p_code, "ABCDEFGHJK"); assert.equal(c.p.code, undefined);
  const dup = await call(share, s, { body: { action: "create", code: "ABCDEFGHJK", scopes: ["labs"], days: 1, purpose: "follow_up", confirm: true } });
  assert.equal(dup.status, 400); assert.match(dup.j.message, /already sharing/);
});
await test("revoke needs a real id", async () => {
  const s = sim();
  assert.equal((await call(share, s, { body: { action: "revoke", id: "../x" } })).status, 400);
  assert.equal((await call(share, s, { body: { action: "revoke", id: "f6000000-0000-0000-0000-0000000000e1" } })).status, 200);
  assert.equal(rpcCalls(s, "share_revoke")[0].body.p_patient, PAT);
});
await test("doctor: GET says whether sharing is on; the code, the patient list and one shared part, each for the signed-in doctor only", async () => {
  const s = sim();
  const g = await call(doctor, s, { token: "tok-d", method: "GET" }); assert.equal(g.j.sharing.on, true);
  assert.equal((await call(doctor, s, { token: "tok-d", body: { action: "share_code" } })).j.code, "ABCDEFGHJK");
  assert.equal((await call(doctor, s, { token: "tok-d", body: { action: "patients" } })).j.patients.length, 1);
  const r = await call(doctor, s, { token: "tok-d", body: { action: "patient_record", share_id: "f6000000-0000-0000-0000-0000000000e1", scope: "medicines", p_doctor: PAT } });
  assert.equal(r.status, 200); const c = rpcCalls(s, "doctor_share_record")[0].body; assert.equal(c.p_doctor, DOC); assert.equal(c.p_scope, "medicines");
  assert.equal((await call(doctor, s, { token: "tok-d", body: { action: "patient_record", share_id: "f6000000-0000-0000-0000-0000000000e1", scope: "everything" } })).status, 400);
  const f = await call(doctor, s, { token: "tok-d", body: { action: "patient_record", share_id: "f6000000-0000-0000-0000-0000000000e1", scope: "labs" } }); assert.equal(f.status, 403);
});
await test("no reply ever contains the server key", () => { for (const t of replies) assert.ok(!t.includes(SECRET)); });

console.log(`\n${passed} sharing tests passed${failed ? `, ${failed} FAILED` : ""}`);
if (process.env.REPORT_DIR) { const { writeFileSync, mkdirSync } = await import("node:fs"); mkdirSync(process.env.REPORT_DIR, { recursive: true }); writeFileSync(`${process.env.REPORT_DIR}/sharing.json`, JSON.stringify({ passed, failed, results }, null, 1)); }
if (failed) process.exitCode = 1;
