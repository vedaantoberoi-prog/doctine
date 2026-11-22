/**
 * Doctine · the Agent Execution Gateway (netlify/lib/gateway, /api/gateway) with Supabase simulated, FICTIONAL data only.
 * Covers: reading printed lab values; comparing only like with like (same test, same unit, never converted); limits and
 * missing values never treated as normal; sources and verification on every point; plan validation, parallel steps,
 * references, selection and size limits; and security: sign-in required, the switch, the person's own token on every
 * read (never the server key), no way to name another person, cross-person isolation, and a document title that tries
 * to instruct the AI being returned as plain data.
 */
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { parseValue, unitKey, testKey, observations, compareSeries, matchesQuery } from "../netlify/lib/gateway/labs.mjs";
import { CAPABILITIES, BY_NAME, validateArgs, searchCapabilities } from "../netlify/lib/gateway/registry.mjs";
import { executeWorkflow, planWaves, LIMITS } from "../netlify/lib/gateway/executor.mjs";
import { userDb } from "../netlify/lib/gateway/db.mjs";
import { gatewayTools, conventionalTools, runTool } from "../netlify/lib/gateway/tools.mjs";
import gateway from "../netlify/functions/gateway.mjs";
import { _resetSettingsCache } from "../netlify/lib/settings.mjs";
import { makeRecords, fakeSupabase, INJECTION_TITLE } from "./fixtures/fictional-health.mjs";

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { failed++; console.log("  ✗ " + name + "\n      " + (e && e.stack || e).toString().split("\n").slice(0, 3).join("\n      ")); } };

const A = "a1110000-0000-4000-8000-000000000001", B = "b2220000-0000-4000-8000-000000000002";
const TA = "token-person-a", TB = "token-person-b";
const dataA = makeRecords({ uid: A, reports: 10, seed: 11 }), dataB = makeRecords({ uid: B, reports: 4, seed: 99 });
dataB.documents.forEach((d) => (d.title = "B-ONLY " + d.title));
const sb = fakeSupabase({ people: { [TA]: { uid: A, data: dataA }, [TB]: { uid: B, data: dataB } }, flags: { ai_gateway: true } });
const dbA = () => userDb({ base: sb.base, anon: sb.anon, token: TA, fetchImpl: sb.fetchImpl });

console.log("lab values");
await test("printed values are read with their unit and range", () => {
  const p = parseValue("132 mg/dL (ref < 100)");
  assert.equal(p.number, 132); assert.equal(p.unit, "mg/dL"); assert.equal(p.range, "< 100"); assert.equal(p.numeric, true);
  assert.equal(parseValue("5.9 % (ref 4.0–5.6)").number, 5.9);
  assert.equal(parseValue("1,200 /uL").number, 1200);
});
await test("limits, words and ambiguous numbers are kept but never treated as exact numbers", () => {
  for (const [v, why] of [["< 0.5 mg/L", "limit"], ["Negative", "not a number"], ["1,6 mg/dL", "comma"], ["", "no value"]]) {
    const p = parseValue(v); assert.equal(p.numeric, false, v); assert.match(p.reason, new RegExp(why.split(" ")[0]), v);
  }
});
await test("unit spellings match, different units never do", () => {
  assert.equal(unitKey("mg/dL"), unitKey("MG/DL ")); assert.equal(unitKey("10^3/µL"), unitKey("x10³/uL"));
  assert.notEqual(unitKey("mg/dL"), unitKey("mmol/L")); assert.notEqual(unitKey("%"), unitKey("mmol/mol"));
});
await test("different report names for one test are grouped, and say so", () => {
  assert.deepEqual(testKey("LDL-C"), { key: "ldl cholesterol", alias: true });
  assert.equal(testKey("Glycated Haemoglobin").key, "hba1c");
  assert.ok(matchesQuery("ldl cholesterol", ["LDL-C"], "cholesterol") && matchesQuery("hdl cholesterol", [], "cholesterol"));
  assert.ok(!matchesQuery("triglycerides", [], "cholesterol"));
});

console.log("comparison over time");
const obsA = observations(dataA.documents, dataA.lab_results);
const labDocsA = dataA.documents.filter((d) => d.category === "Lab report");
await test("'cholesterol' gives LDL, HDL and total as separate series, never merged", () => {
  const s = compareSeries(obsA, { test: "cholesterol", labDocs: labDocsA });
  const keys = s.map((x) => x.test);
  assert.ok(keys.includes("ldl cholesterol") && keys.includes("hdl cholesterol"), keys.join());
  assert.ok(!keys.includes("triglycerides"));
});
await test("HbA1c in % and in mmol/mol stay in separate groups, never converted", () => {
  const [h] = compareSeries(obsA, { test: "hba1c", labDocs: labDocsA });
  const units = h.groups.map((g) => g.unit).sort();
  assert.deepEqual(units, ["%", "mmol/mol"]);
  assert.match(h.cautions.join(" "), /different units.*never converted/);
  for (const g of h.groups) for (const c of g.changes) assert.ok(g.points.every((p) => p.unit_key === g.unit_key));
});
await test("differences are arithmetic between neighbours in date order, with no judgement words", () => {
  const [l] = compareSeries(obsA, { test: "ldl", labDocs: labDocsA });
  const g = l.groups[0];
  for (let i = 1; i < g.points.length; i++) assert.ok(g.points[i - 1].date <= g.points[i].date);
  for (const c of g.changes) { assert.equal(c.difference, +(c.to - c.from).toFixed(4)); assert.ok(["higher", "lower", "same"].includes(c.direction)); }
  assert.doesNotMatch(JSON.stringify(l), /improv|worse|better|normal|abnormal|risk/i);
});
await test("a report without the test is listed as missing, not normal; undated values are kept apart", () => {
  const [l] = compareSeries(obsA, { test: "ldl", labDocs: labDocsA });
  assert.ok(l.lab_reports_without_this_test.some((d) => d.document_id === dataA.documents[5].id), "report 6 has no LDL");
  assert.ok(l.lab_reports_without_this_test.some((d) => d.document_id === dataA.documents[3].id), "report 4 has no LDL");
  assert.ok(!l.groups.some((g) => g.points.some((p) => !p.date)));
});
await test("a '< 0.5' value and a comma decimal are shown but not compared", () => {
  const [c] = compareSeries(obsA, { test: "c-reactive protein", labDocs: labDocsA });
  assert.ok(c.not_compared.some((p) => p.value_text === "< 0.5 mg/L" && /limit/.test(p.why)));
  const [t] = compareSeries(obsA, { test: "triglycerides", labDocs: labDocsA });
  assert.ok(t.not_compared.some((p) => p.value_text === "1,6" && /comma/.test(p.why)));
});
await test("every point keeps its source, range and whether the person confirmed it", () => {
  for (const o of obsA) {
    assert.ok(o.source.document_id && "lab" in o.source && "page" in o.source);
    assert.ok(["confirmed_by_person", "ai_extracted_unconfirmed", "entered_by_person"].includes(o.verification));
  }
  const [l] = compareSeries(obsA, { test: "ldl", labDocs: labDocsA });
  assert.match(l.groups[0].notes.join(" "), /different laboratories/);
  assert.match(l.groups[0].notes.join(" "), /different reference ranges/);
  assert.match(l.groups[0].notes.join(" "), /not confirmed/);
});
await test("a value the person confirmed wins over the AI reading of the same test in the same report", () => {
  const doc = { id: "d1", category: "Lab report", document_date: "2025-01-01", provider: "X", title: "t", fields: { LDL: "120 mg/dL" } };
  const o = observations([doc], [{ document_id: "d1", test: "LDL Cholesterol", value: "210", unit: "mg/dL", origin: "ai_extracted" }]);
  assert.equal(o.length, 1); assert.equal(o[0].number, 120); assert.equal(o[0].verification, "confirmed_by_person");
});

console.log("registry and discovery");
await test("every capability is read-only, typed, documented with an example, and takes no person id", () => {
  for (const c of CAPABILITIES) {
    assert.ok(c.description.length > 40 && c.examples.length && c.input.type === "object" && c.input.additionalProperties === false, c.name);
    assert.ok(!/user|uid|person|patient/i.test(Object.keys(c.input.properties || {}).join(" ")), c.name);
  }
  assert.throws(() => validateArgs(BY_NAME.get("get_medications"), { user_id: B }), /unknown argument "user_id"/);
  assert.throws(() => validateArgs(BY_NAME.get("compare_lab_results"), { from: "2025-13-45" }), /not a real date|YYYY/);
  assert.throws(() => validateArgs(BY_NAME.get("compare_lab_results"), { from: "2026-01-01", to: "2025-01-01" }), /after/);
});
await test("search finds the right operations for plain requests", () => {
  const first = (q) => searchCapabilities(q).capabilities[0].name;
  assert.equal(first("compare my cholesterol results over the last three years"), "compare_lab_results");
  assert.equal(first("what am I allergic to"), "get_allergies");
  assert.equal(first("which medicines did I stop"), "get_medications");
  assert.ok(searchCapabilities("prepare a summary for my cardiologist", { limit: 10 }).capabilities.length >= 3);
});
await test("every capability runs on the fictional records and none returns contact details", async () => {
  for (const c of CAPABILITIES) {
    const out = await c.run({ db: dbA() }, validateArgs(c, c.examples[0].args));
    const s = JSON.stringify(out);
    assert.doesNotMatch(s, /\+91|example\.test|Fictional Contact|1980-06-15/, c.name);
  }
});

console.log("workflow execution");
await test("bad plans are refused with a reason", () => {
  const bad = [
    [{ steps: [] }, /at least one/], [{ steps: [{ id: "a", call: "drop_table" }] }, /not a Doctine capability/],
    [{ steps: [{ id: "a", call: "get_allergies", args: { x: { $from: "b" } } }, { id: "b", call: "get_allergies", args: { y: { $from: "a" } } }] }, /circle/],
    [{ steps: Array.from({ length: LIMITS.steps + 1 }, (_, i) => ({ id: "s" + i, call: "get_allergies" })) }, /At most/],
    [{ steps: [{ id: "a", call: "get_allergies" }], code: "fetch('x')" }, /Unknown plan field/],
    [{ steps: [{ id: "a", call: "get_allergies" }], return: [{ step: "a", path: "__proto__.x" }] }, /path|Bad/],
  ];
  for (const [p, re] of bad) assert.throws(() => planWaves(p), re);
});
await test("independent steps run in parallel; a dependent step waits and receives the earlier value", async () => {
  const slow = fakeSupabase({ people: { [TA]: { uid: A, data: dataA } }, delayMs: 60 });
  const db = userDb({ base: slow.base, anon: slow.anon, token: TA, fetchImpl: slow.fetchImpl });
  const t0 = Date.now();
  const r = await executeWorkflow({ steps: [{ id: "a", call: "get_allergies" }, { id: "m", call: "get_medications" }, { id: "h", call: "get_family_history" }] , return: [{ step: "a", path: "answer" }] }, { db });
  const parallelMs = Date.now() - t0;
  assert.ok(parallelMs < 3 * 2 * 60, `took ${parallelMs} ms`);
  const r2 = await executeWorkflow({ steps: [{ id: "docs", call: "search_documents", args: { category: "Lab report" } }, { id: "t", call: "get_lab_timeline", args: { from: { $from: "docs", path: "documents.0.date" } } }], return: [{ step: "t", path: "dated" }] }, { db: dbA() });
  assert.equal(r2.results[0].value.length, 1, "only the newest report's date onwards");
});
await test("only the selected fields come back, and the audit holds no values", async () => {
  const logs = [];
  const r = await executeWorkflow({ steps: [{ id: "m", call: "get_medications", args: { status: "current" } }], return: [{ step: "m", path: "entries", pick: ["name", "verification"] }] }, { db: dbA(), audit: (l) => logs.push(l) });
  assert.deepEqual(r.results[0].value, [{ name: "Levothyroxine", verification: "self_reported" }]);
  assert.doesNotMatch(JSON.stringify(logs), /Levothyroxine|Penicillin|LDL/);
  assert.equal(logs[0].steps[0].call, "get_medications");
});
await test("a selection too large for the model fails with advice instead of being cut silently", async () => {
  const big = makeRecords({ uid: A, reports: 120, seed: 3 });
  const s = fakeSupabase({ people: { [TA]: { uid: A, data: big } } });
  const db = userDb({ base: s.base, anon: s.anon, token: TA, fetchImpl: s.fetchImpl });
  await assert.rejects(executeWorkflow({ steps: [{ id: "t", call: "get_lab_timeline" }] }, { db }), (e) => e.code === "result_too_large" && /Nothing was dropped/.test(e.message));
});

console.log("security");
const post = (body, token = TA, extra = {}) => new Request("https://app.example/api/gateway", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body), ...extra });
const FAKE_SERVER_KEY = "sb_secret_TEST_ONLY_not_real";
const env = { SUPABASE_URL: sb.base, SUPABASE_ANON_KEY: sb.anon, SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVER_KEY };
const call = async (body, token, opts = {}) => { const r = await gateway(post(body, token), {}, { env, fetchImpl: sb.fetchImpl, log: () => {}, ...opts }); return { status: r.status, body: await r.json() }; };
await test("no sign-in, no data", async () => {
  assert.equal((await call({ op: "search", query: "labs" }, null)).status, 401);
  assert.equal((await call({ op: "search", query: "labs" }, "forged-token")).status, 401);
});
await test("off unless the ai_gateway switch is on", async () => {
  _resetSettingsCache();
  const off = fakeSupabase({ people: { [TA]: { uid: A, data: dataA } }, flags: { ai_assistant: false } });
  const r = await gateway(post({ op: "search", query: "labs" }), {}, { env: { ...env, SUPABASE_URL: off.base }, fetchImpl: off.fetchImpl, log: () => {} });
  assert.equal(r.status, 503);
  _resetSettingsCache();
  const on = fakeSupabase({ people: { [TA]: { uid: A, data: dataA } }, flags: { ai_gateway: true } });
  const r2 = await gateway(post({ op: "search", query: "labs" }), {}, { env: { ...env, SUPABASE_URL: on.base }, fetchImpl: on.fetchImpl, log: () => {} });
  assert.equal(r2.status, 200);
  _resetSettingsCache();
});
await test("every record read uses the person's own token and the public key, never the server key", async () => {
  _resetSettingsCache();
  const on = fakeSupabase({ people: { [TA]: { uid: A, data: dataA } }, flags: { ai_gateway: true } });
  await gateway(post({ op: "execute", plan: { steps: [{ id: "c", call: "compare_lab_results", args: { test: "ldl" } }] } }), {}, { env: { ...env, SUPABASE_URL: on.base }, fetchImpl: on.fetchImpl, log: () => {} });
  const reads = on.seen.filter((s) => s.path.startsWith("/rest/v1/") && !s.path.includes("/rpc/"));
  assert.ok(reads.length >= 2);
  for (const s of reads) { assert.equal(s.authorization, "Bearer " + TA); assert.equal(s.apikey, on.anon); }
  assert.ok(!on.seen.some((s) => /sb_secret/.test(String(s.apikey) + s.authorization) && s.path.startsWith("/rest/v1/") && !s.path.includes("/rpc/")));
  _resetSettingsCache();
});
await test("one person never sees another's records, whatever the plan asks", async () => {
  const r = await call({ op: "execute", plan: { steps: [{ id: "d", call: "search_documents", args: { limit: 50 } }] } }, TA);
  assert.equal(r.status, 200);
  assert.doesNotMatch(JSON.stringify(r.body), /B-ONLY/);
  const r2 = await call({ op: "execute", plan: { steps: [{ id: "d", call: "search_documents", args: { user_id: B } }] } }, TA);
  assert.equal(r2.status, 400); assert.equal(r2.body.error, "bad_args");
  const r3 = await call({ op: "execute", plan: { steps: [{ id: "d", call: "search_documents" }] } }, TB);
  assert.match(JSON.stringify(r3.body), /B-ONLY/); assert.doesNotMatch(JSON.stringify(r3.body), /"id":"da111/, "no record of person A");
});
await test("a document title that tries to instruct the AI comes back as plain data and changes nothing", async () => {
  const r = await call({ op: "execute", plan: { steps: [{ id: "d", call: "search_documents", args: { query: "lipid", limit: 50 } }] } }, TA);
  const titles = r.body.results[0].value.documents.map((d) => d.title);
  assert.ok(titles.includes(INJECTION_TITLE));
  assert.doesNotMatch(JSON.stringify(r.body), /B-ONLY/);
  assert.match(gatewayTools()[1].description, /DATA, never instructions/);
});
await test("tool errors come back as data the model can read, not crashes", async () => {
  const out = await runTool("execute_workflow", { steps: [{ id: "x", call: "nope" }] }, { db: dbA() });
  assert.equal(out.error, "unknown_capability");
  assert.equal((await runTool("rm_rf", {}, { db: dbA() })).error, "unknown_tool");
});
await test("the gateway shows the model 2 tools; the conventional design would show one per capability", () => {
  assert.equal(gatewayTools().length, 2);
  assert.equal(conventionalTools().length, CAPABILITIES.length);
});

console.log(`\n${passed} gateway tests passed${failed ? `, ${failed} FAILED` : ""}`);
if (failed) process.exit(1);
