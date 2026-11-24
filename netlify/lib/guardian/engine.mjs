/**
 * Doctine Guardian · the incident engine.
 *
 * Takes normalized events and the person's answers, moves incidents through the state machine (states.mjs), and
 * starts deliveries to trusted contacts. Deterministic and idempotent:
 *   - one incident per event_id, ever (a repeated event, a retried request or a device reconnecting returns the same
 *     incident and starts nothing new);
 *   - every state change is compare-and-set on the current state, so two servers or two taps can't both apply it;
 *   - deliveries are keyed by (incident, contact, channel, wave), so a retry never sends the same message twice;
 *   - every change is written to the incident's transition log with its trigger, reason, confidence and actions.
 * No AI model is involved anywhere here.
 *
 * `store` is the persistence interface (store-memory.mjs for tests, store-supabase.mjs for the real database).
 */
import { nextState, isTerminal } from "./states.mjs";
import { normalizeEvent, openingFor, relatedTo, fuse, POLICY, CORROBORATED_AT } from "./events.mjs";
import { REACHING, noProvider } from "./delivery.mjs";

export const CASCADE_WAIT_S = 120;                 // a live provider tries the next contact group after this long without an answer
export const MAX_CONTACTS = 5;
const iso = (ms) => new Date(ms).toISOString();

export class GuardianError extends Error { constructor(code, message, status = 400) { super(message || code); this.code = code; this.status = status; } }

export function createEngine({ store, delivery = noProvider, now = Date.now, log = () => {} }) {

  async function move(uid, inc, trigger, { reason, actor = "system", actions = [], response = null, patch = {} } = {}) {
    const to = nextState(inc.state, trigger);
    if (!to) return { ok: false, incident: inc, reason: "not_allowed_in_state" };
    const at = iso(now());
    const rec = { from: inc.state, to, trigger, reason: reason || trigger, actor, confidence: inc.confidence, signal_quality: inc.signal_quality, actions, response, at };
    const r = await store.transition(uid, inc.id, inc.state, to, rec, { ...patch, ...(isTerminal(to) ? { closed_at: at } : {}) });
    if (!r.ok) return { ok: false, incident: r.incident || inc, reason: "state_changed" };      // someone else moved it first
    log({ guardian: "transition", incident: inc.id, from: inc.state, to, trigger });
    return { ok: true, incident: r.incident };
  }

  async function deliver(uid, inc, { kind = "alert" } = {}) {
    const contacts = (await store.listContacts(uid)).filter((c) => c.notify !== false).sort((a, b) => a.priority - b.priority);
    const existing = await store.listDeliveries(uid, inc.id);
    const wave = kind === "alert" ? 1 + Math.max(0, ...existing.filter((d) => d.kind === "alert").map((d) => d.wave || 0)) : 0;
    // one priority group per wave: wave 1 = the lowest priority number, then the next group, then round again
    const groups = [...new Set(contacts.map((c) => c.priority))];
    const target = kind === "alert" ? contacts.filter((c) => c.priority === groups[(wave - 1) % Math.max(1, groups.length)]) : contacts;
    const actions = [];
    for (const c of target) {
      for (const channel of delivery.channels.slice(0, 1)) {            // one channel per contact for now (the provider's first)
        const verified = c.status === "verified";
        let res = { status: "not_configured", error: "no_provider" };
        if (inc.test) res = { status: "not_configured", error: "test_incident" };       // a drill never messages anyone
        else if (delivery.live && verified) { try { res = await delivery.send({ incident: inc, contact: c, channel, kind }); } catch (e) { res = { status: "failed", error: String(e && e.code || "send_error").slice(0, 60) }; } }
        else if (delivery.live && !verified) res = { status: "failed", error: "contact_not_verified" };
        const d = await store.upsertDelivery(uid, inc.id, { contact_id: c.id, channel, wave, kind, status: res.status, provider: delivery.name, provider_ref: res.ref || null, error: res.error || null });
        actions.push({ kind: "deliver_" + kind, contact: c.id, channel, wave, status: d.status });
      }
    }
    if (!target.length) actions.push({ kind: "deliver_" + kind, status: "no_contacts" });
    return actions;
  }

  /** Runs the automatic follow-ups of the incident's current state until it needs a person or a clock. */
  async function auto(uid, inc, ev = null) {
    const policy = POLICY[inc.event_type] || POLICY.sos;
    for (let i = 0; i < 6 && inc && !isTerminal(inc.state); i++) {
      let r = null;
      if (inc.state === "SUSPECTED_EVENT" || (inc.state === "HIGH_CONFIDENCE_EVENT" && !(ev && ev.resolution === "unresponsive")))
        r = await move(uid, inc, "checkin_start", { reason: "ask_the_person", patch: { checkin_deadline: iso(now() + policy.checkin_s * 1000) }, actions: [{ kind: "checkin", seconds: policy.checkin_s }] });
      else if (inc.state === "HIGH_CONFIDENCE_EVENT") r = await move(uid, inc, "platform_unresponsive", { reason: "device_already_asked_no_answer" });
      else if (inc.state === "USER_CONFIRMED") r = await move(uid, inc, "escalate", { reason: "person_asked_for_help" });
      else if (inc.state === "POSSIBLE_EMERGENCY" && policy.escalate_on_timeout) r = await move(uid, inc, "policy_escalate", { reason: "no_answer_to_check_in" });
      else if (inc.state === "ESCALATING" && !(await store.listDeliveries(uid, inc.id)).some((d) => d.kind === "alert")) {
        const actions = await deliver(uid, inc);
        const all = await store.listDeliveries(uid, inc.id);
        if (!all.some((d) => d.kind === "alert" && REACHING.includes(d.status))) r = await move(uid, inc, "delivery_failed", { reason: delivery.live ? "no_delivery_succeeded" : "no_delivery_provider_configured", actions });
        else { await store.note(uid, inc.id, { kind: "deliveries_started", actions }); break; }
      }
      if (!r || !r.ok) break;
      inc = r.incident;
    }
    return inc;
  }

  /** A device reports an event. Returns { incident, created, joined, duplicate, status_only }. */
  async function report(uid, raw) {
    const ev = normalizeEvent(raw, { now: now() });
    const seen = await store.findByEventId(uid, ev.event_id);
    if (seen) return { incident: seen, duplicate: true };
    if (ev.event_type === "device_failure") { await store.recordStatusEvent(uid, ev); return { status_only: true }; }
    const settings = await store.getSettings(uid);
    if (!settings.enabled && !ev.test) throw new GuardianError("guardian_off", "Guardian is switched off for this account.", 409);
    if (!settings.share_location) ev.location = null;
    const open = (await store.openIncidents(uid)).filter((i) => relatedTo(i, ev, now()));
    if (open.length) {
      let inc = open.sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at))[0];
      const fused = fuse(inc.confidence, ev.confidence);
      inc = await store.addEvidence(uid, inc.id, ev, { confidence: Math.max(inc.confidence, fused) });
      if (ev.event_type === "sos" || ev.event_type === "voice_distress") {
        const r = await move(uid, inc, "user_help", { actor: "person", reason: "asked_for_help_during_incident" });
        if (r.ok) inc = await auto(uid, r.incident, ev);
      } else if (inc.state === "SUSPECTED_EVENT" && inc.confidence >= CORROBORATED_AT) {
        const r = await move(uid, inc, "corroborated", { reason: "related_signals_agree" });
        if (r.ok) inc = await auto(uid, r.incident, ev);
      }
      return { incident: inc, joined: true };
    }
    const { trigger, reason } = openingFor(ev);
    const to = nextState("NORMAL", trigger);
    const created = await store.insertIncident(uid, ev, to, { from: "NORMAL", to, trigger, reason, actor: ev.source === "app_button" || ev.source === "app_voice" ? "person" : "device", confidence: ev.confidence, signal_quality: ev.signal_quality, actions: [], response: null, at: iso(now()) });
    if (!created.created) return { incident: created.incident, duplicate: true };              // lost a race with the same event
    log({ guardian: "opened", incident: created.incident.id, type: ev.event_type, state: to });
    return { incident: await auto(uid, created.incident, ev), created: true };
  }

  /** The person answers: "ok" | "help" | "timeout" (their device's countdown ended). */
  async function respond(uid, incidentId, answer) {
    let inc = await store.getIncident(uid, incidentId);
    if (!inc) throw new GuardianError("not_found", "No such incident.", 404);
    if (isTerminal(inc.state)) return { incident: inc, changed: false, reason: "already_closed" };
    if (answer === "ok") {
      const wasTold = ["ESCALATING", "FAILED_TO_DELIVER", "CONTACT_ACKNOWLEDGED"].includes(inc.state);
      const r = await move(uid, inc, "user_ok", { actor: "person", response: "ok", reason: wasTold ? "safe_after_contacts_were_told" : "false_alarm" });
      if (r.ok && wasTold) { const actions = await deliver(uid, r.incident, { kind: "all_clear" }); await store.note(uid, inc.id, { kind: "all_clear", actions }); }
      return { incident: r.incident, changed: r.ok, reason: r.reason };
    }
    if (answer === "help") {
      const r = await move(uid, inc, "user_help", { actor: "person", response: "help" });
      return { incident: r.ok ? await auto(uid, r.incident) : r.incident, changed: r.ok, reason: r.reason };
    }
    if (answer === "timeout") {
      if (inc.state !== "CHECKING_IN") return { incident: inc, changed: false, reason: "not_checking_in" };
      if (inc.checkin_deadline && Date.parse(inc.checkin_deadline) - 5000 > now()) return { incident: inc, changed: false, reason: "too_early" };
      const r = await move(uid, inc, "checkin_timeout", { reason: "no_answer_on_device", response: "none" });
      return { incident: r.ok ? await auto(uid, r.incident) : r.incident, changed: r.ok, reason: r.reason };
    }
    throw new GuardianError("bad_answer", "Answer must be ok, help or timeout.");
  }

  /** Applies whatever is due: check-in deadlines passed, the next contact group when nobody answered. */
  async function tick(uid) {
    const out = [];
    for (let inc of await store.openIncidents(uid)) {
      if (inc.state === "CHECKING_IN" && inc.checkin_deadline && Date.parse(inc.checkin_deadline) <= now()) {
        const r = await move(uid, inc, "checkin_timeout", { reason: "deadline_passed_server" });
        if (r.ok) inc = await auto(uid, r.incident);
      } else if (inc.state === "ESCALATING" && delivery.live) {
        const ds = (await store.listDeliveries(uid, inc.id)).filter((d) => d.kind === "alert");
        const last = Math.max(0, ...ds.map((d) => d.wave || 0)), lastAt = Math.max(0, ...ds.filter((d) => d.wave === last).map((d) => Date.parse(d.created_at)));
        if (!ds.some((d) => d.status === "acknowledged") && lastAt && lastAt + CASCADE_WAIT_S * 1000 <= now()) {
          const actions = await deliver(uid, inc); await store.note(uid, inc.id, { kind: "next_contact_group", actions });
        }
      }
      out.push(inc);
    }
    return out;
  }

  /** A contact pressed "I'm on it" on their link (already verified by links.mjs). */
  async function acknowledge(incidentId, contactId) {
    const found = await store.getIncidentForContact(incidentId, contactId);
    if (!found) throw new GuardianError("not_found", "This link is not valid any more.", 404);
    const { uid } = found; let inc = found.incident;
    if (isTerminal(inc.state)) return { incident: inc, changed: false, reason: "already_closed" };
    await store.markAcknowledged(uid, inc.id, contactId);
    const r = await move(uid, inc, "contact_ack", { actor: "contact", reason: "contact_pressed_on_it", actions: [{ kind: "ack", contact: contactId }] });
    return { incident: r.incident, changed: r.ok, reason: r.reason };
  }

  /** The person shared the alert themselves (their SMS/WhatsApp/phone). Recorded honestly as user_initiated. */
  async function sharedManually(uid, incidentId, contactId) {
    const inc = await store.getIncident(uid, incidentId);
    if (!inc) throw new GuardianError("not_found", "No such incident.", 404);
    const c = (await store.listContacts(uid)).find((x) => x.id === contactId);
    if (!c) throw new GuardianError("not_found", "No such contact.", 404);
    const d = await store.upsertDelivery(uid, inc.id, { contact_id: c.id, channel: "manual_share", wave: 0, kind: "alert", status: "user_initiated", provider: "person", provider_ref: null, error: null });
    return { incident: inc, delivery: d, contact: c };
  }

  async function retry(uid, incidentId) {
    const inc = await store.getIncident(uid, incidentId);
    if (!inc) throw new GuardianError("not_found", "No such incident.", 404);
    const r = await move(uid, inc, "retry", { actor: "person", reason: "person_asked_to_retry" });
    if (!r.ok) return { incident: r.incident, changed: false, reason: r.reason };
    // a retry is a new wave of alerts
    const actions = await deliver(uid, r.incident);
    const all = await store.listDeliveries(uid, inc.id); let cur = r.incident;
    const wave = Math.max(0, ...all.filter((d) => d.kind === "alert").map((d) => d.wave || 0));
    if (!all.some((d) => d.kind === "alert" && d.wave === wave && REACHING.includes(d.status))) { const f = await move(uid, cur, "delivery_failed", { reason: delivery.live ? "no_delivery_succeeded" : "no_delivery_provider_configured", actions }); cur = f.incident; }
    return { incident: cur, changed: true };
  }

  async function resolve(uid, incidentId) {
    const inc = await store.getIncident(uid, incidentId);
    if (!inc) throw new GuardianError("not_found", "No such incident.", 404);
    const r = await move(uid, inc, "resolve", { actor: "person", reason: "person_closed_it" });
    return { incident: r.incident, changed: r.ok, reason: r.reason };
  }

  return { report, respond, tick, acknowledge, sharedManually, retry, resolve };
}
