/**
 * Doctine Guardian · contact acknowledgement links.
 *
 * A link lets one named contact say "I'm on it" for one incident, without an account. It carries the incident id, the
 * contact id and an expiry, signed with GUARDIAN_LINK_SECRET (HMAC-SHA256). Without that secret no links are made and
 * none are accepted. Links expire after 24 hours and stop working when the incident closes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const LINK_TTL_S = 24 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const b64 = (s) => Buffer.from(s).toString("base64url");

export function linkSecret(env = process.env) { const s = env.GUARDIAN_LINK_SECRET || ""; return s.length >= 32 ? s : ""; }

export function makeAckToken(incidentId, contactId, { secret, now = Date.now() }) {
  if (!secret || !UUID.test(incidentId) || !UUID.test(contactId)) return null;
  const payload = [incidentId, contactId, Math.floor(now / 1000) + LINK_TTL_S].join(".");
  return b64(payload) + "." + createHmac("sha256", secret).update(payload).digest("base64url");
}

/** → { incident_id, contact_id } or { error: "bad_link" | "expired" | "not_configured" } */
export function readAckToken(token, { secret, now = Date.now() }) {
  if (!secret) return { error: "not_configured" };
  const [p, mac] = String(token || "").split(".");
  if (!p || !mac || p.length > 200) return { error: "bad_link" };
  let payload; try { payload = Buffer.from(p, "base64url").toString(); } catch { return { error: "bad_link" }; }
  const want = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url")), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: "bad_link" };
  const [incident_id, contact_id, exp] = payload.split(".");
  if (!UUID.test(incident_id) || !UUID.test(contact_id)) return { error: "bad_link" };
  if (!(+exp > Math.floor(now / 1000))) return { error: "expired" };
  return { incident_id, contact_id };
}

/**
 * Consent links: the person sends one to a contact (from their own phone) so the contact can agree, or decline, to
 * be a trusted contact. Valid 7 days, signed separately from "I'm on it" links (a different HMAC context, so one kind
 * can never be used as the other), and bound to the contact's phone number: changing the number voids the old link.
 */
export const CONSENT_TTL_S = 7 * 24 * 3600;
const phoneKey = (phone) => String(phone || "").replace(/\D/g, "").slice(-12);
const consentMac = (secret, payload) => createHmac("sha256", secret).update("guardian-consent:" + payload).digest("base64url");

export function makeConsentToken(contactId, phone, { secret, now = Date.now() }) {
  if (!secret || !UUID.test(contactId) || phoneKey(phone).length < 6) return null;
  const ph = createHmac("sha256", secret).update("phone:" + phoneKey(phone)).digest("base64url").slice(0, 16);
  const payload = ["c", contactId, ph, Math.floor(now / 1000) + CONSENT_TTL_S].join(".");
  return b64(payload) + "." + consentMac(secret, payload);
}

/** → { contact_id, phone_tag } or { error }. The caller checks phone_tag against the contact's current number. */
export function readConsentToken(token, { secret, now = Date.now() }) {
  if (!secret) return { error: "not_configured" };
  const [p, mac] = String(token || "").split(".");
  if (!p || !mac || p.length > 200) return { error: "bad_link" };
  let payload; try { payload = Buffer.from(p, "base64url").toString(); } catch { return { error: "bad_link" }; }
  const want = Buffer.from(consentMac(secret, payload)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { error: "bad_link" };
  const [kind, contact_id, phone_tag, exp] = payload.split(".");
  if (kind !== "c" || !UUID.test(contact_id) || !phone_tag) return { error: "bad_link" };
  if (!(+exp > Math.floor(now / 1000))) return { error: "expired" };
  return { contact_id, phone_tag };
}

export const phoneTag = (phone, secret) => createHmac("sha256", secret).update("phone:" + phoneKey(phone)).digest("base64url").slice(0, 16);
