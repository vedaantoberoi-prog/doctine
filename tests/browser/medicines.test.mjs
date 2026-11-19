/**
 * Doctine · the Medicines form (six steps), the medicine list and the medical-record cards and page viewer.
 * Demo-account mode (no Supabase); fictional data only. Run through tools/run-browser-tests.mjs.
 */
import { chromium } from "playwright";
import { addMed } from "./med-helper.mjs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const out = [];
const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
const pg = await ctx.newPage();
const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
const W = (ms) => pg.waitForTimeout(ms), txt = () => pg.textContent("#view");
await pg.goto(BASE + "/"); await W(300);
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Tara Test"); await pg.fill("input[name=email]", "tara.meds@example.com"); await pg.fill("input[name=pw]", "fictional-pass-1"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(400);
await pg.evaluate("go('medicines')"); await W(150);

// empty state and opening the form
check("with no medicines, the page explains and offers Add medicine (no form until asked)", !(await pg.$("#mf")) && (await txt()).includes("No medicines yet"));
await pg.click("[data-medadd]"); await W(120);
check("the form has the five steps in order", JSON.stringify(await pg.$$eval("#mf .mx-sech h3", (h) => h.map((x) => x.textContent))) === JSON.stringify(["Medicine", "Dose", "Schedule", "Duration", "Instructions"]));
check("the medicine name has a visible label and is the largest field", (await pg.textContent("#mf .mx-fields .mx-lab")).trim() === "Medicine name" && (await pg.$eval("#mf [name=name]", (e) => parseFloat(getComputedStyle(e).fontSize))) > (await pg.$eval("#mf [name=brand]", (e) => parseFloat(getComputedStyle(e).fontSize))));
check("no schedule is chosen for you", await pg.evaluate("S.medDraft.mode===''&&S.medDraft.times.length===0") && !(await pg.$("#mf [data-mt]")));

// validation
await pg.click("#mf button.pri"); await W(150);
const errsShown = await pg.$$eval("#mf .mx-err", (e) => e.map((x) => x.id));
check("Review with nothing filled shows an error beside each required field", ["mxe-name", "mxe-amount", "mxe-mode"].every((k) => errsShown.includes(k)) && await pg.evaluate("S.meds.length===0"), errsShown.join());
check("the first invalid field gets focus and is marked invalid", await pg.evaluate("document.activeElement&&document.activeElement.name==='name'&&document.activeElement.getAttribute('aria-invalid')==='true'"));
await pg.fill("#mf [name=name]", "Fictional paracetamol"); await W(50);
check("an error clears as soon as the field is fixed", !(await pg.$("#mxe-name")));

// strength vs amount: separate fields, and a sentence that ties them together
await pg.selectOption("#mf [name=form]", "tablet"); await W(80);
check("choosing a form fills the dose unit", await pg.$eval("#mf [name=unit]", (e) => e.value) === "tablet");
await pg.fill("#mf [name=sv]", "500"); await pg.fill("#mf [name=amount]", "2"); await pg.selectOption("#mf [name=unit]", "tablet"); await W(80);
check("strength and amount are separate, and the summary reads '2 tablets of 500 mg'", (await pg.textContent("#mf .mx-sentence")).includes("2 tablets") && (await pg.textContent("#mf .mx-sentence")).includes("500 mg"));
await pg.fill("#mf [name=amount]", "two"); await pg.click("#mf input[name=mode][value=thrice] + .mx-opt"); await W(100);
check("'Three times a day' shows three labelled empty times", (await pg.$$("#mf [data-mt]")).length === 3 && (await pg.textContent("#mf .mx-times")).includes("Third dose") && await pg.evaluate("S.medDraft.times.every(t=>!t)"));
await pg.click("[data-mtp='08:00']"); await pg.click("[data-mtp='14:00']"); await W(80);
await pg.click("#mf button.pri"); await W(150);
check("a word instead of a number, and a missing time, are both refused", (await pg.textContent("#mxe-amount")).includes("number") && (await pg.textContent("#mxe-mode")).includes("all 3 times"));
await pg.fill("#mf [name=amount]", "2"); await pg.click("[data-mtp='20:00']"); await W(80);
await pg.click("[data-mtp='20:00']"); await W(80);
check("a time can't be added twice", (await pg.textContent("#toast, .toast, body")).includes("already set"));
await pg.click("#mf input[name=dur][value=for] + .mx-opt"); await W(80); await pg.fill("#mf [name=forN]", "5"); await pg.press("#mf [name=forN]", "Tab"); await W(80);
check("'For 5 days' shows the last day", (await pg.textContent("#mf")).includes("Last dose on"));
await pg.click("#mf input[name=instr][value='After food'] + .mx-opt");
await pg.click("#mf button.pri"); await W(150);
const rev = await pg.textContent("#mf");
check("Review lists every detail before saving", await pg.evaluate("S.medDraft.step==='review'&&S.meds.length===0") && ["Fictional paracetamol", "500 mg", "Tablet", "2 tablets each time", "Three times a day", "8:00 AM, 2:00 PM, 8:00 PM", "After food"].every((x) => rev.includes(x)), ["Fictional paracetamol", "500 mg", "Tablet", "2 tablets each time", "Three times a day", "8:00 AM, 2:00 PM, 8:00 PM", "After food"].filter((x) => !rev.includes(x)).join("|"));
await pg.click("#medback"); await W(100);
check("Edit goes back to the form with everything kept", await pg.$eval("#mf [name=name]", (e) => e.value) === "Fictional paracetamol" && await pg.$eval("#mf [name=sv]", (e) => e.value) === "500" && (await pg.$$eval("#mf [data-mt]", (e) => e.map((x) => x.value))).join() === "08:00,14:00,20:00");
await pg.click("#mf button.pri"); await W(120); await pg.click("#mf button.pri"); await W(150);
const m1 = await pg.evaluate("S.meds[0]");
check("saved with separate fields and a dose line older app versions can show", m1.strength === "500 mg" && m1.amount === "2" && m1.unit === "tablet" && m1.dose === "2 tablets" && m1.freq === "daily" && m1.times.join() === "08:00,14:00,20:00" && m1.instructions === "After food" && !!m1.end, JSON.stringify(m1));
check("the form closes and the list shows strength, dose, how often and the next dose", !(await pg.$("#mf")) && (await txt()).includes("2 tablets · Three times a day") && (await pg.$$(".mx-next")).length === 1);

// as needed: no reminders anywhere
await addMed(pg, { name: "Fictional antacid", form: "syrup", amount: "10", unit: "ml", mode: "prn", note: "Not more than 3 doses a day" });
const prn = await pg.evaluate("S.meds.find(m=>m.name==='Fictional antacid')");
check("an 'only when needed' medicine has no times and is never due", prn.freq === "as_needed" && prn.times.length === 0 && await pg.evaluate("!isOn(S.meds.find(m=>m.name==='Fictional antacid'),today())") && (await txt()).includes("No reminders · taken when needed"));
check("'only when needed' medicines set no phone alarms", await pg.evaluate("DoctineAlarms.plan(S.meds,{},new Date()).every(a=>!a.title.includes('antacid'))"));

// every few hours
await pg.click("[data-medadd]"); await W(100);
await pg.fill("#mf [name=name]", "Fictional antibiotic"); await pg.fill("#mf [name=amount]", "1"); await pg.selectOption("#mf [name=unit]", "capsule"); await W(60);
await pg.click("#mf input[name=mode][value=interval] + .mx-opt"); await W(80); await pg.selectOption("#mf [name=interval]", "6"); await W(60); await pg.fill("#mf [name=first]", "06:00"); await pg.press("#mf [name=first]", "Tab"); await W(80);
check("'every 6 hours from 6:00 AM' previews the four reminder times", (await pg.textContent("#mf")).includes("Reminders at 12:00 AM, 6:00 AM, 12:00 PM, 6:00 PM"));
await pg.click("#mf button.pri"); await W(120); await pg.click("#mf button.pri"); await W(150);
const iv = await pg.evaluate("S.meds.find(m=>m.name==='Fictional antibiotic')");
check("saved with its interval and concrete times", iv.interval === 6 && iv.times.join() === "00:00,06:00,12:00,18:00" && (await txt()).includes("Every 6 hours"));

// certain days
await addMed(pg, { name: "Fictional vitamin", mode: "days", days: [1, 4], times: ["09:00"] });
check("'on certain days' saves the days and shows them", await pg.evaluate("(()=>{const m=S.meds.find(m=>m.name==='Fictional vitamin');return m.freq==='weekly'&&m.days.join()==='1,4'})()") && (await txt()).includes("Once on Mon, Thu"));

// an older medicine (one dose line) opens in the new form without losing anything
await pg.evaluate(() => { S.meds.push({ id: 4242, name: "Older entry", dose: "1 tablet after dinner", status: "active", start: "2026-10-01", end: "", freq: "daily", days: [], times: ["21:00"] }); render(); });
await pg.click("[data-edit='4242']"); await W(120);
check("an older one-line dose is split into amount, unit and instruction, with the original shown", await pg.$eval("#mf [name=amount]", (e) => e.value) === "1" && await pg.$eval("#mf [name=unit]", (e) => e.value) === "tablet" && await pg.$eval("#mf [name=note]", (e) => e.value) === "After dinner" && (await pg.textContent("#mf")).includes("Saved before as “1 tablet after dinner”") && await pg.evaluate("S.medDraft.mode==='once'"));
await pg.click("#mcancel"); await W(80);
check("Cancel closes the form without changing the medicine", !(await pg.$("#mf")) && await pg.evaluate("S.meds.find(m=>m.id===4242).dose==='1 tablet after dinner'&&!S.meds.find(m=>m.id===4242).amount"));

// pause, complete, delete via the More menu
await pg.click(".mx-item:has-text('Fictional vitamin') .mx-more summary"); await pg.click(".mx-item:has-text('Fictional vitamin') [data-st$='|paused']"); await W(100);
check("pausing moves it under Paused, with reminders off", (await pg.textContent(".mx-grp:has-text('Paused')")).includes("Fictional vitamin") && (await txt()).includes("Reminders off while paused"));
await pg.click(".mx-item:has-text('Fictional vitamin') .mx-more summary"); await pg.click(".mx-item:has-text('Fictional vitamin') [data-st$='|active']"); await W(100);
await pg.click(".mx-item:has-text('Older entry') .mx-more summary"); await pg.click(".mx-item:has-text('Older entry') [data-st$='|completed']"); await W(100);
check("a completed medicine moves under Finished and keeps its history", (await pg.textContent(".mx-fin")).includes("Older entry") && await pg.evaluate("S.meds.some(m=>m.id===4242)"));
pg.once("dialog", (d) => d.accept());
await pg.click(".mx-item:has-text('Older entry') .mx-more summary"); await pg.click(".mx-item:has-text('Older entry') [data-del]"); await W(120);
check("delete asks first, naming the medicine, then removes it", !(await pg.evaluate("S.meds.some(m=>m.id===4242)")));

// phone width: no sideways scrolling, controls big enough
await pg.setViewportSize({ width: 360, height: 800 }); await pg.click("[data-medadd]"); await W(120);
check("at 360px the form has no sideways scroll", await pg.evaluate("document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('#mf *')].every(e=>e.getBoundingClientRect().right<=innerWidth+1)"));
check("on phones the choice buttons are at least 40px tall", await pg.$$eval("#mf .mx-opt", (e) => e.every((x) => x.getBoundingClientRect().height >= 40)));
await pg.click("#mcancel"); await pg.setViewportSize({ width: 1280, height: 1000 });

// medical records: scanned prescription card, its medicines, the viewer and download
await pg.evaluate(async () => {
  const mk = async (col) => { const c = document.createElement("canvas"); c.width = 600; c.height = 800; const x = c.getContext("2d"); x.fillStyle = col; x.fillRect(0, 0, 600, 800); return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.8)); };
  for (let i = 0; i < 2; i++) { await IMG.put(`scan:777:${i}`, await mk("#fafafa")); await IMG.put(`orig:777:${i}`, await mk("#ccbbaa")); }
  S.reports.unshift({ id: 777, title: "Prescription – Fictional Clinic", cat: "Prescription", date: "2026-11-15", lab: "Fictional Clinic", fields: { Diagnosis: "Fictional fever" }, imgs: 2,
    scan: { medicines: [{ raw: "Tab Fictomol 650 1-0-1 x3d", name: "Fictomol", form: "tablet", strength: "650 mg", frequency: "1-0-1", timing: "after food", duration: "3 days", confidence: "high", alternatives: [] }, { raw: "Syp Fict?x", name: "Fictox", confidence: "low", alternatives: ["Fictex"] }], unreadable: [], transcription: "Tab Fictomol 650 1-0-1 x3d" }, checked: false });
  go("reports");
}); await W(300);
const card = await pg.textContent(".rx-card");
check("the record card shows title, date, provider and that it isn't checked yet", ["Prescription – Fictional Clinic", "15 Nov 2026", "Fictional Clinic", "Read automatically · not yet checked"].every((x) => card.includes(x)));
check("the medicines read from the photo are a table with strength, how often, when and for how long", (await pg.$$(".rx-meds tbody tr")).length === 2 && (await pg.textContent(".rx-meds")).includes("650 mg") && (await pg.textContent(".rx-meds")).includes("3 days") && (await pg.textContent(".rx-meds")).includes("Unsure"));
check("the page preview shows the page count and loads the image", (await pg.textContent(".rx-pages")) === "2 pages" && await pg.evaluate("new Promise(r=>setTimeout(()=>r(document.querySelector('.rx-thumb img').src.startsWith('blob:')),300))"));
await pg.click(".rx-thumb"); await W(300);
check("the viewer opens on page 1 of 2 with the cleaned page", (await pg.textContent(".scanov")).includes("Page 1 of 2") && (await pg.getAttribute(".scanimg", "alt")).endsWith("page 1"));
await pg.keyboard.press("ArrowRight"); await W(150);
await pg.click(".sv-seg [data-k=orig]"); await W(150);
check("arrow keys change page and the original photo can be shown", (await pg.textContent(".scanov")).includes("Page 2 of 2") && (await pg.getAttribute(".scanimg", "alt")).endsWith("page 2, original photo"));
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click(".scanov [data-k=dl]")]);
check("Download saves the page that's showing", /page-2-original\.jpg$/.test(dl.suggestedFilename()), dl.suggestedFilename());
await pg.keyboard.press("Escape"); await W(100);
check("Escape closes the viewer", !(await pg.$(".scanov")));
await pg.click("[data-rxmeds]"); await W(200);
check("'Add to medicines' opens the prescription's medicines for checking", await pg.evaluate("S.view==='medicines'&&S.medScan&&S.medScan.meds.length===2") && (await txt()).includes("Check and add"));
await pg.click("[data-msadd='0']"); await W(150);
check("from the prescription: strength, amount (1-0-1 → 1), form, twice a day, after food and the end date are filled for checking", await pg.evaluate("(()=>{const d=S.medDraft;return d.sv==='650'&&d.su==='mg'&&d.amount==='1'&&d.unit==='tablet'&&d.mode==='twice'&&d.times.join()==='08:00,21:00'&&d.instr.join()==='After food'&&d.dur==='until'&&!!d.end})()"), JSON.stringify(await pg.evaluate("S.medDraft")));
await pg.click("#mcancel");
await pg.click("[data-msadd='1']"); await W(150);
check("an unclear prescription line gets no invented schedule", await pg.evaluate("S.medDraft.mode===''&&S.medDraft.times.length===0&&S.medDraft.amount===''"));

check("no JavaScript errors on the page", errs.length === 0, errs.join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
