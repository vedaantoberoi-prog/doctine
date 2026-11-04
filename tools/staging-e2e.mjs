/**
 * Doctine · end-to-end check of the deployed STAGING site against its real Supabase project, using two throw-away
 * synthetic accounts that are created at the start and deleted at the end. Synthetic data only.
 *   SITE_URL=https://doctine-staging.netlify.app PRODUCTION_URL=https://… EXPECT_COMMIT=<sha> node tools/staging-e2e.mjs
 *
 * Covers: sign-up and sign-in, the health profile, consent, document records and an upload to private storage,
 * medicines, schedules and dose events (reminders), cross-account isolation (tables and files), refused writes in
 * another person's name, signed-out access, saved-chat consent enforced by the database, /api/chat with a signed-in
 * person, account deletion through /api/account (and that nothing is left), and the shared rate limit on /api/account.
 *
 * Needs on the staging Supabase project: Authentication → Providers → Email → "Confirm email" OFF (staging only),
 * so the synthetic accounts can sign in straight away. Never run this against production: it refuses a site that
 * doesn't report environment "staging", and the production address.
 * Writes REPORT_DIR/staging-e2e.json. Never prints tokens or passwords.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

const base = (process.env.SITE_URL || "").replace(/\/$/, "");
const stop = (m) => { console.error("Staging end-to-end check not started: " + m); process.exit(2); };
if (!base) stop("set SITE_URL to the staging site.");
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
if (process.env.PRODUCTION_URL && hostOf(process.env.PRODUCTION_URL) === hostOf(base)) stop("SITE_URL is the production site.");
const T = (ms = 30_000) => AbortSignal.timeout(ms);
const cfg = await (await fetch(base + "/api/config", { signal: T() })).json().catch(() => ({}));
if (cfg.environment !== "staging") stop(`the site reports environment "${cfg.environment}", not "staging".`);
if (cfg.accounts !== "supabase" || !cfg.supabaseUrl || !cfg.supabaseAnonKey) stop("the staging site has no Supabase settings (it is in demo-account mode).");
let commit = null;
try { const v = await (await fetch(base + "/version.json", { signal: T() })).json(); commit = /^[0-9a-f]{40}$/.test(v.commit || "") ? v.commit : null; } catch {}
if (process.env.EXPECT_COMMIT && commit !== process.env.EXPECT_COMMIT) stop(`the site serves ${commit || "an unknown commit"}, expected ${process.env.EXPECT_COMMIT}.`);

const SB = cfg.supabaseUrl, ANON = cfg.supabaseAnonKey, BUCKET = "health-documents";
const run = Date.now().toString(36) + "-" + randomUUID().slice(0, 6);
const checks = [];
const check = async (name, fn) => {
  try { const d = await fn(); checks.push({ name, status: "passed", detail: d || "" }); console.log("PASS", name, d ? "· " + d : ""); }
  catch (e) { checks.push({ name, status: "failed", detail: String(e.message).slice(0, 300) }); console.log("FAIL", name, "·", e.message); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const sb = async (path, { token, method = "GET", body, headers = {}, raw = false } = {}) => {
  const r = await fetch(SB + path, { method, signal: T(), headers: { apikey: ANON, authorization: `Bearer ${token || ANON}`, ...(body && !raw ? { "content-type": "application/json" } : {}), ...headers }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, json };
};
const rest = (table, q = "", o = {}) => sb(`/rest/v1/${table}${q}`, { ...o, headers: { prefer: "return=representation", ...(o.headers || {}) } });
const people = {};
async function signUp(tag) {
  const email = `doctine-e2e+${run}-${tag}@example.com`, password = randomBytes(18).toString("base64url");
  const r = await sb("/auth/v1/signup", { method: "POST", body: { email, password } });
  must(r.ok, `sign-up HTTP ${r.status} ${r.json && (r.json.msg || r.json.error_description || r.json.error || "")}`);
  const token = r.json.access_token || (r.json.session && r.json.session.access_token);
  must(token, 'no session after sign-up: turn OFF "Confirm email" on the STAGING Supabase project (Authentication → Providers → Email)');
  const uid = (r.json.user && r.json.user.id) || r.json.id;
  people[tag] = { email, password, token, uid };
  return uid;
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAQH/kq8rVQAAAABJRU5ErkJggg==", "base64");
let docId, medId, path;

try {
  await check("two synthetic accounts sign up and receive sessions", async () => { await signUp("a"); await signUp("b"); must(people.a.uid !== people.b.uid, "same user id"); return "accounts created for this run only"; });
  await check("sign-in with email and password works; a wrong password is refused", async () => {
    const ok = await sb("/auth/v1/token?grant_type=password", { method: "POST", body: { email: people.a.email, password: people.a.password } });
    must(ok.ok && ok.json.access_token, "sign-in failed: HTTP " + ok.status); people.a.token = ok.json.access_token;
    const bad = await sb("/auth/v1/token?grant_type=password", { method: "POST", body: { email: people.a.email, password: people.a.password + "x" } });
    must(!bad.ok, "a wrong password was accepted");
  });
  const A = () => people.a.token, B = () => people.b.token;
  await check("A saves a synthetic health profile and consents", async () => {
    let r = await rest("health_profiles", "", { token: A(), method: "POST", body: { full_name: "Synthetic Test Person", blood_group: "O+" }, headers: { prefer: "return=representation,resolution=merge-duplicates" } });
    must(r.ok, "profile HTTP " + r.status);
    r = await rest("consents", "?on_conflict=user_id,kind", { token: A(), method: "POST", body: [{ kind: "cloud_storage", granted: true }, { kind: "ai_chat", granted: true }], headers: { prefer: "return=representation,resolution=merge-duplicates" } });
    must(r.ok, "consent HTTP " + r.status);
  });
  await check("A adds a document record and uploads a page to private storage", async () => {
    const r = await rest("documents", "", { token: A(), method: "POST", body: { client_id: 1, title: "Synthetic lab report (e2e)", category: "Lab report", source: "upload", page_count: 1 } });
    must(r.ok && r.json[0] && r.json[0].id, "document HTTP " + r.status); docId = r.json[0].id;
    path = `${people.a.uid}/${docId}/original-0.png`;
    const up = await sb(`/storage/v1/object/${BUCKET}/${path}`, { token: A(), method: "POST", body: PNG, raw: true, headers: { "content-type": "image/png" } });
    must(up.ok, "upload HTTP " + up.status);
    const f = await rest("document_files", "", { token: A(), method: "POST", body: { document_id: docId, kind: "original", page: 0, storage_path: path, content_type: "image/png" } });
    must(f.ok, "file record HTTP " + f.status);
    const back = await sb(`/storage/v1/object/authenticated/${BUCKET}/${path}`, { token: A() });
    must(back.ok, "A could not read back its own page: HTTP " + back.status);
  });
  await check("A adds a medicine, a reminder schedule and a dose taken", async () => {
    const m = await rest("medicines", "", { token: A(), method: "POST", body: { client_id: 1, name: "Synthetic medicine 500", dose: "1 tablet", start_date: "2026-11-01" } });
    must(m.ok && m.json[0], "medicine HTTP " + m.status); medId = m.json[0].id;
    const s = await rest("medication_schedules", "", { token: A(), method: "POST", body: { medicine_id: medId, times: ["08:00", "20:00"] } });
    must(s.ok, "schedule HTTP " + s.status);
    const d = await rest("dose_events", "", { token: A(), method: "POST", body: { medicine_id: medId, scheduled_date: "2026-11-04", scheduled_time: "08:00", status: "Taken" } });
    must(d.ok, "dose HTTP " + d.status);
    const bad = await rest("dose_events", "", { token: A(), method: "POST", body: { medicine_id: medId, scheduled_date: "2026-11-04", scheduled_time: "25:00", status: "Taken" } });
    must(!bad.ok, "an invalid dose time was accepted");
  });
  await check("B sees none of A's records, medicines, doses or file entries", async () => {
    for (const t of ["documents", "medicines", "dose_events", "medication_schedules", "document_files", "health_profiles", "consents"]) {
      const r = await rest(t, "?select=user_id", { token: B() }); must(r.ok, `${t} HTTP ${r.status}`);
      must(r.json.every((row) => row.user_id === people.b.uid), `B can see another person's ${t}`);
    }
    const one = await rest("documents", `?id=eq.${docId}`, { token: B() }); must(one.ok && one.json.length === 0, "B can read A's document by its id");
  });
  await check("B cannot read or list A's uploaded page", async () => {
    const r = await sb(`/storage/v1/object/authenticated/${BUCKET}/${path}`, { token: B() }); must(!r.ok, "B downloaded A's file");
    const l = await sb(`/storage/v1/object/list/${BUCKET}`, { token: B(), method: "POST", body: { prefix: people.a.uid + "/", limit: 10 } });
    must(!l.ok || (Array.isArray(l.json) && l.json.length === 0), "B can list A's folder");
    const up = await sb(`/storage/v1/object/${BUCKET}/${people.a.uid}/x/0.png`, { token: B(), method: "POST", body: PNG, raw: true, headers: { "content-type": "image/png" } });
    must(!up.ok, "B uploaded into A's folder");
  });
  await check("B cannot write in A's name or change A's medicines", async () => {
    const w = await rest("documents", "", { token: B(), method: "POST", body: { user_id: people.a.uid, client_id: 9, title: "forged" } }); must(!w.ok, "B created a record in A's name");
    const u = await rest("medicines", `?id=eq.${medId}`, { token: B(), method: "PATCH", body: { dose: "changed by B" } }); must(u.ok && u.json.length === 0, "B changed A's medicine");
    const d = await rest("medicines", `?id=eq.${medId}`, { token: B(), method: "DELETE" }); must(d.ok && d.json.length === 0, "B deleted A's medicine");
    const a = await rest("medicines", `?id=eq.${medId}`, { token: A() }); must(a.json[0] && a.json[0].dose === "1 tablet", "A's medicine was altered");
  });
  await check("signed-out visitors can read nothing", async () => {
    for (const t of ["documents", "medicines", "health_profiles"]) { const r = await rest(t, "", {}); must(!r.ok || (Array.isArray(r.json) && r.json.length === 0), `anon read ${t}`); }
  });
  await check("saved chats: refused without consent, stored with it, refused again once switched off", async () => {
    let r = await rest("conversations", "", { token: A(), method: "POST", body: { title: "e2e" } }); must(!r.ok, "a chat was saved without chat-history consent");
    r = await rest("consents", "?on_conflict=user_id,kind", { token: A(), method: "POST", body: { kind: "chat_history", granted: true }, headers: { prefer: "return=representation,resolution=merge-duplicates" } }); must(r.ok, "consent HTTP " + r.status);
    r = await rest("conversations", "", { token: A(), method: "POST", body: { title: "e2e" } }); must(r.ok && r.json[0], "chat not saved with consent: HTTP " + r.status);
    const conv = r.json[0].id;
    r = await rest("messages", "", { token: A(), method: "POST", body: { conversation_id: conv, role: "user", content: "synthetic message" } }); must(r.ok, "message HTTP " + r.status);
    r = await rest("messages", "", { token: B(), method: "POST", body: { conversation_id: conv, role: "user", content: "intrusion" } }); must(!r.ok, "B wrote into A's chat");
    r = await rest("consents", "?on_conflict=user_id,kind", { token: A(), method: "POST", body: { kind: "chat_history", granted: false }, headers: { prefer: "return=representation,resolution=merge-duplicates" } }); must(r.ok, "consent off HTTP " + r.status);
    r = await rest("messages", "", { token: A(), method: "POST", body: { conversation_id: conv, role: "user", content: "after consent off" } }); must(!r.ok, "a message was saved after consent was switched off");
  });
  await check("/api/chat answers a signed-in person (one real AI request)", async () => {
    const r = await fetch(base + "/api/chat", { method: "POST", signal: T(60_000), headers: { "content-type": "application/json", authorization: `Bearer ${A()}` }, body: JSON.stringify({ messages: [{ role: "user", content: "What is HbA1c?" }] }) });
    const j = await r.json().catch(() => ({})); must(r.ok && j.reply, `HTTP ${r.status} ${j.error || ""}`); return "urgency " + j.urgency;
  });
  await check("/api/account deletes A completely", async () => {
    const r = await fetch(base + "/api/account", { method: "DELETE", signal: T(60_000), headers: { authorization: `Bearer ${A()}` } });
    must(r.ok, "delete HTTP " + r.status); people.a.deleted = true;
    const s = await sb("/auth/v1/token?grant_type=password", { method: "POST", body: { email: people.a.email, password: people.a.password } }); must(!s.ok, "A can still sign in");
    for (const t of ["documents", "medicines", "dose_events", "conversations"]) { const q = await rest(t, "", { token: A() }); must(!q.ok || q.json.length === 0, `${t} rows remain after deletion`); }
    const f = await sb(`/storage/v1/object/authenticated/${BUCKET}/${path}`, { token: A() }); must(!f.ok, "A's uploaded page is still in storage");
  });
  await check("/api/account deletes B", async () => { const r = await fetch(base + "/api/account", { method: "DELETE", signal: T(60_000), headers: { authorization: `Bearer ${B()}` } }); must(r.ok, "HTTP " + r.status); people.b.deleted = true; });
  await check("the account route's rate limit is enforced (10 an hour per address)", async () => {
    let n = 0, last;
    for (; n < 12; n++) { last = await fetch(base + "/api/account", { method: "DELETE", signal: T(), headers: { authorization: "Bearer not-a-real-token" } }); if (last.status === 429) break; }
    must(last.status === 429, "no 429 after 12 attempts"); must(+last.headers.get("retry-after") > 0, "429 without retry-after");
    return `429 after ${n + 1} more attempts`;
  });
} finally {
  for (const [tag, p] of Object.entries(people)) if (!p.deleted && p.token) {
    const r = await fetch(base + "/api/account", { method: "DELETE", headers: { authorization: `Bearer ${p.token}` } }).catch(() => null);
    console.log(`cleanup: synthetic account ${tag} ${r && r.ok ? "deleted" : "NOT deleted — delete doctine-e2e+" + run + "-" + tag + "@example.com in the staging Supabase dashboard"}`);
  }
}

const failed = checks.filter((c) => c.status === "failed").length;
if (process.env.REPORT_DIR) { mkdirSync(process.env.REPORT_DIR, { recursive: true }); writeFileSync(`${process.env.REPORT_DIR}/staging-e2e.json`, JSON.stringify({ suite: "staging-e2e", kind: "LIVE against the deployed staging site and its Supabase project (synthetic accounts)", target: base, environment: cfg.environment, commit, run, passed: checks.length - failed, failed, checks, at: new Date().toISOString() }, null, 2)); }
console.log(`\nstaging end-to-end: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
