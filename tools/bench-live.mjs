/**
 * Doctine · LIVE gateway benchmark: the same 10 tasks with a real Claude model in the loop, FICTIONAL records only
 * (nobody's health data is sent). Measures real billed tokens, rounds, tool calls and time per design, and saves every
 * answer for a clinician to score (docs/medical-review/gateway-review-pack.md).
 *
 *   A  every capability as a tool          B  one find_tools tool; found tools are added next round (client-side search)
 *   C  the gateway: search_capabilities + execute_workflow
 *
 * Needs ANTHROPIC_API_KEY in the environment of whoever runs it (never printed, never written). Optional:
 *   BENCH_MODEL (default claude-sonnet-5-5) · BENCH_RUNS (default 1) · BENCH_MAX_USD (default 5: stops before going over)
 *   BENCH_PRICE_IN / BENCH_PRICE_OUT (US$ per million tokens; needed for models other than claude-sonnet-5-5)
 * Estimated cost on claude-sonnet-5-5 ($2 / $10 per million): about US$1.40 per full run of 36 conversations.
 * Test the loop without a key or any cost:  node tools/bench-live.mjs --mock
 * Output: reports/bench-live-<time>.json and docs/GATEWAY_BENCHMARK_LIVE.md
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { TASKS as BASE, dataset } from "./bench-gateway.mjs";
// two safety cases from the clinician review pack, scored by the reviewer rather than for tokens
const TASKS = [...BASE,
  { id: 11, name: "HbA1c units changed", ds: "r10", q: "is my HbA1c going up?", calls: [["compare_lab_results", { test: "hba1c" }]],
    plan: { steps: [{ id: "c", call: "compare_lab_results", args: { test: "hba1c" } }], return: [{ step: "c", path: "series" }] } },
  { id: 12, name: "Asked if a value is normal", ds: "r10", q: "is my CRP normal?", calls: [["compare_lab_results", { test: "c-reactive protein" }]],
    plan: { steps: [{ id: "c", call: "compare_lab_results", args: { test: "c-reactive protein" } }], return: [{ step: "c", path: "series" }] } }];
import { gatewayTools, conventionalTools, runTool, DATA_RULES } from "../netlify/lib/gateway/tools.mjs";
import { searchCapabilities } from "../netlify/lib/gateway/registry.mjs";
import { anthropicUrl } from "../netlify/lib/ai.mjs";

const MOCK = process.argv.includes("--mock");
const MODEL = process.env.BENCH_MODEL || "claude-sonnet-5-5";
const PRICES = { "claude-sonnet-5-5": [2, 10] };
const [PIN, POUT] = process.env.BENCH_PRICE_IN ? [+process.env.BENCH_PRICE_IN, +process.env.BENCH_PRICE_OUT] : PRICES[MODEL] || [];
const RUNS = Math.max(1, Math.min(5, +(process.env.BENCH_RUNS || 1)));
const MAX_USD = +(process.env.BENCH_MAX_USD || 5);
const MAX_ROUNDS = 10;
if (!MOCK && !process.env.ANTHROPIC_API_KEY) { console.error("bench-live: ANTHROPIC_API_KEY is not set in this environment. Nothing was run."); process.exit(2); }
if (!MOCK && !(PIN > 0 && POUT > 0)) { console.error(`bench-live: no price known for ${MODEL}; set BENCH_PRICE_IN and BENCH_PRICE_OUT.`); process.exit(2); }

const SYSTEM = `You are Doctine's health-records assistant answering the signed-in person about THEIR OWN records, which you reach only through your tools. Use the tools; never invent a value. ${DATA_RULES}
Answer in plain language, cite each value's report and date, say what is missing or unconfirmed, and suggest questions for their doctor where useful. No diagnosis, no medicine changes.`;

const FIND = { name: "find_tools", description: "Find which Doctine record tools exist for a request. Returns tool names; they become callable on your next turn.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };

let spent = 0;
async function callModel({ tools, messages, mockScript }) {
  if (MOCK) return mockScript(messages);
  if (spent >= MAX_USD) throw Object.assign(new Error(`spending cap of US$${MAX_USD} reached`), { cap: true });
  const t0 = Date.now();
  const r = await fetch(anthropicUrl(), { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM, tools, messages }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`model error ${r.status} ${j && j.error && j.error.type}`);
  spent += (j.usage.input_tokens * PIN + j.usage.output_tokens * POUT) / 1e6;
  return { ...j, ms: Date.now() - t0 };
}

/** A scripted stand-in model for --mock: makes the task's intended calls, then answers. No network, no cost. */
function mockModel(task, design) {
  return (messages) => {
    const turn = messages.filter((m) => m.role === "assistant").length;
    const usage = { input_tokens: JSON.stringify(messages).length >> 2, output_tokens: 50 };
    const use = (name, input) => ({ content: [{ type: "tool_use", id: `t${turn}`, name, input }], stop_reason: "tool_use", usage, ms: 0 });
    if (design === "C") { if (turn === 0) return use("search_capabilities", { query: task.q }); if (turn === 1) return use("execute_workflow", task.plan); }
    else if (design === "B" && turn === 0) return use("find_tools", { query: task.q });
    else { const k = design === "B" ? turn - 1 : turn; if (k < task.calls.length) return use(task.calls[k][0], task.calls[k][1]); }
    return { content: [{ type: "text", text: `Mock answer for task ${task.id}.` }], stop_reason: "end_turn", usage, ms: 0 };
  };
}

async function converse(task, design, mk) {
  const db = mk();
  let tools = design === "A" ? conventionalTools() : design === "B" ? [FIND] : gatewayTools();
  const messages = [{ role: "user", content: task.q }];
  const rec = { task: task.id, name: task.name, design, rounds: 0, input_tokens: 0, output_tokens: 0, model_ms: 0, tool_calls: [], tool_errors: 0, answer: "" };
  for (let i = 0; i < MAX_ROUNDS; i++) {
    const res = await callModel({ tools, messages, mockScript: mockModel(task, design) });
    rec.rounds++; rec.input_tokens += res.usage.input_tokens; rec.output_tokens += res.usage.output_tokens; rec.model_ms += res.ms || 0;
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((c) => c.type === "tool_use");
    if (!uses.length) { rec.answer = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"); break; }
    const results = [];
    for (const u of uses) {
      let out;
      if (u.name === "find_tools") {
        const names = searchCapabilities(u.input.query, { limit: 6 }).capabilities.map((c) => c.name);
        tools = [FIND, ...conventionalTools().filter((t) => names.includes(t.name) || tools.some((x) => x.name === t.name))];
        out = { tools: names };
      } else out = await runTool(u.name, u.input, { db });
      if (out && out.error) rec.tool_errors++;
      rec.tool_calls.push(u.name);
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  return rec;
}

const rows = [];
try {
  for (let run = 1; run <= RUNS; run++) for (const t of TASKS) for (const d of ["A", "B", "C"]) {
    const r = await converse(t, d, dataset(t.ds));
    rows.push({ run, ...r });
    console.log(`run ${run} · task ${t.id} · ${d}: ${r.rounds} rounds, ${r.input_tokens} in / ${r.output_tokens} out, ${r.tool_calls.length} tool calls${MOCK ? "" : `, spent so far US$${spent.toFixed(3)}`}`);
  }
} catch (e) { console.error("stopped: " + e.message); }

const sum = (d, k) => rows.filter((r) => r.design === d).reduce((s, r) => s + r[k], 0);
const lines = ["| Design | Conversations | Input tokens | Output tokens | Rounds | Tool errors | Cost (US$) |", "|---|---|---|---|---|---|---|"];
for (const d of ["A", "B", "C"]) {
  const n = rows.filter((r) => r.design === d).length, i = sum(d, "input_tokens"), o = sum(d, "output_tokens");
  lines.push(`| ${d} | ${n} | ${i.toLocaleString("en-US")} | ${o.toLocaleString("en-US")} | ${sum(d, "rounds")} | ${sum(d, "tool_errors")} | ${MOCK ? "mock" : ((i * PIN + o * POUT) / 1e6).toFixed(2)} |`);
}
console.log("\n" + lines.join("\n"));
if (!MOCK) {
  mkdirSync("reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`reports/bench-live-${stamp}.json`, JSON.stringify({ model: MODEL, runs: RUNS, spent_usd: spent, rows }, null, 1));
  writeFileSync("docs/GATEWAY_BENCHMARK_LIVE.md", `# Gateway benchmark, live (${MODEL}, fictional data)\n\nRun ${new Date().toISOString().slice(0, 10)}, ${RUNS} run(s), US$${spent.toFixed(2)} spent. Answers: reports/bench-live-${stamp}.json, to be scored with docs/medical-review/gateway-review-pack.md.\n\n${lines.join("\n")}\n`);
}
