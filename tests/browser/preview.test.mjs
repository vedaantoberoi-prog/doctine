/**
 * Doctine · the website (website/), served as a static site the way Cloudflare Pages serves doctine.com.
 * The sample records used to be a copy of the app kept on the website (/app-preview/), which fell behind the real app.
 * Now every "sample" link opens the real app at app.doctine.com/?sample=1, and the old address redirects there.
 * (The real app's ?sample=1 behaviour is checked in dashboard.test.mjs.)
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../website/", import.meta.url));
const srv = createServer((q, r) => {
  let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  const f = normalize(join(root, p));
  if (!f.startsWith(root) || !existsSync(f) || !statSync(f).isFile()) { r.writeHead(404); return r.end("not found"); }
  r.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" }); r.end(readFileSync(f));
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`, SAMPLE = "https://app.doctine.com/?sample=1";

const results = []; const check = (name, ok, detail = "") => results.push((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""));
const b = await chromium.launch(); const errs = []; const left = [];
const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
pg.on("pageerror", (e) => errs.push(e.message));
await pg.route("**/*", (r) => { const u = r.request().url(); if (u.startsWith(BASE)) return r.continue(); left.push(u); return r.abort(); });

await pg.goto(BASE + "/"); await pg.waitForTimeout(200);
check("the homepage's sample links open the real app's sample account", (await pg.$$eval(`a[href='${SAMPLE}']`, (a) => a.length)) >= 2);
check("no page links the old copy of the app", !(await pg.$("a[href='/app-preview/']")));
check("the homepage keeps the safety notice (112 and Tele-MANAS 14416)", /112/.test(await pg.textContent("body")) && /14416/.test(await pg.textContent("body")));
for (const [path, title] of [["/privacy/", "Privacy policy"], ["/terms/", "Terms of service"]]) {
  await pg.goto(BASE + path); await pg.waitForTimeout(100); const t = await pg.textContent("body");
  check(`${title} page names the operator and a contact, and keeps the 112 notice`, (await pg.textContent("h1")) === title && t.includes("Doctine Private Limited") && t.includes("support@doctine.com") && /112/.test(t));
  check(`${title} page links the sample to the real app`, (await pg.$(`a[href='${SAMPLE}']`)) !== null);
  check(`${title} page doesn't scroll sideways at phone width`, !(await pg.evaluate("document.documentElement.scrollWidth>innerWidth")));
}
await pg.goto(BASE + "/"); check("the homepage links to the privacy policy and terms", (await pg.$("a[href='/privacy/']")) !== null && (await pg.$("a[href='/terms/']")) !== null);

// the old address (bookmarks, shared links) sends people to the real app's sample
left.length = 0;
await pg.goto(BASE + "/app-preview/").catch(() => {}); await pg.waitForTimeout(300);
check("the old /app-preview/ address redirects to the real app's sample", left.some((u) => u === SAMPLE), left.join(" "));
const html = readFileSync(join(root, "app-preview/index.html"), "utf8");
check("…with a link to follow if redirects are blocked", html.includes(`href="${SAMPLE}"`) && html.includes(`url=${SAMPLE}`));
check("the website holds no copy of the app any more", readdirSync(join(root, "app-preview")).join() === "index.html" && !html.includes("function homeView"));

check("no JavaScript errors", errs.length === 0, errs.join(" | "));
console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
await b.close(); srv.close(); process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
