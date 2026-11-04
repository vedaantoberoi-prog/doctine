import { chromium } from "playwright";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
import { readFileSync } from "node:fs";
const fake = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const out = []; const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch(); const ctx = await b.newContext(); await ctx.addInitScript(fake);
const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(e.message)); pg.on("dialog", (d) => d.accept());
let n = 0;
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: '{"supabaseUrl":"https://x.supabase.co","supabaseAnonKey":"anon","accounts":"supabase"}' });
  if (u.endsWith("/api/chat")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "Answer " + (++n), urgency: "routine", sections: [] }) });
  if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(700);
const W = (ms) => pg.waitForTimeout(ms);
const register = async (name, email) => { await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", name); await pg.fill("input[name=email]", email); await pg.fill("input[name=pw]", "secret123"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(500); };
const signIn = async (email) => { await pg.fill("input[name=email]", email); await pg.fill("input[name=pw]", "secret123"); await pg.click("#lf button.pri"); await W(700); };
const signOut = async () => { await pg.evaluate("document.getElementById('out').click()"); await W(400); };
const historyOnSetting = async () => { await pg.evaluate("go('settings')"); const c = await pg.$("[data-c=history]"); if (c && !(await c.isChecked())) await pg.check("[data-c=history]"); await W(900); };
const say = async (t) => { await pg.evaluate("go('chat')"); await pg.fill("#ci", t); await pg.click("#cf button.pri"); await W(600); };
const uidOf = (email) => pg.evaluate((e) => window.__sbdb.users[e].user.id, email);

// 1. A saves successfully
await register("Asha", "a@example.com"); await historyOnSetting(); await say("A-first: my thyroid report");
const A = await uidOf("a@example.com");
check("1. account A's chat is saved in A's account", await pg.evaluate((a) => (window.__sbdb.tables.messages || []).filter((m) => m.user_id === a).length === 2, A));
// 2. A's save fails and stays pending
await pg.evaluate(() => { window.__failTable = "messages"; }); await say("A-secret: I am HIV positive");
check("2. a failed save says so", (await pg.textContent("#view")).includes("couldn’t be saved"));
// 3. A signs out
await pg.evaluate(() => { window.__failTable = null; }); await signOut();
check("3. signed out", await pg.evaluate("S.email===null&&!S.cloud"));
// 4–6. B signs in, enables chat history and sends a message
await register("Bharat", "b@example.com"); const B = await uidOf("b@example.com");
await historyOnSetting(); await say("B-hello: what is BMI?"); await W(800);
const w = await pg.evaluate(() => window.__writes);
const leakedToB = w.filter((x) => x.session === B && JSON.stringify(x.rows).includes("A-secret"));
const leakedRowsB = await pg.evaluate((b) => (window.__sbdb.tables.messages || []).filter((m) => m.user_id === b).map((m) => m.content), B);
check("7. A's pending message was never sent under B's sign-in", leakedToB.length === 0, leakedToB.length ? "sent " + leakedToB.length + " time(s)" : "");
check("7. B's account holds only B's messages", leakedRowsB.every((c) => !c.includes("A-")) && leakedRowsB.some((c) => c.includes("B-hello")), JSON.stringify(leakedRowsB));
const aConv1 = await pg.evaluate((a) => (window.__sbdb.tables.conversations || []).filter((c) => c.user_id === a).map((c) => c.id), A);
check("7. no request under B used A's conversation", !w.some((x) => x.session === B && x.table === "messages" && x.rows.some((r) => aConv1.includes(r.conversation_id))));
check("A's unsent message was not saved anywhere (it was discarded at sign-out, with a warning)", !(await pg.evaluate(() => JSON.stringify(window.__sbdb.tables.messages || []).includes("A-secret"))));
// switch while a save is in flight
await signOut(); await signIn("a@example.com"); await pg.evaluate(() => { window.__delay = { conversations: 1200, messages: 1200 }; });
await pg.evaluate("go('chat')"); await pg.fill("#ci", "A-inflight: my pregnancy test"); await pg.click("#cf button.pri"); await W(150);
await signOut(); await signIn("b@example.com"); await pg.evaluate(() => { window.__delay = {}; }); await say("B-second: sleep tips"); await W(2500);
const w2 = await pg.evaluate(() => window.__writes);
check("in-flight: nothing of A's is sent under B's sign-in after switching", !w2.some((x) => x.session === B && JSON.stringify(x.rows).includes("A-")));
const bRows = await pg.evaluate((b) => (window.__sbdb.tables.messages || []).filter((m) => m.user_id === b).map((m) => m.content), B);
check("in-flight: B's account still holds only B's messages", bRows.every((c) => !c.includes("A-")), JSON.stringify(bRows));
const aConvIds = await pg.evaluate((a) => (window.__sbdb.tables.conversations || []).filter((c) => c.user_id === a).map((c) => c.id), A);
check("in-flight: B never writes into one of A's conversations", !w2.some((x) => x.session === B && x.table === "messages" && x.rows.some((r) => aConvIds.includes(r.conversation_id))));
// "saved" is shown only once Supabase confirms
await pg.evaluate(() => { window.__delay = { messages: 1500 }; }); await pg.evaluate("go('chat')"); await pg.fill("#ci", "B-third: vitamin D"); await pg.click("#cf button.pri"); await W(500);
check("while the save is in progress, the chat says 'Saving…', not 'saved'", (await pg.textContent("#view")).includes("Saving this chat"));
await W(1800); check("after Supabase confirms, the chat says it is saved", (await pg.textContent("#view")).includes("This chat is saved in your Doctine account"));
await pg.evaluate(() => { window.__delay = {}; });
// switching saving off while a message is waiting discards it and says so
await pg.evaluate(() => { window.__failTable = "messages"; }); await say("B-pending: private note");
await pg.evaluate(() => { window.__failTable = null; }); await pg.evaluate("go('settings')"); await pg.uncheck("[data-c=history]"); await W(300);
const toastTxt = await pg.textContent("#toast");
check("switching saving off discards the waiting message and says so", toastTxt.includes("1 unsaved message was discarded"), toastTxt);
await pg.check("[data-c=history]"); await W(600); await say("B-after: next question"); await W(500);
check("the discarded message is never saved later", !(await pg.evaluate(() => JSON.stringify(window.__sbdb.tables.messages).includes("B-pending"))));
// signing out with something unsaved asks first
await pg.evaluate(() => { window.__failTable = "messages"; }); await say("B-unsaved: another note"); await pg.evaluate(() => { window.__failTable = null; });
let dlg = ""; pg.removeAllListeners("dialog"); pg.once("dialog", (d) => { dlg = d.message(); d.dismiss(); });
await pg.evaluate("document.getElementById('out').click()"); await W(300);
check("sign-out warns when messages aren't saved, and cancelling keeps you signed in", dlg.includes("haven’t been saved") && await pg.evaluate("S.cloud===true"));
pg.on("dialog", (d) => d.accept());
// records being saved when the account switches: nothing of B's sign-in carries A's data
await signOut(); await signIn("a@example.com"); await pg.evaluate(() => { window.__delay = { medicines: 1500, medication_schedules: 1500 }; });
await pg.evaluate("go('medicines')"); await pg.fill("#mf [name=name]", "A-med Levothyroxine"); await pg.fill("#mf [name=dose]", "50 mcg"); await pg.click("#mf button.pri"); await W(900);
await signOut(); await signIn("b@example.com"); await pg.evaluate(() => { window.__delay = {}; }); await W(2500);
const w3 = await pg.evaluate(() => window.__writes);
check("records: nothing of A's is written under B's sign-in after switching mid-save", !w3.some((x) => x.session === B && JSON.stringify(x.rows).includes("A-med")));
check("records: B sees none of A's medicines", !(await pg.evaluate("S.meds.some(m=>m.name.includes('A-med'))")) && !(await pg.evaluate((b) => (window.__sbdb.tables.medicines || []).some((m) => m.user_id === b && m.name.includes("A-med")), B)));
check("records: no error about A's save is shown to B", !(await pg.textContent("#banner")).includes("aren’t saved"));
// page images cached for A are removed from this browser when A signs out
await signOut(); await signIn("a@example.com"); await pg.evaluate(async () => { await IMG.put("scan:1:0", new Blob(["x"], { type: "image/jpeg" })); });
await signOut();
const left = await pg.evaluate(async () => { const d = await IMG.open(); return new Promise((r) => { const q = d.transaction("img").objectStore("img").count(); q.onsuccess = () => r(q.result); }); });
check("signing out removes cached page images from this browser", left === 0, String(left));
check("no JavaScript errors on the page", errs.length === 0, errs.join(" | "));
console.log(out.filter((x) => x.startsWith("PASS")).length + "/" + out.length + " passed");
await b.close(); process.exit(out.some((x) => x.startsWith("FAIL")) ? 1 : 0);
