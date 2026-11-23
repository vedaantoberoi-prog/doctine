/**
 * Doctine · the chat's orchestrated records path in the app: with the ai_orchestrator switch on and "Use my saved
 * reports" ticked, a records question goes to /api/assist and its facts, AI explanation and sources are shown as
 * separate sections; general questions and a switched-off orchestrator still use /api/chat. Supabase and both APIs are
 * simulated in the browser; FICTIONAL data only.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const out = [], errs = [];
const check = (name, ok, detail = "") => { const line = (ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""); out.push(line); console.log(line); };
const b = await chromium.launch();

const ASSIST = { state: "COMPLETED", route: { category: "C", model: "claude-sonnet-5-5" }, policy_version: "test",
  answer: { kind: "records", text: "What your records show:\nldl cholesterol (mg/dL): 142 mg/dL on 2024-12-10 [E1]; 118 mg/dL on 2026-05-20 [E2].\n  From 2024-12-10 to 2026-05-20: lower by 24 mg/dL across 2 results.\nA difference between two results is arithmetic, not a diagnosis.\n\nWhat this may mean (AI explanation, check with your doctor):\nYour LDL is lower than before [E1][E2].",
    sections: { explanation: "Your LDL is lower than before [E1][E2].", doctor_questions: ["Is this change meaningful for me?"], safety_note: "A difference between two results is arithmetic, not a diagnosis." } },
  evidence: [{ id: "E1", document_title: "Fictional lipid profile", date: "2024-12-10", page: 2, verification: "confirmed_by_person" }, { id: "E2", document_title: "Fictional lipid profile (May)", date: "2026-05-20", page: null, verification: "ai_extracted_unconfirmed" }] };

async function device(features, assistBody = ASSIST, probe = { available: false }, confirmBody = null) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message));
  const calls = [];
  await pg.route("**/*", async (r) => { const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", aiAvailable: true, features }) });
    if (u.endsWith("/api/assist") && r.request().method() === "GET") { calls.push({ api: "probe", auth: r.request().headers().authorization || "" }); return r.fulfill({ contentType: "application/json", body: JSON.stringify(probe) }); }
    if (u.endsWith("/api/assist")) { const b = JSON.parse(r.request().postData() || "{}"); calls.push({ api: b.confirm ? "confirm" : b.verify ? "verify" : "assist", body: b, auth: r.request().headers().authorization || "" });
      return r.fulfill({ contentType: "application/json", body: JSON.stringify(b.confirm && confirmBody ? confirmBody : b.verify ? { answer: { kind: "verified", verified: true } } : assistBody) }); }
    if (u.endsWith("/api/chat")) { calls.push({ api: "chat" }); return r.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "General answer from the chat assistant.", urgency: "routine", sections: [], state: null }) }); }
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(700);
  await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Asha"); await pg.fill("input[name=email]", `asha${Math.random().toString(16).slice(2, 8)}@example.com`); await pg.fill("input[name=pw]", "secret123"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await pg.waitForTimeout(600);
  await pg.evaluate(() => { S.consent.ai = true; S.useRecords = true; go("chat"); });
  return { ctx, pg, calls };
}
const ask = async (pg, q) => { await pg.evaluate((q) => send(q), q); await pg.waitForTimeout(500); return pg.evaluate(() => document.body.innerText); };

{
  const { ctx, pg, calls } = await device({ ai_assistant: true, ai_gateway: true, ai_orchestrator: true });
  const text = await ask(pg, "compare my cholesterol levels over the last two years and explain what changed");
  const a = calls.find((c) => c.api === "assist");
  check("a records question with reports shared goes to /api/assist", !!a && !calls.some((c) => c.api === "chat"));
  check("it sends the message, share_records and a request id, with the person's own sign-in", a && a.body.share_records === true && /^[\w-]{8,64}$/.test(a.body.request_id || "") && /^Bearer /.test(a.auth) && !("user_id" in a.body));
  check("the facts are shown as their own section", text.includes("What your records show") && text.includes("LDL cholesterol (mg/dL): 142 mg/dL on 2024-12-10"));
  check("the AI explanation is labelled and separate", text.includes("What this may mean (AI explanation)"));
  check("sources name the report, date, page and whether it's an unconfirmed AI reading", text.includes("E1: Fictional lipid profile, 2024-12-10, page 2") && text.includes("E2: Fictional lipid profile (May), 2026-05-20 (AI reading, not confirmed)"));
  check("questions for the doctor are offered", text.includes("Is this change meaningful for me?"));
  check("the safety note appears once, and the footer says the values come from their reports", text.split("arithmetic, not a diagnosis").length === 2 && text.includes("Values and dates come from your saved reports") && !text.includes("Doctine has not attached medical sources"));
  await ctx.close();
}
{
  const { ctx, pg, calls } = await device({ ai_assistant: true, ai_gateway: true, ai_orchestrator: true }, { ...ASSIST, answer: { kind: "redirect", code: "use_chat", text: "general" } });
  const text = await ask(pg, "what does LDL mean?");
  check("a general question the orchestrator hands back is answered by /api/chat", calls.map((c) => c.api).join() === "assist,chat" && text.includes("General answer from the chat assistant."));
  await ctx.close();
}
{
  const { ctx, pg, calls } = await device({ ai_assistant: true, ai_gateway: true });
  await ask(pg, "compare my cholesterol levels over the last two years");
  const sent = calls.filter((c) => c.api !== "probe");
  check("with the orchestrator switched off (and not a pilot), the chat is unchanged (/api/chat only)", sent.length === 1 && sent[0].api === "chat");
  await ctx.close();
}
{
  const { ctx, pg, calls } = await device({ ai_assistant: true, ai_gateway: true, ai_orchestrator: true });
  await pg.evaluate(() => { S.useRecords = false; });
  await ask(pg, "compare my cholesterol levels over the last two years");
  check("without “Use my saved reports”, records are not requested (/api/chat only)", calls.length === 1 && calls[0].api === "chat");
  await ctx.close();
}
{
  const { ctx, pg, calls } = await device({ ai_assistant: false, ai_gateway: false, ai_orchestrator: false }, ASSIST, { available: true, pilot: true });
  await pg.waitForTimeout(800);
  const p = calls.find((c) => c.api === "probe");
  check("with the assistant off for everyone, the app asks once whether this account is a pilot (signed in)", !!p && /^Bearer /.test(p.auth));
  const text = await ask(pg, "compare my cholesterol levels over the last two years");
  check("a pilot account's records question goes to /api/assist and is answered", calls.some((c) => c.api === "assist") && text.includes("What your records show"));
  await ctx.close();
}
{
  const { ctx, pg, calls } = await device({ ai_assistant: false, ai_gateway: false, ai_orchestrator: false }, ASSIST, { available: false, pilot: false });
  await pg.waitForTimeout(800);
  await ask(pg, "compare my cholesterol levels over the last two years");
  check("an account that isn't a pilot never sends a records question to /api/assist", calls.some((c) => c.api === "probe") && !calls.some((c) => c.api === "assist"));
  await ctx.close();
}
{
  const PROPOSAL = { state: "AWAITING_CONFIRMATION", route: { category: "A" }, answer: { kind: "proposal", text: "Add a 9:00 pm reminder for Atorvastatin (10 mg)?",
    proposal: { action: "add_reminder", medicine_client_id: "101", medicine_name: "Atorvastatin", time: "21:00", time_label: "9:00 pm", confirmation: "a.b.c.d.e.f", expires_at: "2026-11-23T12:00:00Z" } } };
  const APPROVED = { state: "COMPLETED", answer: { kind: "approved", text: "Approved.", apply: { approved: true, action: "add_reminder", medicine_client_id: "101", medicine_name: "Atorvastatin", time: "21:00" } } };
  const { ctx, pg, calls } = await device({ ai_assistant: true, ai_gateway: true, ai_orchestrator: true, ai_actions: true }, PROPOSAL, { available: false }, APPROVED);
  await pg.evaluate(() => { S.meds.push({ id: 101, name: "Atorvastatin", strength: "10 mg", form: "tablet", amount: "1", unit: "tablet", dose: "1 tablet", status: "active", freq: "daily", days: [], times: ["08:00"], start: "2026-11-01", end: "" }); });
  const text = await ask(pg, "remind me to take my atorvastatin at 9pm");
  check("a reminder request shows the proposal with Review and save / Not now", text.includes("Add a 9:00 pm reminder for Atorvastatin") && !!(await pg.$("[data-aiok]")) && !!(await pg.$("[data-ainot]")));
  await pg.click("[data-aiok]"); await pg.waitForTimeout(600);
  const c = calls.find((x) => x.api === "confirm");
  check("Review and save sends the signed confirmation for exactly the proposed change", !!c && c.body.confirm.token === "a.b.c.d.e.f" && c.body.confirm.time === "21:00" && c.body.confirm.medicine_client_id === "101");
  const st = await pg.evaluate(() => ({ view: S.view, edit: S.medEdit, draft: S.medDraft && S.medDraft.times, mode: S.medDraft && S.medDraft.mode, saved: S.meds.find((m) => m.id === 101).times, form: !!document.querySelector("#mf") }));
  check("the app opens its own medicine editor with 9:00 pm added to the draft (once a day becomes twice a day)", st.view === "medicines" && st.edit === 101 && JSON.stringify(st.draft) === JSON.stringify(["08:00", "21:00"]) && st.form && st.mode === "twice");
  check("nothing is saved until the person presses Save", JSON.stringify(st.saved) === JSON.stringify(["08:00"]));
  await pg.evaluate(async () => { S.meds.find((m) => m.id === 101).times = ["08:00", "21:00"]; await checkPendingAction(); });
  await pg.waitForTimeout(300);
  check("after the save, the app asks the server to verify it", calls.some((x) => x.api === "verify" && x.body.verify.time === "21:00" && x.body.verify.medicine_client_id === "101"));
  await ctx.close();
}
{
  const PROPOSAL = { state: "AWAITING_CONFIRMATION", answer: { kind: "proposal", text: "Add a 9:00 pm reminder for Atorvastatin?", proposal: { action: "add_reminder", medicine_client_id: "101", medicine_name: "Atorvastatin", time: "21:00", time_label: "9:00 pm", confirmation: "a.b.c.d.e.f" } } };
  const { ctx, pg, calls } = await device({ ai_assistant: true, ai_gateway: true, ai_orchestrator: true, ai_actions: true }, PROPOSAL);
  await ask(pg, "remind me to take my atorvastatin at 9pm");
  await pg.click("[data-ainot]"); await pg.waitForTimeout(300);
  const t2 = await pg.evaluate(() => document.body.innerText);
  check("Not now changes nothing and sends nothing", t2.includes("Not changed.") && !calls.some((x) => x.api === "confirm"));
  await ctx.close();
}
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} passed, ${failed} FAILED` : `${out.length}/${out.length} passed`);
process.exit(failed ? 1 : 0);
