/**
 * Doctine · what goes to the model, and what may come back.
 *
 * minimiseEvidence(): the evidence package the model sees. Only what an explanation needs: evidence id, kind, test,
 * value as printed, unit, range, date, document type, page and how sure the reading is. No document titles (they can
 * hold names or planted instructions), no account ids, no profile; contact details and long digit runs are masked.
 *
 * validateExplanation(): checks the model's structured output before anyone sees it. Shape and lengths; every [E#]
 * cited exists; every number written is in the evidence (or the question); no diagnosis claims, no advice to start,
 * stop or change a medicine, no contact details or ids. Any violation means the output is rejected, never shown.
 */
const MASK = [[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"], [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]"],
  [/(\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, "[phone]"], [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "[number]"]];
export const mask = (s) => MASK.reduce((t, [re, r]) => t.replace(re, r), String(s ?? ""));

export function minimiseEvidence(inv) {
  return {
    question_intent: inv.plan.intent, period: inv.plan.dates, sufficiency: inv.sufficiency,
    evidence: inv.evidence.map((e) => ({ id: e.id, kind: e.kind, document_type: e.document_type, date: e.date, page: e.page, verification: e.verification,
      ...(e.structured ? { test: e.structured.test, value: e.structured.value_text, unit: e.structured.unit, reference_range: e.structured.reference_range || null } : { text: mask(e.original_text).slice(0, 400) }),
      ...(e.not_compared_because ? { not_compared_because: e.not_compared_because } : {}) })),
    facts: inv.lines.map(mask), conflicts: inv.conflicts.map((c) => ({ test: c.test, date: c.date, values: c.values.map((v) => v.value_text), note: c.note })),
    duplicates: (inv.duplicates || []).map((d) => ({ test: d.test, date: d.date, value: d.value_text })),
    missing: inv.missing.map((m) => ({ what: m.what, why: m.why })),
  };
}

export const EXPLAIN_TOOL = {
  name: "explain_records",
  description: "Return the explanation of the person's records evidence. Facts and values are shown to the person by Doctine itself; you write only the explanation.",
  input_schema: { type: "object", additionalProperties: false, required: ["explanation", "cited"], properties: {
    explanation: { type: "string", maxLength: 1500, description: "Plain-language explanation citing [E#] for each statement about their records." },
    cited: { type: "array", maxItems: 40, items: { type: "string", pattern: "^E\\d+$" } },
    general_knowledge: { type: "string", maxLength: 800, description: "General medical knowledge, clearly not about their records. Optional." },
    doctor_questions: { type: "array", maxItems: 4, items: { type: "string", maxLength: 200 } },
  } },
};

const DIAGNOSIS = /\b(you (have|are suffering from|are diagnosed with|definitely have)|this (means|confirms|shows) (that )?you have|you('re| are) (diabetic|hypertensive|pre-?diabetic))\b/i;
const MED_ADVICE = /\b(you should|you can|you could|you may want to|i (would )?(recommend|suggest)|try to|it'?s (best|fine|ok(ay)?) to|go ahead and)\b[^.?!]{0,50}\b(stop|start|increase|decrease|reduce|double|halve|skip|switch|taper|discontinue)\b[^.?!]{0,40}\b(medicines?|medications?|dose|dosage|tablets?|pills?|statins?|atorvastatin|rosuvastatin|insulin|metformin|levothyroxine|treatment)\b/i;
const NUM = /(?<![A-Za-z#])\d+(?:[.,]\d+)?/g;
const ALWAYS_OK = new Set(["112", "14416", "108"]);

function allowedNumbers(inv, question) {
  const pool = new Set();
  const add = (s) => { for (const m of String(s ?? "").matchAll(NUM)) { pool.add(m[0]); pool.add(m[0].replace(",", ".")); pool.add(String(+m[0].replace(",", "."))); } };
  add(question);
  for (const e of inv.evidence) { add(e.original_text); add(e.date); add(e.page); if (e.structured) { add(e.structured.value_text); add(e.structured.value); add(e.structured.reference_range); add(e.structured.unit); } }
  for (const l of inv.lines) add(l);
  for (const c of inv.conflicts) add(JSON.stringify(c.values));
  for (const m of inv.missing) add(JSON.stringify(m));
  if (inv.plan && inv.plan.dates) { add(inv.plan.dates.from); add(inv.plan.dates.to); }
  add(inv.series.length); add(inv.evidence.length);
  return pool;
}

export function validateExplanation(out, inv, { question = "" } = {}) {
  const v = [];
  if (!out || typeof out !== "object" || Array.isArray(out)) return { ok: false, violations: ["not_an_object"] };
  const extra = Object.keys(out).filter((k) => !(k in EXPLAIN_TOOL.input_schema.properties));
  if (extra.length) v.push("unexpected_fields");
  if (typeof out.explanation !== "string" || !out.explanation.trim() || out.explanation.length > 1500) v.push("explanation_shape");
  if (!Array.isArray(out.cited) || out.cited.some((c) => typeof c !== "string" || !/^E\d+$/.test(c))) v.push("cited_shape");
  if (out.general_knowledge != null && (typeof out.general_knowledge !== "string" || out.general_knowledge.length > 800)) v.push("general_knowledge_shape");
  if (out.doctor_questions != null && (!Array.isArray(out.doctor_questions) || out.doctor_questions.length > 4 || out.doctor_questions.some((q) => typeof q !== "string" || q.length > 200))) v.push("doctor_questions_shape");
  if (v.length) return { ok: false, violations: v };

  const ids = new Set(inv.evidence.map((e) => e.id));
  const inText = [...out.explanation.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]);
  if ([...inText, ...out.cited].some((id) => !ids.has(id))) v.push("unknown_citation");
  if (inv.evidence.length && !inText.length) v.push("no_citations");
  const records = [out.explanation, ...(out.doctor_questions || [])].join("\n");
  const pool = allowedNumbers(inv, question);
  const stray = [...records.replace(/\[E\d+\]/g, "").matchAll(NUM)].map((m) => m[0]).filter((n) => !pool.has(n) && !pool.has(n.replace(",", ".")) && !ALWAYS_OK.has(n));
  if (stray.length) v.push("number_not_in_evidence");
  const all = [records, out.general_knowledge || ""].join("\n");
  if (DIAGNOSIS.test(all)) v.push("diagnosis_claim");
  if (MED_ADVICE.test(all)) v.push("medicine_change_advice");
  if (mask(all) !== all) v.push("contact_details_or_ids");
  return { ok: !v.length, violations: v, stray_numbers: stray.length };
}
