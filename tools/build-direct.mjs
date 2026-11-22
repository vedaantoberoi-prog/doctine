/**
 * Doctine · builds the app as a folder (and zip) that can be deployed to Cloudflare Pages by drag and drop, without Git:
 *   dist/doctine-app/            the public/ files, _headers, version.json, _worker.js (the server) and _routes.json
 *   dist/doctine-app.zip         the same folder, zipped, for Workers & Pages → project → Create deployment
 * Runs tools/cloudflare-build.mjs first (server tests, commit stamp, security headers), so a broken commit never builds.
 * The Pages project needs the nodejs_compat compatibility flag and the same variables as the Git-built app.
 *
 *   node tools/build-direct.mjs
 */
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const sha = process.env.CF_PAGES_COMMIT_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--", "public", "functions", "netlify"], { cwd: root }).toString().trim();
if (dirty && !process.env.ALLOW_DIRTY) { console.error("build-direct: commit your changes to public/, functions/ or netlify/ first, so the build matches its commit id."); process.exit(1); }

sh(process.execPath, ["tools/cloudflare-build.mjs"], { env: { ...process.env, CF_PAGES_COMMIT_SHA: sha } });
const out = root + "dist/doctine-app";
rmSync(root + "dist", { recursive: true, force: true }); mkdirSync(out, { recursive: true });
cpSync(root + "public", out, { recursive: true });
sh(root + "node_modules/.bin/esbuild", ["tools/worker-entry.mjs", "--bundle", "--format=esm", "--platform=neutral", "--target=es2022",
  "--main-fields=module,main", "--external:node:*", "--outfile=" + out + "/_worker.js", "--log-level=warning"]);
writeFileSync(out + "/_routes.json", JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }) + "\n");
for (const f of ["_headers", "version.json", "_worker.js", "_routes.json", "index.html", "404.html"]) if (!existsSync(out + "/" + f)) { console.error("build-direct: missing " + f); process.exit(1); }
if (/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][^"']{20,}/.test(readFileSync(out + "/_worker.js", "utf8"))) { console.error("build-direct: a secret value is in the bundle"); process.exit(1); }
sh(process.execPath, ["tests/worker.test.mjs"]);
sh("zip", ["-qr", "-X", "../doctine-app.zip", "."], { cwd: out });
console.log(`build-direct: dist/doctine-app.zip for commit ${sha.slice(0, 12)} (drag into Cloudflare → Workers & Pages → project → Create deployment)`);
