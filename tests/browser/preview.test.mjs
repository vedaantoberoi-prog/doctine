/**
 * Doctine · the website's app preview (website/app-preview, built by tools/build-preview.mjs), served as a static site
 * the way Netlify serves doctine.com. Checks that it opens straight into the fictional sample data, leaves out the
 * alarm and family features, never sends anything to a server, and still gives fixed 112 guidance in an emergency.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../website/", import.meta.url));
const srv = createServer((q, r) => {
  let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  const f = normalize(join(root, p));
  if (!f.startsWith(root) || !existsSync(f) || !statSync(f).isFile()) { r.writeHead(404); return r.end("not found"); }
  r.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" }); r.end(readFileSync(f));
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;

const results = []; const check = (name, ok, detail = "") => results.push((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""));
const b = await chromium.launch(); const errs = []; const apiSeen = []; const outside = [];
const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
pg.on("pageerror", (e) => errs.push(e.message));
await pg.route("**/*", (r) => { const u = r.request().url();
  if (/\/api\//.test(u)) { apiSeen.push(u); return r.abort(); }
  if (u.startsWith(BASE)) return r.continue(); outside.push(new URL(u).host); return r.abort(); });

await pg.goto(BASE + "/"); await pg.waitForTimeout(200);
check("the homepage links to the app preview", (await pg.$$eval("a[href='/app-preview/']", (a) => a.length)) >= 2);
check("the homepage keeps the safety notice (112 and Tele-MANAS 14416)", /112/.test(await pg.textContent("body")) && /14416/.test(await pg.textContent("body")));

await pg.goto(BASE + "/app-preview/"); await pg.waitForTimeout(500);
check("the preview opens straight into the sample data", await pg.evaluate("S.sample===true&&!S.email&&document.querySelector('#auth').classList.contains('hidden')"));
const nav = await pg.$$eval("#nav [data-nav]", (e) => e.map((x) => x.dataset.nav));
check("the menu has no Reminders or Family", !nav.includes("reminders") && !nav.includes("family") && nav.includes("medicines"), nav.join(","));
check("the sample-data notice says nothing is saved", (await pg.textContent("body")).includes("Preview with made-up sample data. Nothing you change is saved."));
await pg.evaluate("go('settings')"); await pg.waitForTimeout(100);
const set = await pg.textContent("#view");
check("Settings has no alarm or notification sections", !/Alarms|Reminder notifications|Test alarm/.test(set));

// a sample dose falling due must not ring
await pg.evaluate("(()=>{const d=new Date();S.meds[0].start=today();S.meds[0].end='';S.meds[0].times=[String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')];S.alerted={};render()})()");
await pg.waitForTimeout(5600);
check("a sample medicine falling due doesn't ring an alarm", !(await pg.evaluate("DoctineAlarms.ringing()")) && !(await pg.evaluate("Object.keys(S.alerted).length")));

await pg.evaluate("go('chat')"); await pg.fill("#ci", "What does a high HbA1c mean?"); await pg.click("#cf button.pri"); await pg.waitForTimeout(400);
check("chat says the AI is switched off in the preview", (await pg.textContent("#view")).includes("switched off in this preview"));
await pg.fill("#ci", "my father has crushing chest pain and his left arm is numb"); await pg.click("#cf button.pri"); await pg.waitForTimeout(400);
check("an emergency message still gets fixed 112 guidance", /112/.test(await pg.textContent("#view")));
check("nothing is sent to a server: every /api request is answered inside the page", apiSeen.length === 0, apiSeen.join(" "));

await pg.evaluate("document.querySelector('#out').click()"); await pg.waitForTimeout(200); // in the phone menu
check("'Reset sample data' stays in the preview instead of opening a sign-in screen", await pg.evaluate("S.sample===true&&document.querySelector('#auth').classList.contains('hidden')") && (await pg.textContent("#out")).includes("Reset sample data"));
check("no service worker is registered", (await pg.evaluate("navigator.serviceWorker?navigator.serviceWorker.getRegistrations().then(r=>r.length):0")) === 0);

const wide = [];
for (const v of nav) { await pg.evaluate(`go('${v}')`); await pg.waitForTimeout(60);
  if (await pg.evaluate("(()=>{const v=document.querySelector('#view');return document.documentElement.scrollWidth>innerWidth||v.scrollWidth>v.clientWidth+1})()")) wide.push(v); }
check("no preview screen scrolls sideways at phone width (390px)", wide.length === 0, wide.join(","));
check("no JavaScript errors in the preview", errs.length === 0, errs.join(" | "));

console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
await b.close(); srv.close(); process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
