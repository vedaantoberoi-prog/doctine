/**
 * Doctine · doctor network, phase 1: the rules for a doctor's application and its verification.
 *
 * The same transition list is enforced by the database (supabase/migrations/20261126000000_doctor_onboarding.sql,
 * between "transitions:begin" and "transitions:end"); tests check the two are identical.
 *
 * VERIFIED means only this: a Doctine staff member checked the person's registration against an official register
 * (the NMC's National Medical Register or the State Medical Council's register), found the name, registration number,
 * council and active status matched, matched the photo ID, and recorded that evidence. It is not a quality rating, and
 * nothing in phase 1 shows a doctor to patients or lets anyone book a consultation.
 */

export const STATUSES = Object.freeze(["NOT_STARTED", "DOCUMENTS_SUBMITTED", "UNDER_REVIEW", "VERIFIED", "REJECTED", "SUSPENDED", "EXPIRED_REQUIRES_REVERIFICATION"]);
export const EDITABLE = Object.freeze(["NOT_STARTED", "REJECTED", "EXPIRED_REQUIRES_REVERIFICATION"]);

// [from, to, by]: who may make each change. "system" is the 12-month expiry.
export const TRANSITION_LIST = Object.freeze([
  ["NOT_STARTED", "DOCUMENTS_SUBMITTED", "doctor"], ["REJECTED", "DOCUMENTS_SUBMITTED", "doctor"], ["EXPIRED_REQUIRES_REVERIFICATION", "DOCUMENTS_SUBMITTED", "doctor"],
  ["DOCUMENTS_SUBMITTED", "UNDER_REVIEW", "staff"], ["DOCUMENTS_SUBMITTED", "REJECTED", "staff"],
  ["UNDER_REVIEW", "VERIFIED", "staff"], ["UNDER_REVIEW", "REJECTED", "staff"], ["UNDER_REVIEW", "DOCUMENTS_SUBMITTED", "staff"],
  ["VERIFIED", "SUSPENDED", "staff"], ["VERIFIED", "EXPIRED_REQUIRES_REVERIFICATION", "staff"], ["VERIFIED", "EXPIRED_REQUIRES_REVERIFICATION", "system"],
  ["SUSPENDED", "VERIFIED", "staff"], ["SUSPENDED", "REJECTED", "staff"], ["SUSPENDED", "EXPIRED_REQUIRES_REVERIFICATION", "system"],
]);
export const canMove = (from, to, by) => TRANSITION_LIST.some(([f, t, b]) => f === from && t === to && b === by);
export const staffMoves = (from) => TRANSITION_LIST.filter(([f, , b]) => f === from && b === "staff").map(([, t]) => t);
export const VERIFICATION_VALID_MONTHS = 12;

export const STATUS_TEXT = Object.freeze({
  NOT_STARTED: { label: "Not submitted", doctor: "Fill in your details and upload your documents, then submit them for verification." },
  DOCUMENTS_SUBMITTED: { label: "Submitted", doctor: "Your application is in the queue. A Doctine reviewer will check your registration against the official register." },
  UNDER_REVIEW: { label: "Under review", doctor: "A Doctine reviewer is checking your registration and documents." },
  VERIFIED: { label: "Verified", doctor: "Your registration was checked against the official register. Consultations aren't open on Doctine yet; we'll write to you before they are." },
  REJECTED: { label: "Not verified", doctor: "We couldn't verify your application. See the reason below, correct your details or documents, and submit again." },
  SUSPENDED: { label: "Suspended", doctor: "Your verification is suspended. See the reason below." },
  EXPIRED_REQUIRES_REVERIFICATION: { label: "Needs re-verification", doctor: "Verification lasts 12 months. Please check your details and submit again so we can re-check your registration." },
});

export const DOCUMENT_KINDS = Object.freeze({
  registration_certificate: { label: "Medical registration certificate", required: true, hint: "From the NMC or your State Medical Council, showing your registration number." },
  degree_certificate: { label: "Medical degree certificate", required: true, hint: "Your MBBS (or equivalent) degree; add postgraduate degrees as \"Other\"." },
  photo_id: { label: "Government photo ID", required: true, hint: "PAN card, passport, driving licence or voter ID. Please mask your Aadhaar number if you use Aadhaar." },
  other: { label: "Other (postgraduate degree, additional registration)", required: false, hint: "Optional." },
});
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MIME_TYPES = Object.freeze(["application/pdf", "image/jpeg", "image/png"]);

/** The file's real type from its first bytes; the declared type and file name are not trusted. */
export function sniffMime(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";      // %PDF-
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  return null;
}
export const extFor = (mime) => ({ "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[mime]);

// The National Medical Commission and the State Medical Councils (the registers a registration can be checked against).
export const COUNCILS = Object.freeze([
  "National Medical Commission (Indian Medical Register / NMR)", "Andhra Pradesh Medical Council", "Arunachal Pradesh Medical Council", "Assam Medical Council",
  "Bihar Council of Medical Registration", "Chhattisgarh Medical Council", "Delhi Medical Council", "Goa Medical Council", "Gujarat Medical Council",
  "Haryana Medical Council", "Himachal Pradesh Medical Council", "Jammu & Kashmir Medical Council", "Jharkhand Medical Council", "Karnataka Medical Council",
  "Travancore Cochin Medical Council (Kerala)", "Madhya Pradesh Medical Council", "Maharashtra Medical Council", "Manipur Medical Council",
  "Meghalaya Medical Council", "Mizoram Medical Council", "Nagaland Medical Council", "Odisha Council of Medical Registration", "Punjab Medical Council",
  "Rajasthan Medical Council", "Sikkim Medical Council", "Tamil Nadu Medical Council", "Telangana State Medical Council", "Tripura State Medical Council",
  "Uttar Pradesh Medical Council", "Uttarakhand Medical Council", "West Bengal Medical Council", "Puducherry Medical Council",
]);
export const SPECIALTIES = Object.freeze([
  "General physician", "Family medicine", "Internal medicine", "Paediatrics", "Obstetrics & gynaecology", "Dermatology", "Psychiatry", "Cardiology",
  "Orthopaedics", "ENT", "Ophthalmology", "Endocrinology", "Gastroenterology", "Pulmonology", "Nephrology", "Neurology", "General surgery", "Diabetology",
]);
export const LANGUAGES = Object.freeze(["English", "Hindi", "Bengali", "Marathi", "Telugu", "Tamil", "Gujarati", "Urdu", "Kannada", "Odia", "Malayalam", "Punjabi", "Assamese"]);
export const MODES = Object.freeze(["text", "audio", "video"]);

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Cleans a profile from the doctor's form. Returns { ok, profile } or { ok: false, errors: { field: message } }.
 * A partial profile is fine to save; completeness is checked on submission (by the database, from the saved row).
 */
export function cleanProfile(p, { thisYear = new Date().getFullYear() } = {}) {
  const errors = {}, out = {};
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, errors: { profile: "Missing details." } };
  out.full_name = str(p.full_name, 120);
  if (out.full_name && out.full_name.length < 2) errors.full_name = "Enter your full name as it appears on your registration.";
  out.registration_number = str(p.registration_number, 40).toUpperCase();
  if (out.registration_number && !/^[A-Z0-9/ .-]{2,40}$/.test(out.registration_number)) errors.registration_number = "Letters, numbers, spaces and / . - only.";
  out.registration_council = str(p.registration_council, 120);
  if (out.registration_council && !COUNCILS.includes(out.registration_council)) errors.registration_council = "Choose the council from the list.";
  const ry = p.registration_year === "" || p.registration_year == null ? "" : Number(p.registration_year);
  if (ry !== "" && !(Number.isInteger(ry) && ry >= 1940 && ry <= thisYear)) errors.registration_year = `A year between 1940 and ${thisYear}.`;
  out.registration_year = ry === "" ? "" : ry;
  const quals = Array.isArray(p.qualifications) ? p.qualifications : [];
  if (quals.length > 8) errors.qualifications = "At most 8 qualifications.";
  out.qualifications = quals.slice(0, 8).map((q) => ({ degree: str(q && q.degree, 80), institution: str(q && q.institution, 160), year: Number(q && q.year) }));
  out.qualifications.forEach((q, i) => {
    if (q.degree.length < 2 || q.institution.length < 2 || !(Number.isInteger(q.year) && q.year >= 1940 && q.year <= thisYear)) errors["qualifications." + i] = "Each qualification needs a degree, an institution and a year.";
  });
  const list = (v, allowed, max, key, what) => {
    const a = Array.isArray(v) ? [...new Set(v.map((x) => str(x, 60)).filter(Boolean))] : [];
    if (a.length > max) errors[key] = `At most ${max} ${what}.`;
    if (a.some((x) => !allowed.includes(x))) errors[key] = `Choose ${what} from the list.`;
    return a.slice(0, max);
  };
  out.specialties = list(p.specialties, SPECIALTIES, 5, "specialties", "specialties");
  out.languages = list(p.languages, LANGUAGES, 10, "languages", "languages");
  out.consultation_modes = list(p.consultation_modes, MODES, 3, "consultation_modes", "consultation modes");
  const ex = p.experience_years === "" || p.experience_years == null ? "" : Number(p.experience_years);
  if (ex !== "" && !(Number.isInteger(ex) && ex >= 0 && ex <= 70)) errors.experience_years = "Whole years, 0 to 70.";
  out.experience_years = ex;
  out.bio = str(p.bio, 1200);
  out.declaration = p.declaration === true;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, profile: out };
}

/** What a reviewer must record to verify someone (mirrors the database check). */
export function checkEvidence(e, { today = new Date() } = {}) {
  const errors = [];
  if (!e || typeof e !== "object") return ["Record the evidence."];
  if (!["nmr", "state_council"].includes(e.register)) errors.push("Which register was checked (NMR or State Medical Council).");
  if (!e.register_name || String(e.register_name).trim().length < 3) errors.push("The register's name.");
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(e.checked_on || "")) ? Date.parse(e.checked_on + "T00:00:00Z") : NaN;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (!Number.isFinite(d) || d > t || d < t - 30 * 864e5) errors.push("The date it was checked (within the last 30 days).");
  const m = e.matched || {};
  for (const [k, label] of [["name", "name"], ["registration_number", "registration number"], ["council", "council"], ["active", "registration is active"], ["photo_id", "photo ID matches"]])
    if (m[k] !== true) errors.push(`Confirm: ${label}.`);
  return errors;
}
