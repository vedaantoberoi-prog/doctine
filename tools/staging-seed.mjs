/**
 * Doctine · SQL that creates two FICTIONAL test accounts on STAGING with invented health records, for testing the
 * gateway against the real database: real tables, real constraints, the real extraction trigger, real row security.
 * Never run against production. Accounts have no password (nobody can sign in) and are marked fictional.
 * Idempotent: running it again replaces these two accounts' rows only.  Usage: node tools/staging-seed.mjs > seed.sql
 */
import { makeRecords } from "../tests/fixtures/fictional-health.mjs";

export const FICTIONAL = [
  { uid: "f1c70000-0000-4000-8000-00000000000a", email: "fictional-a@example.test", name: "Fictional Test Patient A", reports: 10, seed: 11 },
  { uid: "f1c70000-0000-4000-8000-00000000000b", email: "fictional-b@example.test", name: "Fictional Test Patient B", reports: 4, seed: 99 },
];
const L = (v) => (v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const J = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

export function seedSql() {
  const out = ["-- FICTIONAL staging test data. Not for production.", "begin;"];
  for (const p of FICTIONAL) {
    const d = makeRecords({ uid: p.uid, reports: p.reports, seed: p.seed });
    out.push(`delete from auth.users where id = ${L(p.uid)};`);   // cascades to every health table
    out.push(`insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at, raw_user_meta_data, raw_app_meta_data) values (${L(p.uid)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${L(p.email)}, now(), now(), ${J({ name: p.name, fictional: true })}, ${J({ provider: "email", providers: ["email"], fictional_test_account: true })});`);
    const h = d.health_profiles[0];
    out.push(`insert into public.health_profiles (user_id, full_name, date_of_birth, sex_at_birth, gender, blood_group, height_cm, weight_kg, phone, contact_email, emergency_name, emergency_phone, history_answers) values (${L(p.uid)}, ${L(p.name)}, ${L(h.date_of_birth)}, ${L(h.sex_at_birth)}, ${L(h.gender)}, ${L(h.blood_group)}, ${h.height_cm}, ${h.weight_kg}, ${L(h.phone)}, ${L(h.contact_email)}, ${L(h.emergency_name)}, ${L(h.emergency_phone)}, ${J(h.history_answers)});`);
    d.documents.forEach((doc, i) => {
      // AI-only reports go in as an extraction, so the real trigger builds lab_results from it
      const labs = d.lab_results.filter((l) => l.document_id === doc.id).map((l) => ({ test: l.test, value: l.value, unit: l.unit, range: l.reference_range, flag: l.flag, confidence: l.confidence }));
      const extraction = labs.length ? { kind: "lab_report", lab_results: labs } : null;
      out.push(`insert into public.documents (user_id, client_id, title, category, document_date, provider, source, fields, extraction, page_count) values (${L(p.uid)}, ${1000 + i}, ${L(doc.title)}, ${L(doc.category)}, ${L(doc.document_date)}, ${L(doc.provider)}, 'scan', ${J(doc.fields)}, ${extraction ? J(extraction) : "null"}, ${doc.page_count});`);
    });
    // a prescription document whose AI reading the trigger turns into a prescription with one unconfirmed line
    out.push(`insert into public.documents (user_id, client_id, title, category, document_date, provider, source, extraction, page_count) values (${L(p.uid)}, 2000, 'Prescription – Dr. Imaginary – 1 Feb 2024', 'Prescription', '2024-02-01', 'Fictional Clinic', 'scan', ${J({ kind: "prescription", doctor: "Dr. Imaginary", facility: "Fictional Clinic", medicines: [{ raw: "Tab Atorvas 10 HS x 1/12", name: "Atorvastatin", strength: "10 mg", frequency: "HS", duration: "1 month", confidence: "medium" }] })}, 1);`);
    d.health_records.forEach((r, i) => out.push(`insert into public.health_records (user_id, client_id, kind, title, status, category, severity, certainty, onset, details, source) values (${L(p.uid)}, ${3000 + i}, ${L(r.kind)}, ${L(r.title)}, ${L(r.status)}, ${L(r.category)}, ${L(r.severity)}, ${L(r.certainty)}, ${L(r.onset)}, ${J(r.details)}, ${L(r.source)});`));
    d.medicines.forEach((m, i) => out.push(`insert into public.medicines (user_id, client_id, name, brand, strength, dose, category, status, start_date, end_date, reason, stop_reason, stopped_on_advice, prescriber) values (${L(p.uid)}, ${4000 + i}, ${L(m.name)}, ${L(m.brand)}, ${L(m.strength)}, ${L(m.dose)}, ${L(m.category)}, ${L(m.status)}, ${L(m.start_date)}, ${L(m.end_date)}, ${L(m.reason)}, ${L(m.stop_reason)}, ${L(m.stopped_on_advice)}, ${L(m.prescriber)});`));
  }
  out.push("commit;");
  return out.join("\n");
}
if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(seedSql() + "\n");
