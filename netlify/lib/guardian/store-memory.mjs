/**
 * Doctine Guardian · in-memory store with the same guarantees as the database store (store-supabase.mjs):
 * unique event ids per person, compare-and-set state changes checked against the state machine, one delivery per
 * (incident, contact, channel, wave, kind). Used by the tests; never used in production.
 */
import { randomUUID } from "node:crypto";
import { nextState, isTerminal } from "./states.mjs";

export const DEFAULT_SETTINGS = Object.freeze({ enabled: false, share_location: false, everyday: true });

export function createMemoryStore({ now = Date.now } = {}) {
  const settings = new Map(), contacts = new Map(), incidents = new Map(), eventIds = new Map(), statusEvents = [];
  const iso = () => new Date(now()).toISOString();
  const own = (uid, id) => { const i = incidents.get(id); return i && i.user_id === uid ? i : null; };
  const view = (i) => i && JSON.parse(JSON.stringify({ ...i, deliveries: undefined, transitions: undefined, notes: undefined }));

  return {
    _raw: { incidents, contacts },
    async getSettings(uid) { return { ...DEFAULT_SETTINGS, ...(settings.get(uid) || {}) }; },
    async saveSettings(uid, s) { settings.set(uid, { ...DEFAULT_SETTINGS, ...(settings.get(uid) || {}), ...s, updated_at: iso() }); return this.getSettings(uid); },
    async listContacts(uid) { return [...contacts.values()].filter((c) => c.user_id === uid).map((c) => ({ ...c })); },
    async saveContact(uid, c) {
      const id = c.id || randomUUID(); const prev = contacts.get(id);
      if (prev && prev.user_id !== uid) throw Object.assign(new Error("not yours"), { code: "not_found" });
      if (!prev && (await this.listContacts(uid)).length >= 5) throw Object.assign(new Error("too many"), { code: "too_many_contacts" });
      const row = { status: "unverified", notify: true, ...prev, ...c, id, user_id: uid, updated_at: iso() };
      if (prev && prev.phone !== c.phone) row.status = "unverified";
      contacts.set(id, row); return { ...row };
    },
    async deleteContact(uid, id) { const c = contacts.get(id); if (c && c.user_id === uid) contacts.delete(id); return true; },
    async findByEventId(uid, eventId) { const id = eventIds.get(uid + ":" + eventId); return id ? view(incidents.get(id)) : null; },
    async recordStatusEvent(uid, ev) { statusEvents.push({ uid, ev }); },
    async openIncidents(uid) { return [...incidents.values()].filter((i) => i.user_id === uid && !isTerminal(i.state)).map(view); },
    async recentIncidents(uid, n = 20) { return [...incidents.values()].filter((i) => i.user_id === uid).sort((a, b) => b.opened_at.localeCompare(a.opened_at)).slice(0, n).map(view); },
    async getIncident(uid, id) { return view(own(uid, id)); },
    async getIncidentForContact(id, contactId) {
      const i = incidents.get(id), c = contacts.get(contactId);
      return i && c && c.user_id === i.user_id ? { uid: i.user_id, incident: view(i), contact_name: c.name } : null;
    },
    async insertIncident(uid, ev, state, rec) {
      const key = uid + ":" + ev.event_id;
      if (eventIds.has(key)) return { created: false, incident: view(incidents.get(eventIds.get(key))) };
      const id = randomUUID();
      const inc = { id, user_id: uid, event_id: ev.event_id, event_type: ev.event_type, source: ev.source, state, confidence: ev.confidence, signal_quality: ev.signal_quality,
        location: ev.location, observed_at: ev.observed_at, opened_at: iso(), updated_at: iso(), closed_at: isTerminal(state) ? iso() : null, checkin_deadline: null, test: ev.test,
        evidence: [{ event_id: ev.event_id, event_type: ev.event_type, source: ev.source, confidence: ev.confidence, signal_quality: ev.signal_quality, observed_at: ev.observed_at, flags: ev.flags, model_version: ev.model_version, supporting_features: ev.supporting_features }],
        deliveries: [], transitions: [rec], notes: [] };
      incidents.set(id, inc); eventIds.set(key, id);
      return { created: true, incident: view(inc) };
    },
    async transition(uid, id, from, to, rec, patch = {}) {
      const i = own(uid, id);
      if (!i || i.state !== from || nextState(from, rec.trigger) !== to) return { ok: false, incident: view(i) };
      Object.assign(i, patch, { state: to, updated_at: iso() }); i.transitions.push(rec);
      return { ok: true, incident: view(i) };
    },
    async addEvidence(uid, id, ev, patch = {}) {
      const i = own(uid, id); if (!i) return null;
      const key = uid + ":" + ev.event_id;
      if (!eventIds.has(key)) { eventIds.set(key, id); i.evidence.push({ event_id: ev.event_id, event_type: ev.event_type, source: ev.source, confidence: ev.confidence, signal_quality: ev.signal_quality, observed_at: ev.observed_at, flags: ev.flags }); Object.assign(i, patch); }
      return view(i);
    },
    async note(uid, id, n) { const i = own(uid, id); if (i) i.notes.push({ ...n, at: iso() }); },
    async upsertDelivery(uid, id, d) {
      const i = own(uid, id); if (!i) throw new Error("no incident");
      let row = i.deliveries.find((x) => x.contact_id === d.contact_id && x.channel === d.channel && x.wave === d.wave && x.kind === d.kind);
      if (!row) { row = { id: randomUUID(), attempts: 0, created_at: iso(), ...d }; i.deliveries.push(row); }
      if (row.status !== "acknowledged") Object.assign(row, { status: d.status, error: d.error, provider_ref: d.provider_ref, updated_at: iso() });
      row.attempts++;
      return { ...row };
    },
    async listDeliveries(uid, id) { const i = own(uid, id); return i ? i.deliveries.map((d) => ({ ...d })) : []; },
    async markAcknowledged(uid, id, contactId) {
      const i = own(uid, id); if (!i) return;
      const mine = i.deliveries.filter((d) => d.contact_id === contactId && d.kind === "alert");
      if (!mine.length) i.deliveries.push({ id: randomUUID(), contact_id: contactId, channel: "manual_share", wave: 0, kind: "alert", status: "acknowledged", attempts: 0, created_at: iso(), updated_at: iso() });
      for (const d of mine) Object.assign(d, { status: "acknowledged", updated_at: iso() });
    },
    async getContactForConsent(contactId) { const c = contacts.get(contactId); return c ? { id: c.id, name: c.name, phone: c.phone, status: c.status } : null; },
    async setContactConsent(contactId, phone, status) {
      const c = contacts.get(contactId);
      if (!c || c.phone !== phone || !["verified", "declined"].includes(status)) throw Object.assign(new Error("no such contact"), { code: "not_found" });
      Object.assign(c, { status, verified_at: status === "verified" ? iso() : null, updated_at: iso() }); return { id: c.id, status };
    },
    async listTransitions(uid, id) { const i = own(uid, id); return i ? i.transitions.map((t) => ({ ...t })) : []; },
  };
}
