/**
 * Doctine · lab history: reading values, matching tests across reports and comparing only like with like.
 *
 * Rules (from the medical-intelligence brief and Doctine's own safety rules):
 *   - Each value keeps what the report printed: the raw text, its unit, its reference range and its flag.
 *   - Values are compared only within the same test AND the same unit. Units are never converted.
 *   - "< 0.5", "> 1000", "Negative" and ambiguous numbers are kept but never put into a numeric comparison.
 *   - A missing value is reported as missing, never as normal. A difference is reported as a difference,
 *     never as an improvement, a worsening or a diagnosis. The report's own flag is passed on as printed.
 *   - Every point carries its source: document, its date, the lab, and whether the person confirmed the value or
 *     it is an unconfirmed AI reading.
 * Pure functions: no network, no database. The capability layer (registry.mjs) feeds them the person's own rows.
 */

const MICRO = /[µμ]/g;
const SUPER = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9" };

/** A unit in a form where only spelling differences disappear (case, spaces, µ, ×10^, superscripts). Never a conversion. */
export function unitKey(u) {
  if (u == null) return "";
  let s = String(u).trim().toLowerCase().replace(MICRO, "u").replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => "^" + SUPER[c]);
  s = s.replace(/\s+/g, "").replace(/^[x×*]/, "").replace(/\^\^/g, "^").replace(/×/g, "x");
  return s;
}

/* Different names that reports use for the same test. Naming only: no clinical equivalence is implied. */
const ALIASES = [
  ["ldl cholesterol", ["ldl", "ldl c", "ldl-c", "ldl chol", "cholesterol ldl", "low density lipoprotein", "ldl cholesterol direct", "ldl direct"]],
  ["hdl cholesterol", ["hdl", "hdl c", "hdl-c", "hdl chol", "cholesterol hdl", "high density lipoprotein"]],
  ["total cholesterol", ["cholesterol total", "serum cholesterol", "total serum cholesterol", "s cholesterol"]],
  ["triglycerides", ["tg", "triglyceride", "serum triglycerides"]],
  ["hba1c", ["glycated haemoglobin", "glycated hemoglobin", "glycosylated haemoglobin", "glycosylated hemoglobin", "hb a1c", "a1c"]],
  ["haemoglobin", ["hemoglobin", "hb", "hgb"]],
  ["fasting blood glucose", ["fasting blood sugar", "fbs", "fasting glucose", "fasting plasma glucose", "fpg", "glucose fasting", "blood sugar fasting"]],
  ["postprandial blood glucose", ["ppbs", "pp blood sugar", "post prandial blood sugar", "postprandial glucose", "glucose pp", "blood sugar pp"]],
  ["tsh", ["thyroid stimulating hormone", "s tsh", "tsh ultrasensitive"]],
  ["creatinine", ["serum creatinine", "s creatinine", "creatinine serum"]],
  ["vitamin d", ["25 oh vitamin d", "25-oh vitamin d", "vitamin d 25 hydroxy", "25 hydroxy vitamin d", "vit d"]],
  ["vitamin b12", ["b12", "vit b12", "cyanocobalamin"]],
  ["platelet count", ["platelets", "plt"]],
  ["white blood cells", ["wbc", "tlc", "total leucocyte count", "total leukocyte count", "wbc count"]],
  ["egfr", ["estimated gfr", "e gfr", "estimated glomerular filtration rate"]],
  ["urea", ["blood urea", "serum urea"]],
  ["blood urea nitrogen", ["bun", "urea nitrogen"]],
  ["alt", ["sgpt", "alanine aminotransferase", "alt sgpt", "sgpt alt"]],
  ["ast", ["sgot", "aspartate aminotransferase", "ast sgot", "sgot ast"]],
  ["alkaline phosphatase", ["alp"]],
  ["total bilirubin", ["bilirubin total", "serum bilirubin", "s bilirubin"]],
  ["free t4", ["ft4", "free thyroxine"]],
  ["vldl cholesterol", ["vldl"]],
  ["random blood glucose", ["rbs", "random blood sugar", "glucose random"]],
];
const ALIAS = new Map();
for (const [main, others] of ALIASES) { ALIAS.set(main, main); for (const o of others) ALIAS.set(o, main); }

export const cleanName = (s) => String(s || "").toLowerCase().replace(/[()[\],:;]/g, " ").replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
/** The key a test is grouped under, and whether a naming alias was used to get there. */
export function testKey(name) {
  const c = cleanName(name);
  if (ALIAS.has(c)) return { key: ALIAS.get(c), alias: ALIAS.get(c) !== c };
  const d = c.replace(/-/g, " ");
  if (ALIAS.has(d)) return { key: ALIAS.get(d), alias: true };
  return { key: c, alias: false };
}
/** Does a series match what the person asked about? Whole words of the query must all appear in the key or a name. */
export function matchesQuery(key, names, query) {
  const words = cleanName(query).split(" ").filter((w) => w.length >= 2);
  if (!words.length) return true;
  const qk = testKey(query).key;
  if (qk === key) return true;
  const hay = [key, ...names.map(cleanName)].join(" | ");
  return words.every((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(hay));
}

/**
 * Read a printed value. Returns { number, qualifier, unit, range, numeric, reason }.
 * "132 mg/dL (ref < 100)" → 132, mg/dL, range "< 100".  "< 0.5 mg/L" → qualifier "<", numeric false.
 */
export function parseValue(raw, unitHint, rangeHint) {
  const text = String(raw == null ? "" : raw).trim();
  const out = { raw: text, number: null, qualifier: null, unit: unitHint ? String(unitHint).trim() : "", range: rangeHint ? String(rangeHint).trim() : "", numeric: false, reason: "" };
  if (!text) { out.reason = "no value printed"; return out; }
  let body = text;
  const ref = body.match(/\((?:ref(?:erence)?(?:\s*range)?|range|normal)\.?\s*:?\s*([^)]*)\)\s*$/i);
  if (ref) { if (!out.range) out.range = ref[1].trim(); body = body.slice(0, ref.index).trim(); }
  const m = body.match(/^([<>]=?|≤|≥)?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) { out.reason = "not a number"; return out; }
  let n = m[2];
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(n)) n = n.replace(/,/g, "");
  else if (n.includes(",")) { out.reason = "ambiguous number (comma)"; if (!out.unit) out.unit = m[3].trim(); return out; }
  out.number = Number(n);
  if (!out.unit) out.unit = m[3].trim();
  if (m[1]) { out.qualifier = m[1].replace("≤", "<=").replace("≥", ">="); out.reason = "a limit, not an exact value"; return out; }
  if (!Number.isFinite(out.number)) { out.number = null; out.reason = "not a number"; return out; }
  out.numeric = true;
  return out;
}

/**
 * Turn the person's documents and lab rows into observations.
 * docs: [{ id, title, category, document_date, provider, fields, page_count }]
 * labRows: [{ id, document_id, test, value, unit, reference_range, flag, confidence, origin }]
 * A value the person confirmed (documents.fields of a lab report) wins over the AI reading of the same test in the same
 * document; the AI reading is then not shown twice. AI readings the person never confirmed are kept and labelled.
 */
export function observations(docs, labRows) {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out = [];
  const seen = new Set();
  for (const d of docs) {
    if (d.category !== "Lab report" || !d.fields || typeof d.fields !== "object") continue;
    for (const [name, v] of Object.entries(d.fields)) {
      if (typeof v !== "string" && typeof v !== "number") continue;
      const p = parseValue(v);
      const k = testKey(name);
      seen.add(d.id + "|" + k.key);
      out.push(point(d, name, k, p, { verification: "confirmed_by_person", origin: "person_confirmed", confidence: null, flag: "" }));
    }
  }
  for (const r of labRows) {
    const d = byId.get(r.document_id);
    if (!d) continue;
    const k = testKey(r.test);
    if (seen.has(d.id + "|" + k.key)) continue;
    const p = parseValue(r.value, r.unit, r.reference_range);
    out.push(point(d, r.test, k, p, {
      verification: r.origin === "user_entered" ? "entered_by_person" : "ai_extracted_unconfirmed",
      origin: r.origin || "ai_extracted", confidence: r.confidence || null, flag: r.flag || "",
    }));
  }
  return out;
}
/** AI readings hidden because the person confirmed the same test in the same report, where the numbers differ. */
export function shadowedDisagreements(docs, labRows) {
  const out = [];
  for (const r of labRows) {
    const d = docs.find((x) => x.id === r.document_id);
    if (!d || d.category !== "Lab report" || !d.fields) continue;
    const k = testKey(r.test).key;
    const hit = Object.entries(d.fields).find(([n]) => testKey(n).key === k);
    if (!hit) continue;
    const a = parseValue(hit[1]), b = parseValue(r.value, r.unit, r.reference_range);
    if (a.numeric && b.numeric && unitKey(a.unit) === unitKey(b.unit) && a.number !== b.number)
      out.push({ test: k, document_id: d.id, date: d.document_date || null, confirmed: hit[1], ai_reading: [r.value, r.unit].filter(Boolean).join(" ") });
  }
  return out;
}
const point = (d, name, k, p, extra) => ({
  test: String(name).slice(0, 120), key: k.key, matched_by_alias: k.alias,
  date: /^\d{4}-\d{2}-\d{2}$/.test(d.document_date || "") ? d.document_date : null,
  value_text: p.raw.slice(0, 80), number: p.number, qualifier: p.qualifier, numeric: p.numeric, not_numeric_reason: p.reason || undefined,
  unit: p.unit.slice(0, 40), unit_key: unitKey(p.unit), reference_range: p.range.slice(0, 80) || null,
  flag_printed: extra.flag ? String(extra.flag).slice(0, 12) : null,
  verification: extra.verification, confidence: extra.confidence,
  source: { document_id: d.id, title: String(d.title || "").slice(0, 160), date: d.document_date || null, lab: d.provider ? String(d.provider).slice(0, 160) : null, page: null },
});

const inRange = (date, from, to) => !date || ((!from || date >= from) && (!to || date <= to));

/**
 * Compare a test over time. Returns one entry per test that matches `test` (all tests when empty).
 * Within a test, values are grouped by unit; only numeric values with a date inside a group are compared.
 */
export function compareSeries(obs, { test = "", from = null, to = null, labDocs = [] } = {}) {
  const pts = obs.filter((o) => inRange(o.date, from, to));
  const byKey = new Map();
  for (const o of pts) { if (!byKey.has(o.key)) byKey.set(o.key, []); byKey.get(o.key).push(o); }
  const series = [];
  for (const [key, list] of byKey) {
    const names = [...new Set(list.map((o) => o.test))];
    if (test && !matchesQuery(key, names, test)) continue;
    const dated = list.filter((o) => o.date).sort((a, b) => a.date.localeCompare(b.date) || a.source.document_id.localeCompare(b.source.document_id));
    const undated = list.filter((o) => !o.date);
    const groups = [];
    const byUnit = new Map();
    for (const o of dated) {
      if (!o.numeric) continue;
      const u = o.unit_key || "(no unit)";
      if (!byUnit.has(u)) byUnit.set(u, []);
      byUnit.get(u).push(o);
    }
    for (const [u, g] of byUnit) {
      const notes = [];
      if (u === "(no unit)") notes.push("No unit was printed or read for these values; compare them only after checking the original reports.");
      const labs = new Set(g.map((o) => (o.source.lab || "").toLowerCase()).filter(Boolean));
      if (labs.size > 1) notes.push(`From ${labs.size} different laboratories: methods can differ, so small differences may not be meaningful.`);
      const ranges = new Set(g.map((o) => (o.reference_range || "").replace(/\s+/g, "")).filter(Boolean));
      if (ranges.size > 1) notes.push("The reports print different reference ranges; each value is shown with its own range.");
      if (g.some((o) => o.verification === "ai_extracted_unconfirmed")) notes.push("Some values are AI readings the person has not confirmed against the paper.");
      const changes = [];
      for (let i = 1; i < g.length; i++) {
        const a = g[i - 1], b = g[i];
        const diff = +(b.number - a.number).toFixed(4);
        changes.push({ from_date: a.date, to_date: b.date, from: a.number, to: b.number, difference: diff, direction: diff > 0 ? "higher" : diff < 0 ? "lower" : "same",
          same_day: a.date === b.date || undefined });
      }
      groups.push({ unit: g[0].unit || null, unit_key: u, comparable: u !== "(no unit)" && g.length > 1, points: g, changes, notes,
        first: g[0] ? { date: g[0].date, value: g[0].number } : null, last: g.length ? { date: g.at(-1).date, value: g.at(-1).number } : null });
    }
    const notCompared = dated.filter((o) => !o.numeric).map((o) => ({ ...o, why: o.not_numeric_reason }));
    const cautions = [];
    if (groups.length > 1) cautions.push(`Reported in ${groups.length} different units (${groups.map((g) => g.unit || "no unit").join(", ")}); values in different units are not compared and are never converted here.`);
    if (list.some((o) => o.matched_by_alias)) cautions.push(`Grouped under one name: ${names.join(", ")}. Check the reports if these might be different tests.`);
    // Lab reports in the period that do not mention this test: missing, not normal.
    const has = new Set(list.map((o) => o.source.document_id));
    const missing = labDocs.filter((d) => inRange(d.document_date, from, to) && d.document_date && !has.has(d.id))
      .map((d) => ({ document_id: d.id, title: String(d.title || "").slice(0, 160), date: d.document_date }));
    series.push({ test: key, names_seen: names, groups, not_compared: notCompared, undated, cautions,
      lab_reports_without_this_test: missing, count: list.length,
      span: dated.length ? { first: dated[0].date, last: dated.at(-1).date } : null });
  }
  series.sort((a, b) => b.count - a.count || a.test.localeCompare(b.test));
  return series;
}

/** Everything measured, by date: one row per report date with the tests it contains (names and values as printed). */
export function timeline(obs, { from = null, to = null } = {}) {
  const byDoc = new Map();
  for (const o of obs.filter((x) => inRange(x.date, from, to))) {
    const k = o.source.document_id;
    if (!byDoc.has(k)) byDoc.set(k, { date: o.date, source: o.source, results: [] });
    byDoc.get(k).results.push({ test: o.test, value_text: o.value_text, unit: o.unit || null, reference_range: o.reference_range, flag_printed: o.flag_printed, verification: o.verification });
  }
  const rows = [...byDoc.values()];
  return { dated: rows.filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date)), undated: rows.filter((r) => !r.date) };
}
