/**
 * Doctine · query understanding: from a person's words to a retrieval plan. Deterministic and reviewable: no model call.
 *
 * CONCEPTS maps everyday words ("sugar", "kidneys", "cholesterol") to the lab tests that MAY be relevant and to search
 * terms for documents. It is a retrieval aid, not clinical equivalence: each test stays its own series, and nothing
 * here is ever presented as a diagnosis. A clinician should review this table (docs/medical-review/gateway-review-pack.md).
 */
import { testKey } from "../gateway/labs.mjs";

export const CONCEPTS = [
  { key: "lipids", label: "cholesterol and other blood fats",
    triggers: ["cholesterol", "lipid", "lipids", "lipoprotein", "low density", "high density", "ldl", "hdl", "triglyceride", "triglycerides", "dyslipid", "hyperlipid", "hypercholesterol", "blood fats", "statin", "vldl"],
    tests: ["ldl cholesterol", "hdl cholesterol", "total cholesterol", "triglycerides", "vldl cholesterol", "non hdl cholesterol"],
    terms: ["lipid profile", "cholesterol", "ldl", "hdl", "triglycerides", "dyslipidaemia", "dyslipidemia", "hyperlipidaemia", "hypercholesterolaemia", "low density lipoprotein", "statin", "atorvastatin", "rosuvastatin"] },
  { key: "glucose", label: "blood sugar",
    triggers: ["sugar", "glucose", "diabetes", "diabetic", "hba1c", "a1c", "glycated", "prediabetes", "fasting sugar"],
    tests: ["hba1c", "fasting blood glucose", "postprandial blood glucose", "random blood glucose"],
    terms: ["hba1c", "glycated haemoglobin", "glucose", "blood sugar", "fasting", "diabetes", "prediabetes", "metformin"] },
  { key: "kidney", label: "kidney function tests",
    triggers: ["kidney", "kidneys", "renal", "creatinine", "egfr", "gfr", "urea", "bun", "kft", "rft"],
    tests: ["creatinine", "egfr", "urea", "blood urea nitrogen"],
    terms: ["creatinine", "egfr", "gfr", "urea", "blood urea nitrogen", "kidney function", "renal function", "kft", "rft"] },
  { key: "liver", label: "liver function tests",
    triggers: ["liver", "lft", "alt", "ast", "sgpt", "sgot", "bilirubin", "jaundice", "hepatic"],
    tests: ["alt", "ast", "alkaline phosphatase", "total bilirubin"],
    terms: ["liver function", "lft", "sgpt", "sgot", "alt", "ast", "bilirubin", "alkaline phosphatase"] },
  { key: "thyroid", label: "thyroid tests",
    triggers: ["thyroid", "tsh", "t3", "t4", "thyroxine", "hypothyroid", "hyperthyroid"],
    tests: ["tsh", "free t4"],
    terms: ["tsh", "thyroid", "t4", "t3", "thyroxine", "hypothyroidism", "levothyroxine"] },
  { key: "blood_count", label: "blood count",
    triggers: ["cbc", "blood count", "haemoglobin", "hemoglobin", "anaemia", "anemia", "platelet", "platelets", "wbc", "hb"],
    tests: ["haemoglobin", "white blood cells", "platelet count"],
    terms: ["complete blood count", "cbc", "haemoglobin", "hemoglobin", "platelet", "wbc", "anaemia"] },
  { key: "inflammation", label: "inflammation markers",
    triggers: ["crp", "c-reactive", "c reactive", "inflammation", "esr"],
    tests: ["c reactive protein", "esr"],
    terms: ["c-reactive protein", "crp", "esr", "inflammation"] },
  { key: "vitamins", label: "vitamin levels",
    triggers: ["vitamin", "vit d", "b12"],
    tests: ["vitamin d", "vitamin b12"],
    terms: ["vitamin d", "vitamin b12", "25-oh"] },
];

const INTENTS = [
  ["current_medications", /\b(current(ly)?|now|still|at the moment)\b.*\b(medicine|medicines|medication|medications|tablets?|taking)\b|\bwhat (medicines|medications|tablets) am i (on|taking)\b/],
  ["meaning", /^(what (is|are|does)|what's|meaning of|define|explain what)\b(?!.*\b(my|mine|i)\b)/],
  ["compare", /\b(chang|trend|compare|comparison|over (the )?(time|years|months)|history of|went (up|down)|gone (up|down)|increas|decreas|improv|wors|progress|going (up|down)|since)\w*/],
  ["mentions", /\b(every|all) (mention|reference)s?\b|\bfirst (time|recorded|mention|documented|appeared)\b|\bwhere (is|was) .* (mentioned|written)\b|\bhow (it|this) was documented\b/],
  ["global", /\b(summar|overview|whole|complete|entire|full)\w*\b.*\b(history|record|records|profile|health)\b|\bfor my (doctor|cardiologist|appointment|specialist|consultation)\b/],
  ["latest", /\b(last|latest|most recent|recent|newest)\b.*\b(report|test|result|results|blood test|scan)\b/],
];
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, a: 1 };

/** Dates the question asks about, as an inclusive [from, to] in YYYY-MM-DD, relative to `today`. */
export function dateRange(q, today = new Date().toISOString().slice(0, 10)) {
  const t = new Date(today + "T00:00:00Z"), iso = (d) => d.toISOString().slice(0, 10);
  let m = q.match(/\b(?:last|past|previous)\s+(\d+|one|two|three|four|five|six|ten|a)\s+(year|month|week)s?\b/);
  if (m) { const n = /^\d+$/.test(m[1]) ? +m[1] : NUM[m[1]]; const d = new Date(t); if (m[2] === "year") d.setUTCFullYear(d.getUTCFullYear() - n); else if (m[2] === "month") d.setUTCMonth(d.getUTCMonth() - n); else d.setUTCDate(d.getUTCDate() - 7 * n); return { from: iso(d), to: today, said: m[0] }; }
  if ((m = q.match(/\bbetween\s+(20\d\d|19\d\d)\s+and\s+(20\d\d|19\d\d)\b/))) return { from: `${m[1]}-01-01`, to: `${m[2]}-12-31`, said: m[0] };
  if ((m = q.match(/\bsince\s+(20\d\d|19\d\d)\b/))) return { from: `${m[1]}-01-01`, to: today, said: m[0] };
  if ((m = q.match(/\bin\s+(20\d\d|19\d\d)\b/))) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31`, said: m[0] };
  return { from: null, to: null, said: null };
}

/** The retrieval plan for one question. Budgets keep expansion and evidence bounded. */
export function understand(question, { today } = {}) {
  const q = String(question || "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim().slice(0, 500);
  // short triggers (ldl, hb, t3) must be whole words; longer ones may begin a word (dyslipid → dyslipidaemia)
  const concepts = CONCEPTS.filter((c) => c.triggers.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${w.length <= 4 ? "([^a-z0-9]|$)" : ""}`).test(q)));
  const intent = (INTENTS.find(([, re]) => re.test(q)) || [concepts.length ? "lookup" : "search"])[0];
  const dates = dateRange(q, today);
  // exact identifiers the person typed (test codes, medicine names) are searched as written
  const words = q.split(/[^a-z0-9.+-]+/).filter((w) => w.length >= 2 && !STOP.has(w));
  const exactTests = [...new Set(words.map((w) => testKey(w)).filter((k) => k.alias || CONCEPTS.some((c) => c.tests.includes(k.key))).map((k) => k.key))];
  const tests = [...new Set([...concepts.flatMap((c) => c.tests), ...exactTests])].slice(0, 12);
  const terms = [...new Set([...concepts.flatMap((c) => c.terms), ...words.filter((w) => !GENERIC.has(w))])].slice(0, 24);
  const budget = { compare: { text: 8 }, latest: { text: 10 }, lookup: { text: 8 }, mentions: { text: 20 }, global: { text: 12 }, current_medications: { text: 8 }, meaning: { text: 4 }, search: { text: 10 } }[intent];
  const strategy = intent === "meaning" ? "general_knowledge" : intent === "global" ? "global" : intent === "mentions" ? "investigative"
    : intent === "compare" ? "comparative" : intent === "current_medications" ? "current_medications" : "patient_specific";
  return { question: q, intent, strategy, concepts: concepts.map((c) => ({ key: c.key, label: c.label, terms: c.terms })), words: words.filter((w) => !GENERIC.has(w)), tests, terms, dates, budget,
    needs: { structured: tests.length > 0 || intent === "current_medications" || intent === "global", text: strategy !== "general_knowledge", history: intent === "compare" || intent === "mentions" } };
}
const STOP = new Set(["my", "me", "i", "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "have", "has", "had", "do", "does", "did", "how", "what", "which", "when", "where", "show", "tell", "please", "can", "you", "results", "result", "levels", "level", "over", "last", "past", "years", "year", "months", "month", "changed", "change", "compare", "historical", "history", "all", "every", "any", "it", "this", "that", "with", "from", "since", "between", "am", "going", "up", "down", "them", "these", "those", "significantly"]);
const GENERIC = new Set(["report", "reports", "test", "tests", "blood", "record", "records", "document", "documents", "doctor", "summary", "summarise", "summarize"]);
