/**
 * Doctine · the identity and permission engine.
 *
 * The identity envelope is built on the server from the verified sign-in token, never from the request body or from
 * anything a model writes. It carries an opaque subject hash for logs, the person's role (only "patient": a person reads
 * their own records; caregiver access does not exist yet), their consents as recorded in the database, and a database
 * client bound to their own token, so row-level security limits every read to their rows. The account id itself is not
 * an enumerable property: it can't end up in a log line, a prompt or a tool argument by accident.
 *
 * Permissions are role + resource + purpose: reading records needs the role, the database's row security (the
 * resource check), a valid `ai_chat` consent, and the person's per-request choice to share their records with the
 * assistant (the purpose). Unknown or unreadable consent means no.
 */
import { createHash } from "node:crypto";
import { userDb } from "../gateway/db.mjs";
import { POLICY } from "./policy.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ROLES = Object.freeze({ patient: { may: ["read_own_records", "draft"] } });

export async function authenticate({ token, base, anon, fetchImpl = fetch, signal }) {
  if (!token || !base || !anon) return null;
  let uid = null, aal = null;
  // The consent lookup starts alongside the sign-in check (saves one database round trip). Row security limits it to the
  // token's owner, and it is only used if the sign-in check succeeds.
  const db = userDb({ base, anon, token, fetchImpl });
  const consentRows = db.select("consents", { columns: "kind,granted,updated_at" }).catch((e) => ({ failed: e }));
  try {
    const r = await fetchImpl(`${base}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` }, signal });
    if (r.ok) { const u = await r.json(); uid = u && typeof u.id === "string" && UUID.test(u.id) ? u.id : null; }
  } catch (e) { if (signal && signal.aborted) throw e; }
  if (!uid) return null;
  try { aal = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString()).aal || null; } catch { aal = null; }
  const envelope = { subject: createHash("sha256").update("assist:" + uid).digest("hex").slice(0, 16), role: "patient", aal, consents: null, purpose: null,
    db };
  Object.defineProperty(envelope, "uid", { value: uid, enumerable: false });
  Object.defineProperty(envelope, "_consentRows", { value: consentRows, enumerable: false });
  Object.defineProperty(envelope, "db", { value: envelope.db, enumerable: false });
  return envelope;
}

/** Reads the person's consents with their own token. Any failure: no consent (fail closed). */
export async function loadConsents(envelope) {
  const from = Date.parse(POLICY.consent.valid_from);
  try {
    const rows = envelope._consentRows ? await envelope._consentRows : await envelope.db.select("consents", { columns: "kind,granted,updated_at" });
    if (!Array.isArray(rows)) throw (rows && rows.failed) || new Error("consents unavailable");
    const by = Object.fromEntries(rows.map((r) => [r.kind, r]));
    const ai = by.ai_chat;
    envelope.consents = { ai_chat: !!(ai && ai.granted === true && Date.parse(ai.updated_at) >= from), source: "database" };
  } catch {
    envelope.consents = { ai_chat: false, source: "unavailable" };
  }
  return envelope.consents;
}

/** The permission decision for one classified request. Returns { allowed, purpose, reason, code }. */
export function decide(envelope, cls, { shareRecords }) {
  if (!envelope || !ROLES[envelope.role]) return { allowed: false, code: "no_role", reason: "not signed in" };
  if (cls.category === "other_person") return { allowed: false, code: "other_person", reason: "Only your own records can be read here." };
  if (cls.category === "injection") return { allowed: false, code: "injection", reason: "Instructions that change how the assistant works are ignored." };
  if (cls.category === "action_request") return { allowed: false, code: "action_not_available", reason: "The assistant can't change, send or book anything yet." };
  if (!envelope.consents || !envelope.consents.ai_chat) return { allowed: false, code: "consent_required", reason: "AI assistant consent is not on." };
  if (cls.needs_records) {
    if (shareRecords !== true) return { allowed: false, code: "share_not_chosen", reason: "Records are used only when you choose to share them for this conversation." };
    if (!ROLES[envelope.role].may.includes("read_own_records")) return { allowed: false, code: "role", reason: "not permitted" };
    return { allowed: true, purpose: "explain_own_records" };
  }
  return { allowed: true, purpose: cls.category === "general_health" ? "general_information" : "clarify" };
}
