/**
 * Doctine · builds the public preview of the app for the website (website/app-preview/index.html) from public/index.html.
 *
 * The preview is the real app, opened straight into its fictional sample data, with these differences:
 *   - no Reminders (alarms) or Family sections;
 *   - it never calls the server: /api/* requests are answered in the browser, so chat and the scanner say they are
 *     switched off in the preview, and no account, sign-in or saving exists;
 *   - no service worker, so the preview never caches itself over the website.
 * The libraries and fonts the app serves itself (public/vendor/, public/fonts/) are copied next to the preview.
 * Every change is a literal replacement that must match exactly once; if the app changes and a replacement no longer
 * matches, the build stops instead of producing a half-patched preview.
 *
 *   node tools/build-preview.mjs            # writes website/app-preview/index.html
 *   node tools/build-preview.mjs --check    # fails if the committed preview is out of date with public/index.html
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(root + "public/index.html", "utf8");
const outPath = root + "website/app-preview/index.html";

const PREVIEW_NOTE = "Preview with made-up sample data. Nothing you change is saved.";
const AI_OFF = "The AI assistant and the scanner are switched off in this preview. They will work in the Doctine app when it opens at app.doctine.com.";

const interceptor = `<script>/* Doctine website preview: the preview has no server. Answer /api/* here so nothing leaves the browser. */
(function(){var f=window.fetch.bind(window);window.fetch=function(u,o){var s=String(u&&u.url||u);if(/(^|\\/)api\\//.test(s)){
var body=/api\\/config/.test(s)?{environment:"preview",supabase:null}:{ok:false,error:"not_configured",missing:[]};
return Promise.resolve(new Response(JSON.stringify(body),{status:/api\\/config/.test(s)?200:503,headers:{"content-type":"application/json"}}))}return f(u,o)}})();
</script>`;

const edits = [
  ["no alarms in the menu (Family isn't in the app's menu either)",
    "['medicines','Medicines','meds'],['reminders','Reminders','clock'],",
    "['medicines','Medicines','meds'],"],
  ["the home card links to medicines, not reminders",
    "data-nav=\"${S.meds.length?'reminders':'medicines'}\">${S.meds.length?'Open reminders':'Add a medicine'}",
    "data-nav=\"medicines\">${S.meds.length?'Open medicines':'Add a medicine'}"],
  ["the AI-unavailable message explains the preview",
    /not_configured:'[^']*'/,
    `not_configured:'${AI_OFF}'`],
  ["the sample-data banner fits the preview",
    "Sample data (fictional). Changes are not saved. Create an account to start with your own empty profile.",
    PREVIEW_NOTE],
  ["sign out resets the sample data instead of opening the sign-in screen",
    "$('#out').onclick=async()=>{",
    "$('#out').onclick=async()=>{return enter(null,sampleData(),true);"],
  ["Settings has no alarm, notification or AI-connection sections",
    /<section class="card p-5 space-y-3"><h2 class="text-xl">Alarms<\/h2>[\s\S]*?(?=<section class="card p-5 space-y-3"><h2 class="text-xl">Your data<\/h2>)/,
    ""],
  ["the sign-out button is labelled for the preview",
    "<button class=\"nav\" id=\"out\">↩ Sign out</button>",
    "<button class=\"nav\" id=\"out\">↺ Reset sample data</button>"],
  ["not installable as an app from the website",
    /<link rel="manifest" href="manifest\.webmanifest"[^>]*>/,
    ""],
  ["no service worker",
    "'serviceWorker' in navigator&&location.protocol==='https:'",
    "false&&location.protocol==='https:'"],
  ["opens straight into the sample data",
    "initCloud().then(",
    "enter(null,sampleData(),true);initCloud().then("],
  ["the server-free fetch runs before the app",
    "<script src=\"vendor/pdfjs-3.11.174/pdf.js\">",
    interceptor + "<script src=\"vendor/pdfjs-3.11.174/pdf.js\">"],
  ["the page says it is a preview",
    /<title>[^<]*<\/title>/,
    "<title>Doctine app preview</title><meta name=\"robots\" content=\"noindex\">"],
];

let html = src;
for (const [why, find, repl] of edits) {
  const hits = typeof find === "string" ? html.split(find).length - 1 : (html.match(new RegExp(find.source, "g")) || []).length;
  if (hits !== 1) { console.error(`build-preview: "${why}" matched ${hits} times (expected 1). Update tools/build-preview.mjs for the changed app.`); process.exit(1); }
  html = typeof find === "string" ? html.replace(find, () => repl) : html.replace(find, () => repl);
}
for (const k of ["['reminders','Reminders'", "['family','Family'", '<h2 class="text-xl">Alarms</h2>', '<h2 class="text-xl">Reminder notifications</h2>']) if (html.includes(k)) { console.error("build-preview: " + k + " is still in the preview"); process.exit(1); }

const COPIED = ["vendor", "fonts", "img"]; // folders of public/ the app loads by relative path, copied into website/app-preview/
const listFiles = (dir) => { try { return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => (e.parentPath || e.path).slice(dir.length) + "/" + e.name).sort(); } catch { return []; } };
if (process.argv.includes("--check")) {
  let cur = ""; try { cur = readFileSync(outPath, "utf8"); } catch {}
  if (cur !== html) { console.error("build-preview: website/app-preview/index.html is out of date. Run: node tools/build-preview.mjs"); process.exit(1); }
  for (const d of COPIED) {
    const src = root + "public/" + d, out = root + "website/app-preview/" + d, a = listFiles(src), b = listFiles(out);
    if (a.join() !== b.join() || a.some((f) => !readFileSync(src + f).equals(readFileSync(out + f)))) { console.error(`build-preview: website/app-preview/${d} differs from public/${d}. Run: node tools/build-preview.mjs`); process.exit(1); }
  }
  console.log("build-preview: preview is up to date"); process.exit(0);
}
mkdirSync(root + "website/app-preview", { recursive: true });
writeFileSync(outPath, html);
for (const d of COPIED) { rmSync(root + "website/app-preview/" + d, { recursive: true, force: true }); cpSync(root + "public/" + d, root + "website/app-preview/" + d, { recursive: true }); }
console.log(`build-preview: wrote website/app-preview/index.html (${edits.length} changes)`);
