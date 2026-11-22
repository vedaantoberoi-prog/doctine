/**
 * Doctine · the doctine.com website under its own Content-Security-Policy (website/_headers), served the way Cloudflare
 * Pages serves it. The site is static: everything loads from doctine.com, with no eval, no outside scripts and nowhere
 * to send data. Every page (and the 3D scene on the homepage) must load without a single policy violation.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../website/", import.meta.url));
const headers = readFileSync(join(root, "_headers"), "utf8");
const csp = (headers.match(/Content-Security-Policy: (.*)/) || [])[1] || "";
const results = []; const check = (name, ok, detail = "") => results.push((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""));

check("the website policy has no eval, no outside script hosts and no database", !!csp && !/unsafe-eval|https:|supabase/.test(csp), csp);
check("…and only connects back to doctine.com itself", /connect-src 'self';/.test(csp) && /default-src 'self'/.test(csp));
check("the website doesn't ask for the camera", /camera=\(\)/.test(headers));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain" };
// upgrade-insecure-requests would turn the local http server's own requests into https, so it is left out locally only
const served = csp.replace(/;?\s*upgrade-insecure-requests/, "");
const srv = createServer((q, r) => {
  let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  const f = normalize(join(root, p));
  if (!f.startsWith(root) || !existsSync(f) || !statSync(f).isFile()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream", "content-security-policy": served }); r.end(readFileSync(f));
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
for (const path of ["/", "/about/", "/contact/", "/medical-safety/", "/privacy/", "/terms/", "/404.html"]) {
  const pg = await b.newPage(); const v = [];
  pg.on("console", (m) => { if (/Content Security Policy|Refused/i.test(m.text())) v.push(m.text().slice(0, 140)); });
  pg.on("pageerror", (e) => v.push("JS error: " + e.message.slice(0, 120)));
  await pg.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.log("Refused (CSP) " + e.violatedDirective + " " + e.blockedURI)));
  await pg.goto(BASE + path); await pg.waitForTimeout(path === "/" ? 5000 : 600);
  if (path === "/") check("the homepage's 3D scene starts under the policy", (await pg.$$eval("canvas", (c) => c.length)) > 0);
  check(`${path} loads with no policy violations or script errors`, v.length === 0, v.join(" | "));
  await pg.close();
}
console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
await b.close(); srv.close(); process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
