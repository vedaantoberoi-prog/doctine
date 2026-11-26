/**
 * Doctine · /api/guardian — Guardian safety incidents, trusted contacts and settings (lib/guardian).
 *
 * Signed-in person only (Authorization: Bearer <their Supabase token>); their id comes from the token, never from the
 * request body. Behind the `guardian` platform switch (admin console), which is off.
 *
 *   GET                         → status: switch, settings, contacts, open and recent incidents (applies due timeouts)
 *   POST { action, ... }        → settings | contact_save | contact_delete | report | respond | retry | resolve | share
 *   GET  ?ack=<link token>      → a trusted contact's page: "I'm on it" (no account needed; signed link, 24 h)
 *   POST ?ack=<link token>      → records the contact's acknowledgement
 *   GET/POST ?consent=<token>   → a contact agrees (or declines) to be a trusted contact (signed link, 7 days)
 *
 * No messaging provider is connected: deliveries are recorded as `not_configured` and the app says so plainly and
 * shows the person how to reach their contacts themselves. Nothing here calls an AI model.
 * One log line per request: action, outcome, timings; never a name, number, location or message.
 */
import { json, readJson } from "../lib/ai.mjs";
import { getSettings } from "../lib/settings.mjs";
import { checkRate } from "../lib/ratelimit.mjs";
import { createEngine, GuardianError, MAX_CONTACTS } from "../lib/guardian/engine.mjs";
import { EventError } from "../lib/guardian/events.mjs";
import { createSupabaseStore } from "../lib/guardian/store-supabase.mjs";
import { deliveryAdapter } from "../lib/guardian/delivery.mjs";
import { linkSecret, makeAckToken, readAckToken, makeConsentToken, readConsentToken, phoneTag } from "../lib/guardian/links.mjs";
import { OPEN_STATES } from "../lib/guardian/states.mjs";

const MAX_BODY = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+?[0-9][0-9 ()-]{5,22}$/;

export async function guardianOn(env = process.env, fetchImpl = fetch) {
  const st = await getSettings({ env, fetchImpl });
  if (st.source === "none") return true;                        // local development and tests: no switches exist
  return st.flags.guardian === true;                            // maintenance mode does NOT stop a safety feature
}

const userCache = new Map();
async function verifiedUser(token, { env, fetchImpl }) {
  if (!token || token.length > 4096) return null;
  const hit = userCache.get(token); if (hit && hit.until > Date.now()) return hit.uid;
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), anon = env.SUPABASE_ANON_KEY || "";
  if (!base || !anon) return null;
  try {
    const r = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const uid = (await r.json()).id;
    if (typeof uid !== "string" || !UUID.test(uid)) return null;
    userCache.set(token, { uid, until: Date.now() + 60_000 }); if (userCache.size > 2000) userCache.delete(userCache.keys().next().value);
    return uid;
  } catch { return null; }
}
export const _resetGuardianCache = () => userCache.clear();

/** What the app shows for one incident: never another person's data; contact names only for this person's contacts. */
async function incidentView(store, uid, inc, contacts) {
  if (!inc) return null;
  const names = new Map(contacts.map((c) => [c.id, c.name]));
  const [deliveries, transitions] = await Promise.all([store.listDeliveries(uid, inc.id), store.listTransitions(uid, inc.id)]);
  const { user_id, ...rest } = inc;
  return { ...rest, open: OPEN_STATES.includes(inc.state),
    deliveries: deliveries.map((d) => ({ contact_id: d.contact_id, contact_name: names.get(d.contact_id) || null, channel: d.channel, wave: d.wave, kind: d.kind, status: d.status, error: d.error, updated_at: d.updated_at })),
    transitions: transitions.slice(-12).map((t) => ({ from: t.from, to: t.to, trigger: t.trigger, reason: t.reason, actor: t.actor, at: t.at })) };
}

function shareMessage(inc, link, { name } = {}) {
  const when = new Date(inc.opened_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const what = { sos: "pressed SOS", voice_distress: "asked for emergency help", fall: "may have fallen", road_incident: "may have been in a road incident", missed_checkin: "missed a safety check-in", wearable_alert: "had a health alert", inactivity: "hasn't moved for a while" }[inc.event_type] || "may need help";
  const who = name ? String(name).slice(0, 60) : "I";
  const loc = inc.location ? ` Last location: https://maps.google.com/?q=${inc.location.lat},${inc.location.lng}` : "";
  return `Doctine alert: ${who} ${what} at ${when} IST.${loc}${link ? ` Please tap to say you're on it: ${link}` : ""} If you can't reach me, call 112.`;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#F3F1EB;color:#14243A}main{max-width:30rem;margin:0 auto;padding:2rem 1.25rem}h1{font-size:1.4rem}button{font:inherit;font-weight:600;padding:.8rem 1.4rem;border-radius:.6rem;border:0;background:#14243A;color:#fff;width:100%}.n{color:#5b6472;font-size:.9rem}a{color:#14243A}</style></head>
<body><main>${body}<p class="n">Doctine is not an emergency service. In an emergency in India, call 112.</p></main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } });
}

async function contactPage(req, url, { engine, store, env, now = Date.now }) {
  const secret = linkSecret(env);
  const t = readAckToken(url.searchParams.get("ack"), { secret, now: now() });
  if (t.error) return page("Link not valid", `<h1>This link isn't valid any more</h1><p>It may have expired (links last 24 hours) or the alert was closed. Try calling the person directly.</p>`, 410);
  const found = await store.getIncidentForContact(t.incident_id, t.contact_id);
  if (!found) return page("Link not valid", `<h1>This link isn't valid any more</h1><p>Try calling the person directly.</p>`, 410);
  const inc = found.incident, open = OPEN_STATES.includes(inc.state);
  const when = new Date(inc.opened_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
  const loc = inc.location ? `<p>Last location shared: <a href="https://maps.google.com/?q=${esc(inc.location.lat)},${esc(inc.location.lng)}" rel="noopener">open in Maps</a>${inc.location.accuracy_m ? ` (accurate to about ${esc(Math.round(inc.location.accuracy_m))} m)` : ""}.</p>` : "<p>No location was shared.</p>";
  if (req.method === "POST") {
    if (!open) return page("Alert closed", `<h1>This alert is already closed</h1><p>Thank you for checking.</p>`);
    const r = await engine.acknowledge(t.incident_id, t.contact_id);
    return page("Thank you", `<h1>Thank you${found.contact_name ? ", " + esc(found.contact_name) : ""}</h1><p>They can now see that you're on it.${r.changed ? "" : " (Someone may have answered already.)"}</p><p>Please try to reach them by phone. If you think it's an emergency, call 112.</p>${loc}`);
  }
  if (!open) return page("Alert closed", `<h1>This alert is closed</h1><p>The person marked it as resolved or a false alarm. Thank you for checking.</p>`);
  return page("Doctine alert", `<h1>${found.contact_name ? esc(found.contact_name) + ", someone" : "Someone"} who listed you as a trusted contact may need help</h1><p>Alert raised ${esc(when)} IST.</p>${loc}
<form method="post"><button type="submit">I'm on it</button></form><p class="n">Pressing this tells them (and Doctine) that you've seen the alert. It doesn't call anyone.</p>`);
}

async function consentPage(req, url, { store, env, now: clock = Date.now }) {
  const secret = linkSecret(env);
  const t = readConsentToken(url.searchParams.get("consent"), { secret, now: clock() });
  const gone = page("Link not valid", `<h1>This link isn't valid any more</h1><p>It may have expired (these links last 7 days) or the number it was sent for has changed. Ask the person to send a new one.</p>`, 410);
  if (t.error) return gone;
  const c = await store.getContactForConsent(t.contact_id);
  if (!c || phoneTag(c.phone, secret) !== t.phone_tag) return gone;
  const hi = c.name ? esc(c.name) + ", s" : "S";
  if (req.method === "POST") {
    const form = new URLSearchParams(await req.text().catch(() => ""));
    const choice = form.get("choice") === "decline" ? "declined" : form.get("choice") === "agree" ? "verified" : null;
    if (!choice) return page("Choose an answer", `<h1>Please choose Agree or Decline</h1>`, 400);
    await store.setContactConsent(c.id, c.phone, choice);
    return choice === "verified"
      ? page("Thank you", `<h1>Thank you${c.name ? ", " + esc(c.name) : ""}</h1><p>You're now a trusted contact. If they raise an alert, you may get a message asking you to check on them. You can change your mind by opening this link again.</p>`)
      : page("Declined", `<h1>You've declined</h1><p>You won't be sent alerts. If you change your mind, open this link again while it's still valid.</p>`);
  }
  const now = c.status === "verified" ? "<p><b>You have already agreed.</b></p>" : c.status === "declined" ? "<p><b>You declined earlier.</b></p>" : "";
  return page("Trusted contact", `<h1>${hi}omeone has added you as a trusted contact on Doctine</h1>
<p>If they raise an alert (for example, they press SOS), you may get a message with the time and, if they chose to share it, their location, and be asked to check on them.</p>${now}
<form method="post"><button type="submit" name="choice" value="agree">I agree</button></form>
<form method="post" style="margin-top:.75rem"><button type="submit" name="choice" value="decline" style="background:#fff;color:#14243A;border:1px solid #14243A">Decline</button></form>
<p class="n">Doctine stores only your name and number, as the person entered them. You can't be sent alerts unless you agree.</p>`);
}

export default async function handler(req, context, { env = process.env, fetchImpl = fetch, store: injected, delivery, now = Date.now, log = (l) => console.log(JSON.stringify(l)) } = {}) {
  const t0 = Date.now(), url = new URL(req.url);
  const store = injected || createSupabaseStore({ env, fetchImpl });
  const done = (action, res, extra = {}) => { log({ fn: "guardian", action, status: res.status, ms: Date.now() - t0, ...extra }); return res; };
  if (!(await guardianOn(env, fetchImpl))) return done("off", json({ error: "switched_off", message: "Guardian isn't switched on yet." }, 503));
  if (!store) return done("no_store", json({ error: "not_configured", message: "Guardian isn't set up on this site." }, 503));
  const engine = createEngine({ store, delivery: delivery || deliveryAdapter(env), now, log: () => {} });

  if (url.searchParams.has("ack")) {
    if (req.method !== "GET" && req.method !== "POST") return done("ack", json({ error: "method_not_allowed" }, 405));
    try { return done("ack", await contactPage(req, url, { engine, store, env, now })); }
    catch { return done("ack", page("Something went wrong", `<h1>Something went wrong</h1><p>Please try calling the person directly.</p>`, 500)); }
  }

  if (url.searchParams.has("consent")) {
    if (req.method !== "GET" && req.method !== "POST") return done("consent", json({ error: "method_not_allowed" }, 405));
    try { return done("consent", await consentPage(req, url, { store, env, now })); }
    catch { return done("consent", page("Something went wrong", `<h1>Something went wrong</h1><p>Please try the link again later.</p>`, 500)); }
  }

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const uid = await verifiedUser(token, { env, fetchImpl });
  if (!uid) return done("auth", json({ error: "unauthorized", message: "Please sign in again." }, 401));
  const rate = await checkRate(req, context, "guardian", { env, fetchImpl });
  if (!rate.allowed) return done("rate", json({ error: rate.error, retry_after: rate.retryAfter }, rate.status));

  try {
    if (req.method === "GET") {
      await engine.tick(uid);
      const [settings, contacts, open, recent] = await Promise.all([store.getSettings(uid), store.listContacts(uid), store.openIncidents(uid), store.recentIncidents(uid, 10)]);
      if (Math.random() < 0.01 && store.purge) store.purge().catch(() => {});
      const d = delivery || deliveryAdapter(env);
      return done("status", json({ available: true, settings, contacts, max_contacts: MAX_CONTACTS,
        open: await Promise.all(open.map((i) => incidentView(store, uid, i, contacts))),
        recent: recent.filter((i) => !OPEN_STATES.includes(i.state)).map(({ user_id, location, evidence, ...i }) => i),
        delivery: { provider: d.name, live: !!d.live }, contact_links: !!linkSecret(env), server_time: new Date(now()).toISOString() }));
    }
    if (req.method !== "POST") return done("method", json({ error: "method_not_allowed" }, 405));
    const parsed = await readJson(req, MAX_BODY).catch(() => ({ error: "invalid", status: 400 }));
    if (parsed.error) return done("body", json({ error: parsed.error }, parsed.status));
    const body = parsed.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return done("body", json({ error: "bad_request" }, 400));
    const action = String(body.action || "");
    const contacts = () => store.listContacts(uid);
    const view = async (inc) => incidentView(store, uid, inc, await contacts());

    if (action === "settings") {
      const s = {}; for (const k of ["enabled", "share_location", "everyday"]) if (typeof body[k] === "boolean") s[k] = body[k];
      return done(action, json({ settings: await store.saveSettings(uid, s) }));
    }
    if (action === "contact_save") {
      const c = body.contact || {};
      const name = typeof c.name === "string" ? c.name.trim().slice(0, 80) : "", phone = typeof c.phone === "string" ? c.phone.trim() : "";
      if (!name || !PHONE.test(phone)) return done(action, json({ error: "invalid", message: "A name and a phone number (with country code) are needed." }, 400));
      if (c.id !== undefined && !UUID.test(String(c.id))) return done(action, json({ error: "invalid" }, 400));
      const priority = Number.isInteger(c.priority) && c.priority >= 1 && c.priority <= 5 ? c.priority : 1;
      // status is never taken from the request: contacts are unverified until a verification flow confirms them
      const saved = await store.saveContact(uid, { ...(c.id ? { id: c.id } : {}), name, phone, relationship: typeof c.relationship === "string" ? c.relationship.trim().slice(0, 40) : "", priority, notify: c.notify !== false });
      return done(action, json({ contact: saved, contacts: await contacts() }));
    }
    if (action === "contact_delete") {
      if (!UUID.test(String(body.id || ""))) return done(action, json({ error: "invalid" }, 400));
      await store.deleteContact(uid, body.id);
      return done(action, json({ contacts: await contacts() }));
    }
    if (action === "report") {
      const r = await engine.report(uid, body.event);
      if (r.status_only) return done(action, json({ status_only: true }));
      return done(action, json({ incident: await view(r.incident), created: !!r.created, joined: !!r.joined, duplicate: !!r.duplicate }), { created: !!r.created });
    }
    if (action === "invite") {
      const c = (await store.listContacts(uid)).find((x) => x.id === body.contact_id);
      if (!c) return done(action, json({ error: "not_found" }, 404));
      const secret = linkSecret(env);
      if (!secret) return done(action, json({ error: "links_not_configured", message: "Confirmation links aren't set up on this site yet." }, 503));
      const origin = env.PUBLIC_APP_URL ? String(env.PUBLIC_APP_URL).replace(/\/$/, "") : url.origin;
      const link = `${origin}/api/guardian?consent=${makeConsentToken(c.id, c.phone, { secret, now: now() })}`;
      const who = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : "I";
      return done(action, json({ link, phone: c.phone, message: `${who === "I" ? "I'd" : who + " would"} like you to be a trusted contact on Doctine, so you can be told if ${who === "I" ? "I" : "they"} raise an alert. Please open this link to agree or decline: ${link}` }));
    }
    const id = String(body.incident_id || "");
    if (!UUID.test(id)) return done(action, json({ error: "invalid", message: "incident_id is required." }, 400));
    if (action === "respond") { const r = await engine.respond(uid, id, body.answer); return done(action, json({ incident: await view(r.incident), changed: r.changed, reason: r.reason || null })); }
    if (action === "retry") { const r = await engine.retry(uid, id); return done(action, json({ incident: await view(r.incident), changed: r.changed, reason: r.reason || null })); }
    if (action === "resolve") { const r = await engine.resolve(uid, id); return done(action, json({ incident: await view(r.incident), changed: r.changed, reason: r.reason || null })); }
    if (action === "share") {
      if (!UUID.test(String(body.contact_id || ""))) return done(action, json({ error: "invalid" }, 400));
      const r = await engine.sharedManually(uid, id, body.contact_id);
      const secret = linkSecret(env);
      const tok = secret ? makeAckToken(id, body.contact_id, { secret, now: now() }) : null;
      const origin = env.PUBLIC_APP_URL ? String(env.PUBLIC_APP_URL).replace(/\/$/, "") : url.origin;
      const link = tok ? `${origin}/api/guardian?ack=${tok}` : null;
      return done(action, json({ incident: await view(r.incident), delivery: r.delivery, link, message: shareMessage(r.incident, link, { name: body.name }), phone: r.contact.phone }));
    }
    return done("unknown", json({ error: "unknown_action" }, 400));
  } catch (e) {
    if (e instanceof EventError) return done("event", json({ error: e.code, message: e.message }, 400));
    if (e instanceof GuardianError) return done("guardian", json({ error: e.code, message: e.message }, e.status));
    if (e && e.code === "not_found") return done("db", json({ error: "not_found" }, 404));
    if (e && e.code === "invalid") return done("db", json({ error: "invalid", message: "That wasn't accepted (check the details; at most 5 contacts)." }, 400));
    if (e && e.code === "not_installed") return done("db", json({ error: "not_configured", message: "Guardian isn't set up on this site yet." }, 503));
    return done("error", json({ error: "server_error", message: "Something went wrong. If you need help now, call 112." }, 500));
  }
}

export const config = { path: "/api/guardian" };
