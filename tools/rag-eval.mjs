/**
 * Doctine · retrieval evaluation on the FICTIONAL corpus (tests/fixtures/rag-corpus.mjs), indexed by the real database
 * code (tools/rag-eval-db.sh). Compares retrieval set-ups on the same questions and hand-labelled relevance:
 *   A  naive keyword match on the raw question        B  BM25 on the original text, raw question
 *   C  contextual BM25 (context line + text), raw question
 *   D  C + query understanding (everyday words → tests and terms), one query per concept, fused by RRF, date filter
 *   F  D + the structured channel (lab rows of the mapped tests) fused by RRF
 *   E  the full investigate_records pipeline (structured evidence first, then passages)
 *   Vector set-ups: NOT RUN (no embedding provider configured; see docs/EVIDENCE_ENGINE.md).
 * Metrics per set-up, averaged over questions: Recall@5, Recall@10, Precision@5, MRR, nDCG@10 (graded 2/1).
 * Then the proof-of-concept question is run end to end with checks.  Usage: node tools/rag-eval.mjs <dir> [--md out.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { QRELS } from "../tests/fixtures/rag-corpus.mjs";
import { bm25, rrf, tokens } from "../netlify/lib/evidence/rank.mjs";
import { understand } from "../netlify/lib/evidence/query.mjs";
import { investigate } from "../netlify/lib/evidence/investigate.mjs";
import { testKey } from "../netlify/lib/gateway/labs.mjs";

const dir = process.argv[2];
const A = JSON.parse(readFileSync(`${dir}/person-a1.json`, "utf8")), B = JSON.parse(readFileSync(`${dir}/person-b2.json`, "utf8"));
const TODAY = "2026-11-23";
const clientOf = new Map(A.documents.map((d) => [d.id, d.client_id])), dateOf = new Map(A.documents.map((d) => [d.id, d.document_date]));

/** The person's rows behind the same select() interface the gateway uses (row security already applied in the dump). */
function jsonDb(data) {
  let calls = 0;
  return { select: async (table, { filters = [], limit = 1000 } = {}) => {
    calls++; let rows = data[table] || [];
    for (const [c, op, v] of filters) rows = rows.filter((r) => (op === "eq" ? String(r[c]) === String(v) : op === "in" ? [].concat(v).includes(r[c]) : true));
    return rows.slice(0, limit);
  }, stats: () => ({ calls }) };
}
const STOP = new Set(["my", "the", "and", "how", "what", "was", "are", "is", "in", "of", "me", "show", "have", "they", "when", "where", "with", "results", "result", "records"]);
const raw = (q) => tokens(q).filter((t) => t.length >= 2 && !STOP.has(t));
const docOrder = (chunks) => { const out = []; for (const c of chunks) if (!out.includes(c.document_id)) out.push(c.document_id); return out.map((id) => clientOf.get(id)); };

const SETUPS = {
  A: (q) => docOrder(A.document_chunks.map((c) => ({ c, s: raw(q).filter((w) => c.content.toLowerCase().includes(w)).length })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).map((x) => x.c)),
  B: (q) => docOrder(bm25(A.document_chunks, raw(q), { field: "content" }).map((r) => r.chunk)),
  C: (q) => docOrder(bm25(A.document_chunks, raw(q), { field: "contextual" }).map((r) => r.chunk)),
  D: (q) => docOrder(fuse(q, false)),
  F: (q) => docOrder(fuse(q, true)),
};
function fuse(q, structured) {
  const plan = understand(q, { today: TODAY });
  const pool = A.document_chunks.filter((c) => { const d = dateOf.get(c.document_id); return !plan.dates.from || (d && d >= plan.dates.from && d <= plan.dates.to); });
  const lists = [...plan.concepts.map((c) => ({ name: c.key, items: bm25(pool, c.terms).map((r) => ({ key: r.chunk.id, chunk: r.chunk })) })),
    ...(plan.words.length ? [{ name: "words", items: bm25(pool, plan.words).map((r) => ({ key: r.chunk.id, chunk: r.chunk })) }] : [])];
  if (structured && plan.tests.length) lists.push({ name: "structured", items: pool.filter((c) => c.kind === "lab_row" && plan.tests.includes(testKey(c.content.split(":")[0]).key))
    .sort((a, b) => String(dateOf.get(b.document_id) || "").localeCompare(String(dateOf.get(a.document_id) || ""))).map((c) => ({ key: c.id, chunk: c })) });
  return rrf(lists).map((f) => f.item.chunk);
}
async function setupE(q) {
  const r = await investigate({ db: jsonDb(A) }, { question: q, today: TODAY });
  const out = []; for (const e of r.evidence) { const c = clientOf.get(e.document_id); if (!out.includes(c)) out.push(c); }
  return out;
}

function metrics(ranked, rel) {
  const R = Object.keys(rel).map(Number), g = (c) => rel[c] || 0;
  const recall = (k) => R.filter((c) => ranked.slice(0, k).includes(c)).length / R.length;
  const p5 = ranked.slice(0, 5).filter((c) => g(c) > 0).length / 5;
  const first = ranked.findIndex((c) => g(c) > 0), mrr = first < 0 ? 0 : 1 / (first + 1);
  const dcg = ranked.slice(0, 10).reduce((s, c, i) => s + (2 ** g(c) - 1) / Math.log2(i + 2), 0);
  const ideal = R.map(g).sort((a, b) => b - a).slice(0, 10).reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
  return { r5: recall(5), r10: recall(10), p5, mrr, ndcg: ideal ? dcg / ideal : 0 };
}

const table = {}, perQ = {};
for (const name of [...Object.keys(SETUPS), "E"]) {
  const ms = [];
  for (const { id, q, rel } of QRELS) {
    const ranked = name === "E" ? await setupE(q) : SETUPS[name](q);
    const m = metrics(ranked, rel); ms.push(m); (perQ[id] ||= {})[name] = m.r10;
  }
  table[name] = Object.fromEntries(["r5", "r10", "p5", "mrr", "ndcg"].map((k) => [k, ms.reduce((s, m) => s + m[k], 0) / ms.length]));
}
const f2 = (x) => x.toFixed(2);
const LABEL = { A: "A naive keyword", B: "B BM25", C: "C contextual BM25", D: "D + query understanding, multi-query RRF", F: "F + structured channel", E: "E investigate_records pipeline" };
const lines = ["| Set-up | Recall@5 | Recall@10 | Precision@5 | MRR | nDCG@10 |", "|---|---|---|---|---|---|"];
for (const [k, v] of Object.entries(table)) lines.push(`| ${LABEL[k]} | ${f2(v.r5)} | ${f2(v.r10)} | ${f2(v.p5)} | ${f2(v.mrr)} | ${f2(v.ndcg)} |`);
lines.push("| Vector and hybrid-with-vector set-ups | not run | | | | |");
const qlines = ["| Question | Scenario | " + Object.keys(LABEL).join(" | ") + " |", "|---|---|" + Object.keys(LABEL).map(() => "---").join("|") + "|"];
for (const { id, q, scenario } of QRELS) qlines.push(`| ${id} ${q} | ${scenario} | ` + Object.keys(LABEL).map((k) => f2(perQ[id][k])).join(" | ") + " |");
console.log("Retrieval quality (averaged over " + QRELS.length + " questions)\n" + lines.join("\n") + "\n\nRecall@10 per question\n" + qlines.join("\n"));

// ---- the proof-of-concept question, end to end ----
const poc = await investigate({ db: jsonDb(A) }, { question: "Compare my historical cholesterol results and show me how they have changed", today: TODAY });
const checks = [];
const ok = (c, w) => checks.push([!!c, w]);
const ser = (t) => poc.series.find((s) => s.test === t);
const ldl = ser("ldl cholesterol"), tc = ser("total cholesterol"), hdl = ser("hdl cholesterol");
ok(poc.plan.intent === "compare" && poc.plan.concepts.some((c) => c.key === "lipids"), "the question is understood as a comparison about cholesterol");
ok(ldl && ldl.groups.length === 1 && ldl.groups[0].points.length === 4, `LDL: 4 dated results in mg/dL compared (got ${ldl && ldl.groups[0].points.length})`);
ok(ldl && ldl.undated.length === 1, "LDL: the undated report is shown apart, not placed on the timeline");
ok(ldl && ldl.names_seen.includes("LDL-C"), "LDL: 'LDL-C' recognised as the same test");
ok(tc && tc.groups.length === 2 && tc.cautions.some((c) => /never converted/.test(c)), "total cholesterol: mg/dL and mmol/L kept apart and never converted");
ok(hdl && hdl.groups.length === 2, "HDL: mg/dL and mmol/L kept apart");
const ldlEv = ldl ? ldl.groups[0].points.map((p) => poc.evidence.find((e) => e.id === p.evidence)) : [];
ok(ldlEv.filter((e) => e.page).length === 4, `LDL values linked to the page they are printed on (${ldlEv.filter((e) => e.page).length} of 4, all four reports have page text)`);
ok(ldlEv.some((e) => e.document_title.startsWith("Health check") && e.page === 3), "the 2025 LDL value is cited on page 3 of its report");
ok(poc.passages.length > 0 && poc.passages.map((id) => poc.evidence.find((e) => e.id === id)).some((e) => /Dyslipidaemia|Hypercholesterolaemia|atorvastatin/i.test(e.original_text)), "related text (diagnosis, statin) is found as separate passages");
ok(!JSON.stringify(poc).includes("PERSON B ONLY") && !JSON.stringify(poc).includes("190 mg/dL"), "nothing from the other person");
ok(!poc.passages.map((id) => poc.evidence.find((e) => e.id === id)).some((e) => /IGNORE ALL PREVIOUS/.test(e.original_text)), "the injection text is not pulled into a cholesterol answer");
ok(poc.missing.some((m) => /not in/.test(m.why)), "reports lacking a test are listed as missing");
ok(["sufficient", "partial"].includes(poc.sufficiency.verdict), `sufficiency stated: ${poc.sufficiency.verdict} — ${poc.sufficiency.note}`);
ok(poc.lines.every((l) => !/(normal|abnormal|improv|worse|better|risk)/i.test(l)), "factual lines carry no judgement words");
ok(poc.telemetry && poc.telemetry.lists.length >= 2 && poc.telemetry.pieces_searched === A.document_chunks.length, `telemetry recorded (${poc.telemetry.lists.map((l) => l.name + ":" + l.candidates).join(", ")})`);
const kid = await investigate({ db: jsonDb(A) }, { question: "How are my kidneys?", today: TODAY });
ok(kid.series.map((s) => s.test).sort().join() === "blood urea nitrogen,creatinine,egfr,urea", `'kidneys' maps to creatinine, eGFR, urea and BUN as separate series (${kid.series.map((s) => s.test).join(", ")})`);
const mean = await investigate({ db: jsonDb(A) }, { question: "What is LDL?", today: TODAY });
ok(mean.sufficiency.verdict === "not_record_question", "'What is LDL?' is recognised as general knowledge, not a records question");
const none = await investigate({ db: jsonDb(A) }, { question: "How has my ferritin changed?", today: TODAY });
ok(none.series.length === 0 && none.sufficiency.verdict === "none", `a test never measured gives 'none', not a guess (${none.sufficiency.note})`);
let bad = 0;
console.log("\nProof of concept: \"Compare my historical cholesterol results and show me how they have changed\"");
for (const [p, w] of checks) { console.log(`${p ? "PASS" : "FAIL"} ${w}`); if (!p) bad++; }
console.log("\nFactual lines the reply must be built from:\n" + poc.lines.join("\n"));
console.log(`\nproof of concept: ${checks.length - bad} passed, ${bad} failed`);
const i = process.argv.indexOf("--md");
if (i > 0) writeFileSync(process.argv[i + 1], `# Evidence retrieval evaluation (fictional corpus)\n\nGenerated by \`tools/rag-eval-db.sh\` + \`node tools/rag-eval.mjs\` on ${TODAY}. ${A.documents.length} documents, ${A.document_chunks.length} index pieces built by the real database code; ${QRELS.length} questions with hand-labelled graded relevance (2 = answers it, 1 = useful context). Document-level metrics.\n\n${lines.join("\n")}\n\n## Recall@10 per question\n\n${qlines.join("\n")}\n\n## Proof of concept\n\n${checks.map(([p, w]) => `- ${p ? "PASS" : "FAIL"} ${w}`).join("\n")}\n\nFactual lines:\n\n\`\`\`\n${poc.lines.join("\n")}\n\`\`\`\n`);
if (bad) process.exit(1);
