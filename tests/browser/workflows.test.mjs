/**
 * Doctine · end-to-end workflows against the REAL Netlify functions (served by tools/dev-server.mjs).
 * Only the Anthropic API is replaced (tests/browser/mock-anthropic.mjs). Demo-account mode (no Supabase).
 * Run through tools/run-browser-tests.mjs, which starts both servers.
 */
import { chromium } from "playwright";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const MOCK = process.env.DOCTINE_MOCK_AI || "http://127.0.0.1:8790";
const out = [];
const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const mockMode = (status) => fetch(MOCK + "/__mode", { method: "POST", body: JSON.stringify({ status }) });
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const pg = await ctx.newPage();
const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
const apiCalls = []; pg.on("request", (r) => { if (r.url().includes("/api/")) apiCalls.push(r.method() + " " + new URL(r.url()).pathname); });
pg.on("dialog", (d) => d.accept());
// Third-party CDNs (fonts, pdf.js) are not needed for these workflows and aren't reachable in every CI sandbox.
await pg.route("**/*", (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
const W = (ms) => pg.waitForTimeout(ms);
const text = (sel = "#view") => pg.textContent(sel);
await mockMode(200);

// ---------- homepage ----------
await pg.goto(BASE + "/"); await W(500);
check("homepage loads with the sign-in screen", (await pg.title()).includes("Doctine") && (await text("#auth")).includes("Welcome back"));
check("the sign-in screen says these are demo accounts when Supabase isn't configured", (await text("#auth")).includes("This is a demo"));
await pg.click("[data-auth=about]"); await W(200);
check("About opens from the sign-in screen", (await text("#auth")).includes("Health is more than a collection of reports."));
await pg.click("[data-auth=login]");

// ---------- registration, sign-out, login ----------
const reg = async (name, email, pw) => { await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", name); await pg.fill("input[name=email]", email); await pg.fill("input[name=pw]", pw); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(300); };
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Kavya Rao"); await pg.fill("input[name=email]", "kavya.test@example.com"); await pg.fill("input[name=pw]", "short"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(200);
check("registration rejects a short password", (await text("#aerr")).includes("at least 8"));
await pg.click("[data-auth=login]"); await reg("Kavya Rao", "kavya.test@example.com", "kavya-pass-123");
check("registration signs in and opens Home", (await text("#view")).includes("Hello, Kavya"));
check("the account is labelled as a browser-only demo account", (await text("#who")).includes("Demo · this browser only"));
await pg.evaluate("document.getElementById('out').click()"); await W(200);
check("sign-out returns to the sign-in screen", (await text("#auth")).includes("Welcome back"));
await pg.fill("input[name=email]", "kavya.test@example.com"); await pg.fill("input[name=pw]", "wrong-password"); await pg.click("#lf button.pri"); await W(300);
check("a wrong password is refused with a clear message", (await text("#aerr")).includes("incorrect"));
await pg.fill("input[name=pw]", "kavya-pass-123"); await pg.click("#lf button.pri"); await W(300);
check("login works after sign-out", await pg.evaluate("S.email==='kavya.test@example.com'"));

// ---------- navigation ----------
const views = { home: "Hello", chat: "What would you like help understanding", health: "My Health", reports: "Medical records", medicines: "Medicines", reminders: "Reminders", about: "Health is more than a collection of reports.", settings: "Settings" };
let navOk = true, bad = [];
for (const [v, expect] of Object.entries(views)) { await pg.click(`#nav [data-nav=${v}]`); await W(80); if (!(await text()).includes(expect)) { navOk = false; bad.push(v); } }
check("every menu item opens its screen", navOk, bad.join(","));
check("Family isn't in the menu until it's built", (await pg.$("#nav [data-nav=family]")) === null);

// ---------- chat without any documents (real /api/chat) ----------
await pg.click("#nav [data-nav=chat]"); await pg.fill("#ci", "What does HbA1c mean?"); await pg.click("#cf button.pri"); await W(300);
check("a new account starts with the AI assistant off and asks before the first message is sent", (await pg.$("#aiask")) !== null && apiCalls.filter((c) => c.endsWith("/api/chat")).length === 0);
await pg.click("#aiallow"); await W(700);
check("a general health question is answered with no reports or profile", (await text()).includes("average blood sugar over about three months"));
check("the answer says it comes from general knowledge, not attached sources", (await text()).includes("Doctine has not attached medical sources"));
// adaptive follow-up
await pg.click("#newchat"); await pg.fill("#ci", "I have a headache"); await pg.click("#cf button.pri"); await W(700);
check("a symptom gets a follow-up question with answer choices", (await text()).includes("How long have you had this headache?") && (await pg.$("[data-q='A few days']")) !== null);
await pg.click("[data-q='A few days']"); await W(700);
const seen = await (await fetch(MOCK + "/__seen")).json();
check("the follow-up sends the conversation and the assistant's notes to the real chat function", seen.some((s) => s.tool === "respond" && s.turns === 3 && s.hasNotes));
check("the follow-up answer builds on what was said", (await text()).includes("lasting a few days") && (await text()).includes("Do you also have a fever?"));
// emergency through the real safety rules
await pg.click("#newchat"); await pg.fill("#ci", "my father has crushing chest pain and is sweating"); await pg.click("#cf button.pri"); await W(700);
check("emergency wording shows the urgent-help banner with 112 (real safety rules)", (await text()).includes("This may need urgent help") && (await text()).includes("112"));

// ---------- error states ----------
await pg.click("#newchat");
for (const [status, words, label] of [[401, "rejected the API key", "invalid key"], [529, "busy right now", "busy"], [400, "no credit left", "no credit"]]) {
  await mockMode(status); await pg.fill("#ci", "What is BMI?"); await pg.click("#cf button.pri"); await W(600);
  check(`AI provider error (${label}) is explained, not hidden`, (await text()).includes(words), (await text()).slice(-200));
}
await mockMode(500); await pg.fill("#ci", "my baby is 2 months old and not breathing properly"); await pg.click("#cf button.pri"); await W(600);
check("with the AI failing, emergency wording still gets 112 guidance", (await text()).includes("112") && (await text()).includes("built-in safety guidance"));
await mockMode(200);
await pg.route(BASE + "/api/chat", (r) => r.abort()); await pg.fill("#ci", "What is BMI?"); await pg.click("#cf button.pri"); await W(400);
check("a network failure shows an error with Retry", (await text()).includes("Network problem") && (await pg.$("[data-retry]")) !== null);
await pg.unroute(BASE + "/api/chat"); await pg.click("[data-retry]"); await W(700);
check("Retry succeeds once the network is back", await pg.evaluate("S.cerr===''") && (await text()).includes("general health information"));

// ---------- consent: AI switched off ----------
await pg.click("#nav [data-nav=settings]"); await pg.uncheck("[data-c=ai]"); await W(100);
const before = apiCalls.filter((c) => c.endsWith("/api/chat")).length;
await pg.click("#nav [data-nav=chat]"); await pg.click("#newchat").catch(() => {}); await pg.fill("#ci", "Is it safe to exercise daily?"); await pg.click("#cf button.pri"); await W(400);
check("with the AI assistant switched off, nothing is sent and it asks instead", apiCalls.filter((c) => c.endsWith("/api/chat")).length === before && (await pg.$("#aiask")) !== null);
await pg.click("#ainot"); await W(100); await pg.click("#nav [data-nav=settings]");
await pg.check("[data-c=ai]"); await W(100);

// ---------- document upload and report viewing (real /api/scan) ----------
await pg.click("#nav [data-nav=reports]");
const photo = await pg.evaluate(async () => { const c = document.createElement("canvas"); c.width = 1200; c.height = 1600; const x = c.getContext("2d"); x.fillStyle = "#5a3d28"; x.fillRect(0, 0, 1200, 1600); x.fillStyle = "#f3efe6"; x.beginPath(); x.moveTo(210, 180); x.lineTo(1010, 260); x.lineTo(1060, 1420); x.lineTo(150, 1350); x.closePath(); x.fill(); x.fillStyle = "#22336a"; x.font = "46px serif"; for (let i = 0; i < 8; i++) x.fillText("Tab Pan-D 40 1-0-0 AC x5d", 300, 420 + i * 100); return c.toDataURL("image/jpeg", 0.9).split(",")[1]; });
await pg.setInputFiles("#file", { name: "prescription.jpg", mimeType: "image/jpeg", buffer: Buffer.from(photo, "base64") });
await pg.waitForSelector(".scanov [data-x=done]", { timeout: 15000 });
check("an uploaded photo opens the scanner with the page found and straightened", await pg.evaluate("!!document.querySelector('.scanov img.scanimg')"));
const scansBefore = apiCalls.filter((c) => c.endsWith("/api/scan")).length;
await pg.click(".scanov [data-x=done]"); await pg.waitForSelector("[data-ai]", { timeout: 5000 });
check("before a photo goes to the AI, Doctine asks, names the provider, and has sent nothing yet", apiCalls.filter((c) => c.endsWith("/api/scan")).length === scansBefore && /Anthropic, United States/.test(await pg.textContent("[role=dialog]")));
await pg.click("[data-ai='1']"); await W(1500);
check("the scan is read by the real /api/scan and saved with an automatic name", (await text()).includes("Prescription – Dr. Sample Physician – 1 Nov 2026"));
check("the saved record shows what was read, with confidence and unreadable parts", (await text()).includes("What Doctine read") && (await text()).includes("Couldn’t read: line 2"));
await pg.click("[data-vs]"); await W(400);
check("the page image opens in the viewer", await pg.evaluate("(()=>{const i=document.querySelector('.scanov img');return !!(i&&i.src.startsWith('blob:'))})()"));
await pg.click(".scanov [data-k=x]");
await pg.click("[data-ask]"); await W(900);
check("'Ask about this report' gives an explanation of that document (real /api/scan explain)", (await text()).includes("prescription from Dr. Sample Physician for acidity"));

// ---------- medicines ----------
await pg.click("#nav [data-nav=medicines]");
const hm = await pg.evaluate("(()=>{const d=new Date(Date.now()-3600e3);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')})()");
await pg.fill("#mf [name=name]", "Cetirizine 10 mg"); await pg.fill("#mf [name=dose]", "1 tablet at night");
await pg.evaluate((t) => { S.medDraft.times = [t]; }, hm); await pg.click("#mf button.pri"); await W(200);
check("a medicine can be added", (await text()).includes("Cetirizine 10 mg"));
await pg.click("[data-edit]"); await pg.fill("#mf [name=dose]", "1 tablet after dinner"); await pg.click("#mf button.pri"); await W(200);
check("a medicine can be edited", (await text()).includes("1 tablet after dinner"));
await pg.click("[data-st$='|paused']"); await W(100); check("a medicine can be paused", (await text()).includes("paused"));
await pg.click("[data-st$='|active']"); await W(100); check("a paused medicine can be resumed", (await pg.$("[data-st$='|paused']")) !== null);

// ---------- reminders ----------
await pg.click("#nav [data-nav=reminders]"); await W(150);
check("the reminder for today's dose is listed", (await text()).includes("Cetirizine 10 mg") && (await text()).includes(hm));
await pg.click(`#view [data-d$='|Taken']`); await W(150);
check("a dose can be marked as taken and appears in the history", (await text()).includes("Taken") && (await text()).includes("Dose history"));
await pg.click(`#view [data-d$='|Undo']`); await W(150);
check("a mistaken entry can be undone", (await pg.$(`#view [data-d$='|Taken']`)) !== null);
await pg.click(`#view [data-d$='|Snoozed']`); await W(150);
check("a dose can be snoozed for 10 minutes", (await text()).includes("Snoozed until"));
await pg.click("#nav [data-nav=medicines]"); await pg.click("[data-del]"); await W(200);
check("a medicine can be deleted", !(await text()).includes("Cetirizine 10 mg"));

// ---------- account switching (demo accounts on one browser) ----------
await pg.evaluate("document.getElementById('out').click()"); await W(200);
await reg("Arjun Mehta", "arjun.test@example.com", "arjun-pass-123");
await pg.click("#nav [data-nav=reports]"); await W(150);
check("a second account on the same browser sees none of the first account's records", !(await text()).includes("Dr. Sample Physician") && (await text()).includes("No reports yet"));
await pg.click("#nav [data-nav=medicines]"); check("…and none of its medicines", (await text()).includes("No medicines yet"));

// ---------- mobile ----------
await pg.setViewportSize({ width: 375, height: 812 }); const wide = [];
for (const v of Object.keys(views)) { await pg.evaluate(`go('${v}')`); await W(60); if (await pg.evaluate("(()=>{const v=document.querySelector('#view');return document.documentElement.scrollWidth>innerWidth||v.scrollWidth>v.clientWidth+1})()")) wide.push(v); }
check("no screen scrolls sideways at 375px", wide.length === 0, wide.join(","));
await pg.click("#burger"); await W(250);
check("the mobile menu opens and navigates", await pg.evaluate("!document.querySelector('#side').classList.contains('-translate-x-full')"));
await pg.click("#nav [data-nav=reminders]"); await W(250);
check("choosing a menu item closes the mobile menu", await pg.evaluate("document.querySelector('#side').classList.contains('-translate-x-full')&&S.view==='reminders'"));

check("no JavaScript errors on the page", errs.length === 0, errs.join(" | "));
const failed = out.filter((x) => x.startsWith("FAIL")).length;
console.log(`${out.length - failed}/${out.length} passed`);
await b.close(); process.exit(failed ? 1 : 0);
