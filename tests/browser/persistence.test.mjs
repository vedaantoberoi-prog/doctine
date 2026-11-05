import { chromium } from "playwright";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
import { readFileSync } from "node:fs";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const results = [], errs = [];
const check = (name, ok, detail = "") => { const line = (ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""); results.push(line); console.log(line); };
const b = await chromium.launch();
async function device(seedDb) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  if (seedDb) await ctx.addInitScript((db) => { if (!localStorage.getItem("__sbdb")) localStorage.setItem("__sbdb", db); }, seedDb);
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message));
  await pg.route("**/*", async (r) => { const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase" }) });
    if (u.endsWith("/api/scan")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ doc: { title: "Lab report – City Lab – 1 Nov 2026", type: "lab_report", date: "2026-11-01", medicines: [{ raw: "Tab Telma 40 0-0-1", name: "Telma 40", frequency: "0-0-1", confidence: "high" }], lab_results: [{ test: "HbA1c", value: "6.1", unit: "%", range: "4-5.6", flag: "high", confidence: "high" }], overall_confidence: "high", transcription: "HbA1c 6.1 %" } }) });
    if (u.endsWith("/api/chat")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "An HbA1c of 6.1% is in the prediabetes range.", urgency: "routine", sections: [{ title: "What helps", body: "Regular activity and less refined sugar." }], state: { mode: "record", topic: "HbA1c" } }) });
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(700);
  return { ctx, pg };
}
const photo = `(async()=>{const c=document.createElement('canvas');c.width=1200;c.height=1600;const x=c.getContext('2d');x.fillStyle='#5a3d28';x.fillRect(0,0,1200,1600);x.fillStyle='#f3efe6';x.fillRect(200,200,800,1200);x.fillStyle='#223';x.font='48px serif';x.fillText('HbA1c 6.1',300,500);const b=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));return new File([b],'lab.jpg',{type:'image/jpeg'})})()`;

// ===== Device 1 =====
let { ctx, pg } = await device(null);
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Meera"); await pg.fill("input[name=email]", "meera@example.com"); await pg.fill("input[name=pw]", "secret123"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await pg.waitForTimeout(500);
check("signed in with a Doctine account, labelled as such", await pg.evaluate("S.cloud") && (await pg.textContent("#who")).includes("Doctine account"));
await pg.evaluate("go('health')"); for (const [k, v] of [["dob", "1979-03-02"], ["height", "158"], ["weight", "64"], ["blood", "A+"], ["allergies", "Sulfa"]]) { await pg.fill(`[data-p=${k}]`, v); await pg.dispatchEvent(`[data-p=${k}]`, "change"); }
await pg.evaluate("go('reports')"); await pg.evaluate(`(async()=>{const f=await ${photo};quickScan(false,null,[f])})()`);
await pg.waitForSelector(".scanov [data-x=done]", { timeout: 15000 }); await pg.click(".scanov [data-x=done]"); await pg.waitForTimeout(1500);
await pg.evaluate("go('medicines')"); await pg.fill("#mf [name=name]", "Vitamin D3"); await pg.fill("#mf [name=dose]", "1 sachet"); await pg.selectOption("#freq", "weekly"); await pg.check("input[name=day][value='0']"); await pg.click("[data-mtp='09:00']").catch(()=>{});
await pg.evaluate(() => { S.medDraft.times = ["09:00"]; }); await pg.click("#mf button.pri"); await pg.waitForTimeout(150);
await pg.fill("#mf [name=name]", "Telma 40"); await pg.fill("#mf [name=dose]", "1 tablet at night"); await pg.click("#mf button.pri"); await pg.waitForTimeout(150);
await pg.evaluate(() => { const t = S.meds.find((m) => m.name === "Telma 40"); t.status = "paused"; S.doses[S.meds[0].id + "@09:00@2026-11-01"] = "Taken"; S.doses[S.meds[0].id + "@09:00@2026-10-25"] = "Skipped"; render(); });
await pg.waitForTimeout(1500);
const t1 = await pg.evaluate(() => window.__sbdb.tables);
check("profile saved to the account", t1.health_profiles?.[0]?.blood_group === "A+" && t1.health_profiles[0].allergies === "Sulfa" && t1.health_profiles[0].height_cm == 158);
check("report and its AI reading saved", t1.documents?.[0]?.extraction?.lab_results?.[0]?.test === "HbA1c");
// where the details came from: read automatically until the person checks them; the AI reading itself is never altered
await pg.evaluate("go('reports')"); await pg.waitForTimeout(150);
check("a scanned record says its details were read automatically and aren't checked yet", (await pg.textContent("#view")).includes("Read automatically · not yet checked") && (await pg.textContent("#view")).includes("Original photo kept") && t1.documents[0].source === "scan");
const ex0 = JSON.stringify(t1.documents[0].extraction);
await pg.click("[data-redit]"); await pg.waitForTimeout(150);
check("checking opens the details with a note to compare them with the original", (await pg.textContent("#view")).includes("Compare each one with the original"));
await pg.click("#ucf"); await pg.waitForTimeout(1500);
const d1 = (await pg.evaluate(() => window.__sbdb.tables.documents))[0];
check("once checked, the record says so and the account stores it, with the AI reading unchanged", (await pg.textContent("#view")).includes("Details checked by you") && d1.source === "manual" && JSON.stringify(d1.extraction) === ex0, d1.source);
// a text-PDF report: the values the person confirms are saved, and the original PDF is kept beside them
await pg.evaluate(() => { const f = new File(["%PDF-1.4\n% Doctine test report\n"], "cbc.pdf", { type: "application/pdf" });
  S.upload = { name: f.name, status: "review", rows: [{ k: "Hemoglobin", v: "13.1 g/dL (ref 12–15.5)" }], title: "Complete blood count", date: "2026-10-30", lab: "City Lab", cat: "Lab report", text: "", warns: [], img: null, file: f }; go("reports"); });
await pg.waitForTimeout(100); await pg.click("#ucf"); await pg.waitForTimeout(1600);
const pdfRec = await pg.evaluate("S.reports.find(r=>r.title==='Complete blood count')");
const pdfFile = (await pg.evaluate(() => window.__sbdb.tables.document_files || [])).find((f) => f.content_type === "application/pdf");
check("a confirmed PDF report keeps its original PDF, stored in the person's private folder", pdfRec && pdfRec.orig === "pdf" && pdfFile && pdfFile.kind === "original" && pdfFile.storage_path.startsWith(pdfFile.user_id + "/"), JSON.stringify(pdfFile));
check("the record says the original PDF is kept and offers to open it", (await pg.textContent("#view")).includes("Original PDF kept") && (await pg.$(`[data-opdf="${pdfRec && pdfRec.id}"]`)) !== null);
check("medicines, weekly schedule and paused status saved", t1.medicines?.length === 2 && t1.medication_schedules.some((s) => s.frequency === "weekly" && s.days_of_week.join() === "0") && t1.medicines.some((m) => m.status === "paused"));
check("dose history saved", t1.dose_events?.length === 2);
// chats: not saved while the switch is off
await pg.evaluate("go('chat')"); await pg.fill("#ci", "What does HbA1c 6.1 mean?"); await pg.click("#cf button.pri"); await pg.waitForTimeout(600);
check("with saving off, no chat is stored", !(await pg.evaluate("window.__sbdb.tables.conversations||[]")).length && (await pg.textContent("#view")).includes("This chat isn’t saved"));
await pg.evaluate("go('settings')"); await pg.check("[data-c=history]"); await pg.waitForTimeout(1200);
check("the 'Save my chats' consent is stored", (await pg.evaluate("window.__sbdb.tables.consents")).some((c) => c.kind === "chat_history" && c.granted));
await pg.evaluate("go('chat')"); await pg.click("#newchat").catch(() => {}); await pg.fill("#ci", "How can I lower my HbA1c?"); await pg.click("#cf button.pri"); await pg.waitForTimeout(800);
const conv = await pg.evaluate("({c:(window.__sbdb.tables.conversations||[]).map(c=>c.title),m:(window.__sbdb.tables.messages||[]).map(m=>m.role)})");
check("with saving on, the chat and both messages are stored", conv.c.length === 1 && conv.m.join() === "user,assistant", JSON.stringify(conv));
check("the chat says it is saved only after the account confirms it", (await pg.textContent("#view")).includes("This chat is saved in your Doctine account"));
// a failed save is visible and recovered
await pg.evaluate(() => { window.__failTable = "medicines"; }); await pg.evaluate("go('medicines')");
await pg.fill("#mf [name=name]", "Metformin 500"); await pg.fill("#mf [name=dose]", "1 tablet after dinner"); await pg.click("#mf button.pri"); await pg.waitForTimeout(1500);
const banner = await pg.textContent("#banner");
check("a failed save shows a warning banner with the reason", banner.includes("aren’t saved to your account yet") && banner.includes("Failed to fetch"));
check("leaving the page with unsaved changes is warned about", await pg.evaluate("CLOUD.err!==''"));
check("the failed change is kept, not discarded", await pg.evaluate("S.meds.some(m=>m.name==='Metformin 500')") && !(await pg.evaluate("window.__sbdb.tables.medicines.some(m=>m.name==='Metformin 500')")));
await pg.evaluate(() => { window.__failTable = null; }); await pg.click("[data-syncnow]"); await pg.waitForTimeout(800);
check("'Try again now' saves it and clears the warning", (await pg.evaluate("window.__sbdb.tables.medicines.some(m=>m.name==='Metformin 500')")) && !(await pg.textContent("#banner")).includes("aren’t saved"));
// a failed chat save is visible too
await pg.evaluate(() => { window.__failTable = "messages"; }); await pg.evaluate("go('chat')"); await pg.fill("#ci", "And what about exercise?"); await pg.click("#cf button.pri"); await pg.waitForTimeout(800);
check("a chat that couldn't be saved says so", (await pg.textContent("#view")).includes("couldn’t be saved to your account"));
await pg.evaluate(() => { window.__failTable = null; }); await pg.fill("#ci", "Thanks"); await pg.click("#cf button.pri"); await pg.waitForTimeout(800);
check("the unsaved exchange is saved with the next message", (await pg.evaluate("window.__sbdb.tables.messages.length")) === 6);
// account settings: who is signed in, changing the password, and what deleting removes
await pg.evaluate("go('settings')"); await pg.waitForTimeout(150);
check("Settings shows which account is signed in", (await pg.textContent("#acct")).includes("Signed in as meera@example.com"));
await pg.click("#pwmail"); await pg.waitForTimeout(200);
check("a password-change link can be emailed from Settings", (await pg.textContent("#acct")).includes("We sent a link to meera@example.com"));
check("before deleting, Settings says exactly what is removed and that it can't be undone", /permanently removes your profile, reports, original documents and photos, medicines, dose history, saved chats/.test(await pg.textContent("#view")) && (await pg.textContent("#view")).includes("export first"));
// refresh keeps you signed in and everything loads
await pg.reload(); await pg.waitForTimeout(900);
check("after a refresh, still signed in with all records", await pg.evaluate("S.cloud&&S.reports.length===2&&S.meds.length===3"));
// sign out
await pg.evaluate("document.getElementById('out').click()"); await pg.waitForTimeout(300);
check("signed out leaves no records on screen", await pg.evaluate("S.email===null&&S.reports.length===0&&S.meds.length===0"));
const dbJson = await pg.evaluate(() => JSON.stringify({ ...window.__sbdb }));
await ctx.close();

// ===== Device 2: nothing in this browser except the account =====
({ ctx, pg } = await device(dbJson));
check("new device starts signed out with no local records", await pg.evaluate("S.email===null") && await pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('doctine:v2')||'{\"users\":{}}').users).length===0"));
await pg.fill("input[name=email]", "meera@example.com"); await pg.fill("input[name=pw]", "secret123"); await pg.click("#lf button.pri"); await pg.waitForTimeout(900);
const s2 = await pg.evaluate("({p:S.profile,r:S.reports.map(r=>({t:r.title,f:r.fields,x:!!(r.scan&&r.scan.lab_results)})),m:S.meds.map(m=>({n:m.name,f:m.freq,d:m.days,t:m.times,s:m.status||'active'})),d:Object.values(S.doses).sort(),h:S.consent.history})");
check("profile arrives on the new device", s2.p.name === "Meera" && s2.p.blood === "A+" && s2.p.allergies === "Sulfa" && s2.p.dob === "1979-03-02");
check("report with its extracted results arrives", s2.r.length === 2 && s2.r.some((r) => r.x) && s2.r.some((r) => Object.keys(r.f).includes("HbA1c")));
check("the 'checked by you' status arrives on the new device", await pg.evaluate("S.reports.some(r=>r.scan&&r.checked===true&&provOf(r).k==='ok')"));
check("the original PDF arrives on the new device and can be fetched from private storage", await pg.evaluate("(async()=>{const r=S.reports.find(x=>x.orig==='pdf');if(!r)return false;const b=await cloudImage(`orig:${r.id}:0`);return !!(b&&b.size>0)})()"));
check("medicines with schedules and status arrive", s2.m.length === 3 && s2.m.some((m) => m.f === "weekly" && m.d.join() === "0" && m.t.join() === "09:00") && s2.m.some((m) => m.n === "Telma 40" && m.s === "paused"));
check("dose history arrives", s2.d.join() === "Skipped,Taken");
check("the chat-saving choice arrives", s2.h === true);
await pg.evaluate("go('reports')"); await pg.waitForTimeout(1200);
check("page image is fetched from private storage on the new device", await pg.evaluate("(()=>{const i=document.querySelector('.scanthumb');return !!(i&&i.src.startsWith('blob:'))})()"));
await pg.evaluate("go('chat')"); await pg.click("#histopen"); await pg.waitForTimeout(500);
check("saved chats are listed on the new device", (await pg.textContent("#view")).includes("How can I lower my HbA1c?"));
console.log("VIEW:", (await pg.textContent("#view")).slice(0,300)); await pg.click("[data-conv]", { timeout: 3000 }).catch(e=>console.log("no conv button")); await pg.waitForTimeout(500);
check("a saved chat reopens with its messages", await pg.evaluate("S.msgs.length===6&&S.msgs[1].p.reply.includes('prediabetes')"));
pg.once("dialog", (d) => d.accept()); await pg.evaluate("go('settings')"); await pg.click("#histall"); await pg.waitForTimeout(600);
check("'Delete all saved chats' removes them from the account", (await pg.evaluate("(window.__sbdb.tables.conversations||[]).length+(window.__sbdb.tables.messages||[]).length")) === 0);
check("no JavaScript errors on the page", errs.length === 0, errs.join(" | "));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
await b.close(); process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
