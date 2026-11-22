/**
 * Doctine · investigate_records: the medical evidence pipeline, for the signed-in person only.
 *
 *   understand → retrieve in parallel (structured lab observations · lexical search of the document index · metadata)
 *   → fuse (Reciprocal Rank Fusion) → assemble evidence (dedupe, link values to their page, keep conflicts, list gaps)
 *   → sufficiency verdict → compact evidence package + telemetry (counts and timings, never values).
 *
 * Structured records stay authoritative for values: a text piece never overrides a lab value; it adds where the value is
 * written (page) and what else the documents say. Semantic (vector) retrieval plugs in as another ranked list once an
 * embedding provider is chosen (see docs/EVIDENCE_ENGINE.md); until then it is reported as "not configured".
 */
import { understand } from "./query.mjs";
import { bm25, rrf, tokens } from "./rank.mjs";
import { observations, compareSeries, shadowedDisagreements, testKey, parseValue } from "../gateway/labs.mjs";
import { GatewayError } from "../gateway/db.mjs";

// Text that tries to instruct an AI. It stays in the person's records (it is their document) but is never used as
// evidence for an answer; the reply says a document contained instructions that were ignored.
export const INSTRUCTION_LIKE = /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,20}\b(instructions?|prompts?|rules)\b|\b(system prompt|admin mode|developer mode|you are now|act as (an? )?(admin|system)|reveal (the )?(prompt|secrets?|keys?))\b|\b(every|all|other) (patients?|users?)('s)? (records|results|data)\b/i;
const CHUNK_COLS = "id,document_id,page,kind,section,parent_key,position,content,context,verification";
const MAX_CHUNKS = 3000;

async function loadChunks(db, plan) {
  try {
    const rows = await db.select("document_chunks", { columns: CHUNK_COLS, limit: MAX_CHUNKS });
    if (rows.length < MAX_CHUNKS || !db.rpc) return { rows, mode: "all_own_pieces" };
    // very large record: let the database pick full-text candidates first
    return { rows: await db.rpc("search_document_chunks", { p_terms: plan.terms, p_limit: 500 }), mode: "database_candidates" };
  } catch (e) {
    if (e instanceof GatewayError && e.code === "not_available") return { rows: [], mode: "index_not_available" };
    throw e;
  }
}
const inRange = (d, { from, to }) => !d || ((!from || d >= from) && (!to || d <= to));

export async function investigate({ db }, { question, from, to, today, retrievers = ["structured", "lexical"] }) {
  const T = { start: Date.now() }, lap = (k) => { T[k] = Date.now() - T.start; };
  const plan = understand(question, { today });
  const range = { from: from || plan.dates.from, to: to || plan.dates.to };
  lap("understand_ms");

  const [docs, labRows, chunkRes] = await Promise.all([
    db.select("documents", { columns: "id,title,category,document_date,provider,page_count", order: "document_date.asc.nullslast" }),
    plan.needs.structured ? db.select("lab_results", { columns: "id,document_id,test,value,unit,reference_range,flag,confidence,origin" }) : [],
    plan.needs.text ? loadChunks(db, plan) : { rows: [], mode: "not_needed" },
  ]);
  lap("retrieve_ms");
  const docById = new Map(docs.map((d) => [d.id, d]));
  // documents.fields isn't fetched above for privacy of unrelated details; the confirmed values come with it here
  const labDocsFull = plan.needs.structured ? await db.select("documents", { columns: "id,title,category,document_date,provider,fields,page_count", filters: [["category", "eq", "Lab report"]] }) : [];

  // ---- structured channel: lab observations for the tests the question maps to ----
  const obs = observations(labDocsFull, labRows);
  const series = plan.tests.length ? compareSeries(obs, { from: range.from, to: range.to, labDocs: labDocsFull })
    .filter((s) => plan.tests.includes(s.test) || plan.tests.some((t) => s.names_seen.some((n) => testKey(n).key === t))) : [];
  const disagreements = shadowedDisagreements(labDocsFull, labRows).filter((d) => plan.tests.includes(d.test) && inRange(d.date, range));

  // ---- lexical channel: BM25 over the person's index pieces, one list per concept, fused ----
  const pieces = chunkRes.rows.filter((c) => { const d = docById.get(c.document_id); return d && inRange(d.document_date, range); });
  const lists = [];
  if (retrievers.includes("lexical") && pieces.length) {
    // one query per concept (multi-query), plus the person's own words as typed; each is a ranked list for fusion
    const conceptTerms = [...plan.concepts.map((c) => ({ name: "lexical:" + c.key, terms: c.terms })), ...(plan.words.length ? [{ name: "lexical:words", terms: plan.words }] : [])];
    for (const { name, terms } of conceptTerms) lists.push({ name, items: bm25(pieces, terms, { field: "contextual" }).slice(0, 60).map((r) => ({ key: r.chunk.id, chunk: r.chunk, matched: r.matched, score: r.score })) });
  }
  if (retrievers.includes("structured") && pieces.length && plan.tests.length) {
    // lab rows whose test is one the question maps to, newest first
    const rows = pieces.filter((c) => c.kind === "lab_row" && plan.tests.includes(testKey(c.content.split(":")[0]).key))
      .sort((a, b) => String(docById.get(b.document_id).document_date || "").localeCompare(String(docById.get(a.document_id).document_date || "")));
    lists.push({ name: "structured", items: rows.map((c) => ({ key: c.id, chunk: c, matched: ["test:" + testKey(c.content.split(":")[0]).key] })) });
  }
  if (retrievers.includes("semantic")) lists.push({ name: "semantic", items: [], note: "not configured" });
  const fused = rrf(lists);
  lap("rank_ms");

  // ---- evidence assembly ----
  const evidence = [];
  const pageOf = (docId, name, valueText) => {
    const n = parseValue(valueText).number, want = tokens(name).join(" ");
    const hit = pieces.find((c) => c.document_id === docId && c.kind === "page_text" && tokens(c.content).join(" ").includes(want) && (n == null || c.content.includes(String(n))));
    return hit ? { page: hit.page, passage: hit.content.split("\n").find((l) => tokens(l).join(" ").includes(want)) || null, chunk_id: hit.id } : null;
  };
  const cite = (item) => { item.id = "E" + (evidence.length + 1); evidence.push(item); return item.id; };
  const meta = (d) => ({ document_id: d.id, document_title: d.title, document_type: d.category, document_date: d.document_date || null, provider: d.provider || null });
  const represented = new Set();
  const seriesOut = series.map((s) => ({
    test: s.test, names_seen: s.names_seen, cautions: s.cautions, span: s.span,
    groups: s.groups.map((g) => ({ unit: g.unit, comparable: g.comparable, notes: g.notes,
      changes: g.changes.map((c) => ({ from_date: c.from_date, to_date: c.to_date, from: c.from, to: c.to, difference: c.difference, direction: c.direction })),
      points: g.points.map((p) => {
        represented.add(p.source.document_id + "|" + p.key);
        const d = docById.get(p.source.document_id) || { id: p.source.document_id, title: p.source.title, document_date: p.date };
        const pg = pageOf(d.id, p.test, p.value_text);
        return { evidence: cite({ kind: "observation", ...meta(d), page: pg ? pg.page : null, section: "Lab results", original_text: pg && pg.passage ? pg.passage : `${p.test}: ${p.value_text}`,
          structured: { test: p.test, value: p.number, value_text: p.value_text, unit: p.unit || null, reference_range: p.reference_range, flag_printed: p.flag_printed },
          date: p.date, verification: p.verification, retrieval: ["structured"].concat(pg ? ["page_link"] : []) }), date: p.date, value: p.number, value_text: p.value_text };
      }) })),
    not_compared: s.not_compared.map((p) => ({ evidence: cite({ kind: "observation", ...meta(docById.get(p.source.document_id) || { id: p.source.document_id, title: p.source.title }), page: null, section: "Lab results",
      original_text: `${p.test}: ${p.value_text}`, structured: { test: p.test, value_text: p.value_text, unit: p.unit || null, reference_range: p.reference_range }, date: p.date, verification: p.verification,
      retrieval: ["structured"], not_compared_because: p.why }), date: p.date, value_text: p.value_text, why: p.why })),
    undated: s.undated.map((p) => ({ evidence: cite({ kind: "observation", ...meta(docById.get(p.source.document_id) || { id: p.source.document_id, title: p.source.title }), page: null, section: "Lab results",
      original_text: `${p.test}: ${p.value_text}`, structured: { test: p.test, value_text: p.value_text, unit: p.unit || null, reference_range: p.reference_range }, date: null, verification: p.verification,
      retrieval: ["structured"], not_compared_because: "the report's date is not known" }), document_title: p.source.title, value_text: p.value_text })),
    lab_reports_without_this_test: s.lab_reports_without_this_test,
  }));
  const text = [], ignored = new Set();
  for (const f of fused) {
    if (text.length >= plan.budget.text) break;
    const c = f.item.chunk, d = docById.get(c.document_id);
    if (INSTRUCTION_LIKE.test(c.content)) { ignored.add(d.title); continue; }
    if (c.kind === "lab_row" && represented.has(c.document_id + "|" + testKey(c.content.split(":")[0]).key)) continue;   // already an observation
    text.push(cite({ kind: "passage", ...meta(d), page: c.page ?? null, section: c.section, original_text: c.content, date: d.document_date || null,
      verification: c.verification, retrieval: Object.keys(f.ranks), relevance: +f.score.toFixed(4), matched_terms: [...new Set(lists.flatMap((l) => l.items.filter((i) => i.key === f.key).flatMap((i) => i.matched || [])))],
      chunk_id: c.id, parent_key: c.parent_key }));
  }
  // conflicts are shown, never resolved by rank
  const conflicts = [];
  for (const s of series) for (const g of s.groups) {
    const byDate = new Map();
    for (const p of g.points) { const k = p.date; if (!byDate.has(k)) byDate.set(k, []); byDate.get(k).push(p); }
    for (const [date, ps] of byDate) if (new Set(ps.map((p) => p.number)).size > 1)
      conflicts.push({ test: s.test, date, values: ps.map((p) => ({ value_text: p.value_text, document_title: p.source.title, verification: p.verification })), note: "Different values on the same date in different documents." });
  }
  for (const d of disagreements) conflicts.push({ test: d.test, date: d.date, values: [{ value_text: d.confirmed, verification: "confirmed_by_person" }, { value_text: d.ai_reading, verification: "ai_extracted_unconfirmed" }],
    document_title: (docById.get(d.document_id) || {}).title, note: "The AI reading of this report differs from the value the person confirmed; the confirmed value is used." });

  // ---- what is missing, and is the evidence enough? ----
  const found = new Set(series.map((s) => s.test));
  const missing = [];
  for (const t of plan.tests) if (!found.has(t)) missing.push({ what: t, why: "no result recorded in the period asked about" });
  for (const s of seriesOut) if (s.lab_reports_without_this_test.length) missing.push({ what: s.test, why: `not in ${s.lab_reports_without_this_test.length} lab report(s) of the period`, reports: s.lab_reports_without_this_test.map((r) => r.date) });
  if (chunkRes.mode === "index_not_available") missing.push({ what: "document text", why: "the document index isn't available on this database yet; only structured results were searched" });
  const unsearchable = docs.filter((d) => !chunkRes.rows.some((c) => c.document_id === d.id) && inRange(d.document_date, range));
  if (chunkRes.mode !== "index_not_available" && unsearchable.length) missing.push({ what: "documents without searchable text", why: `${unsearchable.length} document(s) have no readable text or results`, documents: unsearchable.map((d) => d.title).slice(0, 10) });
  if (ignored.size) missing.push({ what: "text that tried to give instructions", why: "left out of the evidence; treated as document data, never as instructions", documents: [...ignored] });
  const comparable = seriesOut.filter((s) => s.groups.some((g) => g.points.length >= 2));
  const sufficiency = plan.strategy === "general_knowledge" ? { verdict: "not_record_question", note: "This asks what something means; no personal record is needed. Keep general knowledge separate from the person's records." }
    : plan.intent === "compare" ? (comparable.length ? { verdict: comparable.length === seriesOut.length && !conflicts.length ? "sufficient" : "partial",
        note: `${comparable.length} of ${seriesOut.length} test(s) found have two or more comparable results${conflicts.length ? `; ${conflicts.length} conflict(s) to show` : ""}.${plan.tests.filter((t) => !found.has(t)).length ? ` Not recorded: ${plan.tests.filter((t) => !found.has(t)).join(", ")}.` : ""}` }
      : seriesOut.length ? { verdict: "partial", note: "Results were found but not two comparable ones for any test." } : { verdict: "none", note: "No matching results were found. That is not a normal result: it means nothing was recorded." })
    : (evidence.length ? { verdict: "found", note: `${evidence.length} evidence item(s).` } : { verdict: "none", note: "Nothing relevant was found in the person's records." });

  // ---- factual lines with citations (no interpretation): what a reply must be built from ----
  const lines = [];
  for (const s of seriesOut) for (const g of s.groups) if (g.points.length) {
    lines.push(`${s.test}${g.unit ? ` (${g.unit})` : ""}: ` + g.points.map((p) => `${p.value}${g.unit ? " " + g.unit : ""} on ${p.date} [${p.evidence}]`).join("; ") + ".");
    if (g.changes.length) { const a = g.points[0], z = g.points.at(-1); lines.push(`  From ${a.date} to ${z.date}: ${z.value - a.value > 0 ? "higher" : z.value - a.value < 0 ? "lower" : "the same"} by ${Math.abs(+(z.value - a.value).toFixed(4))}${g.unit ? " " + g.unit : ""} across ${g.points.length} results.`); }
    for (const n of g.notes) lines.push("  Note: " + n);
  }
  lap("assemble_ms");
  return {
    question: plan.question, plan: { intent: plan.intent, strategy: plan.strategy, concepts: plan.concepts.map(({ key, label }) => ({ key, label })), tests: plan.tests, terms: plan.terms.slice(0, 12), dates: range },
    sufficiency, series: seriesOut, passages: text, conflicts, missing, lines, evidence,
    scope: "the signed-in person's own records only (row security)",
    telemetry: { ...T, start: undefined, documents: docs.length, instruction_like_ignored: ignored.size, pieces_searched: pieces.length, index_mode: chunkRes.mode,
      lists: lists.map((l) => ({ name: l.name, candidates: l.items.length, note: l.note })), fused: fused.length, evidence_items: evidence.length, structured_series: seriesOut.length },
  };
}
