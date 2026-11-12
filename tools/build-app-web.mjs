#!/usr/bin/env node
/**
 * Doctine · the web files packaged inside the Android (Capacitor) and Mac (Tauri) apps.
 *   node tools/build-app-web.mjs <output dir>
 * Copies the same app the website serves (public/index.html, native.js, vendor, fonts, icons, images, manifest), never
 * the admin console or server files, and puts the website's Content-Security-Policy into the page as a <meta> tag
 * (inside the apps there is no Cloudflare to send it), allowing exactly app.doctine.com for the server.
 * Fails if a secret-looking value or the admin console would be packaged.
 */
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2]; if (!out) { console.error("usage: build-app-web.mjs <output dir>"); process.exit(2); }
const pub = join(root, "public");
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const KEEP = ["index.html", "native.js", "manifest.webmanifest", "sw.js", "vendor", "fonts", "icons", "img"];
for (const k of KEEP) if (existsSync(join(pub, k))) cpSync(join(pub, k), join(out, k), { recursive: true });

// The app page's CSP from public/_headers ("/*" block), adapted for a packaged app.
const headers = readFileSync(join(pub, "_headers"), "utf8");
const block = headers.split(/\n(?=\/)/).find((b) => b.startsWith("/*")) || "";
let csp = (block.match(/Content-Security-Policy:\s*(.+)/) || [])[1];
if (!csp) { console.error("build-app-web: no CSP found for /* in public/_headers"); process.exit(1); }
csp = csp.split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/.test(d)) // not allowed in <meta>
  .map((d) => (/^connect-src\b/.test(d) && !d.includes("https://app.doctine.com") ? d + " https://app.doctine.com" : d))
  // the Mac app's own channel to its Rust core (Tauri IPC); nothing else is added
  .map((d) => (process.argv.includes("--tauri") && /^connect-src\b/.test(d) ? d + " ipc: http://ipc.localhost" : d)).join("; ");
let html = readFileSync(join(out, "index.html"), "utf8");
if (!/<head[^>]*>/.test(html)) { console.error("build-app-web: no <head>"); process.exit(1); }
html = html.replace(/<head([^>]*)>/, `<head$1>\n<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">`);
// --vendor: package supabase-js inside the app (so the sign-in screen works offline), downloaded from the same pinned URL
// and accepted only if it matches the page's own SRI hash; the page then loads it from the app instead of the CDN.
if (process.argv.includes("--vendor")) {
  const m = html.match(/supabase:\['(https:\/\/[^']+)','(sha384-[^']+)'\]/);
  if (!m) { console.error("build-app-web: PIN.supabase not found"); process.exit(1); }
  const buf = Buffer.from(await (await fetch(m[1])).arrayBuffer());
  const { createHash } = await import("node:crypto");
  const got = "sha384-" + createHash("sha384").update(buf).digest("base64");
  if (got !== m[2]) { console.error("build-app-web: supabase-js does not match its pinned hash"); process.exit(1); }
  mkdirSync(join(out, "vendor"), { recursive: true }); writeFileSync(join(out, "vendor", "supabase.js"), buf);
  html = html.replace(m[0], `supabase:['vendor/supabase.js','${m[2]}']`);
  console.log("build-app-web: supabase-js packaged (" + buf.length + " bytes, hash verified)");
}
writeFileSync(join(out, "index.html"), html);
writeFileSync(join(out, "version.json"), JSON.stringify({ commit: process.env.GITHUB_SHA || "local", built: new Date().toISOString() }));

// Checks: nothing from the admin console, no server code, no secret-looking values.
const files = []; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } }; walk(out);
const bad = files.filter((f) => /\/admin\/|_worker|_headers|\.mjs$/.test(f));
if (bad.length) { console.error("build-app-web: must not package " + bad.map((f) => relative(out, f)).join(", ")); process.exit(1); }
for (const f of files.filter((f) => /\.(html|js|json)$/.test(f))) {
  const t = readFileSync(f, "utf8");
  if (/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][^"']{20,}|sk-ant-[A-Za-z0-9_-]{20,}|service_role"\s*,\s*"iat"/.test(t)) { console.error("build-app-web: secret-looking value in " + relative(out, f)); process.exit(1); }
}
console.log(`build-app-web: ${files.length} files in ${relative(process.cwd(), out) || out}; CSP connect-src allows app.doctine.com`);
