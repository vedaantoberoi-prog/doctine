/**
 * Doctine Guardian · state machine, event normalization, incident engine, delivery honesty, contact links and the
 * /api/guardian function. FICTIONAL people, phone numbers and places only; no network, no messages sent.
 */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STATES, TRANSITIONS, TRANSITION_LIST, TERMINAL, nextState, OPEN_STATES } from "../netlify/lib/guardian/states.mjs";
import { normalizeEvent, openingFor, relatedTo, fuse, POLICY, EventError } from "../netlify/lib/guardian/events.mjs";
import { createEngine, GuardianError } from "../netlify/lib/guardian/engine.mjs";
import { createMemoryStore } from "../netlify/lib/guardian/store-memory.mjs";
import { noProvider, deliveryAdapter } from "../netlify/lib/guardian/delivery.mjs";
import { makeAckToken, readAckToken, makeConsentToken, readConsentToken, phoneTag } from "../netlify/lib/guardian/links.mjs";

let passed = 0, failed = 0;
const results = [];
const test = async (name, fn) => { try { await fn(); passed++; results.push({ name, status: "passed" }); console.log("  ✓ " + name); } catch (e) { failed++; results.push({ name, status: "failed", error: String(e && e.message).slice(0, 300) }); console.log("  ✗ " + name + "\n      " + (e && e.stack || e).toString().split("\n").slice(0, 4).join("\n      ")); } };

const A = "a1110000-0000-4000-8000-000000000001", B = "b2220000-0000-4000-8000-000000000002";
let seq = 0;
const eid = () => `e0000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const T0 = Date.parse("2026-11-25T10:00:00Z");

/** A clock the test moves by hand. */
function clock(t = T0) { const c = () => c.t; c.t = t; c.add = (s) => { c.t += s * 1000; }; return c; }
/** A pretend messaging provider (tests only) that records what it was asked to send. */
function fakeLive(status = "sent") { const sent = []; return { sent, adapter: { name: "fake", live: true, channels: ["sms"], async send(x) { sent.push({ contact: x.contact.name, kind: x.kind }); return { status, ref: "ref-" + sent.length }; } } }; }

async function setup({ delivery = noProvider, contacts = [{ name: "Fictional Sister", phone: "+91 90000 00001", relationship: "Sister", priority: 1, status: "verified" }], share_location = true } = {}) {
  const now = clock(), store = createMemoryStore({ now }), engine = createEngine({ store, delivery, now });
  await store.saveSettings(A, { enabled: true, share_location });
  const saved = []; for (const c of contacts) saved.push(await store.saveContact(A, c));
  return { now, store, engine, contacts: saved };
}
const ev = (over = {}) => ({ event_id: eid(), event_type: "sos", source: "app_button", observed_at: new Date(T0).toISOString(), ...over });

console.log("state machine");
await test("every state is either open, terminal or NORMAL, and every transition target is a known state", () => {
  for (const s of STATES) assert.ok(s === "NORMAL" || TERMINAL.includes(s) || OPEN_STATES.includes(s));
  for (const [from, , to] of TRANSITION_LIST) { assert.ok(STATES.includes(from)); assert.ok(STATES.includes(to)); }
  for (const t of TERMINAL) assert.deepEqual(TRANSITIONS[t], {});
});
await test("only listed transitions exist (no jump from a check-in straight to contacts, nothing out of a closed incident)", () => {
  assert.equal(nextState("CHECKING_IN", "escalate"), null);
  assert.equal(nextState("SUSPECTED_EVENT", "policy_escalate"), null);
  assert.equal(nextState("RESOLVED", "retry"), null);
  assert.equal(nextState("CANCELLED", "user_help"), null);
  assert.equal(nextState("CHECKING_IN", "checkin_timeout"), "POSSIBLE_EMERGENCY");
});
await test("the database's transition list (migration) is exactly the code's list", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261125000000_guardian.sql", import.meta.url), "utf8");
  const block = sql.split("-- transitions:begin")[1].split("-- transitions:end")[0];
  const db = [...block.matchAll(/\('([A-Z_]+)', '([a-z_]+)', '([A-Z_]+)'\)/g)].map((m) => [m[1], m[2], m[3]]).sort();
  assert.deepEqual(db, [...TRANSITION_LIST].map((x) => [...x]).sort());
});

console.log("events");
await test("an event needs a device-made UUID, a known type and a known source", () => {
  assert.throws(() => normalizeEvent({ event_type: "sos", source: "app_button" }), (e) => e instanceof EventError && e.code === "bad_event_id");
  assert.throws(() => normalizeEvent({ event_id: eid(), event_type: "meteor", source: "app_button" }), (e) => e.code === "bad_event_type");
  assert.throws(() => normalizeEvent({ event_id: eid(), event_type: "sos", source: "anywhere" }), (e) => e.code === "bad_source");
  assert.throws(() => normalizeEvent({ event_id: eid(), event_type: "sos", source: "test" }), (e) => e.code === "bad_source");
});
await test("a device clock far ahead is clamped to the server's time and flagged", () => {
  const n = normalizeEvent(ev({ observed_at: new Date(T0 + 3600e3).toISOString() }), { now: T0 });
  assert.equal(n.observed_at, new Date(T0).toISOString()); assert.ok(n.flags.includes("clock_ahead"));
});
await test("only small numeric features are kept, never raw sensor streams; bad locations are dropped", () => {
  const n = normalizeEvent(ev({ event_type: "fall", source: "phone_sensors", supporting_features: { peak_g: 4.2, samples: [1, 2, 3], still_s: 61, "Bad Key": 1 }, location: { lat: 95, lng: 73 } }), { now: T0 });
  assert.deepEqual(n.supporting_features, { peak_g: 4.2, still_s: 61 }); assert.equal(n.location, null);
});
await test("opening rules: asking for help bypasses thresholds; weak or poor-quality signals stay suspected; old events aren't acted on", () => {
  const o = (x) => openingFor(normalizeEvent(ev(x), { now: T0 })).trigger;
  assert.equal(o({ event_type: "sos" }), "open_confirmed");
  assert.equal(o({ event_type: "voice_distress", source: "app_voice" }), "open_confirmed");
  assert.equal(o({ event_type: "fall", source: "phone_sensors", confidence: 0.9, signal_quality: "good" }), "open_high");
  assert.equal(o({ event_type: "fall", source: "phone_sensors", confidence: 0.9, signal_quality: "poor" }), "open_suspected");
  assert.equal(o({ event_type: "road_incident", source: "phone_sensors", confidence: 0.5, signal_quality: "good" }), "open_suspected");
  assert.equal(o({ event_type: "wearable_alert", source: "healthkit", confidence: 0.99, signal_quality: "good" }), "open_suspected");
  assert.equal(o({ event_type: "fall", source: "phone_sensors", confidence: 0.9, signal_quality: "good", observed_at: new Date(T0 - 3600e3).toISOString() }), "open_expired");
  assert.equal(o({ event_type: "sos", observed_at: new Date(T0 - 7200e3).toISOString() }), "open_suspected");   // a late SOS asks first
});
await test("fusion combines independent signals and never reaches certainty", () => {
  assert.equal(Math.round(fuse(0.6, 0.5) * 100), 80);
  assert.ok(fuse(0.99, 0.99, 0.99) < 1);
});

console.log("engine");
await test("SOS: opens confirmed, goes straight to escalation, and with no provider says it could NOT deliver", async () => {
  const { engine, store } = await setup();
  const r = await engine.report(A, ev());
  assert.equal(r.created, true);
  assert.equal(r.incident.state, "FAILED_TO_DELIVER");
  const ds = await store.listDeliveries(A, r.incident.id);
  assert.equal(ds.length, 1); assert.equal(ds[0].status, "not_configured");
  const tr = (await store.listTransitions(A, r.incident.id)).map((t) => t.to);
  assert.deepEqual(tr, ["USER_CONFIRMED", "ESCALATING", "FAILED_TO_DELIVER"]);
  assert.equal((await store.listTransitions(A, r.incident.id)).at(-1).reason, "no_delivery_provider_configured");
});
await test("the same event sent twice (retry, reconnect) returns the same incident and sends nothing new", async () => {
  const live = fakeLive(); const { engine, store } = await setup({ delivery: live.adapter });
  const e = ev();
  const r1 = await engine.report(A, e), r2 = await engine.report(A, e);
  assert.equal(r2.duplicate, true); assert.equal(r2.incident.id, r1.incident.id);
  assert.equal(live.sent.length, 1); assert.equal((await store.recentIncidents(A)).length, 1);
});
await test("each transition records from, to, trigger, reason, actor, confidence, actions and time", async () => {
  const { engine, store } = await setup();
  const r = await engine.report(A, ev());
  for (const t of await store.listTransitions(A, r.incident.id)) for (const k of ["from", "to", "trigger", "reason", "actor", "confidence", "signal_quality", "actions", "at"]) assert.ok(k in t, k);
});
await test("a fall with good signal starts a check-in; 'I'm OK' cancels it and nobody is told", async () => {
  const live = fakeLive(); const { engine } = await setup({ delivery: live.adapter });
  const r = await engine.report(A, ev({ event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good" }));
  assert.equal(r.incident.state, "CHECKING_IN"); assert.ok(r.incident.checkin_deadline);
  const ok = await engine.respond(A, r.incident.id, "ok");
  assert.equal(ok.incident.state, "CANCELLED"); assert.equal(live.sent.length, 0);
});
await test("no answer to a fall check-in: the deadline passing escalates, and a live provider's 'sent' is NOT shown as delivered", async () => {
  const live = fakeLive("sent"); const { engine, now, store } = await setup({ delivery: live.adapter });
  const r = await engine.report(A, ev({ event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good" }));
  now.add(30); await engine.tick(A);
  assert.equal((await store.getIncident(A, r.incident.id)).state, "CHECKING_IN");                 // 60 s for falls, not yet
  now.add(31); const [inc] = await engine.tick(A);
  assert.equal(inc.state, "ESCALATING");
  assert.equal((await store.listDeliveries(A, r.incident.id))[0].status, "sent");
  assert.deepEqual(live.sent, [{ contact: "Fictional Sister", kind: "alert" }]);
});
await test("a check-in 'timeout' from the device is refused before the deadline (a fast or wrong clock can't escalate early)", async () => {
  const { engine } = await setup();
  const r = await engine.report(A, ev({ event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good" }));
  const t = await engine.respond(A, r.incident.id, "timeout");
  assert.equal(t.changed, false); assert.equal(t.reason, "too_early");
});
await test("different timeouts per event type (road 30 s, fall 60 s, scheduled check-in 300 s)", async () => {
  const { engine, now } = await setup();
  const d = async (type, src) => { const r = await engine.report(A, ev({ event_type: type, source: src, confidence: 0.9, signal_quality: "good", observed_at: new Date(now()).toISOString() })); return (Date.parse(r.incident.checkin_deadline) - now()) / 1000; };
  assert.equal(await d("road_incident", "phone_sensors"), 30);
  now.add(1000); assert.equal(await d("fall", "phone_sensors"), 60);
  now.add(1000); assert.equal(await d("missed_checkin", "app_checkin"), 300);
});
await test("a wearable heart alert never escalates on silence alone: it waits for the person", async () => {
  const live = fakeLive(); const { engine, now } = await setup({ delivery: live.adapter });
  const r = await engine.report(A, ev({ event_type: "wearable_alert", source: "healthkit", confidence: 0.95, signal_quality: "good" }));
  now.add(600); const [inc] = await engine.tick(A);
  assert.equal(inc.state, "POSSIBLE_EMERGENCY"); assert.equal(live.sent.length, 0);
  const h = await engine.respond(A, r.incident.id, "help");
  assert.equal(h.incident.state, "ESCALATING"); assert.equal(live.sent.length, 1);
});
await test("inactivity alone is not an emergency; inactivity after a suspected fall corroborates it", async () => {
  const live = fakeLive(); const { engine, now } = await setup({ delivery: live.adapter });
  const alone = await engine.report(A, ev({ event_type: "inactivity", source: "phone_sensors", confidence: 0.6, signal_quality: "good" }));
  now.add(600); await engine.tick(A);
  assert.equal(live.sent.length, 0); await engine.respond(A, alone.incident.id, "ok");
  now.add(3600);
  const at = new Date(now()).toISOString();
  const fall = await engine.report(A, ev({ event_type: "fall", source: "phone_sensors", confidence: 0.6, signal_quality: "fair", observed_at: at }));
  assert.equal(fall.incident.state, "CHECKING_IN");
  const still = await engine.report(A, ev({ event_type: "inactivity", source: "phone_sensors", confidence: 0.6, signal_quality: "good", observed_at: at }));
  assert.equal(still.joined, true); assert.equal(still.incident.id, fall.incident.id);
  assert.ok(still.incident.confidence >= 0.8);
});
await test("a phone impact with poor signal stays suspected and asks first", async () => {
  const live = fakeLive(); const { engine } = await setup({ delivery: live.adapter });
  const r = await engine.report(A, ev({ event_type: "fall", source: "phone_sensors", confidence: 0.95, signal_quality: "poor" }));
  assert.equal(r.incident.state, "CHECKING_IN"); assert.equal(live.sent.length, 0);
});
await test("pressing SOS during an open check-in escalates that incident (no second incident)", async () => {
  const live = fakeLive(); const { engine, store } = await setup({ delivery: live.adapter });
  const f = await engine.report(A, ev({ event_type: "fall", source: "phone_sensors", confidence: 0.5, signal_quality: "fair" }));
  const s = await engine.report(A, ev());
  assert.equal(s.joined, true); assert.equal(s.incident.id, f.incident.id); assert.equal(s.incident.state, "ESCALATING");
  assert.equal((await store.recentIncidents(A)).length, 1);
});
await test("Apple's own fall alert already went unanswered: escalate without asking a second time", async () => {
  const live = fakeLive(); const { engine } = await setup({ delivery: live.adapter });
  const r = await engine.report(A, ev({ event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good", platform_resolution: "unresponsive" }));
  assert.equal(r.incident.state, "ESCALATING"); assert.equal(live.sent.length, 1);
});
await test("contact cascade: first the priority-1 group, then the next group after 2 minutes without an answer", async () => {
  const live = fakeLive();
  const { engine, now } = await setup({ delivery: live.adapter, contacts: [{ name: "Fictional Sister", phone: "+91 90000 00001", priority: 1, status: "verified" }, { name: "Fictional Friend", phone: "+91 90000 00002", priority: 2, status: "verified" }] });
  await engine.report(A, ev());
  assert.deepEqual(live.sent.map((x) => x.contact), ["Fictional Sister"]);
  now.add(119); await engine.tick(A); assert.equal(live.sent.length, 1);
  now.add(2); await engine.tick(A); assert.deepEqual(live.sent.map((x) => x.contact), ["Fictional Sister", "Fictional Friend"]);
});
await test("unverified contacts are never messaged automatically (they haven't agreed)", async () => {
  const live = fakeLive(); const { engine, store } = await setup({ delivery: live.adapter, contacts: [{ name: "Fictional Neighbour", phone: "+91 90000 00003", priority: 1, status: "unverified" }] });
  const r = await engine.report(A, ev());
  assert.equal(live.sent.length, 0); assert.equal(r.incident.state, "FAILED_TO_DELIVER");
  assert.equal((await store.listDeliveries(A, r.incident.id))[0].error, "contact_not_verified");
});
await test("a test alert runs the whole flow but never messages anyone, even with a live provider", async () => {
  const live = fakeLive(); const { engine, store } = await setup({ delivery: live.adapter });
  const r = await engine.report(A, ev({ source: "test", test: true }));
  assert.equal(r.incident.state, "FAILED_TO_DELIVER"); assert.equal(live.sent.length, 0);
  assert.equal((await store.listDeliveries(A, r.incident.id))[0].error, "test_incident");
});
await test("no contacts at all: the incident says it failed to deliver, it doesn't pretend", async () => {
  const { engine } = await setup({ contacts: [] });
  const r = await engine.report(A, ev());
  assert.equal(r.incident.state, "FAILED_TO_DELIVER");
});
await test("a contact acknowledging moves the incident on; the person then closes it", async () => {
  const live = fakeLive(); const { engine, store, contacts } = await setup({ delivery: live.adapter });
  const r = await engine.report(A, ev());
  const a = await engine.acknowledge(r.incident.id, contacts[0].id);
  assert.equal(a.incident.state, "CONTACT_ACKNOWLEDGED");
  assert.equal((await store.listDeliveries(A, r.incident.id))[0].status, "acknowledged");
  const done = await engine.resolve(A, r.incident.id); assert.equal(done.incident.state, "RESOLVED");
});
await test("'I'm OK' after contacts were told closes it as RESOLVED and sends an all-clear", async () => {
  const live = fakeLive(); const { engine } = await setup({ delivery: live.adapter });
  const r = await engine.report(A, ev());
  const ok = await engine.respond(A, r.incident.id, "ok");
  assert.equal(ok.incident.state, "RESOLVED");
  assert.deepEqual(live.sent.map((x) => x.kind), ["alert", "all_clear"]);
});
await test("retry after a failed delivery is a new wave; still honest when nothing can send", async () => {
  const { engine, store } = await setup();
  const r = await engine.report(A, ev());
  const again = await engine.retry(A, r.incident.id);
  assert.equal(again.incident.state, "FAILED_TO_DELIVER");
  assert.deepEqual((await store.listDeliveries(A, r.incident.id)).map((d) => d.wave), [1, 2]);
});
await test("sharing the alert yourself is recorded as user_initiated, never as delivered", async () => {
  const { engine, store, contacts } = await setup();
  const r = await engine.report(A, ev());
  const s = await engine.sharedManually(A, r.incident.id, contacts[0].id);
  assert.equal(s.delivery.status, "user_initiated");
  assert.ok((await store.listDeliveries(A, r.incident.id)).every((d) => d.status !== "delivered" && d.status !== "sent"));
});
await test("another person can't see, answer or close someone's incident", async () => {
  const { engine } = await setup();
  const r = await engine.report(A, ev());
  await assert.rejects(engine.respond(B, r.incident.id, "ok"), (e) => e instanceof GuardianError && e.status === 404);
  await assert.rejects(engine.resolve(B, r.incident.id), (e) => e.status === 404);
});
await test("a closed incident ignores further answers", async () => {
  const { engine } = await setup();
  const r = await engine.report(A, ev({ event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good" }));
  await engine.respond(A, r.incident.id, "ok");
  const again = await engine.respond(A, r.incident.id, "help");
  assert.equal(again.changed, false); assert.equal(again.incident.state, "CANCELLED");
});
await test("two answers racing (two taps, two servers): only one state change applies", async () => {
  const { engine, store } = await setup();
  const r = await engine.report(A, ev({ event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good" }));
  const [x, y] = await Promise.all([engine.respond(A, r.incident.id, "ok"), engine.respond(A, r.incident.id, "help")]);
  assert.equal([x.changed, y.changed].filter(Boolean).length, 1);
  const states = (await store.listTransitions(A, r.incident.id)).map((t) => t.to);
  assert.equal(states.filter((s) => s === "CANCELLED" || s === "USER_CONFIRMED").length, 1);
});
await test("Guardian switched off: events are refused (except explicit test events)", async () => {
  const { engine, store } = await setup();
  await store.saveSettings(A, { enabled: false });
  await assert.rejects(engine.report(A, ev()), (e) => e.code === "guardian_off");
});
await test("location is kept only when the person allowed it", async () => {
  const { engine } = await setup({ share_location: false });
  const r = await engine.report(A, ev({ location: { lat: 18.52, lng: 73.85, accuracy_m: 20, at: new Date(T0).toISOString() } }));
  assert.equal(r.incident.location, null);
});
await test("a device-failure report is status only, never an incident", async () => {
  const { engine, store } = await setup();
  const r = await engine.report(A, ev({ event_type: "device_failure", source: "phone_sensors" }));
  assert.equal(r.status_only, true); assert.equal((await store.recentIncidents(A)).length, 0);
});

console.log("delivery and links");
await test("no provider is connected: the only adapter sends nothing and says not_configured", async () => {
  assert.equal(deliveryAdapter({}).live, false);
  assert.equal(deliveryAdapter({ GUARDIAN_DELIVERY_PROVIDER: "twilio" }).live, false);
  assert.deepEqual(await noProvider.send(), { status: "not_configured", error: "no_provider" });
});
await test("contact links: signed, expire after 24 h, refuse tampering, and don't exist without a secret", () => {
  const secret = "x".repeat(40), inc = "c0000000-0000-4000-8000-000000000001", con = "c0000000-0000-4000-8000-000000000002";
  const t = makeAckToken(inc, con, { secret, now: T0 });
  assert.deepEqual(readAckToken(t, { secret, now: T0 + 3600e3 }), { incident_id: inc, contact_id: con });
  assert.equal(readAckToken(t, { secret, now: T0 + 25 * 3600e3 }).error, "expired");
  assert.equal(readAckToken(t.slice(0, -2) + "xx", { secret, now: T0 }).error, "bad_link");
  assert.equal(readAckToken(t, { secret: "y".repeat(40), now: T0 }).error, "bad_link");
  assert.equal(makeAckToken(inc, con, { secret: "", now: T0 }), null);
  assert.equal(readAckToken(t, { secret: "", now: T0 }).error, "not_configured");
});


await test("consent links: 7 days, bound to the phone number, and never usable as an 'I'm on it' link (or the reverse)", () => {
  const secret = "z".repeat(40), con = "c0000000-0000-4000-8000-000000000002", inc = "c0000000-0000-4000-8000-000000000001";
  const t = makeConsentToken(con, "+91 90000 00001", { secret, now: T0 });
  const r = readConsentToken(t, { secret, now: T0 + 6 * 86400e3 });
  assert.equal(r.contact_id, con); assert.equal(r.phone_tag, phoneTag("+91 90000 00001", secret)); assert.notEqual(r.phone_tag, phoneTag("+91 90000 00009", secret));
  assert.equal(readConsentToken(t, { secret, now: T0 + 8 * 86400e3 }).error, "expired");
  assert.equal(readAckToken(t, { secret, now: T0 }).error, "bad_link");
  assert.equal(readConsentToken(makeAckToken(inc, con, { secret, now: T0 }), { secret, now: T0 }).error, "bad_link");
  assert.equal(makeConsentToken(con, "+91 90000 00001", { secret: "", now: T0 }), null);
});

console.log("/api/guardian");
const { default: guardianFn, _resetGuardianCache } = await import("../netlify/functions/guardian.mjs");
const { _resetSettingsCache } = await import("../netlify/lib/settings.mjs");
const ENV = { SUPABASE_URL: "https://fictional.supabase.test", SUPABASE_ANON_KEY: "anon-fictional" };
const TOKENS = { "tok-a": A, "tok-b": B };
function authFetch(flags) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith("/auth/v1/user")) return new Response("{}", { status: 401 });
    if (u.includes("/rpc/public_settings")) return new Response(JSON.stringify({ flags }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
}
async function apiSetup(extraEnv = {}) {
  _resetGuardianCache(); _resetSettingsCache();
  const now = clock(), store = createMemoryStore({ now }), lines = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/v1/user")) { const tok = (init.headers.authorization || "").replace("Bearer ", ""); return TOKENS[tok] ? new Response(JSON.stringify({ id: TOKENS[tok] }), { status: 200 }) : new Response("{}", { status: 401 }); }
    return new Response("{}", { status: 404 });
  };
  const call = async (method, body, { token = "tok-a", query = "", form = false } = {}) => {
    const headers = { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" }; if (token) headers.authorization = "Bearer " + token;
    const req = new Request("https://app.doctine.test/api/guardian" + query, { method, headers, body: method === "POST" ? (form ? (typeof form === "string" ? form : "") : JSON.stringify(body || {})) : undefined });
    const res = await guardianFn(req, {}, { env: { ...ENV, ...extraEnv }, fetchImpl, store, now, log: (l) => lines.push(JSON.stringify(l)) });
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch {}
    return { status: res.status, json: j, text };
  };
  lastStore = store;
  return { call, store, now, lines };
}
let lastStore = null;
const apiStore = async () => lastStore;
await test("no sign-in, no Guardian", async () => {
  const { call } = await apiSetup();
  assert.equal((await call("GET", null, { token: "" })).status, 401);
  assert.equal((await call("GET", null, { token: "tok-forged" })).status, 401);
});
await test("the guardian switch off (the default) refuses everything", async () => {
  _resetSettingsCache();
  const req = new Request("https://app.doctine.test/api/guardian", { headers: { authorization: "Bearer tok-a" } });
  const res = await guardianFn(req, {}, { env: { ...ENV, SUPABASE_SERVICE_ROLE_KEY: "service-fictional" }, fetchImpl: authFetch({ guardian: false }), store: createMemoryStore(), log: () => {} });
  assert.equal(res.status, 503); assert.equal((await res.json()).error, "switched_off");
  _resetSettingsCache();
});
await test("status says plainly that no messaging provider is connected", async () => {
  const { call } = await apiSetup();
  const r = await call("GET");
  assert.equal(r.status, 200); assert.equal(r.json.delivery.live, false); assert.equal(r.json.delivery.provider, "none"); assert.equal(r.json.contact_links, false);
  assert.equal(r.json.settings.enabled, false);
});
await test("a contact can't be saved as verified through the API; bad numbers are refused", async () => {
  const { call } = await apiSetup();
  const ok = await call("POST", { action: "contact_save", contact: { name: "Fictional Sister", phone: "+91 90000 00001", relationship: "Sister", status: "verified" } });
  assert.equal(ok.status, 200); assert.equal(ok.json.contact.status, "unverified");
  assert.equal((await call("POST", { action: "contact_save", contact: { name: "X", phone: "ring me" } })).status, 400);
});
await test("SOS through the API: incident opens, escalates, and reports not_configured per contact by name", async () => {
  const { call } = await apiSetup();
  await call("POST", { action: "settings", enabled: true });
  await call("POST", { action: "contact_save", contact: { name: "Fictional Sister", phone: "+91 90000 00001" } });
  const e = ev();
  const r = await call("POST", { action: "report", event: e });
  assert.equal(r.status, 200); assert.equal(r.json.created, true);
  assert.equal(r.json.incident.state, "FAILED_TO_DELIVER");
  assert.deepEqual(r.json.incident.deliveries.map((d) => [d.contact_name, d.status]), [["Fictional Sister", "not_configured"]]);
  assert.equal(r.json.incident.user_id, undefined);
  const again = await call("POST", { action: "report", event: e });
  assert.equal(again.json.duplicate, true); assert.equal(again.json.incident.id, r.json.incident.id);
});
await test("an invalid event is refused with a reason; Guardian off for the person refuses events", async () => {
  const { call } = await apiSetup();
  assert.equal((await call("POST", { action: "report", event: ev() })).json.error, "guardian_off");
  await call("POST", { action: "settings", enabled: true });
  const bad = await call("POST", { action: "report", event: { event_type: "sos" } });
  assert.equal(bad.status, 400); assert.equal(bad.json.error, "bad_event_id");
});
await test("another signed-in person can't answer, retry, resolve or share someone's incident", async () => {
  const { call } = await apiSetup();
  await call("POST", { action: "settings", enabled: true });
  const r = await call("POST", { action: "report", event: ev() });
  for (const body of [{ action: "respond", answer: "ok" }, { action: "retry" }, { action: "resolve" }]) assert.equal((await call("POST", { ...body, incident_id: r.json.incident.id }, { token: "tok-b" })).status, 404);
});
await test("sharing it yourself: no link without a secret, and the message says to call 112", async () => {
  const { call } = await apiSetup();
  await call("POST", { action: "settings", enabled: true });
  const c = (await call("POST", { action: "contact_save", contact: { name: "Fictional Sister", phone: "+91 90000 00001" } })).json.contact;
  const r = await call("POST", { action: "report", event: ev() });
  const s = await call("POST", { action: "share", incident_id: r.json.incident.id, contact_id: c.id, name: "Asha" });
  assert.equal(s.json.link, null); assert.match(s.json.message, /call 112/); assert.match(s.json.message, /^Doctine alert: Asha pressed SOS/);
  assert.ok(s.json.incident.deliveries.some((d) => d.channel === "manual_share" && d.status === "user_initiated"));
});
await test("a contact's link: page with 'I'm on it'; pressing it acknowledges; tampered and closed links are refused", async () => {
  const { call } = await apiSetup({ GUARDIAN_LINK_SECRET: "s".repeat(48) });
  await call("POST", { action: "settings", enabled: true, share_location: true });
  const c = (await call("POST", { action: "contact_save", contact: { name: "Fictional Sister", phone: "+91 90000 00001" } })).json.contact;
  const r = await call("POST", { action: "report", event: ev({ location: { lat: 18.5204, lng: 73.8567, accuracy_m: 25, at: new Date(T0).toISOString() } }) });
  const s = await call("POST", { action: "share", incident_id: r.json.incident.id, contact_id: c.id });
  assert.match(s.json.link, /^https:\/\/app\.doctine\.test\/api\/guardian\?ack=/);
  const q = "?ack=" + s.json.link.split("ack=")[1];
  const pageR = await call("GET", null, { token: "", query: q });
  assert.equal(pageR.status, 200); assert.match(pageR.text, /I'm on it/); assert.match(pageR.text, /maps\.google\.com\/\?q=18\.5204,73\.8567/);
  assert.doesNotMatch(pageR.text, /90000/);                                   // the contact page never shows phone numbers
  const ack = await call("POST", null, { token: "", query: q, form: true });
  assert.equal(ack.status, 200); assert.match(ack.text, /Thank you, Fictional Sister/);
  assert.equal((await call("GET")).json.open[0].state, "CONTACT_ACKNOWLEDGED");
  assert.equal((await call("GET", null, { token: "", query: q.slice(0, -3) + "abc" })).status, 410);
  await call("POST", { action: "resolve", incident_id: r.json.incident.id });
  assert.match((await call("GET", null, { token: "", query: q })).text, /This alert is closed/);
});
await test("asking a contact to confirm: invite link, the contact agrees on the page, and only then shows as agreed", async () => {
  const { call } = await apiSetup({ GUARDIAN_LINK_SECRET: "s".repeat(48) });
  const c = (await call("POST", { action: "contact_save", contact: { name: "Fictional Sister", phone: "+91 90000 00001" } })).json.contact;
  const inv = await call("POST", { action: "invite", contact_id: c.id, name: "Asha" });
  assert.equal(inv.status, 200); assert.match(inv.json.message, /^Asha would like you to be a trusted contact on Doctine/); assert.match(inv.json.link, /\/api\/guardian\?consent=/);
  const q = "?consent=" + inv.json.link.split("consent=")[1];
  const pg = await call("GET", null, { token: "", query: q });
  assert.equal(pg.status, 200); assert.match(pg.text, /Fictional Sister, someone has added you as a trusted contact/); assert.match(pg.text, /I agree/); assert.doesNotMatch(pg.text, /Asha|90000/);
  const req = new Request("https://app.doctine.test/api/guardian" + q, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "choice=agree" });
  _resetGuardianCache();
  const res = await guardianFn(req, {}, { env: { ...ENV, GUARDIAN_LINK_SECRET: "s".repeat(48) }, fetchImpl: async () => new Response("{}", { status: 401 }), store: (await apiStore()), log: () => {} });
  assert.equal(res.status, 200); assert.match(await res.text(), /You're now a trusted contact/);
  assert.equal((await call("GET")).json.contacts[0].status, "verified");
  await call("POST", { action: "contact_save", contact: { id: c.id, name: "Fictional Sister", phone: "+91 90000 00009" } });
  assert.equal((await call("GET")).json.contacts[0].status, "unverified");
  assert.equal((await call("GET", null, { token: "", query: q })).status, 410);                   // the old link is void after the number changed
});
await test("a contact can decline; without a link secret, invites are refused plainly", async () => {
  const { call } = await apiSetup();
  const c = (await call("POST", { action: "contact_save", contact: { name: "Fictional Friend", phone: "+91 90000 00002" } })).json.contact;
  const r = await call("POST", { action: "invite", contact_id: c.id });
  assert.equal(r.status, 503); assert.equal(r.json.error, "links_not_configured");
  const s2 = await apiSetup({ GUARDIAN_LINK_SECRET: "s".repeat(48) });
  const c2 = (await s2.call("POST", { action: "contact_save", contact: { name: "Fictional Friend", phone: "+91 90000 00002" } })).json.contact;
  const inv = await s2.call("POST", { action: "invite", contact_id: c2.id });
  const q = "?consent=" + inv.json.link.split("consent=")[1];
  const d = await s2.call("POST", null, { token: "", query: q, form: "choice=decline" });
  assert.match(d.text, /You've declined/); assert.equal((await s2.call("GET")).json.contacts[0].status, "declined");
  assert.equal((await s2.call("POST", { action: "invite", contact_id: c2.id }, { token: "tok-b" })).status, 404);   // another person can't invite my contact
});
await test("log lines carry actions and timings only: no names, numbers, places or messages", async () => {
  const { call, lines } = await apiSetup();
  await call("POST", { action: "settings", enabled: true, share_location: true });
  const c = (await call("POST", { action: "contact_save", contact: { name: "Fictional Sister", phone: "+91 90000 00001" } })).json.contact;
  const r = await call("POST", { action: "report", event: ev({ location: { lat: 18.5204, lng: 73.8567 } }) });
  await call("POST", { action: "share", incident_id: r.json.incident.id, contact_id: c.id, name: "Asha" });
  const all = lines.join("\n");
  for (const bad of ["Fictional", "90000", "18.52", "73.85", "Asha", "Sister"]) assert.ok(!all.includes(bad), bad);
});
await test("the check-in deadline is applied by the server on the next status read", async () => {
  const { call, now } = await apiSetup();
  await call("POST", { action: "settings", enabled: true });
  await call("POST", { action: "report", event: ev({ event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good" }) });
  assert.equal((await call("GET")).json.open[0].state, "CHECKING_IN");
  now.add(61);
  assert.equal((await call("GET")).json.open[0].state, "FAILED_TO_DELIVER");
});

const done = () => {
  console.log(`\n${passed} guardian tests passed${failed ? `, ${failed} FAILED` : ""}`);
  if (process.env.REPORT_DIR) { import("node:fs").then(({ writeFileSync, mkdirSync }) => { mkdirSync(process.env.REPORT_DIR, { recursive: true }); writeFileSync(`${process.env.REPORT_DIR}/guardian.json`, JSON.stringify({ passed, failed, results }, null, 1)); }); }
  if (failed) process.exitCode = 1;
};
await test("the app's Permissions-Policy lets the page itself ask for location (Guardian's opt-in location), and still blocks the microphone and payments", () => {
  for (const f of ["netlify.toml", "tools/cloudflare-build.mjs"]) {
    const t = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    assert.match(t, /geolocation=\(self\)/, f); assert.doesNotMatch(t, /geolocation=\(\)/, f); assert.match(t, /microphone=\(\)/, f); assert.match(t, /payment=\(\)/, f);
  }
});
done();
