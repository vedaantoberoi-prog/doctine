/**
 * Doctine · doctor network phase 1: the verification rules (netlify/lib/doctors/verification.mjs) and /api/doctor with
 * Supabase simulated. The database rules themselves are tested against real PostgreSQL in tests/doctor.test.sql.
 * Checks: the code's transition list equals the database's; identity comes only from the sign-in token; the switch
 * gates everything; file types are read from the bytes; a failed record removes its file; incomplete applications
 * can't be submitted; the server key never appears in a reply. Fictional people and documents only.
 */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { STATUSES, TRANSITION_LIST, canMove, staffMoves, cleanProfile, checkEvidence, sniffMime, COUNCILS } from "../netlify/lib/doctors/verification.mjs";
import handler, { _resetDoctorCache } from "../netlify/functions/doctor.mjs";
import { _resetSettingsCache } from "../netlify/lib/settings.mjs";
import { _resetTokenCache } from "../netlify/lib/ratelimit.mjs";

let passed = 0, failed = 0; const results = [];
const test = async (name, fn) => { try { await fn(); passed++; results.push({ name, status: "passed" }); console.log("  ✓ " + name); } catch (e) { failed++; results.push({ name, status: "failed", error: String(e && e.message).slice(0, 300) }); console.log("  ✗ " + name + "\n      " + (e && e.stack || e).toString().split("\n").slice(0, 4).join("\n      ")); } };

console.log("doctor verification rules");
await test("the code's transition list is exactly the database's", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261126000000_doctor_onboarding.sql", import.meta.url), "utf8");
  const block = sql.slice(sql.indexOf("-- transitions:begin"), sql.indexOf("-- transitions:end"));
  const fromSql = [...block.matchAll(/\('([A-Z_]+)', '([A-Z_]+)', '([a-z]+)'\)/g)].map((m) => m.slice(1, 4).join(">")).sort();
  assert.deepEqual(fromSql, TRANSITION_LIST.map((t) => t.join(">")).sort());
  for (const [f, t] of TRANSITION_LIST) { assert.ok(STATUSES.includes(f), f); assert.ok(STATUSES.includes(t), t); }
});
await test("only staff verify; doctors only submit; nobody jumps straight to VERIFIED", () => {
  assert.ok(canMove("NOT_STARTED", "DOCUMENTS_SUBMITTED", "doctor"));
  assert.ok(!canMove("NOT_STARTED", "VERIFIED", "doctor")); assert.ok(!canMove("DOCUMENTS_SUBMITTED", "VERIFIED", "staff"), "a review must start first");
  assert.ok(!TRANSITION_LIST.some(([, t, b]) => t === "VERIFIED" && b !== "staff"));
  assert.deepEqual(staffMoves("UNDER_REVIEW").sort(), ["DOCUMENTS_SUBMITTED", "REJECTED", "VERIFIED"]);
  assert.ok(canMove("VERIFIED", "EXPIRED_REQUIRES_REVERIFICATION", "system") && canMove("EXPIRED_REQUIRES_REVERIFICATION", "DOCUMENTS_SUBMITTED", "doctor"));
});
await test("profile cleaning: trims, uppercases the registration number, and refuses values outside the lists", () => {
  const ok = cleanProfile({ full_name: "  Dr Asha Fictional ", registration_number: "mmc/2010/12345", registration_council: COUNCILS[16], registration_year: "2010",
    qualifications: [{ degree: "MBBS", institution: "Fictional Medical College", year: "2009" }], specialties: ["General physician", "General physician"], languages: ["English", "Hindi"], consultation_modes: ["video"], declaration: true }, { thisYear: 2026 });
  assert.ok(ok.ok, JSON.stringify(ok.errors)); assert.equal(ok.profile.full_name, "Dr Asha Fictional"); assert.equal(ok.profile.registration_number, "MMC/2010/12345");
  assert.deepEqual(ok.profile.specialties, ["General physician"]); assert.equal(ok.profile.qualifications[0].year, 2009); assert.equal(ok.profile.declaration, true);
  const bad = cleanProfile({ registration_council: "Made-up Council", specialties: ["Astrology"], consultation_modes: ["in-person"], registration_year: 2030, registration_number: "<b>", qualifications: [{ degree: "M", institution: "", year: 1800 }], declaration: "yes" }, { thisYear: 2026 });
  assert.equal(bad.ok, false); for (const k of ["registration_council", "specialties", "consultation_modes", "registration_year", "registration_number", "qualifications.0"]) assert.ok(bad.errors[k], k);
  assert.equal(cleanProfile({ declaration: "yes" }).profile.declaration, false, "only a real true confirms the declaration");
  assert.equal(cleanProfile(null).ok, false); assert.equal(cleanProfile({ specialties: ["General physician", "Family medicine", "Internal medicine", "Paediatrics", "Dermatology", "Psychiatry"] }).ok, false, "at most 5 specialties");
});
await test("evidence: register, recent date and every match are required", () => {
  const today = new Date(Date.UTC(2026, 10, 26));
  const good = { register: "nmr", register_name: "National Medical Register", checked_on: "2026-11-26", matched: { name: true, registration_number: true, council: true, active: true, photo_id: true } };
  assert.deepEqual(checkEvidence(good, { today }), []);
  assert.ok(checkEvidence({ ...good, register: "google" }, { today }).length);
  assert.ok(checkEvidence({ ...good, checked_on: "2026-11-27" }, { today }).length, "not in the future");
  assert.ok(checkEvidence({ ...good, checked_on: "2026-09-01" }, { today }).length, "not older than 30 days");
  assert.ok(checkEvidence({ ...good, matched: { ...good.matched, active: false } }, { today }).length);
  assert.ok(checkEvidence({ ...good, matched: { ...good.matched, photo_id: "true" } }, { today }).length, "the string 'true' is not true");
});
await test("file types come from the bytes", () => {
  assert.equal(sniffMime(Buffer.from("%PDF-1.7\n")), "application/pdf");
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffMime(Buffer.from("<html><script>")), null); assert.equal(sniffMime(Buffer.from("MZ\x90\x00")), null); assert.equal(sniffMime(Buffer.alloc(0)), null);
});

console.log("/api/doctor (Supabase simulated)");
const SECRET = "sb_secret_TEST_ONLY_not_real";
const env = { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_x", SUPABASE_SERVICE_ROLE_KEY: SECRET, RATE_LIMIT_SECRET: "r".repeat(40) };
const DOC_A = "d0000000-0000-0000-0000-0000000000a1", DOC_B = "d0000000-0000-0000-0000-0000000000b1";
const TOKENS = { "tok-a": DOC_A, "tok-b": DOC_B };
function sim({ flag = true, failAdd = false } = {}) {
  const db = { apps: {}, calls: [], storage: new Map(), deleted: [] };
  const app = (u) => (db.apps[u] ||= { status: "NOT_STARTED", documents: [], profile: {} });
  const missing = (a) => [...["full_name", "registration_number", "registration_council", "registration_year"].filter((k) => !a.profile[k]),
    ...["registration_certificate", "degree_certificate", "photo_id"].filter((k) => !a.documents.some((d) => d.kind === k)).map((k) => "doc:" + k)];
  const view = (u) => { const a = app(u); return { status: a.status, ...a.profile, documents: a.documents, missing: missing(a), editable: ["NOT_STARTED", "REJECTED", "EXPIRED_REQUIRES_REVERIFICATION"].includes(a.status), exists: true }; };
  const ok = (v) => new Response(JSON.stringify(v)); const err = (code, status = 400, message = "") => new Response(JSON.stringify({ code, message }), { status });
  const fetchImpl = async (url, init = {}) => {
    url = String(url); const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null; db.calls.push({ url, body, headers: init.headers || {}, method: init.method });
    if (url.endsWith("/auth/v1/user")) { const t = String((init.headers || {}).authorization || "").replace("Bearer ", ""); return TOKENS[t] ? ok({ id: TOKENS[t] }) : new Response("{}", { status: 401 }); }
    if (url.endsWith("/rpc/public_settings")) return ok({ flags: { doctor_onboarding: flag }, maintenance: { on: false }, announcements: [] });
    if (url.endsWith("/rpc/rate_limit_hit")) return ok([{ allowed: true, hits: 1, reset_at: new Date(Date.now() + 6e5).toISOString() }]);
    if (url.endsWith("/rpc/practitioner_get")) return ok(view(body.p_user));
    if (url.endsWith("/rpc/practitioner_save")) { const a = app(body.p_user); if (!view(body.p_user).editable) return err("22023", 400, "the application can not be changed while it is " + a.status); a.profile = { ...body.p };
      for (const k of Object.keys(a.profile)) if (a.profile[k] === "") delete a.profile[k]; return ok(view(body.p_user)); }
    if (url.endsWith("/rpc/practitioner_document_add")) { if (failAdd) return err("22023", 400, "documents can not be added while the application is UNDER_REVIEW");
      if (!body.p.path.startsWith(body.p_user + "/")) return err("22023"); const a = app(body.p_user); a.documents.push({ id: "f0000000-0000-0000-0000-00000000000" + a.documents.length, ...body.p }); return ok({ id: "x" }); }
    if (url.endsWith("/rpc/practitioner_document_remove")) { const a = app(body.p_user); const i = a.documents.findIndex((d) => d.id === body.p_id); if (i < 0) return err("P0002", 404); a.documents.splice(i, 1); return ok({ ok: true }); }
    if (url.endsWith("/rpc/practitioner_submit")) { const a = app(body.p_user); const m = missing(a); if (m.length) return ok({ ok: false, error: "incomplete", missing: m }); a.status = "DOCUMENTS_SUBMITTED"; return ok({ ok: true }); }
    if (url.includes("/storage/v1/object/practitioner-credentials/") && init.method === "POST") { db.storage.set(url.split("/practitioner-credentials/")[1], { bytes: init.body, type: init.headers["content-type"] }); return ok({ Key: "x" }); }
    if (url.endsWith("/storage/v1/object/practitioner-credentials") && init.method === "DELETE") { db.deleted.push(...body.prefixes); for (const p of body.prefixes) db.storage.delete(p); return ok([]); }
    return new Response("{}", { status: 404 });
  };
  return { db, fetchImpl };
}
const replies = [];
const call = async (s, { token = "tok-a", method = "POST", body } = {}) => {
  _resetSettingsCache(); _resetTokenCache();
  const req = new Request("https://app.doctine.test/api/doctor", { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const r = await handler(req, { ip: "203.0.113.7" }, { env, fetchImpl: s.fetchImpl, log: () => {} });
  const t = await r.text(); replies.push(t); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j };
};
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n% fictional registration certificate\n"), Buffer.alloc(200, 0x20)]);
const profile = { full_name: "Dr Asha Fictional", registration_number: "MMC/2010/12345", registration_council: "Maharashtra Medical Council", registration_year: 2010,
  qualifications: [{ degree: "MBBS", institution: "Fictional Medical College", year: 2009 }], specialties: ["General physician"], languages: ["English"], consultation_modes: ["video"], declaration: true };

await test("switched off: every request is refused, even signed in", async () => {
  const s = sim({ flag: false }); _resetDoctorCache();
  const r = await call(s, { method: "GET" }); assert.equal(r.status, 503); assert.equal(r.j.error, "switched_off");
  assert.ok(!s.db.calls.some((c) => c.url.includes("practitioner_")), "the database is never asked");
});
await test("not signed in, or a bad token: 401", async () => {
  const s = sim(); _resetDoctorCache();
  assert.equal((await call(s, { method: "GET", token: null })).status, 401);
  assert.equal((await call(s, { method: "GET", token: "tok-nobody" })).status, 401);
});
await test("the person is always the one in the token: an id in the request is ignored", async () => {
  const s = sim(); _resetDoctorCache();
  const r = await call(s, { body: { action: "save", p_user: DOC_B, user_id: DOC_B, profile } }); assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.ok(s.db.calls.filter((c) => c.url.includes("/rpc/practitioner_")).every((c) => c.body.p_user === DOC_A));
  assert.equal(s.db.apps[DOC_B], undefined);
});
await test("GET returns the application and the form's choices", async () => {
  const s = sim(); _resetDoctorCache();
  const r = await call(s, { method: "GET" }); assert.equal(r.status, 200); assert.equal(r.j.application.status, "NOT_STARTED");
  assert.ok(r.j.options.councils.length > 30 && r.j.options.document_kinds.photo_id && r.j.options.status_text.VERIFIED);
});
await test("invalid details come back field by field and are not saved", async () => {
  const s = sim(); _resetDoctorCache();
  const r = await call(s, { body: { action: "save", profile: { ...profile, registration_council: "Not A Council", specialties: ["Astrology"] } } });
  assert.equal(r.status, 400); assert.ok(r.j.fields.registration_council && r.j.fields.specialties); assert.ok(!s.db.calls.some((c) => c.url.endsWith("/rpc/practitioner_save")));
});
await test("upload: the type is read from the bytes, the file goes under the person's folder, and the record carries its hash", async () => {
  const s = sim(); _resetDoctorCache();
  const r = await call(s, { body: { action: "upload", kind: "registration_certificate", file_name: "../../etc/passwd.exe", data: "data:image/png;base64," + PDF.toString("base64") } });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const [path, obj] = [...s.db.storage.entries()][0];
  assert.ok(path.startsWith(DOC_A + "/") && path.endsWith(".pdf"), path); assert.equal(obj.type, "application/pdf", "the declared image/png is ignored");
  const add = s.db.calls.find((c) => c.url.endsWith("/rpc/practitioner_document_add")).body.p;
  assert.equal(add.sha256, createHash("sha256").update(PDF).digest("hex")); assert.equal(add.size_bytes, PDF.length); assert.ok(!add.file_name.includes("/"), add.file_name);
});
await test("upload: other file types, empty and oversized files are refused before storage", async () => {
  const s = sim(); _resetDoctorCache();
  assert.equal((await call(s, { body: { action: "upload", kind: "photo_id", file_name: "x.html", data: Buffer.from("<html><script>alert(1)</script>").toString("base64") } })).status, 415);
  assert.equal((await call(s, { body: { action: "upload", kind: "photo_id", file_name: "x.pdf", data: "" } })).status, 400);
  assert.equal((await call(s, { body: { action: "upload", kind: "photo_id", file_name: "x.pdf", data: "not base64 !!" } })).status, 400);
  const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4 * 1024 * 1024)]);
  assert.equal((await call(s, { body: { action: "upload", kind: "photo_id", file_name: "big.pdf", data: big.toString("base64") } })).status, 413);
  assert.equal((await call(s, { body: { action: "upload", kind: "selfie", file_name: "x.pdf", data: PDF.toString("base64") } })).status, 400, "unknown kinds");
  assert.equal(s.db.storage.size, 0);
});
await test("if the database refuses the record, the stored file is deleted again", async () => {
  const s = sim({ failAdd: true }); _resetDoctorCache();
  const r = await call(s, { body: { action: "upload", kind: "photo_id", file_name: "id.pdf", data: PDF.toString("base64") } });
  assert.equal(r.status, 400); assert.match(r.j.message, /can not be added/); assert.equal(s.db.storage.size, 0); assert.equal(s.db.deleted.length, 1);
});
await test("submission: refused with the list of what's missing, then accepted once complete", async () => {
  const s = sim(); _resetDoctorCache();
  await call(s, { body: { action: "save", profile } });
  const r1 = await call(s, { body: { action: "submit" } }); assert.equal(r1.status, 400); assert.deepEqual(r1.j.missing.sort(), ["doc:degree_certificate", "doc:photo_id", "doc:registration_certificate"]);
  for (const kind of ["registration_certificate", "degree_certificate", "photo_id"]) assert.equal((await call(s, { body: { action: "upload", kind, file_name: kind + ".pdf", data: PDF.toString("base64") } })).status, 200);
  const r2 = await call(s, { body: { action: "submit" } }); assert.equal(r2.status, 200); assert.equal(r2.j.application.status, "DOCUMENTS_SUBMITTED");
  const r3 = await call(s, { body: { action: "save", profile: { ...profile, full_name: "Changed After Submitting" } } }); assert.equal(r3.status, 400, "locked once submitted");
});
await test("removing a document needs a real id", async () => {
  const s = sim(); _resetDoctorCache();
  assert.equal((await call(s, { body: { action: "remove_document", id: "../../x" } })).status, 400);
  assert.equal((await call(s, { body: { action: "remove_document", id: "f0000000-0000-0000-0000-000000000009" } })).status, 404);
});
await test("unknown actions and methods are refused", async () => {
  const s = sim(); _resetDoctorCache();
  assert.equal((await call(s, { body: { action: "verify_myself" } })).status, 400);
  assert.equal((await call(s, { method: "DELETE" })).status, 405);
});
await test("no reply ever contains the server key", () => { for (const t of replies) assert.ok(!t.includes(SECRET)); });

console.log(`\n${passed} doctor tests passed${failed ? `, ${failed} FAILED` : ""}`);
if (process.env.REPORT_DIR) { const { writeFileSync, mkdirSync } = await import("node:fs"); mkdirSync(process.env.REPORT_DIR, { recursive: true }); writeFileSync(`${process.env.REPORT_DIR}/doctor.json`, JSON.stringify({ passed, failed, results }, null, 1)); }
if (failed) process.exitCode = 1;
