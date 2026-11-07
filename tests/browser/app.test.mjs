import { chromium } from "playwright";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const b = await chromium.launch(); const errs = []; const results = [];
const check = (name, ok, detail = "") => { results.push((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : "")); };
const pg = await b.newPage({ viewport: { width: 390, height: 844 } }); pg.on("pageerror", (e) => errs.push(e.message));
let chatBodies = [], chatMode = "ok", scanConf = "medium";
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: '{"supabaseUrl":null,"supabaseAnonKey":null,"accounts":"browser_demo"}' });
  if (u.includes("/api/chat")) { const body = JSON.parse(r.request().postData() || "{}"); chatBodies.push(body);
    if (chatMode === "down") return r.abort("failed");
    if (chatMode === "emergency") return r.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "Please call 112 now.", urgency: "emergency", safety: "rule", sections: [], ai_unavailable: "ai_timeout" }) });
    const n = chatBodies.length; return r.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: n === 1 ? "How long have you had the headache?" : "With a blocked nose for 3 days, sinus congestion is common.", urgency: "routine", question: n === 1 ? "How long?" : "", options: n === 1 ? ["Today", "A few days"] : [], sections: [], state: { mode: "symptom", topic: "headache", known: n === 1 ? [] : ["3 days"] } }) }); }
  if (u.endsWith("/api/scan")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ doc: { title: "Prescription – Dr. A. Kumar – 28 Oct 2026", type: "prescription", date: "2026-10-28", medicines: [{ raw: "Tab Mon[?]-LC 0-0-1", name: "Montair-LC", frequency: "0-0-1", confidence: scanConf, alternatives: ["Montek-LC"] }], lab_results: [{ test: "Hb", value: "11.4", unit: "g/dL", range: "12-15.5" }], unreadable: ["line 3"], overall_confidence: "medium", transcription: "Rx Tab Mon[?]-LC 0-0-1" } }) });
  if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(400);
// account
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Ravi"); await pg.fill("input[name=email]", "ravi@example.com"); await pg.fill("input[name=pw]", "password123"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await pg.waitForTimeout(300);
check("browser-demo account created when Supabase isn't configured", await pg.evaluate("S.email==='ravi@example.com'&&!S.cloud"));
const navKeys = await pg.$$eval("#nav [data-nav]", (e) => e.map((x) => x.dataset.nav));
check("the menu lists only working sections: no Family, which isn't built yet", !navKeys.includes("family") && navKeys.includes("medicines") && navKeys.includes("reminders"), navKeys.join(","));
check("menu icons are drawn as line icons, not emoji", await pg.$$eval("#nav [data-nav]", (e) => e.every((x) => x.querySelector("svg") && !/\p{Extended_Pictographic}/u.test(x.textContent))));
check("home shows how much of the health profile is filled in, with a link to finish it", (await pg.textContent("#profcard")).includes("1 of 6 details added") && (await pg.$("#profcard [data-nav=health]")) !== null);
// A/B: chat without any reports, then a follow-up
await pg.evaluate("go('chat')"); await pg.fill("#ci", "I have a headache"); await pg.click("#cf button.pri"); await pg.waitForTimeout(400);
check("general chat works with no reports or profile", chatBodies[0] && chatBodies[0].context === null && chatBodies[0].messages.length === 1, JSON.stringify(chatBodies[0]).slice(0, 80));
check("follow-up question and answer options are shown", (await pg.textContent("#view")).includes("How long?") && (await pg.$("[data-q='A few days']")) !== null);
await pg.click("[data-q='A few days']"); await pg.waitForTimeout(400);
const b2 = chatBodies[1];
check("follow-up sends the earlier conversation and the assistant's notes", b2 && b2.messages.length === 3 && b2.messages[1].role === "assistant" && b2.state && b2.state.topic === "headache");
// emergency
chatMode = "emergency"; await pg.fill("#ci", "my father has crushing chest pain"); await pg.click("#cf button.pri"); await pg.waitForTimeout(400);
const vtxt = await pg.textContent("#view");
check("emergency answer shows the urgent-help banner with 112", vtxt.includes("This may need urgent help") && vtxt.includes("112"));
check("people are told when the AI couldn't be reached", vtxt.includes("built-in safety guidance"));
// network failure is shown, not hidden
chatMode = "down"; await pg.fill("#ci", "What is BMI?"); await pg.click("#cf button.pri"); await pg.waitForTimeout(400);
check("network failure shows an error with Retry", await pg.evaluate("S.cerr==='network'") && (await pg.$("[data-retry]")) !== null);
// report reading with records context
chatMode = "ok";
// scan a prescription in Medicines (medium confidence)
const photo = `(async()=>{const c=document.createElement('canvas');c.width=1200;c.height=1600;const x=c.getContext('2d');x.fillStyle='#5a3d28';x.fillRect(0,0,1200,1600);x.fillStyle='#f3efe6';x.fillRect(200,200,800,1200);x.fillStyle='#223';x.font='48px serif';x.fillText('Rx Tab Montair-LC',300,500);const b=await new Promise(r=>c.toBlob(r,'image/jpeg',.9));return new File([b],'rx.jpg',{type:'image/jpeg'})})()`;
await pg.evaluate("go('medicines')"); await pg.evaluate(`(async()=>{const f=await ${photo};quickScan(false,(rec,doc)=>{S.medScan={rid:rec.id,title:rec.title,meds:(doc&&doc.medicines||[]).filter(m=>m.name),added:{}}},[f])})()`);
await pg.waitForSelector(".scanov [data-x=done]", { timeout: 15000 }); await pg.click(".scanov [data-x=done]"); await pg.waitForTimeout(800);
const btn = await pg.textContent("[data-msadd='0']");
check("uncertain medicine is labelled and offers 'Check and add'", btn.trim() === "Check and add" && (await pg.textContent("#view")).includes("Could also be: Montek-LC"));
await pg.click("[data-msadd='0']"); await pg.waitForTimeout(200);
check("form explains the uncertainty and shows the line as written", (await pg.textContent("#mf")).includes("wasn’t sure") && (await pg.textContent("#mf")).includes("Mon[?]-LC"));
check("times are prefilled from 0-0-1", JSON.stringify(await pg.evaluate("S.medDraft.times")) === '["21:00"]');
await pg.click("#mf button.pri"); await pg.waitForTimeout(200);
check("an uncertain medicine cannot be saved without confirming it was checked", await pg.evaluate("S.meds.length===0") && (await pg.textContent("#merr")).includes("Tick the box"));
await pg.check("input[name=srcok]"); await pg.fill("#mf [name=dose]", "1 tablet at night"); await pg.click("#mf button.pri"); await pg.waitForTimeout(200);
const med = await pg.evaluate("S.meds[0]");
check("after confirming, it saves with a link to its source prescription", med && med.src && med.src.raw === "Tab Mon[?]-LC 0-0-1" && med.src.conf === "medium" && (await pg.textContent("#view")).includes("as written: Tab Mon[?]-LC"));
// scanned record keeps original + cleaned pages, and shows what was read
const keys = await pg.evaluate(async () => { const d = await IMG.open(); return new Promise((r) => { const q = d.transaction("img").objectStore("img").getAllKeys(); q.onsuccess = () => r(q.result); }); });
check("original photo and cleaned page are both kept", keys.some((k) => k.startsWith("orig:")) && keys.some((k) => k.startsWith("scan:")), keys.join(","));
await pg.evaluate("go('reports')"); await pg.waitForTimeout(300);
check("scanned record shows what was read, with confidence and unreadable parts", (await pg.textContent("#view")).includes("What Doctine read") && (await pg.textContent("#view")).includes("Couldn’t read: line 3"));
check("lab result from the scan is saved as a field", await pg.evaluate("S.reports[0].fields.Hb==='11.4 g/dL (ref 12-15.5)'"));
check("the scanned record is marked as read automatically, with a button to check it", (await pg.textContent("#view")).includes("Read automatically · not yet checked") && (await pg.textContent("[data-redit]")).trim() === "Check details");
check("the menu names say what each area is", JSON.stringify(await pg.$$eval("#nav [data-nav]", (e) => e.map((x) => x.textContent.trim()))) === JSON.stringify(["Overview", "My Health", "Medical records", "Medicines", "Reminders", "AI Assistant", "About", "Settings"]));
await pg.click("[data-vs]"); await pg.waitForTimeout(300); await pg.click(".scanov [data-k=orig]"); await pg.waitForTimeout(400);
check("viewer can switch to the original photo", await pg.evaluate("(()=>{const i=document.querySelector('.scanov img');return !!(i&&i.src.startsWith('blob:'))})()"));
await pg.click(".scanov [data-k=x]");
// data persists after reload
await pg.reload(); await pg.waitForTimeout(500);
check("records, medicines and doses survive a reload", await pg.evaluate("S.email==='ravi@example.com'&&S.reports.length===1&&S.meds.length===1"));
// export and delete
await pg.evaluate("go('settings')"); await pg.click("#exp2"); await pg.waitForTimeout(200);
const exp = JSON.parse(await pg.evaluate("S.exp"));
check("export includes profile, reports, medicines and dose history", exp.reports.length === 1 && exp.medicines.length === 1 && "dose_history" in exp);
// the .zip download carries the data plus the record's original photo and cleaned page; a separate zip reader (Python's) must accept it
const [dl] = await Promise.all([pg.waitForEvent("download"), pg.click("#expzip")]);
const zipPath = await dl.path(); const { execFileSync } = await import("node:child_process");
const zinfo = JSON.parse(execFileSync("python3", ["-I", "-c", "import zipfile,json,sys;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({'bad':z.testzip(),'names':z.namelist(),'data':json.loads(z.read('doctine-data.json'))}))", zipPath]).toString());
check("the .zip download is a valid zip named by date, with the data, a README, and the record's original and cleaned images",
  /^doctine-export-\d{4}-\d{2}-\d{2}\.zip$/.test(dl.suggestedFilename()) && zinfo.bad === null && zinfo.names.includes("README.txt") && zinfo.data.reports.length === 1 &&
  zinfo.names.some((n) => /^files\/.+\/page-1-original-photo\.(jpg|png|webp)$/.test(n)) && zinfo.names.some((n) => /^files\/.+\/page-1-cleaned\.jpg$/.test(n)), zinfo.names.join(" "));
await pg.waitForTimeout(100);
check("…and Settings confirms what was downloaded", /Downloaded doctine-export-.+ with your data and 2 files/.test(await pg.textContent("#view")));
pg.once("dialog", (d) => d.accept()); await pg.click("#wipe"); await pg.waitForTimeout(300);
check("delete removes the account from this browser", await pg.evaluate("!JSON.parse(localStorage.getItem('doctine:v2')).users['ravi@example.com']&&S.email===null"));
// mobile layouts: no sideways scrolling on any screen
await pg.click("#samp"); await pg.waitForTimeout(200);
// sample data is fictional: a dose falling due must not ring, notify or show a "time for" toast (matches the phone app)
await pg.evaluate("(()=>{const d=new Date();S.meds[0].start=today();S.meds[0].end='';S.meds[0].times=[String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')];S.alerted={};render()})()");
const dueInSample = await pg.evaluate("dueNow().length"); await pg.waitForTimeout(5600);
check("a sample medicine falling due doesn't ring an alarm or send a reminder", dueInSample > 0 && !(await pg.evaluate("DoctineAlarms.ringing()")) && !(await pg.evaluate("Object.keys(S.alerted).length")), "due=" + dueInSample);
// stopping when nothing rings must not call the vibration API (it was called every 5 seconds, filling the console)
await pg.evaluate("(()=>{window.__vib=0;const v=navigator.vibrate;navigator.vibrate=function(){window.__vib++;return true};DoctineAlarms.stop();DoctineAlarms.stop()})()");
check("stopping an alarm that isn't ringing doesn't touch vibration", (await pg.evaluate("window.__vib")) === 0);
await pg.evaluate("(()=>{DoctineAlarms.start(3000);DoctineAlarms.stop()})()");
check("stopping a ringing alarm still stops the vibration", (await pg.evaluate("window.__vib")) >= 2 && !(await pg.evaluate("DoctineAlarms.ringing()")));
const wide = [];
for (const v of ["home", "chat", "health", "reports", "medicines", "reminders", "family", "about", "settings"]) { await pg.evaluate(`go('${v}')`); await pg.waitForTimeout(60);
  if (await pg.evaluate("(()=>{const v=document.querySelector('#view');return document.documentElement.scrollWidth>innerWidth||v.scrollWidth>v.clientWidth+1})()")) wide.push(v); }
check("no screen scrolls sideways at phone width (390px)", wide.length === 0, wide.join(","));
const wideAt = [];
for (const w of [320, 360, 768, 1280]) { await pg.setViewportSize({ width: w, height: 800 });
  for (const v of ["home", "chat", "health", "reports", "medicines", "reminders", "about", "settings"]) { await pg.evaluate(`go('${v}')`); await pg.waitForTimeout(40);
    if (await pg.evaluate("(()=>{const v=document.querySelector('#view');return document.documentElement.scrollWidth>innerWidth||v.scrollWidth>v.clientWidth+1})()")) wideAt.push(v + "@" + w); } }
check("no screen scrolls sideways at 320px, 360px, tablet or desktop width", wideAt.length === 0, wideAt.join(","));
// phones: iPhone Safari zooms the page when a field under 16px is focused, and fingers need targets of about 44px
await pg.setViewportSize({ width: 375, height: 800 });
const smallFields = [];
for (const v of ["home", "chat", "health", "reports", "medicines", "settings"]) { await pg.evaluate(`go('${v}')`); await pg.waitForTimeout(40);
  smallFields.push(...(await pg.evaluate(`[...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea')].filter(e=>e.offsetParent&&parseFloat(getComputedStyle(e).fontSize)<16).map(e=>'${v}:'+(e.name||e.id||e.tagName))`))); }
check("on phones every text field is at least 16px, so iPhones don't zoom in when it's tapped", smallFields.length === 0, smallFields.join(","));
await pg.evaluate("go('home')"); await pg.waitForTimeout(40);
const smallTaps = await pg.evaluate(`[...document.querySelectorAll('#view .chip,#view button.underline')].filter(e=>e.offsetParent&&e.getBoundingClientRect().height<44).length`);
check("on phones the shortcut chips and text buttons are at least 44px tall", smallTaps === 0, String(smallTaps));
check("no JavaScript errors on the page", errs.length === 0, errs.join(" | "));
console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
await b.close(); process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
