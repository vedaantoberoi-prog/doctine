/**
 * Doctine · server function tests. Run: node tests/functions.test.mjs
 * The Anthropic API is replaced by a stand-in so every success and failure path can be checked without a key or credit.
 * (A real call is checked separately with GET /api/chat?test=1 after deploying.)
 */
import "./hermetic-env.mjs"; // first: the tests must not see this machine's (or the Netlify site's) real settings
import assert from "node:assert/strict";
import chat from "../netlify/functions/chat.mjs";
import scan from "../netlify/functions/scan.mjs";
import { emergencyCheck } from "../netlify/lib/safety.mjs";
import config from "../netlify/functions/config.mjs";
import { checkRate, _resetTokenCache } from "../netlify/lib/ratelimit.mjs";
import { CASES, KNOWN_GAPS } from "./safety-cases.mjs";
import { readFileSync } from "node:fs";
import * as await_import_fs from "node:fs";
import account from "../netlify/functions/account.mjs";

let passed = 0, lastReq = null, reply = null, section = "";
const results = [];
// Every test runs; a failure is recorded with its message and the run exits non-zero at the end.
const test = async (name, fn) => {
  const t0 = Date.now();
  try { await fn(); passed++; results.push({ suite: section, name, status: "passed", ms: Date.now() - t0 }); console.log("  ✓", name); }
  catch (e) { results.push({ suite: section, name, status: "failed", ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 500) }); console.error("  ✗", name, "\n     ", String(e && e.message || e).split("\n")[0]); }
};
const _log = console.log.bind(console);
console.log = (...a) => { if (typeof a[0] === "string" && !a[0].startsWith("  ") && a.length === 1 && !a[0].startsWith("\n")) section = a[0]; _log(...a); };
const anthropic = (status, body) => { reply = { status, body }; };
globalThis.fetch = async (url, init) => {
  lastReq = { url, body: JSON.parse(init.body), headers: init.headers };
  if (reply === "abort") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
  if (reply === "network") throw new TypeError("fetch failed");
  return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), { status: reply.status });
};
const toolReply = (name, input) => ({ content: [{ type: "tool_use", name, input }], stop_reason: "tool_use" });
let ipN = 0;
const call = async (fn, path, body, { method = "POST", ip } = {}) => {
  const res = await fn(new Request("https://doctine.test" + path, { method, body: method === "POST" ? JSON.stringify(body) : undefined }), { ip: ip || "10.0.0." + (++ipN) });
  return [res.status, await res.json()];
};
const user = (t) => ({ role: "user", content: t });

console.log("emergency rules (evaluation set: tests/safety-cases.mjs)");
for (const cat of [...new Set(CASES.map((c) => c[0]))]) {
  await test(`${cat}: ${CASES.filter((c) => c[0] === cat).length} cases`, () => {
    for (const [, text, expect] of CASES.filter((c) => c[0] === cat)) assert.equal(emergencyCheck(text).length > 0, expect, `${expect ? "should" : "should not"} flag: ${text}`);
  });
}
await test("known gaps are still gaps (if one is now caught, move it into CASES)", () => {
  for (const t of KNOWN_GAPS) assert.equal(emergencyCheck(t).length, 0, t);
});
await test("the web page applies exactly the same rules as the server", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const block = html.slice(html.indexOf("/* SAFETY-RULES:START"), html.indexOf("/* SAFETY-RULES:END */"));
  const page = new Function(block + "; return { EMERG, SELFHARM };")();
  const pageFlags = (t) => page.SELFHARM.test(t) || page.EMERG.some((r) => r.test(t));
  for (const [, t] of CASES) assert.equal(pageFlags(t), emergencyCheck(t).length > 0, "page and server differ on: " + t + " (run node tools/sync-safety-rules.mjs)");
  for (const t of KNOWN_GAPS) assert.equal(pageFlags(t), false);
});

console.log("/api/chat");
process.env.ANTHROPIC_API_KEY = "";
await test("no key: clear not_configured error naming the variable", async () => {
  const [s, j] = await call(chat, "/api/chat", { messages: [user("What is anaemia?")] });
  assert.equal(s, 503); assert.equal(j.error, "not_configured"); assert.deepEqual(j.missing, ["ANTHROPIC_API_KEY"]);
});
await test("no key but emergency wording: fixed 112 guidance, marked as coming from the AI being unavailable", async () => {
  const [s, j] = await call(chat, "/api/chat", { messages: [user("my mother has severe chest pain right now")] });
  assert.equal(s, 200); assert.equal(j.urgency, "emergency"); assert.equal(j.safety, "rule"); assert.match(j.reply, /112/); assert.equal(j.ai_unavailable, "not_configured");
});
process.env.ANTHROPIC_API_KEY = "sk-test"; process.env.AI_MODEL = "gpt-4o";

await test("general question: sends model, tool, history; returns frontend shape", async () => {
  anthropic(200, toolReply("respond", { reply: "Anaemia means fewer red blood cells than normal.", sections: [{ title: "Common causes", body: "Iron deficiency is the most common in India." }], urgency: "routine", uncertainty: "", state: { mode: "general", topic: "anaemia" } }));
  const [s, j] = await call(chat, "/api/chat", { messages: [user("What is anaemia?")] });
  assert.equal(s, 200); assert.match(j.reply, /red blood cells/); assert.equal(j.sections.length, 1); assert.equal(j.urgency, "routine"); assert.equal(j.state.topic, "anaemia");
  assert.equal(lastReq.body.model, "claude-sonnet-5-5", "non-Claude AI_MODEL falls back to a Claude model");
  assert.equal(lastReq.body.tool_choice.name, "respond"); assert.equal(lastReq.headers["x-api-key"], "sk-test");
  assert.match(lastReq.body.system, /not shared any saved records/);
});
await test("follow-up keeps history and the assistant's notes (state)", async () => {
  anthropic(200, toolReply("respond", { reply: "Thanks. A headache for 3 days with a blocked nose often points to sinus congestion.", urgency: "routine", question: "Do you have a fever?", options: ["Yes", "No"], state: { mode: "symptom", topic: "headache", known: ["3 days", "blocked nose"], missing: ["fever"] } }));
  const [s, j] = await call(chat, "/api/chat", {
    messages: [user("I have a headache"), { role: "assistant", content: "How long have you had it?" }, user("3 days, and my nose is blocked")],
    state: { mode: "symptom", topic: "headache", known: [], missing: ["duration"] },
  });
  assert.equal(s, 200); assert.equal(lastReq.body.messages.length, 3); assert.equal(lastReq.body.messages[1].role, "assistant");
  assert.match(lastReq.body.system, /Your notes from earlier/); assert.match(lastReq.body.system, /"topic":"headache"/);
  assert.equal(j.question, "Do you have a fever?"); assert.deepEqual(j.state.missing, ["fever"]);
});
await test("record claims are kept only when they cite a record that was sent", async () => {
  anthropic(200, toolReply("respond", { reply: "Your haemoglobin was a little low.", urgency: "routine",
    record_claims: [{ text: "Haemoglobin 11.4 g/dL on 2 Sep", source: "R1" }, { text: "Ferritin 8", source: "R9" }, { text: "no source", source: "" }] }));
  const [, j] = await call(chat, "/api/chat", { messages: [user("Is my haemoglobin okay?")],
    context: { profile: { age: 38, allergies: ["Penicillin"] }, records: [{ id: "R1", title: "CBC", date: "2026-09-02", test: "Hemoglobin", value: "11.4 g/dL (ref 12–15.5)" }] } });
  assert.deepEqual(j.record_claims.map((c) => c.source), ["R1"]);
  assert.match(lastReq.body.system, /chose to share/); assert.match(lastReq.body.system, /Penicillin/);
});
await test("emergency wording forces emergency even if the model says routine", async () => {
  anthropic(200, toolReply("respond", { reply: "Please call 112 now.", urgency: "routine", current_emergency: true }));
  const [, j] = await call(chat, "/api/chat", { messages: [user("my husband suddenly can't move his left arm and his face is drooping")] });
  assert.equal(j.urgency, "emergency"); assert.equal(j.safety, "rule"); assert.match(lastReq.body.system, /safety check flagged/);
});
await test("a general question about emergency symptoms is not turned into an alarm, but still gets a 112 line", async () => {
  anthropic(200, toolReply("respond", { reply: "Common signs of a stroke include face drooping…", urgency: "routine", current_emergency: false }));
  const [, j] = await call(chat, "/api/chat", { messages: [user("What are the signs of a stroke?")] });
  assert.equal(j.urgency, "routine"); assert.equal(j.safety, undefined); assert.match(j.safety_note, /112/);
});
await test("child and pregnancy emergencies are kept as emergencies; ordinary medicine questions are not", async () => {
  anthropic(200, toolReply("respond", { reply: "Take your child to the nearest emergency department now.", urgency: "same_day", current_emergency: true }));
  let [, j] = await call(chat, "/api/chat", { messages: [user("my 2 year old has a high fever and is very sleepy and hard to wake")] });
  assert.equal(j.urgency, "emergency"); assert.equal(j.safety, "rule");
  anthropic(200, toolReply("respond", { reply: "Go to hospital now; bleeding in pregnancy needs urgent care.", urgency: "emergency", current_emergency: true }));
  [, j] = await call(chat, "/api/chat", { messages: [user("I'm 7 months pregnant and have bleeding")] }); assert.equal(j.urgency, "emergency");
  anthropic(200, toolReply("respond", { reply: "Paracetamol is generally used with most BP medicines, but check with your pharmacist.", urgency: "routine" }));
  [, j] = await call(chat, "/api/chat", { messages: [user("Can I take paracetamol with my blood pressure medicine?")] });
  assert.equal(j.urgency, "routine"); assert.equal(j.safety, undefined); assert.ok(!/safety check flagged/.test(lastReq.body.system));
});
await test("vague messages reach the AI with the instruction to ask one follow-up question", async () => {
  anthropic(200, toolReply("respond", { reply: "I'm sorry you're unwell.", urgency: "routine", question: "What are you feeling most?", options: ["Fever", "Pain", "Tiredness"] }));
  const [, j] = await call(chat, "/api/chat", { messages: [user("I feel unwell")] });
  assert.match(lastReq.body.system, /at most ONE follow-up question/); assert.equal(j.question, "What are you feeling most?"); assert.equal(j.options.length, 3);
});
await test("past events: no alarm when the AI says it isn't happening now, but the right helpline is still given", async () => {
  anthropic(200, toolReply("respond", { reply: "Gentle exercise is often encouraged after recovery, with your cardiologist's advice.", urgency: "routine", current_emergency: false }));
  let [, j] = await call(chat, "/api/chat", { messages: [user("I had a heart attack 5 years ago, can I start jogging?")] });
  assert.equal(j.urgency, "routine"); assert.match(j.safety_note, /112/);
  anthropic(200, toolReply("respond", { reply: "Thank you for sharing that. It's good to hear you're doing okay.", urgency: "routine", current_emergency: false }));
  [, j] = await call(chat, "/api/chat", { messages: [user("I used to self-harm as a teenager, I'm okay now")] });
  assert.equal(j.urgency, "routine"); assert.match(j.safety_note, /14416/);
  anthropic(200, toolReply("respond", { reply: "Please call 112.", urgency: "routine" }));
  [, j] = await call(chat, "/api/chat", { messages: [user("I had a heart attack 5 years ago and now I have crushing chest pain again")] });
  assert.equal(j.urgency, "emergency", "when the AI doesn't say it's only historical, the rules keep it an emergency");
});
await test("flagged emergencies always carry 112, and self-harm always carries Tele-MANAS, whatever the AI wrote", async () => {
  anthropic(200, toolReply("respond", { reply: "I'm sorry you're feeling this way. Please talk to someone you trust.", urgency: "emergency", current_emergency: true }));
  let [, j] = await call(chat, "/api/chat", { messages: [user("I don't see any point in living anymore")] });
  assert.equal(j.urgency, "emergency"); assert.match(j.safety_note, /112/); assert.match(j.safety_note, /14416/);
  anthropic(200, toolReply("respond", { reply: "Call 112 now. Tele-MANAS 14416 is free and open 24×7.", urgency: "emergency", current_emergency: true }));
  [, j] = await call(chat, "/api/chat", { messages: [user("I want to end my life")] });
  assert.ok(!j.safety_note, "nothing duplicated when the AI already gave both");
  anthropic(200, toolReply("respond", { reply: "Lay him on his side and stay with him.", urgency: "emergency", current_emergency: true }));
  [, j] = await call(chat, "/api/chat", { messages: [user("he collapsed and is unconscious")] });
  assert.match(j.safety_note, /112/); assert.doesNotMatch(j.safety_note, /14416/);
});
await test("AI fails during an emergency: fixed guidance instead of an error", async () => {
  anthropic(500, "boom");
  const [s, j] = await call(chat, "/api/chat", { messages: [user("I want to kill myself")] });
  assert.equal(s, 200); assert.match(j.reply, /14416/); assert.equal(j.ai_unavailable, "ai_error");
});
await test("a provider error is logged as status and type only: no message text, no reply body, no key", async () => {
  const saved = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = "sk-ant-LOGTEST-SECRET";
  anthropic(500, { error: { type: "api_error", message: "echo: PRIVATE-HEALTH-TEXT my HbA1c is 9" } });
  const lines = []; const e = console.error; console.error = (...a) => lines.push(a.join(" "));
  try { await call(chat, "/api/chat", { messages: [user("PRIVATE-HEALTH-TEXT my HbA1c is 9")] }); } finally { console.error = e; process.env.ANTHROPIC_API_KEY = saved; }
  const all = lines.join("\n");
  assert.match(all, /\[ai\] anthropic error 500 api_error/);
  assert.ok(!/PRIVATE-HEALTH-TEXT|HbA1c|LOGTEST-SECRET/.test(all), "nothing sensitive logged: " + all);
});
await test("provider errors map to the app's error codes", async () => {
  const cases = [[401, "", "invalid_key"], [403, "", "key_forbidden"], [404, "", "model_not_found"], [429, "", "ai_rate_limited"], [529, "", "ai_busy"],
    [400, '{"error":{"message":"Your credit balance is too low"}}', "insufficient_credits"], [500, "x", "ai_error"]];
  for (const [st, body, code] of cases) { anthropic(st, body); const [, j] = await call(chat, "/api/chat", { messages: [user("What is BMI?")] }); assert.equal(j.error, code, String(st)); }
  reply = "abort"; let [s, j] = await call(chat, "/api/chat", { messages: [user("What is BMI?")] }); assert.equal(j.error, "ai_timeout"); assert.equal(s, 504);
  reply = "network"; [, j] = await call(chat, "/api/chat", { messages: [user("What is BMI?")] }); assert.equal(j.error, "ai_network");
  anthropic(200, { content: [{ type: "text", text: "hi" }] }); [, j] = await call(chat, "/api/chat", { messages: [user("What is BMI?")] }); assert.equal(j.error, "bad_output");
});
await test("input validation", async () => {
  let [s, j] = await call(chat, "/api/chat", { messages: [] }); assert.equal(s, 400);
  [s] = await call(chat, "/api/chat", { messages: [user("hi"), { role: "assistant", content: "hello" }] }); assert.equal(s, 400, "must end with the person's message");
  [s, j] = await call(chat, "/api/chat", { messages: [user("x".repeat(2001))] }); assert.equal(s, 413); assert.equal(j.error, "too_large");
  [s] = await call(chat, "/api/chat", { messages: Array.from({ length: 21 }, () => user("hi")) }); assert.equal(s, 400);
  const res = await chat(new Request("https://doctine.test/api/chat", { method: "POST", body: "{not json" }), { ip: "9.9.9.9" }); assert.equal(res.status, 400);
});
await test("rate limit per address", async () => {
  anthropic(200, toolReply("respond", { reply: "ok", urgency: "routine" }));
  let last;
  for (let i = 0; i < 41; i++) [last] = await call(chat, "/api/chat", { messages: [user("What is BMI?")] }, { ip: "7.7.7.7" });
  assert.equal(last, 429);
});
await test("GET ?test=1 makes a real tiny call and reports the result", async () => {
  anthropic(200, { content: [{ type: "text", text: "ok" }] });
  let [, j] = await call(chat, "/api/chat?test=1", null, { method: "GET" }); assert.equal(j.ok, true); assert.equal(j.model, "claude-sonnet-5-5"); assert.equal(lastReq.body.max_tokens, 5);
  anthropic(401, ""); [, j] = await call(chat, "/api/chat?test=1", null, { method: "GET" }); assert.equal(j.ok, false); assert.equal(j.error, "invalid_key");
});

console.log("knowledge retrieval (off by default)");
await test("with no knowledge provider, answers carry no sources and the AI is told not to cite documents", async () => {
  delete process.env.KNOWLEDGE_PROVIDER;
  anthropic(200, toolReply("respond", { reply: "Dengue is a viral infection spread by mosquitoes.", urgency: "routine", citations: ["K1"] }));
  const [, j] = await call(chat, "/api/chat", { messages: [user("What is dengue?")] });
  assert.deepEqual(j.sources, []); assert.equal(j.knowledge, "off"); assert.match(lastReq.body.system, /No reference passages are available/);
});
const kbFetch = (passages, { fail = false } = {}) => { const anth = globalThis.fetch; return async (url, init) => {
  if (url.startsWith("https://kb.test")) { if (fail) throw new Error("down"); return new Response(JSON.stringify({ passages })); }
  return anth(url, init); }; };
await test("with a provider, only cited passages that were retrieved, from allowed domains, become sources", async () => {
  process.env.KNOWLEDGE_PROVIDER = "http"; process.env.KNOWLEDGE_URL = "https://kb.test/search";
  const saved = globalThis.fetch;
  globalThis.fetch = kbFetch([
    { title: "Dengue fact sheet", publisher: "WHO", url: "https://www.who.int/news-room/fact-sheets/detail/dengue-and-severe-dengue", text: "Dengue is a viral infection transmitted to humans through the bite of infected mosquitoes." },
    { title: "Random blog", publisher: "Blog", url: "https://example-health-blog.com/dengue", text: "Papaya leaf cures dengue." },
  ]);
  anthropic(200, toolReply("respond", { reply: "Dengue spreads through mosquito bites.", urgency: "routine", citations: ["K1", "K2", "K7"] }));
  const [, j] = await call(chat, "/api/chat", { messages: [user("How does dengue spread?")] });
  assert.equal(j.knowledge, "ok"); assert.equal(j.sources.length, 1); assert.equal(j.sources[0].publisher, "WHO");
  assert.match(lastReq.body.system, /\[K1\] Dengue fact sheet/); assert.ok(!/Papaya leaf/.test(lastReq.body.system), "passages from domains not on the list are dropped");
  globalThis.fetch = saved;
});
await test("if the knowledge service fails, the assistant still answers, without sources", async () => {
  const saved = globalThis.fetch; globalThis.fetch = kbFetch([], { fail: true });
  anthropic(200, toolReply("respond", { reply: "Dengue spreads through mosquito bites.", urgency: "routine" }));
  const [s2, j] = await call(chat, "/api/chat", { messages: [user("How does dengue spread?")] });
  assert.equal(s2, 200); assert.equal(j.knowledge, "unavailable"); assert.deepEqual(j.sources, []);
  globalThis.fetch = saved; delete process.env.KNOWLEDGE_PROVIDER; delete process.env.KNOWLEDGE_URL;
});

await test("retrieval refuses unsafe links, bad replies and an insecure service address", async () => {
  const { retrieve } = await import("../netlify/lib/knowledge.mjs");
  const env = { KNOWLEDGE_PROVIDER: "http", KNOWLEDGE_URL: "https://kb.test/search" };
  const reply = (body) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body));
  const good = { title: "Dengue", publisher: "WHO", url: "https://www.who.int/x", text: "Dengue is viral." };
  let r = await retrieve({ query: "dengue" }, { env, fetchImpl: reply({ index_version: "2026-11-01", passages: [good, { ...good }, { ...good, url: "https://user:pw@who.int/y" }, { ...good, url: "https://142.250.1.1/z" },
    { ...good, url: "https://who.int.evil.com/z" }, { ...good, url: "http://www.who.int/plain" }, { ...good, publisher: "" , url: "https://who.int/nopub" }] }) });
  assert.equal(r.passages.length, 1, JSON.stringify(r.passages.map((p) => p.url))); assert.equal(r.version, "2026-11-01");
  r = await retrieve({ query: "dengue" }, { env, fetchImpl: reply("not json") }); assert.equal(r.status, "invalid_response");
  r = await retrieve({ query: "dengue" }, { env, fetchImpl: reply({ passages: "nope" }) }); assert.equal(r.status, "invalid_response");
  r = await retrieve({ query: "dengue" }, { env, fetchImpl: reply("x".repeat(250_000)) }); assert.equal(r.status, "invalid_response");
  r = await retrieve({ query: "dengue" }, { env: { ...env, KNOWLEDGE_URL: "http://kb.test/search" }, fetchImpl: reply({ passages: [good] }) }); assert.equal(r.status, "misconfigured");
  r = await retrieve({ query: "dengue" }, { env: { ...env, KNOWLEDGE_TIMEOUT_MS: "50" }, fetchImpl: (u, i) => new Promise((_, rej) => i.signal.addEventListener("abort", () => rej(new Error("aborted")))) }); assert.equal(r.status, "unavailable");
});

console.log("/api/scan (unchanged behaviour on the shared helpers)");
await test("read returns a cleaned document", async () => {
  anthropic(200, toolReply("record_document", { title: "Prescription – Dr. A. Kumar – 28 Oct 2026", type: "prescription", medicines: [{ raw: "Tab Pan-D", name: "Pan-D", confidence: "maybe" }], overall_confidence: "medium", transcription: "Rx", junk: 1 }));
  const [s, j] = await call(scan, "/api/scan", { action: "read", images: [{ media_type: "image/jpeg", data: "QUJD" }] });
  assert.equal(s, 200); assert.equal(j.doc.title, "Prescription – Dr. A. Kumar – 28 Oct 2026"); assert.equal(j.doc.medicines[0].confidence, "low"); assert.ok(!("junk" in j.doc));
  assert.equal(lastReq.body.tool_choice.name, "record_document"); assert.equal(lastReq.body.messages[0].content[0].type, "image");
});
await test("explain answers about the document", async () => {
  anthropic(200, toolReply("explain", { reply: "This is a prescription for acidity.", urgency: "routine" }));
  const [s, j] = await call(scan, "/api/scan", { action: "explain", doc: { title: "Rx" }, messages: [user("Explain")] });
  assert.equal(s, 200); assert.match(j.reply, /acidity/); assert.match(lastReq.body.messages[0].content, /^The document, as read/);
});
await test("scan rejects non-image uploads and maps provider errors", async () => {
  let [s] = await call(scan, "/api/scan", { action: "read", images: [{ media_type: "text/html", data: "x" }] }); assert.equal(s, 400);
  anthropic(401, ""); let [, j] = await call(scan, "/api/scan", { action: "read", images: [{ media_type: "image/jpeg", data: "QUJD" }] }); assert.equal(j.error, "invalid_key");
  [, j] = await call(scan, "/api/scan", null, { method: "GET" }); assert.equal(j.ok, true);
});

console.log("/api/config and /api/account");
await test("config hands out only the public Supabase settings", async () => {
  delete process.env.SUPABASE_URL; let r = await config(new Request("https://d/api/config")); let j = await r.json(); assert.equal(j.accounts, "browser_demo");
  process.env.SUPABASE_URL = "https://abc.supabase.co/"; process.env.SUPABASE_ANON_KEY = "anon-key"; process.env.SUPABASE_SERVICE_ROLE_KEY = "service-secret";
  r = await config(new Request("https://d/api/config")); j = await r.json();
  assert.equal(j.supabaseUrl, "https://abc.supabase.co"); assert.equal(j.supabaseAnonKey, "anon-key"); assert.ok(!JSON.stringify(j).includes("service-secret"));
});
await test("config reports the site environment, and only known names", async () => {
  const saved = process.env.DOCTINE_ENV;
  for (const [v, want] of [["staging", "staging"], ["PRODUCTION", "production"], ["", "unset"], ["prod; drop", "unset"]]) {
    process.env.DOCTINE_ENV = v; const j = await (await config(new Request("https://d/api/config"))).json(); assert.equal(j.environment, want);
  }
  if (saved === undefined) delete process.env.DOCTINE_ENV; else process.env.DOCTINE_ENV = saved;
});
/* A small stand-in for Supabase Storage + Auth admin, with real paging (limit/offset) and per-path deletion. */
function storageSim({ files, failDeleteBatch = -1, stuck = [], failListAt = -1 }) {
  const live = new Set(files); let deleteCalls = 0, listCalls = 0; const log = [];
  const uid = "aaaaaaaa-0000-0000-0000-000000000001";
  globalThis.fetch = async (url, init = {}) => {
    const u = url.replace("https://abc.supabase.co", ""); log.push((init.method || "GET") + " " + u);
    if (u === "/auth/v1/user") return new Response(JSON.stringify({ id: uid }));
    if (u.startsWith("/storage/v1/object/list/")) {
      if (++listCalls === failListAt) return new Response("{}", { status: 500 });
      const { prefix, limit, offset } = JSON.parse(init.body);
      const names = new Map();
      for (const f of [...live].sort()) if (f.startsWith(prefix + "/")) { const rest = f.slice(prefix.length + 1), seg = rest.split("/")[0]; if (!names.has(seg)) names.set(seg, rest.includes("/") ? null : "file-id"); }
      const page = [...names].slice(offset, offset + limit).map(([name, id]) => ({ name, id }));
      return new Response(JSON.stringify(page));
    }
    if (u.startsWith("/storage/v1/object/health-documents") && init.method === "DELETE") {
      if (deleteCalls++ === failDeleteBatch) return new Response("{}", { status: 500 });
      for (const p of JSON.parse(init.body).prefixes) if (!stuck.includes(p)) live.delete(p);
      return new Response("[]");
    }
    if (u.startsWith("/auth/v1/admin/users/")) { log.userDeleted = true; return new Response("{}"); }
    return new Response("{}", { status: 404 });
  };
  return { live, log, uid };
}
const del = (ip) => account(new Request("https://d/api/account", { method: "DELETE", headers: { authorization: "Bearer good" } }), { ip });
const manyFiles = (uid) => { const f = [];
  for (let r = 0; r < 1100; r++) f.push(`${uid}/${1700000000000 + r}/cleaned-0.jpg`, `${uid}/${1700000000000 + r}/original-0.jpg`);   // 1,100 record folders
  for (let i = 0; i < 1500; i++) f.push(`${uid}/1800000000000/page-${String(i).padStart(4, "0")}.jpg`);                                  // one folder with 1,500 files
  f.push("bbbbbbbb-0000-0000-0000-000000000002/1/cleaned-0.jpg");                                                                       // someone else's file
  return f; };
await test("account deletion pages through more than 1,000 folders and files, then deletes the user", async () => {
  const sim = storageSim({ files: manyFiles("aaaaaaaa-0000-0000-0000-000000000001") });
  const r = await del("8.8.8.1"); const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j)); assert.equal(j.files_removed, 3700); assert.equal(sim.log.userDeleted, true);
  assert.equal([...sim.live].length, 1, "only the other person's file remains"); assert.ok([...sim.live][0].startsWith("bbbbbbbb"));
  const lastDelete = sim.log.map((x, i) => [x, i]).filter(([x]) => x.startsWith("DELETE /storage")).pop()[1];
  assert.ok(sim.log.findIndex((x) => x.startsWith("DELETE /auth/v1/admin")) > lastDelete, "the user is deleted only after every file");
});
await test("a failed file batch stops everything: account kept, progress reported", async () => {
  const sim = storageSim({ files: manyFiles("aaaaaaaa-0000-0000-0000-000000000001"), failDeleteBatch: 2 });
  const r = await del("8.8.8.2"); const j = await r.json();
  assert.equal(r.status, 502); assert.equal(j.files_removed, 1000); assert.equal(j.files_total, 3700); assert.match(j.message, /NOT deleted/);
  assert.ok(!sim.log.userDeleted, "account not deleted");
});
await test("files that survive deletion are caught by the final check; account kept", async () => {
  const uid = "aaaaaaaa-0000-0000-0000-000000000001";
  const sim = storageSim({ files: [`${uid}/1/cleaned-0.jpg`, `${uid}/1/original-0.jpg`], stuck: [`${uid}/1/original-0.jpg`] });
  const r = await del("8.8.8.3"); const j = await r.json();
  assert.equal(r.status, 502); assert.equal(j.files_left, 1); assert.ok(!sim.log.userDeleted);
});
await test("a listing failure part-way removes nothing and keeps the account", async () => {
  const sim = storageSim({ files: manyFiles("aaaaaaaa-0000-0000-0000-000000000001"), failListAt: 3 });
  const r = await del("8.8.8.4");
  assert.equal(r.status, 502); assert.ok(!sim.log.some((x) => x.startsWith("DELETE")), "no deletion started"); assert.equal(sim.live.size, 3701);
});
await test("an account with no files is deleted cleanly", async () => {
  const sim = storageSim({ files: [] }); const r = await del("8.8.8.5"); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.files_removed, 0); assert.ok(sim.log.userDeleted);
});
await test("a bad token removes nothing", async () => {
  const calls = []; globalThis.fetch = async (url, init = {}) => { calls.push((init.method || "GET") + " " + url); return url.endsWith("/auth/v1/user") ? new Response("{}", { status: 401 }) : new Response("[]"); };
  const r = await account(new Request("https://d/api/account", { method: "DELETE", headers: { authorization: "Bearer bad" } }), { ip: "8.8.8.6" });
  assert.equal(r.status, 401);
  assert.ok(!calls.some((c) => c.startsWith("DELETE") || c.includes("/object/list/")), "nothing was listed or deleted: " + calls.join(", "));
});

console.log("shared rate limiting (netlify/lib/ratelimit.mjs)");
function limiterSim({ down = false, users = { "tok-a": "aaaaaaaa-0000-0000-0000-000000000001", "tok-b": "bbbbbbbb-0000-0000-0000-000000000002" } } = {}) {
  const counts = new Map(), bodies = []; const sim = { counts, bodies, calls: 0 };
  globalThis.fetch = async (url, init = {}) => {
    if (url.endsWith("/auth/v1/user")) { const t = (init.headers.authorization || "").replace("Bearer ", ""); return users[t] ? new Response(JSON.stringify({ id: users[t] })) : new Response("{}", { status: 401 }); }
    if (url.endsWith("/rest/v1/rpc/rate_limit_hit")) { sim.calls++; if (down) return new Response("{}", { status: 503 });
      const b = JSON.parse(init.body); bodies.push({ ...b, auth: init.headers.authorization }); const k = b.p_bucket + "|" + b.p_subject; const n = (counts.get(k) || 0) + 1; counts.set(k, n);
      return new Response(JSON.stringify([{ allowed: n <= b.p_limit, hits: n, reset_at: new Date(Date.now() + b.p_window_seconds * 1000).toISOString() }])); }
    return new Response("{}", { status: 404 });
  };
  return sim;
}
const rq = (tok, ip = "1.1.1.1") => new Request("https://d/api/chat", { method: "POST", headers: tok ? { authorization: "Bearer " + tok, "x-nf-client-connection-ip": ip } : { "x-nf-client-connection-ip": ip } });
const sharedEnv = { SUPABASE_URL: "https://abc.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service-secret" };
await test("signed-in people are limited per account, across function instances", async () => {
  _resetTokenCache(); const sim = limiterSim(); let last;
  for (let i = 0; i < 61; i++) last = await checkRate(rq("tok-a"), { ip: "1.1.1." + (i % 200) }, "chat", { env: sharedEnv });
  assert.equal(last.allowed, false); assert.equal(last.mode, "shared"); assert.equal(last.who, "user"); assert.ok(last.retryAfter > 0);
  const other = await checkRate(rq("tok-b"), { ip: "1.1.1.1" }, "chat", { env: sharedEnv }); assert.equal(other.allowed, true, "another account is unaffected");
});
await test("anonymous visitors are limited per IP address", async () => {
  _resetTokenCache(); limiterSim(); let last;
  for (let i = 0; i < 21; i++) last = await checkRate(rq(null, "9.9.9.9"), { ip: "9.9.9.9" }, "chat", { env: sharedEnv });
  assert.equal(last.allowed, false); assert.equal(last.who, "ip");
  assert.equal((await checkRate(rq(null, "9.9.9.8"), { ip: "9.9.9.8" }, "chat", { env: sharedEnv })).allowed, true);
});
await test("an invalid sign-in token is treated as anonymous (stricter IP limits)", async () => {
  _resetTokenCache(); limiterSim(); const r = await checkRate(rq("forged-token"), { ip: "5.6.7.8" }, "chat", { env: sharedEnv }); assert.equal(r.who, "ip");
});
await test("the daily AI budget stops all AI requests once reached", async () => {
  _resetTokenCache(); limiterSim(); const env = { ...sharedEnv, AI_DAILY_REQUEST_CAP: "3" }; let last;
  for (let i = 0; i < 4; i++) last = await checkRate(rq(null, "2.2.2." + i), { ip: "2.2.2." + i }, "scan", { ai: true, env });
  assert.equal(last.allowed, false); assert.equal(last.error, "capacity"); assert.equal(last.status, 503);
});
await test("no raw user ids or IP addresses reach the limiter; the service key is sent only to Supabase", async () => {
  _resetTokenCache(); const sim = limiterSim(); await checkRate(rq("tok-a", "203.0.113.7"), { ip: "203.0.113.7" }, "chat", { ai: true, env: sharedEnv });
  const sent = JSON.stringify(sim.bodies.map(({ auth, ...b }) => b));
  assert.ok(!sent.includes("aaaaaaaa") && !sent.includes("203.0.113.7"), sent); assert.ok(sim.bodies.every((b) => b.auth === "Bearer service-secret"));
});
await test("if the shared limiter is down, the local limiter is used and the mode says so", async () => {
  _resetTokenCache(); limiterSim({ down: true }); const r = await checkRate(rq(null, "4.4.4.4"), { ip: "4.4.4.4" }, "chat", { env: sharedEnv });
  assert.equal(r.allowed, true); assert.equal(r.mode, "local");
});
await test("with RATE_LIMIT_REQUIRE_SHARED=true, AI requests are refused while the shared limiter is down", async () => {
  _resetTokenCache(); limiterSim({ down: true }); const r = await checkRate(rq(null, "4.4.4.5"), { ip: "4.4.4.5" }, "chat", { env: { ...sharedEnv, RATE_LIMIT_REQUIRE_SHARED: "true" } });
  assert.equal(r.allowed, false); assert.equal(r.error, "limiter_unavailable"); assert.equal(r.status, 503);
});
await test("without Supabase settings, limits are local-only and reported as such", async () => {
  const r = await checkRate(rq(null, "6.6.6.6"), { ip: "6.6.6.6" }, "chat", { env: {} }); assert.equal(r.mode, "local");
});
await test("a rate-limited emergency still gets 112 guidance", async () => {
  _resetTokenCache(); limiterSim(); Object.assign(process.env, sharedEnv, { ANTHROPIC_API_KEY: "sk-test", AI_DAILY_REQUEST_CAP: "1" });
  await call(chat, "/api/chat", { messages: [user("hello")] }, { ip: "3.3.3.1" });
  const [s2, j] = await call(chat, "/api/chat", { messages: [user("my father can't breathe")] }, { ip: "3.3.3.2" });
  assert.equal(s2, 200); assert.equal(j.urgency, "emergency"); assert.equal(j.ai_unavailable, "capacity");
  const [s3, j3] = await call(chat, "/api/chat", { messages: [user("What is BMI?")] }, { ip: "3.3.3.3" }); assert.equal(s3, 503); assert.equal(j3.error, "capacity");
  delete process.env.AI_DAILY_REQUEST_CAP;
});

console.log("evaluation access (staging only)");
const EVAL_SECRET = "eval-secret-0123456789-abcdefghijklmnop"; // 39 chars, test value only
const erq = (token, ip = "7.7.7.7", extra = {}) => new Request("https://d/api/chat", { method: "POST", headers: { "x-nf-client-connection-ip": ip, ...(token ? { "x-doctine-eval-token": token } : {}), ...extra } });
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };
await test("on production, a correct evaluation token is ignored and normal anonymous limits apply", async () => {
  _resetTokenCache(); limiterSim(); const env = { ...sharedEnv, DOCTINE_ENV: "production", EVAL_ACCESS_TOKEN: EVAL_SECRET }; let last;
  await quiet(async () => { for (let i = 0; i < 21; i++) last = await checkRate(erq(EVAL_SECRET, "7.7.7.1"), { ip: "7.7.7.1" }, "chat", { env }); });
  assert.equal(last.who, "ip"); assert.equal(last.allowed, false, "the 21st request is still limited");
});
await test("with DOCTINE_ENV unset, the token is ignored", async () => {
  _resetTokenCache(); limiterSim(); const r = await quiet(() => checkRate(erq(EVAL_SECRET), { ip: "7.7.7.2" }, "chat", { env: { ...sharedEnv, EVAL_ACCESS_TOKEN: EVAL_SECRET } })); assert.equal(r.who, "ip");
});
await test("on staging, a wrong token falls back to normal limits", async () => {
  _resetTokenCache(); limiterSim(); const env = { ...sharedEnv, DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET };
  const r = await checkRate(erq(EVAL_SECRET + "x"), { ip: "7.7.7.3" }, "chat", { env }); assert.equal(r.who, "ip");
  const r2 = await checkRate(erq(EVAL_SECRET.slice(0, -1)), { ip: "7.7.7.3" }, "chat", { env }); assert.equal(r2.who, "ip");
});
await test("on staging, a secret shorter than 32 characters turns evaluation access off", async () => {
  _resetTokenCache(); limiterSim(); const short = "short-secret-123";
  const r = await quiet(() => checkRate(erq(short), { ip: "7.7.7.4" }, "chat", { env: { ...sharedEnv, DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: short } })); assert.equal(r.who, "ip");
});
await test("on staging, the correct token gets the separate evaluation limit (61 requests pass, public limit unchanged)", async () => {
  _resetTokenCache(); const sim = limiterSim(); const env = { ...sharedEnv, DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET }; let last;
  for (let i = 0; i < 61; i++) last = await checkRate(erq(EVAL_SECRET, "7.7.7.5"), { ip: "7.7.7.5" }, "chat", { ai: true, env });
  assert.equal(last.allowed, true); assert.equal(last.who, "eval");
  assert.ok(sim.bodies.some((b) => b.p_bucket === "eval-eval-1h" && b.p_limit === 300));
  let anon; for (let i = 0; i < 21; i++) anon = await checkRate(erq(null, "7.7.7.6"), { ip: "7.7.7.6" }, "chat", { env });
  assert.equal(anon.allowed, false, "anonymous visitors on the same site keep the normal limit");
});
await test("evaluation requests still count against the daily AI budget", async () => {
  _resetTokenCache(); limiterSim(); const env = { ...sharedEnv, DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET, AI_DAILY_REQUEST_CAP: "2" }; let last;
  for (let i = 0; i < 3; i++) last = await checkRate(erq(EVAL_SECRET), { ip: "7.7.7.7" }, "chat", { ai: true, env });
  assert.equal(last.allowed, false); assert.equal(last.error, "capacity");
});
await test("the evaluation limit itself is enforced (requests over it are refused)", async () => {
  _resetTokenCache(); limiterSim(); const env = { ...sharedEnv, DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET, RATE_LIMIT_EVAL_EVAL_1H: "5" }; let last;
  for (let i = 0; i < 6; i++) last = await checkRate(erq(EVAL_SECRET), { ip: "7.7.7.8" }, "chat", { env });
  assert.equal(last.allowed, false); assert.equal(last.who, "eval");
});
await test("account deletion never uses the evaluation limit", async () => {
  _resetTokenCache(); limiterSim(); const r = await checkRate(erq(EVAL_SECRET), { ip: "7.7.7.9" }, "account", { env: { ...sharedEnv, DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET } });
  assert.equal(r.who, "ip");
});
await test("evaluation logs carry metadata only: no message text, no token, no answer", async () => {
  _resetTokenCache(); limiterSim(); const saved = { ...process.env };
  Object.assign(process.env, sharedEnv, { DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET, ANTHROPIC_API_KEY: "sk-test" });
  const sim = globalThis.fetch;
  globalThis.fetch = async (url, init) => url.includes("anthropic") ? new Response(JSON.stringify(toolReply("respond", { reply: "UNIQUE-ANSWER-TEXT about sugar levels.", sections: [], urgency: "routine", question: "How long?", options: ["Today"] }))) : sim(url, init);
  const lines = []; const l = console.log; console.log = (...a) => lines.push(a.join(" "));
  let res;
  try {
    res = await chat(new Request("https://d/api/chat", { method: "POST", headers: { "x-doctine-eval-token": EVAL_SECRET, "x-doctine-eval-run": "run-42", "x-doctine-eval-case": "MED-007<script>", "x-nf-client-connection-ip": "7.7.8.1" }, body: JSON.stringify({ messages: [user("UNIQUE-QUESTION-TEXT my HbA1c is 7.2")] }) }), { ip: "7.7.8.1" });
  } finally { console.log = l; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
  assert.equal(res.status, 200);
  const evt = lines.filter((x) => x.includes('"doctine_eval"')); assert.equal(evt.length, 1, "one evaluation log line");
  const j = JSON.parse(evt[0]); assert.equal(j.run, "run-42"); assert.equal(j.case, "MED-007script"); assert.equal(j.urgency, "routine"); assert.equal(j.follow_up, true);
  const all = lines.join("\n"); assert.ok(!/UNIQUE-QUESTION|UNIQUE-ANSWER|HbA1c is 7\.2/.test(all), "no health text in logs"); assert.ok(!all.includes(EVAL_SECRET), "token never logged");
  assert.ok(!(await res.text()).includes(EVAL_SECRET), "token never echoed");
});
await test("GET /api/chat?eval=1 says whether the token is accepted, makes no AI call, and is false on production", async () => {
  const saved = { ...process.env }; const prev = globalThis.fetch;
  const ask = async (env, token, ip) => {
    for (const k of ["DOCTINE_ENV", "EVAL_ACCESS_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k];
    Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-test" }, env);
    let aiCalls = 0; globalThis.fetch = async (url) => { if (String(url).includes("anthropic")) aiCalls++; return new Response("{}", { status: 404 }); };
    const r = await chat(new Request("https://d/api/chat?eval=1", { headers: token ? { "x-doctine-eval-token": token } : {} }), { ip });
    return { ...(await r.json()), aiCalls };
  };
  try {
    await quiet(async () => {
      let j = await ask({ DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET }, EVAL_SECRET, "7.7.9.1"); assert.equal(j.eval_access, true); assert.equal(j.aiCalls, 0);
      j = await ask({ DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET }, EVAL_SECRET + "x", "7.7.9.2"); assert.equal(j.eval_access, false);
      j = await ask({ DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET }, null, "7.7.9.3"); assert.equal(j.eval_access, false);
      j = await ask({ DOCTINE_ENV: "production", EVAL_ACCESS_TOKEN: EVAL_SECRET }, EVAL_SECRET, "7.7.9.4"); assert.equal(j.eval_access, false, "never on production, even with the right token");
      for (let i = 0; i < 11; i++) j = await ask({ DOCTINE_ENV: "staging", EVAL_ACCESS_TOKEN: EVAL_SECRET }, "guess-" + i, "7.7.9.5");
      assert.equal(j.error, "rate_limited", "token guessing is rate-limited");
    });
  } finally { globalThis.fetch = prev; for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); }
});
await test("ordinary requests write no evaluation log line", async () => {
  _resetTokenCache(); const saved = { ...process.env }; Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-test" }); delete process.env.SUPABASE_URL;
  anthropic(200, toolReply("respond", { reply: "BMI is weight divided by height squared.", sections: [], urgency: "routine" }));
  const prev = globalThis.fetch; globalThis.fetch = async (url, init) => new Response(JSON.stringify(reply.body), { status: reply.status });
  const lines = []; const l = console.log; console.log = (...a) => lines.push(a.join(" "));
  try { await call(chat, "/api/chat", { messages: [user("What is BMI?")] }); } finally { console.log = l; globalThis.fetch = prev; Object.assign(process.env, saved); }
  assert.ok(!lines.some((x) => x.includes("doctine_eval")));
});

console.log("secrets never reach the browser");
await test("published files contain no server secrets or secret names", () => {
  const { readdirSync, statSync } = await_import_fs;
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = d + "/" + f; return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk(new URL("../public", import.meta.url).pathname)) {
    if (/\.(png|jpg|ico)$/.test(f)) continue;
    const t = readFileSync(f, "utf8");
    assert.ok(!/SERVICE_ROLE|service_role|sk-ant-|ANTHROPIC_API_KEY|RATE_LIMIT_SECRET|KNOWLEDGE_TOKEN/.test(t), "secret material or name in " + f);
  }
});
await test("no server response echoes a secret value", async () => {
  Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-SECRET-1", SUPABASE_SERVICE_ROLE_KEY: "SERVICE-SECRET-2", SUPABASE_URL: "https://abc.supabase.co", SUPABASE_ANON_KEY: "anon", RATE_LIMIT_SECRET: "RL-SECRET-3", KNOWLEDGE_TOKEN: "KB-SECRET-4" });
  _resetTokenCache(); globalThis.fetch = async (url) => url.includes("anthropic") ? new Response("{}", { status: 401 }) : new Response("[]", { status: 503 });
  const outs = [];
  outs.push(JSON.stringify((await call(chat, "/api/chat", { messages: [user("What is BMI?")] }))[1]));
  outs.push(JSON.stringify((await call(chat, "/api/chat?test=1", null, { method: "GET" }))[1]));
  outs.push(JSON.stringify((await call(scan, "/api/scan", null, { method: "GET" }))[1]));
  outs.push(JSON.stringify((await call(scan, "/api/scan", { action: "read", images: [{ media_type: "image/jpeg", data: "QUJD" }] }))[1]));
  outs.push(await (await config(new Request("https://d/api/config"))).text());
  outs.push(await (await account(new Request("https://d/api/account", { method: "DELETE", headers: { authorization: "Bearer x" } }), { ip: "1.2.3.9" })).text());
  for (const o of outs) assert.ok(!/SECRET-|sk-ant-SECRET/.test(o), "secret in response: " + o);
});

const failed = results.filter((r) => r.status === "failed");
_log(`\n${passed} tests passed${failed.length ? `, ${failed.length} FAILED` : ""}`);
if (process.env.REPORT_DIR) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(process.env.REPORT_DIR, { recursive: true });
  writeFileSync(process.env.REPORT_DIR + "/backend.json", JSON.stringify({ suite: "backend", kind: "mocked (Anthropic, Supabase and the limiter are simulated)", passed, failed: failed.length, total: results.length, results }, null, 2));
}
process.exit(failed.length ? 1 : 0);
