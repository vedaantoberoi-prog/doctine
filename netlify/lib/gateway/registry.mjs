/**
 * Doctine · the capability registry: every operation the AI may use, typed, read-only, and run as the signed-in person.
 *
 * Each capability: name, domain, description, keywords (for discovery), input (a small JSON schema the gateway
 * validates), output (what comes back), permission ("read": nothing here can write), examples (correct use, and the
 * mistakes that matter for safety), and run(ctx, args). ctx.db is userDb(): row-level security limits every read to
 * the person's own rows. No capability takes a user id.
 *
 * Every medical item returned says where it came from (`source`) and how sure it is (`verification`):
 *   self_reported · clinician_documented · from_document · confirmed_by_person · entered_by_person ·
 *   ai_extracted_unconfirmed · prescription_line_unconfirmed · prescription_line_confirmed
 * Contact details (phone, email, address, emergency contact) are never returned: no medical question needs them.
 */
import { observations, compareSeries, timeline, testKey, matchesQuery } from "./labs.mjs";
import { GatewayError } from "./db.mjs";
import { investigate } from "../evidence/investigate.mjs";
import { understand } from "../evidence/query.mjs";
import { bm25 } from "../evidence/rank.mjs";

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD" };
const SRC = { user: "self_reported", clinician: "clinician_documented", document: "from_document", import: "self_reported" };
const today = () => new Date().toISOString().slice(0, 10);
const ageOn = (dob, on = today()) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || "")) return null;
  let a = +on.slice(0, 4) - +dob.slice(0, 4);
  if (on.slice(5) < dob.slice(5)) a--;
  return a >= 0 && a < 130 ? a : null;
};
const cut = (v, n) => (typeof v === "string" ? v.slice(0, n) : v == null ? null : String(v).slice(0, n));

async function loadLabs(db) {
  const [docs, rows] = await Promise.all([
    db.select("documents", { columns: "id,title,category,document_date,provider,fields,page_count", order: "document_date.asc.nullslast" }),
    db.select("lab_results", { columns: "id,document_id,test,value,unit,reference_range,flag,confidence,origin" }),
  ]);
  return { docs, rows, labDocs: docs.filter((d) => d.category === "Lab report"), obs: observations(docs, rows) };
}
async function records(db, kinds) {
  return db.select("health_records", { columns: "id,kind,title,status,category,severity,certainty,onset,details,source,source_document_id,created_at,updated_at", filters: [["kind", "in", kinds]], order: "onset.asc.nullslast" });
}
const rec = (r) => ({ id: r.id, title: cut(r.title, 160), status: r.status || null, category: r.category || null, severity: r.severity || null,
  certainty: r.certainty || null, onset: r.onset || null, reaction: r.details && typeof r.details.reaction === "string" ? cut(r.details.reaction, 200) : undefined,
  age_at_diagnosis: r.details && r.details.age != null ? cut(String(r.details.age), 10) : undefined,
  verification: SRC[r.source] || "self_reported", source_document_id: r.source_document_id || null, recorded: (r.updated_at || r.created_at || "").slice(0, 10) });
async function answers(db) {
  const p = await db.select("health_profiles", { columns: "date_of_birth,sex_at_birth,gender,blood_group,height_cm,weight_kg,allergies,history_answers,lifestyle,updated_at", limit: 1 });
  return p[0] || null;
}
const ANS = { yes: "yes", no: "no", not_sure: "not sure", prefer_not: "prefer not to say", nka: "no known allergies", not_assessed: "never been checked" };

export const CAPABILITIES = [
  {
    name: "get_profile_summary", domain: "profile",
    description: "Age (from date of birth), sex assigned at birth, gender, blood group, height and weight as saved by the person, and their explicit yes/no answers for each history section. No contact details.",
    keywords: ["profile", "age", "sex", "gender", "blood group", "height", "weight", "bmi", "body", "demographics", "about me"],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: "{ age, sex_at_birth, gender, blood_group, height_cm, weight_kg, answers: {conditions, past, surgery, hosp, other, allergies, devices, family, meds_regular, meds_occasional}, verification: 'self_reported', updated }",
    examples: [{ args: {}, note: "Missing values come back as null: never treat null as 'none' or 'normal'." }],
    async run({ db }) {
      const p = await answers(db);
      if (!p) return { exists: false, note: "No health profile saved yet." };
      const a = p.history_answers || {};
      return { exists: true, age: ageOn(p.date_of_birth), sex_at_birth: p.sex_at_birth || null, gender: p.gender || null, blood_group: p.blood_group || null,
        height_cm: p.height_cm ?? null, weight_kg: p.weight_kg ?? null,
        answers: Object.fromEntries(["conditions", "past", "surgery", "hosp", "other", "allergies", "devices", "family", "meds_regular", "meds_occasional"].map((k) => [k, a[k] ? ANS[a[k]] || null : null])),
        verification: "self_reported", updated: (p.updated_at || "").slice(0, 10) || null };
    },
  },
  {
    name: "get_allergies", domain: "allergies",
    description: "Allergies, intolerances and medicine side effects the person recorded, each with kind (confirmed / suspected / intolerance / adverse reaction), severity, reaction, source; plus their overall answer (e.g. 'no known allergies' vs 'never been checked') and any older free-text note.",
    keywords: ["allergy", "allergies", "allergic", "intolerance", "reaction", "side effect", "anaphylaxis", "drug allergy", "food allergy"],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: "{ answer, entries: [{ title, category, certainty, severity, reaction, onset, verification, source_document_id }], older_note }",
    examples: [{ args: {}, note: "An empty list with answer null means NOT ANSWERED, not 'no allergies'. Only answer 'no known allergies' means none were reported. A suspected allergy or intolerance is not a confirmed allergy." }],
    async run({ db }) {
      const [p, rows] = await Promise.all([answers(db), records(db, ["allergy"])]);
      const a = p && p.history_answers && p.history_answers.allergies;
      return { answer: a ? ANS[a] : null, entries: rows.map(rec), older_note: p && p.allergies && p.allergies.trim() ? { text: cut(p.allergies, 300), verification: "self_reported" } : null };
    },
  },
  {
    name: "get_medical_history", domain: "history",
    description: "Long-term conditions, past illnesses, surgeries and procedures, hospital stays and other important history (transfusions, injuries, cancer…), with status, onset and source.",
    keywords: ["history", "condition", "conditions", "diagnosis", "diagnosed", "disease", "illness", "surgery", "operation", "procedure", "hospital", "admitted", "chronic", "diabetes", "hypertension", "asthma", "thyroid", "cardiac", "heart"],
    input: { type: "object", properties: { kinds: { type: "array", items: { type: "string", enum: ["condition", "past_illness", "surgery", "hospitalization", "other_history"] }, maxItems: 5 } }, additionalProperties: false },
    output: "{ answers: {conditions, past, surgery, hosp, other}, entries: [{ kind, title, status, onset, verification, source_document_id }] }",
    examples: [{ args: { kinds: ["condition"] }, note: "Status 'unknown' or null is not 'resolved'. A self-reported condition is not clinician-confirmed." }],
    async run({ db }, { kinds }) {
      const k = kinds && kinds.length ? kinds : ["condition", "past_illness", "surgery", "hospitalization", "other_history"];
      const [p, rows] = await Promise.all([answers(db), records(db, k)]);
      const a = (p && p.history_answers) || {};
      return { answers: Object.fromEntries(["conditions", "past", "surgery", "hosp", "other"].map((x) => [x, a[x] ? ANS[a[x]] : null])), entries: rows.map((r) => ({ kind: r.kind, ...rec(r) })) };
    },
  },
  {
    name: "get_medical_devices", domain: "devices",
    description: "Medical devices (implanted, external, wearable): name, type, status (in use / removed), since when, source.",
    keywords: ["device", "devices", "implant", "pacemaker", "stent", "insulin pump", "hearing aid", "cpap", "prosthesis"],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: "{ answer, entries: [{ title, category, status, onset, verification }] }",
    examples: [{ args: {} }],
    async run({ db }) {
      const [p, rows] = await Promise.all([answers(db), records(db, ["device"])]);
      const a = p && p.history_answers && p.history_answers.devices;
      return { answer: a ? ANS[a] : null, entries: rows.map(rec) };
    },
  },
  {
    name: "get_family_history", domain: "family",
    description: "Conditions in blood relatives: relationship, condition, age at diagnosis, whether the relative is living.",
    keywords: ["family", "hereditary", "genetic", "mother", "father", "parents", "sibling", "inherited", "runs in the family"],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: "{ answer, entries: [{ relationship, title, age_at_diagnosis, status, verification }] }",
    examples: [{ args: {}, note: "Family history is context for a clinician, never evidence that the person has the condition." }],
    async run({ db }) {
      const [p, rows] = await Promise.all([answers(db), records(db, ["family"])]);
      const a = p && p.history_answers && p.history_answers.family;
      return { answer: a ? ANS[a] : null, entries: rows.map((r) => ({ relationship: r.category, ...rec(r) })) };
    },
  },
  {
    name: "get_medications", domain: "medications",
    description: "Medicines the person keeps in Doctine: name, strength, dose as written, regular or occasional, status, start and end dates, why it was started and stopped, prescriber, and whether it came from a prescription.",
    keywords: ["medicine", "medicines", "medication", "medications", "drug", "drugs", "tablet", "dose", "dosage", "prescribed", "taking", "current medicines", "stopped", "discontinued"],
    input: { type: "object", properties: { status: { type: "string", enum: ["current", "stopped", "all"], default: "all" } }, additionalProperties: false },
    output: "{ answers: {regular, occasional}, entries: [{ name, brand, strength, dose, category, status, current, start_date, end_date, reason, stop_reason, prescriber, verification, source_document_id }] }",
    examples: [{ args: { status: "current" }, note: "'current' means status active or paused and no end date in the past, AS RECORDED. It does not prove the person still takes it. Never advise starting, stopping or changing a dose." }],
    async run({ db }, { status = "all" }) {
      const [p, rows] = await Promise.all([answers(db), db.select("medicines", { columns: "id,name,brand,strength,dose,category,status,start_date,end_date,reason,stop_reason,stopped_on_advice,prescriber,source_document_id,source_confidence,updated_at", order: "start_date.desc.nullslast" })]);
      const t = today();
      const items = rows.map((m) => {
        const current = m.status !== "completed" && !(m.end_date && m.end_date < t);
        return { id: m.id, name: cut(m.name, 120), brand: m.brand || null, strength: m.strength || null, dose: cut(m.dose, 120), category: m.category || "regular",
          status: m.status === "completed" ? "stopped" : m.status, current, start_date: m.start_date || null, end_date: m.end_date || null,
          reason: m.reason || null, stop_reason: m.stop_reason || null, stopped_on_advice: m.stopped_on_advice || null, prescriber: m.prescriber || null,
          verification: m.source_document_id ? "from_prescription_checked_by_person" : "self_reported", source_document_id: m.source_document_id || null,
          last_updated: (m.updated_at || "").slice(0, 10) };
      }).filter((m) => status === "all" || (status === "current" ? m.current : !m.current));
      const a = (p && p.history_answers) || {};
      return { answers: { regular: a.meds_regular ? ANS[a.meds_regular] : null, occasional: a.meds_occasional ? ANS[a.meds_occasional] : null }, entries: items };
    },
  },
  {
    name: "get_prescriptions", domain: "medications",
    description: "Prescriptions read from uploaded documents: doctor, facility, date, and each line as written with the AI's reading and whether the person confirmed it.",
    keywords: ["prescription", "prescriptions", "rx", "doctor wrote", "prescribed", "chit", "parchi"],
    input: { type: "object", properties: { from: DATE, to: DATE }, additionalProperties: false },
    output: "{ prescriptions: [{ document_id, date, doctor, facility, items: [{ raw_text, name, strength, frequency, timing, duration, confidence, verification }] }] }",
    examples: [{ args: { from: "2025-01-01" }, note: "An unconfirmed line is an AI reading of handwriting: report it as such, never as a verified medicine." }],
    async run({ db }, { from, to }) {
      const filters = [];
      if (from) filters.push(["prescribed_on", "gte", from]);
      if (to) filters.push(["prescribed_on", "lte", to]);
      const rx = await db.select("prescriptions", { columns: "id,document_id,doctor,facility,prescribed_on,prescription_items(position,raw_text,name,strength,frequency,timing,duration,confidence,confirmed)", filters, order: "prescribed_on.asc.nullslast" });
      return { prescriptions: rx.map((p) => ({ document_id: p.document_id, date: p.prescribed_on || null, doctor: p.doctor || null, facility: p.facility || null,
        items: (p.prescription_items || []).sort((a, b) => a.position - b.position).map((i) => ({ raw_text: cut(i.raw_text, 200), name: i.name || null, strength: i.strength || null,
          frequency: i.frequency || null, timing: i.timing || null, duration: i.duration || null, confidence: i.confidence || null,
          verification: i.confirmed ? "prescription_line_confirmed" : "prescription_line_unconfirmed" })) })) };
    },
  },
  {
    name: "search_documents", domain: "documents",
    description: "Find the person's medical documents by words in the title, provider or recorded test names, by type and by date. Returns details about each document (never the images).",
    keywords: ["document", "documents", "report", "reports", "upload", "uploaded", "file", "scan", "record", "records", "discharge", "imaging", "x-ray", "mri", "find"],
    input: { type: "object", properties: { query: { type: "string", maxLength: 80 }, category: { type: "string", enum: ["Lab report", "Prescription", "Imaging", "Other"] }, from: DATE, to: DATE, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } }, additionalProperties: false },
    output: "{ total, documents: [{ id, title, category, date, provider, pages, tests_recorded }] }",
    examples: [{ args: { category: "Lab report", from: "2024-11-01" } }, { args: { query: "thyroid" } }],
    async run({ db }, { query, category, from, to, limit = 20 }) {
      const filters = [];
      if (category) filters.push(["category", "eq", category]);
      const docs = await db.select("documents", { columns: "id,title,category,document_date,provider,page_count,fields", filters, order: "document_date.desc.nullslast" });
      const words = String(query || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
      const hit = docs.filter((d) => (!from || (d.document_date && d.document_date >= from)) && (!to || (d.document_date && d.document_date <= to)))
        .filter((d) => !words.length || words.every((w) => [d.title, d.provider, ...Object.keys(d.fields || {})].join(" ").toLowerCase().includes(w)));
      return { total: hit.length, documents: hit.slice(0, limit).map((d) => ({ id: d.id, title: cut(d.title, 160), category: d.category, date: d.document_date || null,
        provider: d.provider || null, pages: d.page_count, tests_recorded: d.category === "Lab report" ? Object.keys(d.fields || {}).length : undefined })) };
    },
  },
  {
    name: "get_lab_results", domain: "labs",
    description: "Every lab value in the person's reports, optionally for one test and period: value and unit as printed, reference range, the report's own flag, date, lab and document, and whether the person confirmed the value or it is an unconfirmed AI reading.",
    keywords: ["lab", "labs", "test", "tests", "result", "results", "blood test", "blood report", "value", "level", "levels", "cholesterol", "ldl", "hdl", "hba1c", "sugar", "glucose", "haemoglobin", "thyroid", "tsh", "vitamin", "creatinine", "cbc"],
    input: { type: "object", properties: { test: { type: "string", maxLength: 60 }, from: DATE, to: DATE }, additionalProperties: false },
    output: "{ count, results: [{ test, date, value_text, unit, reference_range, flag_printed, verification, source: { document_id, title, date, lab, page } }] }",
    examples: [{ args: { test: "hba1c", from: "2024-01-01" } }],
    async run({ db }, { test, from, to }) {
      const { obs } = await loadLabs(db);
      const r = obs.filter((o) => (!test || matchesQuery(o.key, [o.test], test)) && (!o.date || ((!from || o.date >= from) && (!to || o.date <= to))));
      return { count: r.length, results: r.map(({ key, unit_key, matched_by_alias, ...o }) => o) };
    },
  },
  {
    name: "compare_lab_results", domain: "labs",
    description: "How a test changed over time: values grouped by unit, compared only within the same unit, oldest to newest, with the difference between consecutive results, each report's own reference range, cautions (different labs, ranges, units), values that could not be compared, and lab reports in the period that do not include the test.",
    keywords: ["compare", "comparison", "trend", "change", "changed", "over time", "history", "progress", "went up", "went down", "cholesterol", "hba1c", "sugar", "lab", "blood test"],
    input: { type: "object", properties: { test: { type: "string", maxLength: 60, description: "Test name or part of it, e.g. 'ldl', 'cholesterol', 'hba1c'. Empty = every test." }, from: DATE, to: DATE }, additionalProperties: false },
    output: "{ series: [{ test, names_seen, groups: [{ unit, comparable, points: [...], changes: [{ from_date, to_date, from, to, difference, direction }], notes }], not_compared, undated, cautions, lab_reports_without_this_test, span }] }",
    examples: [
      { args: { test: "cholesterol", from: "2023-11-01" }, note: "'cholesterol' returns LDL, HDL and total cholesterol as SEPARATE series. 'direction' is arithmetic only (higher / lower), never better or worse." },
      { args: { test: "hba1c" }, note: "Values in different units (% vs mmol/mol) stay in separate groups and are never converted." },
    ],
    async run({ db }, { test = "", from, to }) {
      const { obs, labDocs } = await loadLabs(db);
      const series = compareSeries(obs, { test, from: from || null, to: to || null, labDocs });
      return { series, note: series.length ? undefined : "No lab values match. That means no record, not a normal result." };
    },
  },
  {
    name: "get_lab_timeline", domain: "labs",
    description: "All lab reports in date order with the tests and values each one contains, as printed.",
    keywords: ["timeline", "chronological", "all reports", "every test", "over the years", "history of tests"],
    input: { type: "object", properties: { from: DATE, to: DATE }, additionalProperties: false },
    output: "{ dated: [{ date, source, results: [...] }], undated: [...] }",
    examples: [{ args: { from: "2024-01-01" } }],
    async run({ db }, { from, to }) { const { obs } = await loadLabs(db); return timeline(obs, { from: from || null, to: to || null }); },
  },
  {
    name: "get_health_readings", domain: "readings",
    description: "Readings the person logged: blood pressure, glucose, weight, pulse, temperature, SpO2, with time and context.",
    keywords: ["reading", "readings", "blood pressure", "bp", "glucose", "sugar", "weight", "pulse", "heart rate", "temperature", "oxygen", "spo2", "home readings"],
    input: { type: "object", properties: { kind: { type: "string", maxLength: 30 }, from: DATE, to: DATE }, additionalProperties: false },
    output: "{ readings: [{ kind, value, value2, unit, context, measured_at, verification: 'self_measured' }] }",
    examples: [{ args: { kind: "blood_pressure", from: "2026-01-01" } }],
    async run({ db }, { kind, from, to }) {
      const filters = [];
      if (kind) filters.push(["kind", "eq", kind]);
      if (from) filters.push(["measured_at", "gte", from]);
      if (to) filters.push(["measured_at", "lte", to + "T23:59:59Z"]);
      const rows = await db.select("vital_readings", { columns: "kind,value,value2,unit,context,measured_at", filters, order: "measured_at.asc", limit: 500 });
      return { readings: rows.map((r) => ({ ...r, verification: "self_measured" })) };
    },
  },
  {
    name: "identify_missing_information", domain: "profile",
    description: "What is missing or unconfirmed: history questions not answered, lab values never confirmed by the person, documents without a date, current medicines without a recorded reason.",
    keywords: ["missing", "gaps", "incomplete", "unconfirmed", "what else", "complete my profile", "before my appointment"],
    input: { type: "object", properties: {}, additionalProperties: false },
    output: "{ unanswered: [...], documents_without_date, unconfirmed_lab_values, medicines_without_reason }",
    examples: [{ args: {} }],
    async run({ db }) {
      const [p, lab, meds] = await Promise.all([answers(db), loadLabs(db), db.select("medicines", { columns: "status,end_date,reason" })]);
      const a = (p && p.history_answers) || {};
      const t = today();
      return {
        unanswered: ["conditions", "past", "surgery", "hosp", "other", "allergies", "devices", "family", "meds_regular", "meds_occasional"].filter((k) => !a[k]),
        documents_without_date: lab.docs.filter((d) => !d.document_date).length,
        unconfirmed_lab_values: lab.obs.filter((o) => o.verification === "ai_extracted_unconfirmed").length,
        medicines_without_reason: meds.filter((m) => m.status !== "completed" && !(m.end_date && m.end_date < t) && !m.reason).length,
      };
    },
  },
  {
    name: "investigate_records", domain: "evidence",
    description: "The full evidence pipeline for one question about the person's own records: understands the question (everyday words to the lab tests and terms that may be relevant), searches structured results and the document text index together, links each lab value to the page it is written on where page text exists, keeps conflicting values side by side, lists what is missing, and says whether the evidence is sufficient. Returns citable evidence items (E1, E2, …) and factual lines; it does not interpret.",
    keywords: ["investigate", "evidence", "compare", "changed", "trend", "history", "how is my", "how are my", "kidney", "kidneys", "sugar", "cholesterol", "liver", "thyroid", "my reports", "my records", "find every mention", "first time", "summary"],
    input: { type: "object", properties: { question: { type: "string", maxLength: 500 }, from: DATE, to: DATE }, additionalProperties: false },
    output: "{ plan, sufficiency: { verdict, note }, series: [...lab groups with evidence ids], passages: [ids], conflicts, missing, lines: [factual sentences with [E#] citations], evidence: [{ id, kind, document_id, document_title, document_type, page, section, original_text, structured, date, verification, retrieval, relevance }], telemetry }",
    examples: [{ args: { question: "Compare my historical cholesterol results and show me how they have changed" }, note: "Build the reply only from `lines` and `evidence`, citing [E#]. If sufficiency is 'partial' or 'none', say so. Show every conflict. A difference is not a diagnosis." }],
    async run({ db }, { question, from, to }) {
      if (!question) throw new GatewayError("bad_args", "investigate_records needs a question.");
      return investigate({ db }, { question, from, to });
    },
  },
  {
    name: "search_medical_records", domain: "evidence",
    description: "Search the text of the person's documents (lab rows, prescription lines, diagnoses, page text) by words or phrases, ranked by contextual BM25 with everyday words expanded to the relevant terms. Returns passages with document, date, page and how sure the reading is.",
    keywords: ["search", "find", "mention", "mentioned", "written", "says", "word", "where", "documents say"],
    input: { type: "object", properties: { query: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 30, default: 10 } }, additionalProperties: false },
    output: "{ terms, results: [{ chunk_id, document_id, document_title, date, page, section, text, verification, score }] }",
    examples: [{ args: { query: "dyslipidaemia" } }],
    async run({ db }, { query, limit = 10 }) {
      const plan = understand(query || "");
      const [chunks, docs] = await Promise.all([db.select("document_chunks", { columns: "id,document_id,page,kind,section,parent_key,content,context,verification", limit: 3000 }).catch((e) => { if (e.code === "not_available") return null; throw e; }),
        db.select("documents", { columns: "id,title,document_date" })]);
      if (!chunks) return { terms: plan.terms, results: [], note: "The document index isn't available on this database yet." };
      const byId = new Map(docs.map((d) => [d.id, d]));
      return { terms: plan.terms, results: bm25(chunks, plan.terms.length ? plan.terms : [query || ""]).slice(0, limit).map((r) => ({ chunk_id: r.chunk.id, document_id: r.chunk.document_id,
        document_title: (byId.get(r.chunk.document_id) || {}).title || null, date: (byId.get(r.chunk.document_id) || {}).document_date || null, page: r.chunk.page ?? null, section: r.chunk.section,
        text: r.chunk.content, verification: r.chunk.verification, score: +r.score.toFixed(3), matched: r.matched })) };
    },
  },
  {
    name: "retrieve_source_evidence", domain: "evidence",
    description: "Open one evidence passage in its surroundings: the whole section or page it belongs to (all its sibling pieces in order), with the document's details, so a value can be read with its full table or page.",
    keywords: ["source", "original", "page", "open", "show me where", "context", "whole table"],
    input: { type: "object", properties: { chunk_id: { type: "string", pattern: "^[0-9a-f-]{36}$", description: "chunk_id from investigate_records or search_medical_records" } }, additionalProperties: false },
    output: "{ document: { id, title, type, date, provider }, section, page, pieces: [{ position, text, verification }] }",
    examples: [{ args: { chunk_id: "00000000-0000-4000-8000-000000000000" }, note: "Use only ids returned by the other evidence tools." }],
    async run({ db }, { chunk_id }) {
      if (!chunk_id) throw new GatewayError("bad_args", "retrieve_source_evidence needs a chunk_id.");
      const got = await db.select("document_chunks", { columns: "id,document_id,page,section,parent_key", filters: [["id", "eq", chunk_id]], limit: 1 }).catch((e) => { if (e.code === "not_available") return null; throw e; });
      if (!got) return { found: false, note: "The document index isn't available on this database yet." };
      const [c] = got;
      if (!c) return { found: false, note: "No such passage in this person's records." };
      const [sib, docs] = await Promise.all([db.select("document_chunks", { columns: "position,content,verification", filters: [["parent_key", "eq", c.parent_key]], order: "position.asc", limit: 200 }),
        db.select("documents", { columns: "id,title,category,document_date,provider", filters: [["id", "eq", c.document_id]], limit: 1 })]);
      const d = docs[0] || {};
      return { found: true, document: { id: d.id, title: d.title, type: d.category, date: d.document_date || null, provider: d.provider || null }, section: c.section, page: c.page ?? null,
        pieces: sib.map((x) => ({ position: x.position, text: x.content, verification: x.verification })) };
    },
  },
];

export const BY_NAME = new Map(CAPABILITIES.map((c) => [c.name, c]));

/** Validate arguments against a capability's small schema. Unknown keys, wrong types and bad dates are refused. */
export function validateArgs(cap, args) {
  if (args == null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new GatewayError("bad_args", `${cap.name}: arguments must be an object.`);
  const props = cap.input.properties || {};
  for (const k of Object.keys(args)) if (!props[k]) throw new GatewayError("bad_args", `${cap.name}: unknown argument "${k}". Allowed: ${Object.keys(props).join(", ") || "none"}.`);
  const out = {};
  for (const [k, s] of Object.entries(props)) {
    const v = args[k];
    if (v === undefined || v === null || v === "") continue;
    const bad = (why) => { throw new GatewayError("bad_args", `${cap.name}.${k}: ${why}`); };
    if (s.type === "string") {
      if (typeof v !== "string") bad("must be text");
      if (s.maxLength && v.length > s.maxLength) bad(`at most ${s.maxLength} characters`);
      if (s.enum && !s.enum.includes(v)) bad(`one of ${s.enum.join(", ")}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) bad(s.description || "wrong format");
      if (s.pattern === DATE.pattern && Number.isNaN(Date.parse(v))) bad("not a real date");
    } else if (s.type === "integer") {
      if (!Number.isInteger(v) || (s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum)) bad(`a whole number from ${s.minimum} to ${s.maximum}`);
    } else if (s.type === "array") {
      if (!Array.isArray(v) || v.length > (s.maxItems || 20)) bad("must be a short list");
      for (const x of v) if (s.items.enum && !s.items.enum.includes(x)) bad(`items must be ${s.items.enum.join(", ")}`);
    }
    out[k] = v;
  }
  if (out.from && out.to && out.from > out.to) throw new GatewayError("bad_args", `${cap.name}: 'from' is after 'to'.`);
  return out;
}

/** What discovery returns for one capability: enough to call it correctly, nothing executable. */
export const describe = (c, { examples = true } = {}) => ({ name: c.name, domain: c.domain, description: c.description, permission: "read",
  input: c.input, output: c.output, ...(examples ? { examples: c.examples } : {}) });

/** search_capabilities: rank by words of the request found in the name, keywords and description. */
export function searchCapabilities(query, { limit = 5 } = {}) {
  const q = String(query || "").toLowerCase().slice(0, 300);
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));
  const broad = BROAD.test(q);
  const scored = CAPABILITIES.map((c) => {
    let s = broad && BROAD_SET.has(c.name) ? 3 : 0;
    for (const k of c.keywords) if (q.includes(k)) s += k.includes(" ") ? 4 : 3;
    for (const w of words) { if (c.name.includes(w)) s += 2; if (c.description.toLowerCase().includes(w)) s += 1; }
    return { c, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name));
  return { query: q, capabilities: scored.slice(0, Math.min(Math.max(limit, 1), 10)).map((x) => describe(x.c)), total_capabilities: CAPABILITIES.length };
}
// Requests for a whole picture (an appointment, a summary, a specialist) need the core of the record, whatever words they use.
const BROAD = /summary|summarise|summarize|appointment|consultation|specialist|cardiolog|endocrinolog|nephrolog|neurolog|gynaecolog|gynecolog|oncolog|physician|my doctor|second opinion|complete history|everything|overview|referral/;
const BROAD_SET = new Set(["get_profile_summary", "get_medical_history", "get_medications", "get_allergies", "compare_lab_results", "identify_missing_information"]);
const STOP = new Set(["the", "my", "me", "and", "or", "of", "to", "in", "on", "for", "a", "an", "is", "are", "was", "all", "how", "what", "have", "has", "show", "over", "last", "with", "from", "any", "do", "did", "i", "it", "this", "that", "years", "year"]);
export { testKey };
