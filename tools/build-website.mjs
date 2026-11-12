/**
 * Doctine · website release package.
 *   node tools/build-website.mjs           stamps asset links, then writes dist/doctine-website.zip
 *   node tools/build-website.mjs --check   fails if any page links an asset without its current fingerprint
 *
 * Browsers keep site.css, fonts.css and the 3D bundle for hours (Cloudflare's default caching). Each page links them as
 * /assets/site.css?v=<first 10 hex of the file's SHA-256>, so a changed file gets a new address at once and an
 * unchanged one stays cached. The zip leaves out dotfiles and README.md, as before.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url)), site = join(root, "website");
const ASSETS = ["/assets/site.css", "/assets/fonts/fonts.css", "/assets/hero3d/hero3d.js"];
const hash = (p) => createHash("sha256").update(readFileSync(join(site, p))).digest("hex").slice(0, 10);
const v = Object.fromEntries(ASSETS.map((a) => [a, hash(a)]));

const pages = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "app-preview" || n.startsWith(".")) continue; if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".html")) pages.push(p); } };
walk(site);

const check = process.argv.includes("--check");
let stale = [];
for (const p of pages) {
  const src = readFileSync(p, "utf8");
  let out = src;
  for (const a of ASSETS) {
    const re = new RegExp(a.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "(\\?v=[0-9a-f]+)?(?=['\"])", "g");
    out = out.replace(re, `${a}?v=${v[a]}`);
  }
  if (out !== src) { if (check) stale.push(p.slice(root.length)); else writeFileSync(p, out); }
}
if (check) {
  if (stale.length) { console.error("build-website: asset fingerprints out of date in " + stale.join(", ") + " (run node tools/build-website.mjs)"); process.exit(1); }
  console.log("build-website: every page links the current asset fingerprints"); process.exit(0);
}
mkdirSync(join(root, "dist"), { recursive: true }); rmSync(join(root, "dist/doctine-website.zip"), { force: true });
execFileSync("zip", ["-qr", "../dist/doctine-website.zip", ".", "-x", ".*", "-x", "README.md"], { cwd: site, stdio: "inherit" });
console.log("build-website: stamped " + pages.length + " pages (" + ASSETS.map((a) => a.split("/").pop() + "=" + v[a]).join(", ") + ") and wrote dist/doctine-website.zip");
