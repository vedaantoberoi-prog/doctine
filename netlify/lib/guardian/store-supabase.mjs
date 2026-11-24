/**
 * Doctine Guardian · the database store: each method is one server-only function in migration
 * 20261125000000_guardian.sql, called with the service key and the person's id that /api/guardian verified from their
 * sign-in token. Browsers can't call these functions (tests/guardian.test.sql). The service key never leaves the server.
 */
import { serviceHeaders } from "../supabase-keys.mjs";

export function createSupabaseStore({ env = process.env, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const base = (env.SUPABASE_URL || "").replace(/\/$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !key) return null;
  async function rpc(name, args) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: "POST", signal: ac.signal, headers: serviceHeaders(key, { "content-type": "application/json" }), body: JSON.stringify(args) });
      const text = await r.text();
      if (!r.ok) {
        let code = "db_error"; try { const j = JSON.parse(text); code = j.code === "P0002" ? "not_found" : j.code === "22023" || j.code === "23514" ? "invalid" : j.code === "PGRST202" ? "not_installed" : "db_error"; } catch {}
        throw Object.assign(new Error(name + " " + r.status), { code, status: r.status });
      }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(t); }
  }
  return {
    getSettings: (uid) => rpc("guardian_settings_get", { p_user: uid }),
    saveSettings: (uid, s) => rpc("guardian_settings_save", { p_user: uid, p: s }),
    listContacts: async (uid) => (await rpc("guardian_contacts_list", { p_user: uid })) || [],
    saveContact: (uid, c) => rpc("guardian_contact_save", { p_user: uid, p: c }),
    deleteContact: (uid, id) => rpc("guardian_contact_delete", { p_user: uid, p_id: id }),
    findByEventId: (uid, eventId) => rpc("guardian_incident_by_event", { p_user: uid, p_event: eventId }),
    recordStatusEvent: (uid, ev) => rpc("guardian_status_event", { p_user: uid, p: { source: ev.source, observed_at: ev.observed_at, flags: ev.flags } }),
    openIncidents: async (uid) => (await rpc("guardian_incidents_open", { p_user: uid })) || [],
    recentIncidents: async (uid, n = 20) => (await rpc("guardian_incidents_recent", { p_user: uid, p_limit: n })) || [],
    getIncident: (uid, id) => rpc("guardian_incident_get", { p_user: uid, p_id: id }),
    getIncidentForContact: (id, contactId) => rpc("guardian_incident_for_contact", { p_id: id, p_contact: contactId }),
    insertIncident: (uid, ev, state, rec) => rpc("guardian_incident_insert", { p_user: uid, p_event: ev, p_state: state, p_record: rec }),
    transition: (uid, id, from, to, rec, patch = {}) => rpc("guardian_incident_transition", { p_user: uid, p_id: id, p_from: from, p_to: to, p_record: rec, p_patch: patch }),
    addEvidence: (uid, id, ev, patch = {}) => rpc("guardian_incident_evidence", { p_user: uid, p_id: id, p_event: ev, p_patch: patch }),
    note: (uid, id, n) => rpc("guardian_incident_note", { p_user: uid, p_id: id, p_note: n }),
    upsertDelivery: (uid, id, d) => rpc("guardian_delivery_upsert", { p_user: uid, p_id: id, p: d }),
    listDeliveries: async (uid, id) => (await rpc("guardian_deliveries", { p_user: uid, p_id: id })) || [],
    markAcknowledged: (uid, id, contactId) => rpc("guardian_mark_ack", { p_user: uid, p_id: id, p_contact: contactId }),
    listTransitions: async (uid, id) => (await rpc("guardian_transitions", { p_user: uid, p_id: id })) || [],
    purge: () => rpc("guardian_purge", {}),
  };
}
