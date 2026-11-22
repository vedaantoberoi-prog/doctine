/**
 * Doctine · gateway benchmark, deterministic part. FICTIONAL data only (tests/fixtures/fictional-health.mjs).
 *
 * For 10 tasks, it replays the calls a correct agent would make under three designs, against the real capability code
 * and a simulated database, and measures what each design would put into the model's context:
 *   A  conventional: every capability is a tool, every round re-sends all definitions, every raw result stays in context
 *   B  tool search:  a search tool finds the definitions needed; raw results still return to the model
 *   C  gateway:      2 tools; one search, one plan; only the selected evidence returns
 * Measured: characters and estimated tokens (characters ÷ 4) per design, model rounds, database reads, evidence bytes.
 * NOT measured here (needs real model runs, an API key and approval for the cost): real token counts, the model's answer
 * accuracy and source-attribution accuracy, latency including the model. Run: node tools/bench-gateway.mjs [--md out.md]
 */
import { writeFileSync } from "node:fs";
import { makeRecords, fakeSupabase } from "../tests/fixtures/fictional-health.mjs";
import { userDb } from "../netlify/lib/gateway/db.mjs";
import { BY_NAME, validateArgs, searchCapabilities, describe } from "../netlify/lib/gateway/registry.mjs";
import { executeWorkflow } from "../netlify/lib/gateway/executor.mjs";
import { gatewayTools, conventionalTools } from "../netlify/lib/gateway/tools.mjs";

const UID = "c3330000-0000-4000-8000-000000000003", TOKEN = "bench-token";
const SYSTEM_CHARS = 2600;                               // Doctine's assistant instructions are about this long today
const tok = (chars) => Math.round(chars / 4);
const J = (v) => JSON.stringify(v);

export function dataset(name) {
  const d = { r10: { reports: 10 }, r50: { reports: 50 }, d100: { reports: 10, extraDocs: 100 } }[name];
  const s = fakeSupabase({ people: { [TOKEN]: { uid: UID, data: makeRecords({ uid: UID, seed: 5, ...d }) } } });
  return () => userDb({ base: s.base, anon: s.anon, token: TOKEN, fetchImpl: s.fetchImpl });
}

// Each task: the request, its dataset, the calls (for A and B), and the plan with selections (for C).
export const TASKS = [
  { id: 1, name: "Retrieve one medication", ds: "r10", q: "what dose of levothyroxine am I on",
    calls: [["get_medications", { status: "current" }]],
    plan: { steps: [{ id: "m", call: "get_medications", args: { status: "current" } }], return: [{ step: "m", path: "entries", pick: ["name", "strength", "dose", "start_date", "verification"] }] } },
  { id: 2, name: "Complete health profile", ds: "r10", q: "summarise my whole health profile",
    calls: [["get_profile_summary", {}], ["get_medical_history", {}], ["get_medications", {}], ["get_allergies", {}], ["get_medical_devices", {}], ["get_family_history", {}]],
    plan: { steps: [{ id: "p", call: "get_profile_summary" }, { id: "h", call: "get_medical_history" }, { id: "m", call: "get_medications" }, { id: "a", call: "get_allergies" }, { id: "d", call: "get_medical_devices" }, { id: "f", call: "get_family_history" }],
      return: [{ step: "p" }, { step: "h", path: "entries", pick: ["kind", "title", "status", "onset", "verification"] }, { step: "m", path: "entries", pick: ["name", "strength", "dose", "current", "verification"] }, { step: "a" }, { step: "d", path: "answer" }, { step: "f", path: "entries", pick: ["relationship", "title", "age_at_diagnosis"] }] } },
  { id: 3, name: "Compare 10 lab reports", ds: "r10", q: "how has my cholesterol changed",
    calls: [["compare_lab_results", { test: "cholesterol" }]],
    plan: { steps: [{ id: "c", call: "compare_lab_results", args: { test: "cholesterol" } }], return: [{ step: "c", path: "series" }] } },
  { id: 4, name: "Compare 50 lab reports", ds: "r50", q: "how has my LDL changed over the years",
    calls: [["compare_lab_results", { test: "ldl" }]],
    plan: { steps: [{ id: "c", call: "compare_lab_results", args: { test: "ldl" } }], return: [{ step: "c", path: "series.0.groups.0.changes" }, { step: "c", path: "series.0.groups.0.notes" }, { step: "c", path: "series.0.cautions" }, { step: "c", path: "series.0.lab_reports_without_this_test", pick: ["date", "title"] }, { step: "c", path: "series.0.groups.0.points", pick: ["date", "value_text", "reference_range", "verification", "source.title"] }] } },
  { id: 5, name: "History from 100 documents", ds: "d100", q: "what does my record say about my thyroid",
    calls: [["search_documents", { query: "thyroid", limit: 50 }], ["get_medical_history", { kinds: ["condition"] }], ["get_medications", {}]],
    plan: { steps: [{ id: "d", call: "search_documents", args: { query: "thyroid" } }, { id: "h", call: "get_medical_history", args: { kinds: ["condition"] } }, { id: "m", call: "get_medications" }],
      return: [{ step: "d", path: "documents", pick: ["title", "date"] }, { step: "h", path: "entries", pick: ["title", "status", "onset", "verification"] }, { step: "m", path: "entries", pick: ["name", "reason", "current"] }] } },
  { id: 6, name: "Multi-year timeline", ds: "r50", q: "show every blood test I have had, by date",
    calls: [["get_lab_timeline", {}]],
    plan: { steps: [{ id: "t", call: "get_lab_timeline" }], return: [{ step: "t", path: "dated", pick: ["date", "source.title", "results"] }] } },
  { id: 7, name: "Medication changes", ds: "r10", q: "which medicines have I stopped and why",
    calls: [["get_medications", { status: "all" }], ["get_prescriptions", {}]],
    plan: { steps: [{ id: "m", call: "get_medications", args: { status: "stopped" } }, { id: "p", call: "get_prescriptions" }], return: [{ step: "m", path: "entries", pick: ["name", "start_date", "end_date", "stop_reason", "stopped_on_advice", "verification"] }, { step: "p", path: "prescriptions", pick: ["date", "doctor", "items"] }] } },
  { id: 8, name: "Appointment summary", ds: "r50", q: "prepare a summary for my cardiologist tomorrow",
    calls: [["get_profile_summary", {}], ["get_medical_history", {}], ["get_medications", { status: "current" }], ["get_allergies", {}], ["compare_lab_results", { test: "cholesterol" }], ["identify_missing_information", {}]],
    plan: { steps: [{ id: "p", call: "get_profile_summary" }, { id: "h", call: "get_medical_history" }, { id: "m", call: "get_medications", args: { status: "current" } }, { id: "a", call: "get_allergies" }, { id: "c", call: "compare_lab_results", args: { test: "cholesterol" } }, { id: "x", call: "identify_missing_information" }],
      return: [{ step: "p", pick: ["age", "sex_at_birth", "answers"] }, { step: "h", path: "entries", pick: ["kind", "title", "status", "onset", "verification"] }, { step: "m", path: "entries", pick: ["name", "strength", "dose", "verification"] }, { step: "a" }, { step: "c", path: "series", pick: ["test", "span", "cautions", "groups.0.first", "groups.0.last", "groups.0.unit"] }, { step: "x" }] } },
  { id: 9, name: "Earliest mention of a condition", ds: "d100", q: "when was hypothyroidism first recorded",
    calls: [["get_medical_history", { kinds: ["condition"] }], ["search_documents", { query: "thyroid", limit: 50 }]],
    plan: { steps: [{ id: "h", call: "get_medical_history", args: { kinds: ["condition"] } }, { id: "d", call: "search_documents", args: { query: "thyroid" } }], return: [{ step: "h", path: "entries", pick: ["title", "onset", "verification"] }, { step: "d", path: "documents", pick: ["title", "date"] }] } },
  { id: 10, name: "Conflicting information", ds: "r10", q: "do my prescriptions and my medicine list disagree",
    calls: [["get_medications", { status: "all" }], ["get_prescriptions", {}]],
    plan: { steps: [{ id: "m", call: "get_medications" }, { id: "p", call: "get_prescriptions" }], return: [{ step: "m", path: "entries", pick: ["name", "strength", "status", "start_date", "end_date", "verification"] }, { step: "p", path: "prescriptions", pick: ["date", "items"] }] } },
];

async function runA(task, mk, { search = false } = {}) {
  const defsAll = J(conventionalTools()).length;
  let context = SYSTEM_CHARS + task.q.length, input = 0, rounds = 0, reads = 0;
  const found = search ? searchCapabilities(task.q, { limit: 10 }).capabilities.map((c) => c.name) : null;
  const needed = new Set(task.calls.map(([n]) => n));
  const defsFor = () => (search ? J(conventionalTools().filter((t) => found.includes(t.name) || needed.has(t.name))).length : defsAll);
  if (search) { // round 0: the tool-search round with only the search tool loaded; its result is the definitions
    // the search tool's result is a list of references; the API then loads those definitions into the tools list
    const searchDef = 600; rounds++; input += context + searchDef;
    context += 60 + 40 * found.length;
  }
  for (const [name, args] of task.calls) {
    const db = mk();
    rounds++; input += context + (search ? defsFor() : defsAll) + 80;
    const out = await BY_NAME.get(name).run({ db }, validateArgs(BY_NAME.get(name), args));
    reads += db.stats().calls;
    context += 80 + J(out).length;                       // the call and its whole raw result stay in the conversation
  }
  rounds++; input += context + (search ? defsFor() : defsAll);   // the final answer round
  return { rounds, input_chars: input, evidence_chars: context - SYSTEM_CHARS - task.q.length, reads, definitions_chars: search ? defsFor() : defsAll };
}
async function runC(task, mk) {
  const defs = J(gatewayTools()).length;
  let context = SYSTEM_CHARS + task.q.length, input = 0, rounds = 0;
  const found = searchCapabilities(task.q, { limit: 6 });
  rounds++; input += context + defs + 60; context += 60 + J(found).length;                // search
  const db = mk();
  const r = await executeWorkflow(task.plan, { db });
  rounds++; input += context + defs + J(task.plan).length; context += J(task.plan).length + J(r.results).length; // execute
  rounds++; input += context + defs;                                                       // answer
  return { rounds, input_chars: input, evidence_chars: J(r.results).length, reads: db.stats().calls, definitions_chars: defs, discovery_chars: J(found).length };
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
async function main() {
const rows = [];
for (const t of TASKS) {
  const mk = dataset(t.ds);
  const a = await runA(t, mk), b = await runA(t, mk, { search: true }), c = await runC(t, mk);
  rows.push({ task: t.id, name: t.name, dataset: t.ds, A: a, B: b, C: c });
}

const pct = (x, base) => (base ? Math.round(100 * (1 - x / base)) : 0);
const lines = ["| # | Task | Data | A input tok | B input tok | C input tok | C vs A | Rounds A/B/C | Evidence tok A / C | DB reads A / C |", "|---|---|---|---|---|---|---|---|---|---|"];
let sumA = 0, sumB = 0, sumC = 0;
for (const r of rows) {
  sumA += r.A.input_chars; sumB += r.B.input_chars; sumC += r.C.input_chars;
  lines.push(`| ${r.task} | ${r.name} | ${r.dataset} | ${tok(r.A.input_chars).toLocaleString("en-US")} | ${tok(r.B.input_chars).toLocaleString("en-US")} | ${tok(r.C.input_chars).toLocaleString("en-US")} | ${pct(r.C.input_chars, r.A.input_chars)}% less | ${r.A.rounds}/${r.B.rounds}/${r.C.rounds} | ${tok(r.A.evidence_chars).toLocaleString("en-US")} / ${tok(r.C.evidence_chars).toLocaleString("en-US")} | ${r.A.reads} / ${r.C.reads} |`);
}
lines.push(`| | **All 10** | | **${tok(sumA).toLocaleString("en-US")}** | **${tok(sumB).toLocaleString("en-US")}** | **${tok(sumC).toLocaleString("en-US")}** | **${pct(sumC, sumA)}% less** | | | |`);
const defsA = J(conventionalTools()).length, defsC = J(gatewayTools()).length;
const summary = `Tool definitions sent every round: A ${tok(defsA)} tokens (${conventionalTools().length} tools), C ${tok(defsC)} tokens (2 tools).`;
console.log(lines.join("\n") + "\n\n" + summary);
const i = process.argv.indexOf("--md");
if (i > 0) writeFileSync(process.argv[i + 1], `# Gateway benchmark (deterministic, fictional data)\n\nGenerated by \`node tools/bench-gateway.mjs\` on ${new Date().toISOString().slice(0, 10)}. Tokens are estimated as characters ÷ 4; exact counts, answer accuracy and model latency need real model runs.\n\n${lines.join("\n")}\n\n${summary}\n`);
if (process.argv.includes("--json")) console.log(J(rows));
}
