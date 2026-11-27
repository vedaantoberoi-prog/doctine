/**
 * Doctine · patient context for /api/chat, built ON THE SERVER as the signed-in person.
 *
 * Why: the app used to assemble the health context in the browser and send it with each message, and the server
 * trusted it. For signed-in accounts the server now reads it itself, through userDb() (the person's own sign-in token
 * and the public key), so the database's row-level security decides what is visible: only their own rows. No user id
 * is ever taken from the request or the model.
 *
 * What goes in (the same rules the app used, now enforced in one place):
 *   always, because they matter for safety: age, sex at birth, allergies (or the answer "no known allergies" /
 *     "never assessed"), long-term conditions that are not resolved, current medicines, pregnancy only when the
 *     person chose to share it with the assistant;
 *   only when relevant to what they are asking: other history (past illness, surgery, hospital stays, family history,
 *     devices, stopped medicines) and lab values whose test matches the question, newest first, at most 10;
 *   the document the person has open ("focus"), up to 12 values.
 * Every item says where it came from (self-reported, clinician-documented, from a medical record) and its date.
 * Contact details are never read. Nothing missing is filled in.
 *
 * Returns { context, refs, stats } where context has the shape cleanContext() in chat.mjs accepts, refs maps each
 * record id the model may cite (R1…) to the document it came from, and stats are counts only (for logs).
 */
import { observations, testKey } from "../gateway/labs.mjs";
import { understand } from "../evidence/query.mjs";

const SRC = { user: "self-reported", clinician: "clinician-documented", document: "from a medical record", import: "self-reported" };
const KIND = { confirmed: "confirmed allergy", suspected: "suspected allergy", intolerance: "intolerance", adverse_reaction: "medicine side effect" };
const STATUS = { active: "active", controlled: "controlled", remission: "in remission" };
const TYPE = { past_illness: "past illness", surgery: "surgery", hospitalization: "hospital stay", other_history: "other history", family: "family history", device: "medical device" };
const SEV = ["mild", "moderate", "severe"];
const DAY = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const day = (v) => (typeof v === "string" && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : undefined);
const cut = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const today = () => new Date().toISOString().slice(0, 10);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9+ ]+/g, " ").replace(/\s+/g, " ").trim();

export function ageOn(dob, on = today()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || "")) return null;
  let a = +on.slice(0, 4) - +dob.slice(0, 4);
  if (on.slice(5) < dob.slice(5)) a--;
  return a >= 0 && a < 130 ? a : null;
}

/** Words from the last three things the person said, plus the lab tests the question may be about. */
export function relevance(userTurns) {
  const recent = userTurns.slice(-3).join(" \n ");
  const plan = understand(recent);
  const words = [...new Set((norm(recent).match(/[a-z0-9][a-z0-9+-]{2,}/g) || []).filter((w) => w.length >= 3))];
  return { words, tests: new Set(plan.tests), terms: plan.terms.map(norm).filter((t) => t.length >= 3) };
}
const hits = (rel, text) => {
  const n = norm(text);
  if (n.length < 3) return false;
  return rel.words.some((k) => n.includes(k) || k.includes(n) || n.split(" ").some((w) => w.length >= 4 && (k.includes(w) || w.includes(k))))
    || rel.terms.some((t) => n.includes(t));
};

/**
 * @param {{ select: Function }} db  userDb() for the signed-in person
 * @param {{ userTurns: string[], focus?: string }} q  what they said (latest last) and the app's id of the open document
 */
export async function patientContext(db, { userTurns = [], focus } = {}) {
  const t0 = Date.now();
  const rel = relevance(userTurns);
  const [profiles, recs, meds, docs, labs] = await Promise.all([
    db.select("health_profiles", { columns: "date_of_birth,sex_at_birth,allergies,history_answers,womens_health", limit: 1 }),
    db.select("health_records", { columns: "id,kind,title,status,category,severity,certainty,onset,details,source", limit: 300 }),
    db.select("medicines", { columns: "name,strength,dose,category,status,start_date,end_date,stop_reason,source_document_id", limit: 200 }),
    db.select("documents", { columns: "id,client_id,title,category,document_date,provider,fields", order: "document_date.desc.nullslast", limit: 300 }),
    db.select("lab_results", { columns: "id,document_id,test,value,unit,reference_range,flag,confidence,origin", limit: 1000 }).catch((e) => { if (e && e.code === "not_available") return []; throw e; }),
  ]);
  const p = profiles[0] || {};
  const prof = {};
  const age = ageOn(p.date_of_birth);
  if (age != null) prof.age = age;
  if (["female", "male", "intersex"].includes(p.sex_at_birth)) prof.sex = p.sex_at_birth;

  // allergies: always (safety)
  const al = recs.filter((r) => r.kind === "allergy").map((r) => tidy({ substance: cut(r.title, 60), kind: KIND[r.certainty], severity: SEV.includes(r.severity) ? r.severity : undefined,
    reaction: cut(r.details && r.details.reaction, 120), source: SRC[r.source || "user"], since: day(r.onset) })).filter((a) => a.substance);
  for (const x of String(p.allergies || "").split(",").map((s) => s.trim()).filter(Boolean)) if (!al.some((a) => a.substance.toLowerCase() === x.toLowerCase())) al.push({ substance: x.slice(0, 60), source: "self-reported" });
  const ans = (p.history_answers && typeof p.history_answers === "object") ? p.history_answers : {};
  if (al.length) prof.allergies = al.slice(0, 15);
  else if (ans.allergies === "nka") prof.allergy_status = "no known allergies";
  else if (ans.allergies === "not_assessed") prof.allergy_status = "never assessed";

  // conditions that are not resolved: always
  const conds = recs.filter((r) => r.kind === "condition" && r.status !== "resolved").map((r) => tidy({ name: cut(r.title, 120), status: STATUS[r.status] || "status not recorded", since: day(r.onset), source: SRC[r.source || "user"] })).filter((c) => c.name);
  if (conds.length) prof.conditions = conds.slice(0, 10);

  // current medicines: always
  const t = today();
  const ended = (m) => m.status === "completed" || (m.end_date && m.end_date < t);
  const cur = meds.filter((m) => !ended(m) && (m.status || "active") === "active").map((m) => tidy({ name: cut(m.name, 120), dose: cut([m.strength, m.dose && m.dose !== "Not recorded" ? m.dose : ""].filter(Boolean).join(" "), 120),
    taken: m.category === "occasional" ? "now and then" : "regularly", since: day(m.start_date), source: m.source_document_id ? "from a prescription the person checked" : "self-reported" })).filter((m) => m.name);
  if (cur.length) prof.current_medicines = cur.slice(0, 15);

  // other history and stopped medicines: only when relevant
  const related = [
    ...recs.filter((r) => TYPE[r.kind] && hits(rel, r.title)).map((r) => tidy({ type: TYPE[r.kind],
      text: cut(r.kind === "family" ? `${r.category ? r.category + ": " : ""}${r.title}${r.details && r.details.age ? `, diagnosed around age ${r.details.age}` : ""}` : r.title, 200),
      when: day(r.onset), source: SRC[r.source || "user"] })),
    ...meds.filter((m) => ended(m) && hits(rel, m.name)).map((m) => tidy({ type: "stopped medicine", text: cut(`${m.name}, stopped${m.stop_reason ? " (" + m.stop_reason + ")" : ""}`, 200), when: day(m.end_date), source: "self-reported" })),
  ].filter((x) => x.text);
  if (related.length) prof.related_history = related.slice(0, 8);

  // pregnancy: only when the person chose to share it with the assistant
  const wh = p.womens_health && typeof p.womens_health === "object" ? p.womens_health : {};
  if (wh.shareAI === true) { const pg = { yes: "pregnant", no: "not pregnant", trying: "trying to conceive" }[wh.preg]; if (pg) prof.pregnancy = pg; }

  // lab values: the open document first, then values whose test matches the question, newest first
  // values the person confirmed or typed in; automatic readings nobody has checked stay out (as before, in the app)
  const obs = observations(docs, labs).filter((o) => o.verification === "confirmed_by_person" || o.verification === "entered_by_person");
  const byDoc = new Map(docs.map((d) => [d.id, d]));
  const picked = [];
  const focusDoc = typeof focus === "string" && focus ? docs.find((d) => d.client_id === focus) : null;
  if (focusDoc) for (const o of obs.filter((o) => o.source.document_id === focusDoc.id).slice(0, 12)) picked.push(o);
  const relevant = obs.filter((o) => !picked.includes(o) && (rel.tests.has(o.key) || hits(rel, o.test) || rel.words.some((w) => testKey(w).key === o.key)))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  for (const o of relevant) { if (picked.length >= 10 && !focusDoc) break; if (picked.length >= 16) break; picked.push(o); }

  const refs = [], records = [];
  picked.slice(0, focusDoc ? 16 : 10).forEach((o, i) => {
    const id = "R" + (i + 1), d = byDoc.get(o.source.document_id) || {};
    const value = [o.value_text, o.value_text && o.unit && !o.value_text.includes(o.unit) ? o.unit : "", o.reference_range ? `(reference ${o.reference_range})` : "", o.flag_printed ? `[${o.flag_printed}]` : ""].filter(Boolean).join(" ");
    records.push({ id, title: String(d.title || "Medical document").slice(0, 120), date: o.date || "", test: o.test.slice(0, 80), value: value.slice(0, 120) });
    refs.push({ id, client_id: d.client_id || null, title: String(d.title || "Medical document").slice(0, 120), date: o.date || null });
  });

  const context = {};
  if (Object.keys(prof).length) context.profile = prof;
  if (records.length) context.records = records;
  return {
    context: Object.keys(context).length ? context : null, refs,
    stats: { profile_items: Object.values(prof).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0), records: records.length, focus: !!focusDoc, ms: Date.now() - t0 },
  };
}
function tidy(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")); }
