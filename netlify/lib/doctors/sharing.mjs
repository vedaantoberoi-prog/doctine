/**
 * Doctine · patient-controlled record sharing with a verified doctor: the parts that can be shared, the purposes and
 * the durations. The database (20261127000000_record_sharing.sql) enforces the same lists.
 */
export const SCOPES = Object.freeze({
  profile: { label: "Basic details", hint: "Name, age, sex, blood group, height and weight." },
  allergies: { label: "Allergies", hint: "Allergies and reactions you've recorded." },
  medicines: { label: "Medicines", hint: "Current and past medicines, doses and why they were stopped." },
  history: { label: "Medical history", hint: "Conditions, past illnesses, surgeries, hospital stays, devices and family history." },
  labs: { label: "Test results", hint: "Lab values from your reports, with the report and date." },
  documents: { label: "List of documents", hint: "Titles and dates of your reports and prescriptions (not the files)." },
});
export const PURPOSES = Object.freeze({ consultation: "A consultation", second_opinion: "A second opinion", follow_up: "A follow-up", other: "Something else" });
export const DAYS = Object.freeze([1, 7, 30]);
export const CODE = /^[A-Za-z0-9 -]{10,16}$/;
export const cleanCode = (c) => String(c || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** Validates a share request from the app. Returns { ok, share } or { ok: false, error }. */
export function cleanShare(b) {
  if (!b || typeof b !== "object") return { ok: false, error: "Missing details." };
  const code = cleanCode(b.code);
  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) return { ok: false, error: "That code doesn't look right. It has 10 letters and numbers." };
  const scopes = Array.isArray(b.scopes) ? [...new Set(b.scopes.map(String))] : [];
  if (!scopes.length) return { ok: false, error: "Choose at least one part of your record." };
  if (scopes.some((s) => !Object.prototype.hasOwnProperty.call(SCOPES, s))) return { ok: false, error: "Unknown part of the record." };
  const days = Number(b.days);
  if (!DAYS.includes(days)) return { ok: false, error: "Share for 1, 7 or 30 days." };
  if (!Object.prototype.hasOwnProperty.call(PURPOSES, b.purpose)) return { ok: false, error: "Choose why you're sharing." };
  if (b.confirm !== true) return { ok: false, error: "Please confirm you want to share." };
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 300) : "";
  return { ok: true, share: { code, scopes, days, purpose: b.purpose, note, confirm: true } };
}
