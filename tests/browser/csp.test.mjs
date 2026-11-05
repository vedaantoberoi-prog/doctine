/**
 * Doctine · the app under its Content-Security-Policy (from tools/cloudflare-build.mjs, also in netlify.toml and
 * website/_headers). The page is served with the policy, plus a script tag like the analytics beacon a host can
 * inject into HTML. Checks the app still starts and runs its inline code, and that the injected script is refused.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const build = readFileSync(new URL("../../tools/cloudflare-build.mjs", import.meta.url), "utf8");
const CSP = build.match(/const CSP = "([^"]+)"/)[1];
const toml = readFileSync(new URL("../../netlify.toml", import.meta.url), "utf8"), site = readFileSync(new URL("../../website/_headers", import.meta.url), "utf8");
const results = []; const check = (name, ok, detail = "") => results.push((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""));
check("the same policy is used for the app on Cloudflare, staging on Netlify and the website", toml.includes(`Content-Security-Policy = "${CSP}"`) && site.includes(`Content-Security-Policy: ${CSP}`));
check("the policy allows scripts only from this site and the two library CDNs", /script-src 'self' [^;]*https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net;/.test(CSP) && !/cloudflareinsights|\*/.test(CSP));

const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [], blocked = [], beaconHits = [];
pg.on("pageerror", (e) => errs.push(e.message));
await pg.exposeFunction("__cspBlocked", (u) => blocked.push(u));
await pg.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => window.__cspBlocked(e.blockedURI)));
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u.includes("cloudflareinsights")) { beaconHits.push(u); return r.fulfill({ contentType: "text/javascript", body: "window.__beaconRan=true" }); }
  if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: '{"supabaseUrl":null,"supabaseAnonKey":null,"accounts":"browser_demo"}' });
  if (r.request().resourceType() === "document" && u.startsWith(BASE)) {
    const res = await r.fetch(); let body = await res.text();
    body = body.replace("</body>", '<script defer src="https://static.cloudflareinsights.com/beacon.min.js/v1" data-cf-beacon=\'{"token":"test"}\'></script></body>');
    return r.fulfill({ response: res, body, headers: { ...res.headers(), "content-security-policy": CSP } });
  }
  if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(800);
check("the app starts under the policy (inline scripts run, sign-in screen shown)", await pg.evaluate("typeof go==='function'&&!document.querySelector('#auth').classList.contains('hidden')"));
await pg.click("#samp"); await pg.waitForTimeout(300); await pg.evaluate("go('medicines')"); await pg.waitForTimeout(150);
check("screens still render and respond under the policy", (await pg.textContent("#view")).includes("Medicines"));
check("a script injected by the host (an analytics beacon) is refused and never runs", beaconHits.length === 0 && blocked.some((u) => /cloudflareinsights/.test(u)) && !(await pg.evaluate("!!window.__beaconRan")), JSON.stringify({ beaconHits, blocked }));
check("no JavaScript errors", errs.length === 0, errs.join(" | "));
await b.close();
console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
