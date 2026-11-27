/**
 * Doctine · /api/admin and /api/events, with Supabase simulated. The permission rules themselves are tested against a
 * real PostgreSQL in tests/admin.test.sql; these tests check the web server around them: identity comes only from the
 * sign-in token, refusals are logged, two-step sign-in is required for every admin, invitations are only accepted by the
 * invited person and only send Supabase's invite email for new emails, database refusals stay refusals, and the server
 * key never appears in any reply. Fictional data only.
 */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import admin from "../netlify/functions/admin.mjs";
import events from "../netlify/functions/events.mjs";
import monitor from "../netlify/functions/monitor.mjs";
import errorsFn from "../netlify/functions/errors.mjs";
import { _resetTokenCache } from "../netlify/lib/ratelimit.mjs";

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n      " + e.message); } };

const SECRET = "sb_secret_TEST_ONLY_not_real";
Object.assign(process.env, { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_x", SUPABASE_SERVICE_ROLE_KEY: SECRET });
const jwt = (claims) => "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const PEOPLE = {
  [jwt({ sub: "owner", aal: "aal2", session_id: "sess-founder-1" })]: "a0000000-0000-0000-0000-000000000001",
  [jwt({ sub: "owner_aal1", aal: "aal1" })]: "a0000000-0000-0000-0000-000000000001",
  [jwt({ sub: "analyst", aal: "aal2" })]: "a0000000-0000-0000-0000-000000000004",
  [jwt({ sub: "analyst_aal1", aal: "aal1" })]: "a0000000-0000-0000-0000-000000000004",
  [jwt({ sub: "user", aal: "aal1" })]: "b0000000-0000-0000-0000-000000000001",
  [jwt({ sub: "invitee", aal: "aal1" })]: "b0000000-0000-0000-0000-000000000002",
};
// "owner" is the Founder; "analyst" a Co-Founder with analytics permissions only.
const ROLES = { "a0000000-0000-0000-0000-000000000001": "founder", "a0000000-0000-0000-0000-000000000004": "co_founder" };
const INVITE = { id: "d0000000-0000-0000-0000-000000000001", title: "Co-Founder" };
let mfaEnrolled = false, calls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body ? JSON.parse(init.body) : null; calls.push({ url, body, headers: init.headers || {} });
  if (url.endsWith("/auth/v1/user")) { const t = String(init.headers.authorization || "").replace("Bearer ", ""); return PEOPLE[t] ? new Response(JSON.stringify({ id: PEOPLE[t], user_metadata: { role: "owner" } })) : new Response("{}", { status: 401 }); }
  if (url.endsWith("/rpc/rate_limit_hit")) return new Response(JSON.stringify([{ allowed: true, hits: 1, reset_at: new Date(Date.now() + 6e5).toISOString() }]));
  if (url.endsWith("/rpc/admin_me")) { const r = ROLES[body.p_actor]; return new Response(JSON.stringify(r ? { role: r, title: r === "founder" ? "Founder" : "Co-Founder", email: r + "@example.test", perms: r === "founder" ? ["analytics.view", "reports.export", "team.manage"] : ["analytics.view"], mfa_enrolled: mfaEnrolled }
    : { role: null, invite: body.p_actor === "b0000000-0000-0000-0000-000000000002" ? INVITE : null })); }
  if (url.endsWith("/rpc/admin_invite_accept")) return new Response(JSON.stringify(body.p_id === INVITE.id ? { ok: true } : { ok: false, error: "not_invited" }));
  if (url.endsWith("/rpc/admin_invite_create")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ ok: true, id: "e0000000-0000-0000-0000-000000000001", existing_account: body.p_email === "has.account@example.test" })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/rpc/admin_invite_delivery")) return new Response(JSON.stringify({ ok: true }));
  if (url.includes("/auth/v1/invite")) return new Response("{}", { status: 200 });
  if (url.endsWith("/rpc/admin_log_session")) return new Response(JSON.stringify({ ok: true, recorded: true }));
  if (url.endsWith("/rpc/admin_member_set")) return new Response(JSON.stringify({ ok: true }));
  if (url.endsWith("/rpc/admin_log_denied")) return new Response("null");
  // The database refuses analysts the user list, exactly as private.require does.
  if (url.endsWith("/rpc/admin_users")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ total: 1, rows: [{ id: "b0000000-0000-0000-0000-000000000001", email: "asha.sample@example.test" }] })) : new Response(JSON.stringify({ code: "42501", message: "forbidden" }), { status: 403 });
  if (url.endsWith("/rpc/admin_user_action")) return new Response(JSON.stringify({ ok: true, apply_ban: "on", sessions_ended: 2 }));
  if (url.includes("/auth/v1/admin/users/")) return new Response("{}", { status: 200 });
  if (url.endsWith("/rpc/admin_log_action")) return new Response(JSON.stringify({ ok: true }));
  if (url.endsWith("/rpc/admin_series")) return new Response(JSON.stringify([{ day: "2026-11-11", users_total: 3, users_new: 1, dau: 1, wau: 1, mau: 1, documents: 0 }, { day: "=HYPERLINK(1)", users_total: 3 }]));
  if (url.endsWith("/rpc/admin_overview")) return new Response(JSON.stringify({ users_total: 11, users_new: 2, users_new_prev: 1, documents_new: 3, documents_new_prev: 0, storage_bytes: 1048576 }));
  if (url.endsWith("/rpc/admin_funnel")) return new Response(JSON.stringify({ account_created: 2, email_verified: 1, signed_in: 1, first_activity: 1 }));
  if (url.endsWith("/rpc/admin_adoption")) return new Response(JSON.stringify({ accounts: 11, features: [{ label: "Record added", ever: 5, period: 2 }] }));
  if (url.endsWith("/rpc/record_uptime")) return new Response("true");
  if (url.endsWith("/rpc/monitor_run")) return new Response(JSON.stringify({ opened: 1, open: 1, to_notify: [{ id: "c0000000-0000-0000-0000-000000000001", severity: "critical", message: "Database failed its last two checks", opened_at: new Date().toISOString() }] }));
  if (url.endsWith("/rpc/monitor_mark_notified")) return new Response("null");
  if (url.endsWith("/rpc/report_error")) return new Response("true");
  if (url.endsWith("/rpc/admin_ai_pilot")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ pilots: [], max: 10, got: { action: body.p_action, email: body.p_email, reason: body.p_reason } })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/rpc/admin_guardian_summary")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ by_state: { CANCELLED: 1 }, by_type: { sos: 1 }, people_enabled: 2 })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/rpc/admin_sharing_summary")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ active_shares: 1, shares_30d: 2, stopped_30d: 0, openings_30d: 5 })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/rpc/admin_practitioners")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ counts: { DOCUMENTS_SUBMITTED: 1 }, items: [], got: body.p_status })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/rpc/admin_practitioner_document")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ path: "c0000000-0000-0000-0000-00000000d0c1/a b.pdf", mime: "application/pdf", file_name: "reg.pdf" })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.includes("/storage/v1/object/sign/practitioner-credentials/")) return new Response(JSON.stringify({ signedURL: "/object/sign/practitioner-credentials/x.pdf?token=fictional" }));
  if (url.endsWith("/rpc/admin_practitioner_transition")) return body.p_actor === body.p_user ? new Response(JSON.stringify({ code: "42501" }), { status: 403 })
    : body.p_to === "VERIFIED" && !(body.p_evidence && body.p_evidence.matched && body.p_evidence.matched.active) ? new Response(JSON.stringify({ code: "22023" }), { status: 400 }) : new Response(JSON.stringify({ ok: true, status: body.p_to, got: body }));
  if (url.endsWith("/rpc/admin_ai_traces")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ days: body.p_days, total: 0 })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/rpc/ai_provider_check_add")) return new Response("true");
  if (url.endsWith("/rpc/admin_ai_chat_activity")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ replies: 12, failed: 1, errors: { ai_timeout: 1 }, context: { server: 9, none: 4 }, hourly: [] })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/rpc/admin_knowledge_overview")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ approved: 0, draft: 1, retired: 0, passages_searchable: 0, sources: [] })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/rpc/admin_knowledge_set_status")) return ROLES[body.p_actor] !== "founder" ? new Response(JSON.stringify({ code: "42501" }), { status: 403 })
    : body.p_status === "approved" && (!body.p_reviewed_by || !body.p_reviewed_on) ? new Response(JSON.stringify({ code: "22023" }), { status: 400 }) : new Response(JSON.stringify({ id: body.p_source, status: body.p_status }));
  if (url.endsWith("/rpc/admin_ai_provider_checks")) return ROLES[body.p_actor] === "founder" ? new Response(JSON.stringify({ last_success: { at: "2026-11-27T00:00:00Z", kind: "test_request", ms: 800, model: "claude-sonnet-5-5" }, last_failure: null, recent: [] })) : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.startsWith("https://api.anthropic.com/v1/models/")) return new Response(JSON.stringify({ id: "claude-sonnet-5-5" }));
  if (url === "https://api.anthropic.com/v1/messages") return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
  if (url.endsWith("/rpc/admin_incidents")) return ROLES[body.p_actor] === "founder" ? new Response("[]") : new Response(JSON.stringify({ code: "42501" }), { status: 403 });
  if (url.endsWith("/version.json") || url.endsWith("/auth/v1/health") || url.includes("/storage/v1/bucket/") || url.endsWith("/rpc/public_settings")) return new Response("{}");
  if (url.startsWith("https://api.resend.com/")) return new Response("{}");
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
await test("missing dates mean no date filter, never 1 January 1970 (the Users list once came back empty)", async () => {
  for (const v of [null, "", undefined]) {
    calls = []; const { status } = await read(await post(admin, tok("owner"), { action: "users", reg_from: v, reg_to: v }));
    const c = calls.find((x) => x.url.endsWith("/rpc/admin_users")).body;
    assert.equal(status, 200); assert.equal(c.p_from, null); assert.equal(c.p_to, null);
  }
  calls = []; await read(await post(admin, tok("owner"), { action: "audit", from: null, to: "" }));
  const a = calls.find((x) => x.url.endsWith("/rpc/admin_audit"));
  assert.ok(!a || (a.body.p_from === null && a.body.p_to === null));
  calls = []; await read(await post(admin, tok("owner"), { action: "users", reg_from: "2026-11-01T00:00:00Z" }));
  assert.equal(calls.find((x) => x.url.endsWith("/rpc/admin_users")).body.p_from, "2026-11-01T00:00:00.000Z");
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
await test("two-step sign-in (aal2) is required for every admin, Founder included, with no setting to turn it off", async () => {
  process.env.ADMIN_REQUIRE_MFA = "false";
  let { status, j } = await read(await post(admin, tok("owner_aal1"), { action: "overview" })); assert.equal(status, 403); assert.equal(j.error, "mfa_required");
  ({ status, j } = await read(await post(admin, tok("owner_aal1"), { action: "me" }))); assert.equal(status, 200); assert.equal(j.mfa_required, true);
  ({ status, j } = await read(await post(admin, tok("analyst_aal1"), { action: "series" }))); assert.equal(status, 403); assert.equal(j.error, "mfa_required");
  ({ status } = await read(await post(admin, tok("owner"), { action: "series" }))); assert.equal(status, 200);
  delete process.env.ADMIN_REQUIRE_MFA;
});
await test("a non-member sees and accepts only their own invitation; everything else stays refused", async () => {
  let { status, j } = await read(await post(admin, tok("invitee"), { action: "me" })); assert.equal(status, 200); assert.equal(j.role, null); assert.equal(j.invite.title, "Co-Founder");
  ({ status } = await read(await post(admin, tok("invitee"), { action: "overview" }))); assert.equal(status, 403);
  ({ status, j } = await read(await post(admin, tok("invitee"), { action: "accept_invite", id: "d0000000-0000-0000-0000-000000000009" }))); assert.equal(status, 403);
  ({ status, j } = await read(await post(admin, tok("invitee"), { action: "accept_invite", id: INVITE.id }))); assert.equal(status, 200); assert.equal(j.data.ok, true);
  ({ status } = await read(await post(admin, tok("user"), { action: "accept_invite", id: INVITE.id }))); assert.equal(status, 403, "someone without an invitation cannot accept one");
});
await test("inviting: the database checks the Founder first; Supabase's invite email goes only to emails without an account, back to /admin/", async () => {
  calls = []; let { status, j } = await read(await post(admin, tok("owner"), { action: "invite", email: "New.Person@Example.test", permissions: ["analytics.view"], reason: "fictional" }));
  assert.equal(status, 200); assert.equal(j.data.delivery, "email_sent");
  const inv = calls.find((c) => c.url.includes("/auth/v1/invite")); assert.ok(inv); assert.equal(inv.body.email, "new.person@example.test");
  assert.equal(new URL(inv.url).searchParams.get("redirect_to"), "https://app.doctine.test/admin/");
  assert.ok(calls.some((c) => c.url.endsWith("/rpc/admin_invite_delivery") && c.body.p_delivery === "email_sent"));
  calls = []; ({ j } = await read(await post(admin, tok("owner"), { action: "invite", email: "has.account@example.test", permissions: [], reason: "x" })));
  assert.equal(j.data.delivery, "existing_account"); assert.ok(!calls.some((c) => c.url.includes("/auth/v1/invite")), "no email for an existing account");
  calls = []; ({ status } = await read(await post(admin, tok("analyst"), { action: "invite", email: "x@example.test", permissions: [], reason: "x" })));
  assert.equal(status, 403); assert.ok(!calls.some((c) => c.url.includes("/auth/v1/invite")), "a Co-Founder's invitation is refused before any email");
  ({ status } = await read(await post(admin, tok("owner"), { action: "invite", email: "y@example.test", permissions: ["'; drop table x;--"], reason: "x" }))); assert.equal(status, 400);
});
await test("console sessions are recorded by a hash of the session id, never the id itself", async () => {
  calls = []; const { status } = await read(await post(admin, tok("owner"), { action: "session", event: "sign_in" })); assert.equal(status, 200);
  const c = calls.find((x) => x.url.endsWith("/rpc/admin_log_session")); assert.match(c.body.p_session, /^[0-9a-f]{16}$/); assert.ok(!JSON.stringify(c.body).includes("sess-founder-1"));
});
await test("permission lists are validated before the database sees them", async () => {
  assert.equal((await read(await post(admin, tok("owner"), { action: "member_set", id: "a0000000-0000-0000-0000-000000000004", status: "active", permissions: "team.manage", reason: "x" }))).status, 400);
  assert.equal((await read(await post(admin, tok("owner"), { action: "member_set", id: "a0000000-0000-0000-0000-000000000004", status: "active", permissions: ["analytics.view"], reason: "x" }))).status, 200);
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
  calls = [];
  const r = await post(admin, tok("owner"), { action: "report", report: "growth", format: "csv", from: "2026-11-01T00:00:00Z", to: "2026-11-12T00:00:00Z" });
  assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition"), /attachment; filename="doctine-growth-2026-11-01-to-2026-11-12\.csv"/);
  const t = await r.text(); replies.push(t); assert.match(t, /^# User growth/); assert.match(t, /\nDay,New accounts,Total accounts\n/); assert.match(t, /\n'=HYPERLINK\(1\),/);
  const logs = calls.filter((c) => c.url.endsWith("/rpc/admin_log_action")).map((c) => c.body.p_outcome);
  assert.deepEqual(logs, ["requested", "ok"], "each export is logged before and after");
  const bad = await post(admin, tok("owner"), { action: "report", report: "medical_records", format: "csv" }); assert.equal(bad.status, 400, "unknown report kinds are refused");
});
await test("PDF report: a real PDF file, permission checked before any figures are read", async () => {
  calls = []; const r = await post(admin, tok("owner"), { action: "pdf", from: "2026-11-01T00:00:00Z", to: "2026-11-12T00:00:00Z" });
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/pdf");
  const buf = Buffer.from(await r.arrayBuffer()); assert.equal(buf.subarray(0, 5).toString(), "%PDF-"); replies.push(buf.toString("latin1"));
  const first = calls.findIndex((c) => c.url.endsWith("/rpc/admin_log_action")), data = calls.findIndex((c) => c.url.endsWith("/rpc/admin_overview"));
  assert.ok(first >= 0 && first < data, "the export permission is checked (and logged) before the figures are fetched");
});
await test("the server key is never in any reply", async () => { assert.ok(replies.length > 10); for (const t of replies) assert.ok(!t.includes(SECRET)); });

console.log("scheduled monitoring and error reports");
await test("/api/monitor checks and records on its own, and replies with counts only", async () => {
  calls = []; const r = await monitor(new Request("https://app.doctine.test/api/monitor", { method: "POST", body: JSON.stringify({ rows: [{ target: "app", ok: false }] }) }), { ip: "10.3.0.1" });
  const j = await r.json(); replies.push(JSON.stringify(j));
  assert.equal(r.status, 200); assert.equal(j.recorded, true); assert.equal(j.open_alerts, 1);
  const rec = calls.find((c) => c.url.endsWith("/rpc/record_uptime")); assert.ok(rec.body.p_rows.every((x) => x.ok === true), "the caller's own 'results' are ignored");
  assert.ok(!JSON.stringify(j).includes("Database failed"), "no alert text in the public reply");
  assert.equal(j.email, "not_configured"); assert.equal(j.unnotified_alerts, 1, "the workflow is told to fail, so GitHub emails the owner");
  assert.ok(!calls.some((c) => c.url.endsWith("/rpc/monitor_mark_notified")), "not marked as emailed when no email was sent");
});
await test("with Resend configured, new alerts are emailed once and marked", async () => {
  Object.assign(process.env, { RESEND_API_KEY: "re_TEST_not_real", ALERT_EMAIL_TO: "ops@example.test", ALERT_EMAIL_FROM: "alerts@example.test" });
  calls = []; const j = await (await monitor(new Request("https://app.doctine.test/api/monitor"), { ip: "10.3.0.2" })).json();
  const mail = calls.find((c) => c.url.startsWith("https://api.resend.com/"));
  assert.equal(j.email, "sent"); assert.equal(j.unnotified_alerts, 0); assert.match(mail.body.subject, /Database failed/); assert.deepEqual(mail.body.to, ["ops@example.test"]);
  assert.ok(calls.some((c) => c.url.endsWith("/rpc/monitor_mark_notified")));
  for (const k of ["RESEND_API_KEY", "ALERT_EMAIL_TO", "ALERT_EMAIL_FROM"]) delete process.env[k];
});
await test("/api/errors takes reports from this site only, and passes just kind, message, place and release", async () => {
  calls = [];
  const bad = await errorsFn(new Request("https://app.doctine.test/api/errors", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }), { ip: "10.4.0.1" });
  assert.equal(bad.status, 403);
  const ok = await errorsFn(new Request("https://app.doctine.test/api/errors", { method: "POST", headers: { origin: "https://app.doctine.test" }, body: JSON.stringify({ kind: "TypeError", message: "x", location: "/index.html:1:2", release: "abc", user: "someone", record: "Haemoglobin" }) }), { ip: "10.4.0.2" });
  assert.equal(ok.status, 200); const sent = calls.find((c) => c.url.endsWith("/rpc/report_error")).body;
  assert.deepEqual(Object.keys(sent).sort(), ["p_env", "p_kind", "p_location", "p_message", "p_release", "p_request", "p_route", "p_source", "p_stack"]);
  assert.ok(!JSON.stringify(sent).includes("someone") && !JSON.stringify(sent).includes("Haemoglobin"), "fields outside the list are dropped");
});

console.log("measurement events");
const ev = (token, body, ip) => events(new Request("https://d/api/events", { method: "POST", headers: token ? { authorization: "Bearer " + token } : {}, body: JSON.stringify(body) }), { ip });
await test("a signed-in event is stored against the account from the token", async () => {
  calls = []; const r = await ev(tok("user"), { name: "record_exported", props: { format: "pdf" }, key: "exp-1", user_id: "someone-else" }, "10.2.0.1");
  assert.equal(r.status, 200); assert.equal(calls.find((c) => c.url.endsWith("/rpc/record_event")).body.p_user, "b0000000-0000-0000-0000-000000000001");
});
await test("signed-out visitors cannot send any event (so failure counts can't be inflated anonymously)", async () => {
  assert.equal((await ev(null, { name: "record_exported", props: {}, key: "k" }, "10.2.0.2")).status, 401);
  assert.equal((await ev(null, { name: "login_failure", props: { reason: "invalid_credentials" }, key: "k" }, "10.2.0.3")).status, 401);
});
await test("free text is refused", async () => {
  assert.equal((await ev(tok("user"), { name: "document_upload_failed", props: { reason: "Haemoglobin 13.1" }, key: "k2" }, "10.2.0.4")).status, 400);
});

const KEYLIKE = ["fictional", "provider", "value", "for", "tests"].join("-");
await test("AI provider check: health.view only; a real check only when asked; recorded; key never returned", async () => {
  process.env.ANTHROPIC_API_KEY = KEYLIKE;
  calls = [];
  const view = await read(await post(admin, tok("owner"), { action: "ai_provider_check" }, "10.3.1.1"));
  assert.equal(view.status, 200); assert.equal(view.j.data.check, null, "opening the page doesn't spend anything");
  assert.ok(!calls.some((c) => c.url.startsWith("https://api.anthropic.com/")), "no provider call without run: true");
  assert.equal(view.j.data.history.last_success.model, "claude-sonnet-5-5");
  calls = [];
  const run = await read(await post(admin, tok("owner"), { action: "ai_provider_check", run: true }, "10.3.1.2"));
  assert.equal(run.status, 200); assert.equal(run.j.data.check.test_request.ok, true); assert.equal(run.j.data.check.model_accessible, true);
  const recorded = calls.filter((c) => c.url.endsWith("/rpc/ai_provider_check_add")).map((c) => c.body.p_row.kind);
  assert.deepEqual(recorded, ["model_lookup", "test_request"], "both steps are recorded");
  const sent = calls.find((c) => c.url === "https://api.anthropic.com/v1/messages");
  assert.deepEqual(sent.body.messages, [{ role: "user", content: "ping" }], "the real request carries no person's data");
  assert.ok(!run.t.includes(KEYLIKE), "the key is never returned");
  calls = [];
  const no = await read(await post(admin, tok("analyst"), { action: "ai_provider_check", run: true }, "10.3.1.3"));
  assert.equal(no.status, 403); assert.ok(!calls.some((c) => c.url.startsWith("https://api.anthropic.com/")), "refused before any provider call");
  delete process.env.ANTHROPIC_API_KEY;
});
await test("assistant activity, medical sources and release status: health.view; counts only; approving needs a reviewer and date", async () => {
  const act = await read(await post(admin, tok("owner"), { action: "ai_activity", hours: 24 }, "10.3.2.1"));
  assert.equal(act.status, 200); assert.equal(act.j.data.available, true); assert.equal(act.j.data.context.server, 9);
  calls = [];
  const bad = await read(await post(admin, tok("owner"), { action: "ai_activity", hours: 99999 }, "10.3.2.2"));
  assert.equal(calls.find((c) => c.url.endsWith("/rpc/admin_ai_chat_activity")).body.p_hours, 24, "an out-of-range window falls back to 24 hours");
  assert.equal((await read(await post(admin, tok("analyst"), { action: "ai_activity" }, "10.3.2.3"))).status, 403);
  process.env.KNOWLEDGE_PROVIDER = "supabase";
  const kn = await read(await post(admin, tok("owner"), { action: "knowledge" }, "10.3.2.4"));
  delete process.env.KNOWLEDGE_PROVIDER;
  assert.equal(kn.j.data.provider, "supabase"); assert.equal(kn.j.data.draft, 1);
  const id = "11111111-2222-4333-8444-555555555555";
  assert.equal((await read(await post(admin, tok("owner"), { action: "knowledge_set_status", id, status: "approved" }, "10.3.2.5"))).status, 400, "no reviewer, no approval");
  const ap = await read(await post(admin, tok("owner"), { action: "knowledge_set_status", id, status: "approved", reviewed_by: "Dr Fictional Reviewer", reviewed_on: "2026-11-20" }, "10.3.2.6"));
  assert.equal(ap.status, 200); assert.equal(ap.j.data.status, "approved");
  assert.equal((await read(await post(admin, tok("owner"), { action: "knowledge_set_status", id: "x; drop", status: "approved" }, "10.3.2.7"))).status, 400);
  assert.equal((await read(await post(admin, tok("owner"), { action: "knowledge_set_status", id, status: "published" }, "10.3.2.8"))).status, 400);
  assert.equal((await read(await post(admin, tok("analyst"), { action: "knowledge_set_status", id, status: "retired" }, "10.3.2.9"))).status, 403);
  const rs = await read(await post(admin, tok("owner"), { action: "release_status" }, "10.3.2.10"));
  assert.equal(rs.status, 200); assert.equal(typeof rs.j.data.evaluation.critical, "number");
  assert.equal((await read(await post(admin, tok("analyst"), { action: "release_status" }, "10.3.2.11"))).status, 403);
});
await test("AI infrastructure page: configuration only, behind health.view; no key or health data", async () => {
  process.env.ANTHROPIC_API_KEY = KEYLIKE;
  const ok = await read(await post(admin, tok("owner"), { action: "ai_infrastructure" }, "10.3.0.1"));
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(ok.status, 200); assert.ok(ok.j.data.policy.version && ok.j.data.provider.key_configured === true);
  assert.ok(!ok.t.includes(KEYLIKE) && !ok.t.includes(SECRET));
  const no = await read(await post(admin, tok("analyst"), { action: "ai_infrastructure" }, "10.3.0.2"));
  assert.equal(no.status, 403);
  const tr = await read(await post(admin, tok("owner"), { action: "ai_traces", days: 999 }, "10.3.0.3"));
  assert.equal(tr.status, 200); assert.equal(tr.j.data.available, true); assert.equal(tr.j.data.days, 30, "window capped");
  assert.equal((await read(await post(admin, tok("analyst"), { action: "ai_traces" }, "10.3.0.4"))).status, 403);
  const pl = await read(await post(admin, tok("owner"), { action: "ai_pilot", op: "add", email: "pilot@example.test", reason: "fictional pilot" }, "10.3.0.5"));
  assert.equal(pl.status, 200); assert.deepEqual(pl.j.data.got, { action: "add", email: "pilot@example.test", reason: "fictional pilot" });
  const ls = await read(await post(admin, tok("owner"), { action: "ai_pilot", op: "drop table" }, "10.3.0.6"));
  assert.equal(ls.j.data.got.action, "list", "unknown operations become a harmless list");
  assert.equal((await read(await post(admin, tok("analyst"), { action: "ai_pilot", op: "add", email: "x@example.test", reason: "x" }, "10.3.0.7"))).status, 403);
  const gs = await read(await post(admin, tok("owner"), { action: "guardian_summary" }, "10.3.0.8"));
  assert.equal(gs.status, 200); assert.equal(gs.j.data.available, true); assert.equal(gs.j.data.people_enabled, 2);
  assert.equal(typeof gs.j.data.contact_links, "boolean"); assert.deepEqual(gs.j.data.delivery, { provider: "none", live: false });
  assert.ok(!JSON.stringify(gs.j.data).includes(process.env.GUARDIAN_LINK_SECRET || "no-secret-set-here"), "never returns the link secret");
  assert.equal((await read(await post(admin, tok("analyst"), { action: "guardian_summary" }, "10.3.0.9"))).status, 403);
});

await test("doctor verification: list filter, 60-second credential links, evidence passed through cleaned, refusals stay refusals", async () => {
  const l = await read(await post(admin, tok("owner"), { action: "doctors", status: "UNDER_REVIEW" }, "10.4.0.1"));
  assert.equal(l.status, 200); assert.equal(l.j.data.got, "UNDER_REVIEW");
  assert.equal((await read(await post(admin, tok("owner"), { action: "doctors", status: "'; drop table x" }, "10.4.0.2"))).j.data.got, null, "unknown status filters become no filter");
  assert.equal((await read(await post(admin, tok("analyst"), { action: "doctors" }, "10.4.0.3"))).status, 403);
  const sm = await read(await post(admin, tok("owner"), { action: "sharing_summary" }, "10.4.1.1")); assert.equal(sm.j.data.available, true); assert.equal(sm.j.data.openings_30d, 5);
  assert.deepEqual(Object.keys(sm.j.data).sort(), ["active_shares", "available", "openings_30d", "shares_30d", "stopped_30d"], "counts only");
  assert.equal((await read(await post(admin, tok("analyst"), { action: "sharing_summary" }, "10.4.1.2"))).status, 403);
  calls = [];
  const d = await read(await post(admin, tok("owner"), { action: "doctor_document", id: "c0000000-0000-0000-0000-00000000d0c1", doc: "c0000000-0000-0000-0000-0000000000f1" }, "10.4.0.4"));
  assert.equal(d.status, 200); assert.equal(d.j.data.expires_in, 60); assert.ok(d.j.data.url.startsWith("https://abc.supabase.co/storage/v1/object/sign/"), d.j.data.url);
  const sign = calls.find((c) => c.url.includes("/object/sign/")); assert.equal(sign.body.expiresIn, 60); assert.ok(sign.url.endsWith("/a%20b.pdf"), "the path is encoded");
  assert.equal((await read(await post(admin, tok("owner"), { action: "doctor_document", id: "not-a-uuid", doc: "c0000000-0000-0000-0000-0000000000f1" }, "10.4.0.5"))).status, 400);
  assert.equal((await read(await post(admin, tok("analyst"), { action: "doctor_document", id: "c0000000-0000-0000-0000-00000000d0c1", doc: "c0000000-0000-0000-0000-0000000000f1" }, "10.4.0.6"))).status, 403);
  calls = [];
  const v = await read(await post(admin, tok("owner"), { action: "doctor_set_status", id: "c0000000-0000-0000-0000-00000000d0c1", to: "VERIFIED", reason: "Checked on the register",
    evidence: { register: "nmr", register_name: "National Medical Register", checked_on: "2026-11-26", matched: { name: true, registration_number: true, council: true, active: true, photo_id: true, extra: "x" }, injected: "<script>" } }, "10.4.0.7"));
  assert.equal(v.status, 200); const sent = v.j.data.got.p_evidence;
  assert.deepEqual(Object.keys(sent.matched).sort(), ["active", "council", "name", "photo_id", "registration_number"]); assert.equal(sent.injected, undefined, "only known evidence fields reach the database");
  assert.equal((await read(await post(admin, tok("owner"), { action: "doctor_set_status", id: "c0000000-0000-0000-0000-00000000d0c1", to: "VERIFIED", reason: "x", evidence: { matched: { active: "yes" } } }, "10.4.0.8"))).status, 400, "'yes' is not true");
  assert.equal((await read(await post(admin, tok("owner"), { action: "doctor_set_status", id: "c0000000-0000-0000-0000-00000000d0c1", to: "APPROVED" }, "10.4.0.9"))).status, 400, "unknown statuses are refused before the database");
  assert.equal((await read(await post(admin, tok("owner"), { action: "doctor_set_status", id: "a0000000-0000-0000-0000-000000000001", to: "REJECTED", reason: "trying my own" }, "10.4.1.0"))).status, 403, "never your own application");
});

console.log(failed ? `${passed} admin server tests passed, ${failed} FAILED` : `${passed} admin server tests passed`);
process.exit(failed ? 1 : 0);
