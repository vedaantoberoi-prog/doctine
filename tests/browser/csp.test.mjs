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
const dir = (n) => (CSP.split(";").map((d) => d.trim()).find((d) => d.startsWith(n + " ")) || "");
check("the policy allows scripts only from this site and the two library CDNs", /^script-src 'self' [^;]*https:\/\/cdnjs\.cloudflare\.com https:\/\/cdn\.jsdelivr\.net$/.test(dir("script-src")) && !/cloudflareinsights|\*/.test(dir("script-src")));
check("the app can connect only to itself, Supabase and the library CDNs; plugins, framing and outside forms are off",
  dir("connect-src").split(/\s+/).slice(1).every((s) => ["'self'", "blob:", "data:", "https://*.supabase.co", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"].includes(s))
  && ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "frame-src 'none'", "form-action 'self'"].every((d) => CSP.includes(d)), dir("connect-src"));

const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [], blocked = [], beaconHits = []; let tessServed = 0;
pg.on("pageerror", (e) => errs.push(e.message));
await pg.exposeFunction("__cspBlocked", (u) => blocked.push(u));
await pg.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => window.__cspBlocked(e.blockedURI)));
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u.includes("tesseract.min.js")) { tessServed++; return r.fulfill({ contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: "window.__tampered=true" }); }
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
// PDF reading uses the copy of PDF.js this site serves itself (no CDN), including its worker, under the policy
const pdfOut = await pg.evaluate(async () => {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = "BT /F1 12 Tf 20 150 Td (HbA1c 6.1 %) Tj ET"; objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length; pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  const r = await readPdf(new File([pdf], "t.pdf", { type: "application/pdf" }));
  const src = document.querySelector('script[src*="pdf.js"]').src;
  return { text: JSON.stringify(r).slice(0, 400), src, worker: pdfjsLib.GlobalWorkerOptions.workerSrc, version: pdfjsLib.version };
});
check("PDF.js is served by this site (no CDN) and reads a PDF with its worker under the policy", pdfOut.src.startsWith(BASE + "/vendor/") && pdfOut.version === "3.11.174" && /HbA1c/.test(pdfOut.text), JSON.stringify(pdfOut));
// every library from a public CDN is pinned by fingerprint: nothing outside the PIN list is loaded from a CDN
const appSrc = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const pinBlock = appSrc.slice(appSrc.indexOf("const PIN={"), appSrc.indexOf("};", appSrc.indexOf("const PIN={")));
const cdnOutside = (appSrc.replace(pinBlock, "").match(/https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)[^'"\s)]*/g) || []);
check("every library from a CDN is pinned by a SHA-384 fingerprint (none loaded outside the pinned list)", cdnOutside.length === 0 && (pinBlock.match(/'sha384-[A-Za-z0-9+/]{64}'/g) || []).length === 5, cdnOutside.join(" "));
// check-before-use: a correct file is accepted, a changed one is refused; the browser refuses a script whose fingerprint differs
const pin = await pg.evaluate(async (base) => {
  const body = await fetch(base + "/sw.js").then((r) => r.arrayBuffer());
  const sri = "sha384-" + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-384", body))));
  const ok = await verifiedURL([base + "/sw.js", sri]).then((u) => u.startsWith("blob:"), (e) => e.message);
  const bad = await verifiedURL([base + "/sw.js", "sha384-" + "A".repeat(64)]).then(() => "accepted", (e) => e.message);
  const tess = await loadTess().then(() => "loaded", (e) => e.message);
  return { ok, bad, tess };
}, BASE);
check("a downloaded component is used only if its fingerprint matches; a changed one is refused with a clear message", pin.ok === true && /didn’t match its expected fingerprint/.test(pin.bad), JSON.stringify(pin));
check("a tampered text-recognition library is refused by the browser, and the app says so instead of running it", tessServed > 0 && /could not load/.test(pin.tess) && !(await pg.evaluate("!!window.__tampered")), JSON.stringify({ tessServed, tess: pin.tess }));
check("no JavaScript errors", errs.length === 0, errs.join(" | "));
await b.close();
console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
