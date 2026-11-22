/**
 * Doctine · replays the cholesterol workflow of /api/assist on rows read from the STAGING database as the fictional
 * account A (row security on, rolled-back transaction). Input: a compact JSON of those rows (documents D, AI lab rows L,
 * non-lab index pieces C); the 38 lab-row index pieces are rebuilt in the trigger's own format. Stand-in model, no cost.
 *   node tools/staging-assist-replay.mjs <staging-a.json>
 */
import { readFileSync } from "node:fs";
import { fakeSupabase } from "../tests/fixtures/fictional-health.mjs";
import handler from "../netlify/functions/assist.mjs";
import { createBudget, createTtlStore } from "../netlify/lib/orchestrator/budget.mjs";

const UID = "f1c70000-0000-4000-8000-00000000000a", T = "staging-replay-token";
const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
const did = (i) => `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
let n = 0; const cid = () => `c0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const documents = raw.D.map(([i, t, c, date, prov, fields, pages]) => ({ id: did(i), user_id: UID, title: t.replace(/^~/, "Lipid and sugar profile – "), category: c === "L" ? "Lab report" : "Prescription", document_date: date, provider: prov, fields, page_count: pages }));
const lab_results = raw.L.map(([i, test, value, unit, range, conf], k) => ({ id: cid(), user_id: UID, document_id: did(i), test, value, unit, reference_range: range, flag: "", confidence: conf === "h" ? "high" : "medium", origin: "ai_extracted" }));
const document_chunks = [];
for (const d of documents) Object.entries(d.fields).forEach(([k, v]) => document_chunks.push({ id: cid(), user_id: UID, document_id: d.id, page: null, kind: "lab_row", section: "Lab results (confirmed by the person)", parent_key: d.id + ":confirmed", position: 1, content: `${k}: ${v}`, context: "", verification: "confirmed_by_person" }));
for (const l of lab_results) if (!Object.keys(documents.find((d) => d.id === l.document_id).fields).map((k) => k.toLowerCase()).includes(l.test.toLowerCase()))
  document_chunks.push({ id: cid(), user_id: UID, document_id: l.document_id, page: null, kind: "lab_row", section: "Lab results (AI reading, unconfirmed)", parent_key: l.document_id + ":ai_labs", position: 2, content: `${l.test}: ${l.value} ${l.unit} (reference ${l.reference_range})`, context: "", verification: "ai_extracted_unconfirmed" });
for (const [i, kind, content] of raw.C) document_chunks.push({ id: cid(), user_id: UID, document_id: did(i), page: null, kind, section: "Prescription lines", parent_key: did(i) + ":ai_meds", position: 3, content, context: "", verification: "ai_extracted_unconfirmed" });

async function run(consents, label) {
  const sb = fakeSupabase({ people: { [T]: { uid: UID, data: { documents, lab_results, document_chunks, consents } } } });
  const req = new Request("https://staging.test/api/assist", { method: "POST", headers: { authorization: "Bearer " + T }, body: JSON.stringify({ message: "compare my cholesterol levels over the last two years and explain what changed", share_records: true }) });
  const provider = { name: "stand-in", configured: true, calls: 0, async call(model, r) { this.calls++; const p = JSON.parse(r.messages[0].content).evidence_package; const e = p.evidence.filter((x) => /^ldl/i.test(x.test || "") && x.date); return { input: { explanation: `LDL readings in this period start at ${e[0].value.split(" ")[0]} mg/dL [${e[0].id}] and end at ${e.at(-1).value.split(" ")[0]} mg/dL [${e.at(-1).id}].`, cited: [e[0].id, e.at(-1).id] }, usage: { input_tokens: 2000, output_tokens: 100 } }; } };
  const res = await handler(req, {}, { env: { SUPABASE_URL: sb.base, SUPABASE_ANON_KEY: sb.anon }, fetchImpl: sb.fetchImpl, provider, log: () => {}, stores: { budget: createBudget(), cache: createTtlStore(), idem: createTtlStore() }, today: "2026-11-23" });
  const j = await res.json();
  console.log(`\n== ${label}: HTTP ${res.status} · ${j.state} · ${j.answer && (j.answer.code || j.answer.kind)} · route ${j.route && j.route.category}${j.route && j.route.degraded ? " (" + j.route.degraded + ")" : ""} · model calls ${provider.calls}`);
  console.log("   path: " + j.trace.path.join(" → "));
  if (j.answer && j.answer.kind === "records") console.log(j.answer.text.split("\n").map((l) => "   | " + l).join("\n"));
  return j;
}
const a = await run([], "as staging is now (no consent row for the account)");
const b = await run([{ user_id: UID, kind: "ai_chat", granted: true, updated_at: "2026-11-22T10:00:00Z" }], "with ai_chat consent given");
const ok = a.answer.code === "consent_required" && b.answer.kind === "records" && !/IGNORE ALL/.test(JSON.stringify(b.answer)) && b.trace.path.at(-1) === "COMPLETED";
console.log(ok ? "\nstaging replay: as expected" : "\nstaging replay: UNEXPECTED"); process.exit(ok ? 0 : 1);
