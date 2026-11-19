/**
 * Doctine · My Health (the screen after signing in), Vitals, the grouped sidebar, the phone tab bar and screen routing.
 * Demo accounts and the sample account (no Supabase); fictional data only. Run through tools/run-browser-tests.mjs.
 */
import { chromium } from "playwright";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const out = [];
const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1366, height: 1000 } });
const pg = await ctx.newPage();
const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
const W = (ms) => pg.waitForTimeout(ms), txt = () => pg.textContent("#view");

// ---------- a brand-new account: no made-up numbers, useful empty states ----------
await pg.goto(BASE + "/"); await W(300);
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Neha Newcomer"); await pg.fill("input[name=email]", "neha.dash@example.com"); await pg.fill("input[name=pw]", "fictional-pass-1"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(400);
check("after signing up, My Health opens first", await pg.evaluate("S.view==='home'") && (await pg.textContent(".dh-hello h1")).includes("Neha"));
check("the greeting shows today's date and a short description", /Here’s an overview of your health today/.test(await txt()) && (await pg.textContent(".dh-date")).length > 5);
check("a new account shows a getting-started guide and no summary numbers", (await txt()).includes("Start your health record") && !(await pg.$(".dh-tiles")) && !(await pg.$(".dh-spark")));
check("empty sections explain what will appear and how to add it", (await txt()).includes("No readings yet") && (await txt()).includes("No records yet") && (await txt()).includes("No medicines yet"));
check("the profile shows 'Not added' rather than invented values", (await pg.textContent(".dh-prof")).includes("Not added"));
check("Ask Doctine sits below the health sections, not as the whole screen", await pg.evaluate("(()=>{const a=document.querySelector('.dh-ask'),g=document.querySelector('.dh-grid');return !!a&&!!g&&a.getBoundingClientRect().top>g.getBoundingClientRect().top})()"));

// ---------- sidebar groups, tab routing and refresh ----------
const groups = await pg.$$eval("#nav .navg", (e) => e.map((x) => x.textContent));
check("the sidebar is grouped: Overview, Health, AI, Account", JSON.stringify(groups) === JSON.stringify(["Overview", "Health", "AI", "Account"]), groups.join());
const items = await pg.$$eval("#nav [data-nav]", (e) => e.map((x) => x.textContent.trim()));
check("it lists My Health, Medicines, Reminders, Vitals, Medical records, Health profile, Doctine AI, Settings, About", JSON.stringify(items) === JSON.stringify(["My Health", "Medicines", "Reminders", "Vitals", "Medical records", "Health profile", "Doctine AI", "Settings", "About"]), items.join());
await pg.click("#nav [data-nav=vitals]"); await W(150);
check("opening Vitals puts #vitals in the address", await pg.evaluate("location.hash") === "#vitals" && (await txt()).includes("No readings yet"));
await pg.reload(); await W(700);
check("after a refresh the same screen opens again", await pg.evaluate("S.view") === "vitals");
await pg.click("#nav [data-nav=home]"); await W(150);
check("My Health clears the address back to the plain app link", await pg.evaluate("location.hash") === "");

// ---------- adding readings ----------
await pg.click(".dh-hello [data-vadd]"); await W(150);
check("'Add reading' opens the reading form on Vitals", await pg.evaluate("S.view==='vitals'") && !!(await pg.$("#vf")));
await pg.click("#vf input[name=kind][value=blood_pressure] + .mx-opt"); await W(100);
await pg.fill("#vf [name=v]", "80"); await pg.fill("#vf [name=v2]", "120"); await pg.click("#vf button.pri"); await W(120);
check("blood pressure with the numbers swapped is refused, with the reason beside the field", (await pg.textContent("#vxe-v2")).includes("lower than the top number") && await pg.evaluate("(S.vitals||[]).length===0"));
await pg.fill("#vf [name=v]", "124"); await pg.fill("#vf [name=v2]", "82"); await pg.fill("#vf [name=note]", "Left arm, seated"); await pg.click("#vf button.pri"); await W(150);
const bp = await pg.evaluate("S.vitals[0]");
check("a blood pressure reading saves with both numbers, its unit, the time and the note", bp.kind === "blood_pressure" && bp.v === 124 && bp.v2 === 82 && bp.unit === "mmHg" && bp.note === "Left arm, seated" && !!bp.at, JSON.stringify(bp));
check("Vitals shows the reading with its unit, when and 'Added by you'", (await pg.textContent("#vk-blood_pressure")).includes("124/82") && (await pg.textContent("#vk-blood_pressure")).includes("mmHg") && (await pg.textContent("#vk-blood_pressure")).includes("Added by you"));
check("one reading draws no trend line", !(await pg.$("#vk-blood_pressure .dh-spark")));
for (const [v, back] of [["118", 2], ["121", 1]]) {
  await pg.click("[data-vadd='1']"); await W(100); await pg.click("#vf input[name=kind][value=blood_pressure] + .mx-opt"); await W(80);
  await pg.fill("#vf [name=v]", v); await pg.fill("#vf [name=v2]", "78"); await pg.fill("#vf [name=date]", await pg.evaluate((n) => addDays(today(), -n), back)); await pg.click("#vf button.pri"); await W(120);
}
check("after three readings a trend line appears, newest point marked", !!(await pg.$("#vk-blood_pressure .dh-spark circle")) && (await pg.textContent("#vk-blood_pressure")).includes("3 readings"));
check("the newest reading is shown first even when older ones were added later", (await pg.textContent("#vk-blood_pressure .dh-big")).includes("124/82"));
await pg.click("[data-vadd='1']"); await W(80); await pg.click("#vf input[name=kind][value=spo2] + .mx-opt"); await W(80); await pg.fill("#vf [name=v]", "140"); await pg.click("#vf button.pri"); await W(100);
check("an impossible oxygen saturation is refused", (await pg.textContent("#vxe-v")).includes("between 50 and 100"));
await pg.fill("#vf [name=v]", "98"); await pg.fill("#vf [name=date]", await pg.evaluate("addDays(today(),2)")); await pg.click("#vf button.pri"); await W(100);
check("a reading in the future is refused", (await pg.textContent("#vxe-when")).includes("future"));
await pg.click("#vcancel"); await W(80);
await pg.evaluate(() => { const d = document.querySelector("#vk-blood_pressure details"); if (d) d.open = true; });
await pg.click("#vk-blood_pressure [data-vdel]"); await W(60);
check("deleting a reading takes a second tap", await pg.evaluate("S.vitals.length===3"));
await pg.click("#vk-blood_pressure [data-vdel]"); await W(120);
check("the second tap deletes it", await pg.evaluate("S.vitals.length===2"));
check("the page never calls a reading good or bad", !/\b(normal|healthy|unhealthy|high blood|low blood|abnormal)\b/i.test(await txt()));

// ---------- the dashboard with data ----------
await pg.evaluate(() => { const d = today(); S.meds.push({ id: 31, name: "Fictional tablet", strength: "5 mg", form: "tablet", amount: "1", unit: "tablet", dose: "1 tablet", status: "active", start: addDays(d, -3), end: "", freq: "daily", days: [], times: ["00:01", "23:59"], instructions: "After food" });
  S.meds.push({ id: 32, name: "Fictional drops", amount: "2", unit: "drop", dose: "2 drops", status: "active", start: d, end: "", freq: "as_needed", days: [], times: [] }); go("home"); });
await W(200);
check("with medicines and readings, the summary shows doses today and the latest blood pressure", (await pg.textContent(".dh-tiles")).includes("of 2") && (await pg.textContent(".dh-tiles")).includes("121/78"), await pg.textContent(".dh-tiles"));
check("each reading tile names its unit, when it was measured and that it was added by you", /mmHg[\s\S]*Added by you/.test(await pg.textContent(".dh-tiles")));
check("today's doses list name, strength, amount and time", (await txt()).includes("Fictional tablet 5 mg") && (await txt()).includes("1 tablet · After food") && (await txt()).includes("12:01 AM"));
check("'only when needed' medicines are listed without times", (await txt()).includes("Taken only when needed: Fictional drops"));
await pg.click(".dh-dose.due [data-d$='|Taken']"); await W(150);
check("a dose can be marked taken from My Health", await pg.evaluate("Object.values(S.doses).includes('Taken')") && (await pg.textContent(".dh-tiles")).includes("1 of 2"));
check("recent activity lists the dose and the readings", (await pg.textContent(".dh-act")).includes("Taken: Fictional tablet") && (await pg.textContent(".dh-act")).includes("Blood pressure added"));

// ---------- records on My Health: text, not photos ----------
await pg.evaluate(() => { S.reports.unshift({ id: 41, title: "Fictional lipid panel", cat: "Lab report", date: addDays(today(), -2), lab: "Fictional Labs", fields: { "LDL cholesterol": "118 mg/dL (ref < 100)", HDL: "52 mg/dL" } }); render(); }); await W(100);
check("recent records show their key values as text, not photos", (await pg.textContent(".dh-recs")).includes("LDL cholesterol 118 mg/dL") && !(await pg.$(".dh-recs img")));
await pg.click("[data-rfocus='41']"); await W(200);
check("'Open' goes to that record in Medical records", await pg.evaluate("S.view==='reports'") && !!(await pg.$("#rx-41")));

// ---------- Ask Doctine ----------
await pg.evaluate("go('home')"); await W(120);
const sugg = await pg.$$eval(".dh-sugg [data-hq]", (e) => e.map((x) => x.textContent));
check("suggested questions match what's in the account", sugg.includes("Explain my latest blood report") && sugg.includes("What medicines am I currently taking?") && !sugg.includes("Help me understand my prescription"), sugg.join(" | "));
await pg.click(".dh-sugg [data-hq='Explain my latest blood report']"); await W(200);
check("a suggestion opens Doctine AI with the question ready, and asks before using records", await pg.evaluate("S.view==='chat'") && (await pg.inputValue("#ci")) === "Explain my latest blood report" && await pg.evaluate("S.useRecords!==true"));
await pg.evaluate("go('home')"); await W(100);
await pg.fill("#haq", "How can I sleep better?"); await pg.click("#hask button"); await W(400);
check("typing a question on My Health sends it in Doctine AI (existing chat, consent and all)", await pg.evaluate("S.view==='chat'") && await pg.evaluate("S.msgs.some(m=>m.r==='u'&&m.t==='How can I sleep better?')||!!S.aiAsk"));

// ---------- the sample account ----------
await pg.evaluate("document.getElementById('out').click()"); await W(300);
await pg.click("#samp"); await W(400);
check("the sample account opens on My Health, marked as made-up data", await pg.evaluate("S.view==='home'&&S.sample") && (await pg.textContent("#banner")).includes("Sample data"));
check("sample readings, medicines and records fill the dashboard", (await pg.$$(".dh-vl li")).length >= 4 && (await pg.$$(".dh-doses li")).length >= 1 && (await pg.$$(".dh-recs li")).length >= 3);
check("sample trends draw from several readings", (await pg.$$(".dh-vl .dh-spark")).length >= 3);

// ---------- phones ----------
await pg.setViewportSize({ width: 375, height: 760 }); await W(200);
check("on phones a tab bar shows My Health, Medicines, Records, Doctine AI and More", JSON.stringify(await pg.$$eval("#tabbar button", (e) => e.map((x) => x.textContent.trim()))) === JSON.stringify(["My Health", "Medicines", "Records", "Doctine AI", "More"]));
check("at 375px nothing scrolls sideways", await pg.evaluate("[...document.querySelectorAll('#view *')].every(e=>e.getBoundingClientRect().right<=innerWidth+1)&&document.documentElement.scrollWidth<=innerWidth"));
check("the summary tiles sit two to a row on phones", await pg.evaluate("(()=>{const t=[...document.querySelectorAll('.dh-tile')];return t.length>=2&&Math.abs(t[0].getBoundingClientRect().top-t[1].getBoundingClientRect().top)<2})()"));
await pg.click("#tabbar [data-nav=medicines]"); await W(150);
check("the tab bar switches screens and marks the current one", await pg.evaluate("S.view==='medicines'") && (await pg.getAttribute("#tabbar [data-nav=medicines]", "aria-current")) === "page");
await pg.click("#tbmore"); await W(200);
check("More opens the full menu (vitals, reminders, profile, settings)", await pg.evaluate("!document.getElementById('side').classList.contains('-translate-x-full')"));
await pg.click("#nav [data-nav=vitals]"); await W(150);
check("…and choosing from it closes the menu", await pg.evaluate("S.view==='vitals'&&document.getElementById('side').classList.contains('-translate-x-full')"));
await pg.setViewportSize({ width: 1366, height: 1000 }); await W(100);
check("on desktop the tab bar is hidden and the sidebar stays", !(await pg.isVisible("#tabbar")) && await pg.isVisible("#nav"));

check("no JavaScript errors on the page", errs.length === 0, errs.join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
