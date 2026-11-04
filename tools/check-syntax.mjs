/** Doctine · syntax check for every JavaScript file, including the inline <script> blocks of public/index.html. */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
const skip = new Set(["node_modules", ".git", "reports", "test-results"]);
const walk = (d) => readdirSync(d).flatMap((f) => (skip.has(f) ? [] : statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(root).filter((f) => /\.(mjs|js)$/.test(f));
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
  catch (e) { bad++; console.error("✗ " + f.replace(root, "") + "\n" + String(e.stderr || e.message).split("\n").slice(0, 4).join("\n")); }
}
// Inline scripts in the web page are classic scripts: parse each one.
const html = readFileSync(join(root, "public/index.html"), "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
blocks.forEach((code, i) => {
  try { new vm.Script(code, { filename: `public/index.html#script${i + 1}` }); }
  catch (e) { bad++; console.error(`✗ public/index.html inline script ${i + 1}: ${e.message}`); }
});
console.log(`${bad ? "✗" : "✓"} syntax: ${files.length} files and ${blocks.length} inline scripts checked, ${bad} problem${bad === 1 ? "" : "s"}`);
process.exit(bad ? 1 : 0);
