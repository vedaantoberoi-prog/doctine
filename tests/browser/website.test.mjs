/**
 * Doctine · the doctine.com website (website/), served as a static site the way Cloudflare Pages serves it.
 * Checks that every page shares one header and footer, every internal link and asset exists, features that aren't
 * available are labelled as such, claims we can't support stay out, and no page scrolls sideways from 320px up.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../website/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml" };
const resolve = (p) => { let f = decodeURIComponent(p.split(/[?#]/)[0]); if (f.endsWith("/")) f += "index.html"; f = normalize(join(root, f)); return f.startsWith(root) && existsSync(f) && statSync(f).isFile() ? f : null; };
const srv = createServer((q, r) => { const f = resolve(q.url); if (!f) { r.writeHead(404); return r.end("not found"); } r.writeHead(200, { "content-type": types[extname(f)] || "application/octet-stream" }); r.end(readFileSync(f)); }).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}`;
const PAGES = ["/", "/about/", "/medical-safety/", "/contact/", "/privacy/", "/terms/"];

const results = []; const check = (name, ok, detail = "") => results.push((ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""));
const html = Object.fromEntries(PAGES.map((p) => [p, readFileSync(resolve(p), "utf8")]));
const between = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
const strip = (s) => s.replace(/ aria-current="page"/g, "");

// structure shared by every page
const head0 = strip(between(html["/"], '<header class="site-head">', "</header>")), foot0 = between(html["/"], '<footer class="site-foot">', "</footer>");
check("every page has the same header and footer", PAGES.every((p) => strip(between(html[p], '<header class="site-head">', "</header>")) === head0 && between(html[p], '<footer class="site-foot">', "</footer>") === foot0));
check("every page uses the shared stylesheet and has one h1", PAGES.every((p) => html[p].includes('href="/assets/site.css"') && (html[p].match(/<h1[\s>]/g) || []).length === 1));
const internal = [...new Set(PAGES.flatMap((p) => [...html[p].matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1])))];
const broken = internal.filter((u) => !resolve(u));
check("every internal link and asset exists", broken.length === 0, broken.join(" "));
const anchors = PAGES.flatMap((p) => [...html[p].matchAll(/href="\/#([\w-]+)"/g)].map((m) => m[1])).filter((id) => !html["/"].includes(`id="${id}"`));
check("links to homepage sections point at real sections", anchors.length === 0, anchors.join(" "));
check("sign-up buttons go to the real app", (html["/"].match(/href="https:\/\/app\.doctine\.com\/"/g) || []).length >= 3);

// honesty: what isn't available is labelled, and unsupported claims stay out
const home = html["/"];
check("the assistant is labelled as not yet available", /status dev">In development · not yet available/.test(home));
check("family profiles are labelled as in development", /status dev">Family profiles in development/.test(home));
check("the vision separates available, in development and planned", /status now">Available now/.test(home) && /status later">Planned/.test(home));
const all = PAGES.map((p) => html[p]).join("\n");
const banned = [/revolution/i, /AI doctor/i, /guarantee/i, /predict(s|ing)? (every|disease)/i, /replac(e|es|ing) (your )?doctors?/i, /not a medical device/i, /is a medical device/i, /clinically (validated|proven)(?! )/i, /Look after your family/i, /HIPAA|ISO 27001|SOC 2|end-to-end encrypt/i];
// denials ("doesn't replace your doctor", "hasn't been clinically validated") are the safe wording, so they're allowed
const denied = all.replace(/hasn't been clinically validated|has not been clinically validated/gi, "").replace(/(doesn't|does not|never|not)( [a-z]+){0,3} replace (your )?doctors?/gi, "");
const found = banned.filter((r) => r.test(denied));
check("no unsupported claims (medical-device status, guarantees, certifications, family features)", found.length === 0, found.join(" "));
// search engines and link previews
check("every page names its canonical address and has a full link preview with an image", PAGES.every((p) => html[p].includes(`<link rel="canonical" href="https://doctine.com${p}">`) && html[p].includes('og:image" content="https://doctine.com/assets/brand/og-image.png"') && html[p].includes('twitter:card')));
const robots = readFileSync(resolve("/robots.txt"), "utf8"), sitemap = readFileSync(resolve("/sitemap.xml"), "utf8"), notFound = readFileSync(resolve("/404.html"), "utf8");
check("robots.txt points to the sitemap, and the sitemap lists every public page", /Sitemap: https:\/\/doctine\.com\/sitemap\.xml/.test(robots) && PAGES.every((p) => sitemap.includes(`<loc>https://doctine.com${p}</loc>`)));
check("a 'page not found' page exists (so unknown addresses aren't served as the homepage), isn't indexed and links home", notFound.includes('name="robots" content="noindex"') && notFound.includes('href="/"') && strip(between(notFound, '<header class="site-head">', "</header>")) === head0);
// security contact (RFC 9116) on both sites, and the app's own "not found" page (unknown app addresses aren't the app)
const sec = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const secOk = (t, host) => /^Contact: mailto:support@doctine\.com$/m.test(t) && new Date((t.match(/^Expires: (.+)$/m) || [])[1]) > new Date() && t.includes(`Canonical: https://${host}/.well-known/security.txt`);
check("both sites publish a security contact (security.txt) that hasn't expired", secOk(sec("../../website/.well-known/security.txt"), "doctine.com") && secOk(sec("../../public/.well-known/security.txt"), "app.doctine.com"));
const app404 = sec("../../public/404.html");
check("the app has its own 'page not found' page that isn't indexed and links back", app404.includes('content="noindex"') && app404.includes('href="/"') && !/<script/i.test(app404));
// fonts are served by the sites themselves: no page or the app contacts Google Fonts, and every font file listed exists
const appHtml = sec("../../public/index.html");
check("no page (website or app) loads anything from Google Fonts", ![...PAGES.map((p) => html[p]), notFound, appHtml].some((h) => /fonts\.(googleapis|gstatic)\.com/.test(h)));
const fontsOk = ["../../website/assets/fonts/", "../../public/fonts/"].every((dir) => {
  const css = sec(dir + "fonts.css"); const files = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
  return files.length === 4 && files.every((f) => readFileSync(fileURLToPath(new URL(dir + f, import.meta.url))).subarray(0, 4).toString() === "wOF2");
});
check("each site's fonts.css lists 4 font files that exist and are real WOFF2 fonts", fontsOk);
check("emergency numbers are on every page", PAGES.every((p) => /call 112/.test(html[p]) && /14416/.test(html[p])));

// in a browser: no sideways scrolling, the menu works on phones, no script errors
const b = await chromium.launch(); const errs = [];
const wide = [];
for (const w of [320, 360, 390, 430, 768, 1280]) {
  const pg = await b.newPage({ viewport: { width: w, height: 800 } }); pg.on("pageerror", (e) => errs.push(e.message));
  await pg.route("**/*", (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  for (const p of PAGES) { await pg.goto(BASE + p); if (await pg.evaluate("document.documentElement.scrollWidth>innerWidth")) wide.push(`${p}@${w}`); }
  if (w === 360) {
    await pg.goto(BASE + "/");
    check("on a phone the main links move into a menu", !(await pg.isVisible(".nav")) && (await pg.isVisible(".menu summary")));
    await pg.click(".menu summary");
    check("…which opens and links to every main page", (await pg.isVisible('.menu .panel a[href="/medical-safety/"]')) && (await pg.isVisible('.menu .panel a[href="/about/"]')));
    const small = await pg.evaluate(`[...document.querySelectorAll('.btn,.menu summary,.signin')].filter(e=>e.offsetParent&&e.getBoundingClientRect().height<40).length`);
    check("buttons are at least 40px tall on phones", small === 0, String(small));
    const fontState = await pg.evaluate(async () => { await document.fonts.ready; return { serif: document.fonts.check("600 32px Fraunces"), sans: document.fonts.check("400 16px 'Instrument Sans'"), loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family) }; });
    check("the homepage renders with its own Fraunces and Instrument Sans (Google is blocked in this test)", fontState.serif && fontState.sans && fontState.loaded.some((f) => /Fraunces/.test(f)) && fontState.loaded.some((f) => /Instrument Sans/.test(f)), JSON.stringify(fontState));
  }
  await pg.close();
}
check("no page scrolls sideways from 320px to desktop", wide.length === 0, wide.join(" "));
check("no JavaScript errors", errs.length === 0, errs.join(" | "));
await b.close(); srv.close();
console.log(results.join("\n"));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
