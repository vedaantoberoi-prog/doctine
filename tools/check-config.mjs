/**
 * Doctine · configuration consistency checks. Fails on anything that would make a deploy or the docs wrong:
 * netlify.toml settings, function routes, migration names, the web manifest, package scripts, env vars the code
 * reads but the docs don't mention, file paths the docs mention that don't exist, and workflow YAML.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");
const problems = [];
const ok = [];
const need = (cond, msg) => (cond ? ok.push(msg) : problems.push(msg));

// netlify.toml
const toml = read("netlify.toml");
need(/^\s*publish\s*=\s*"public"/m.test(toml), 'netlify.toml publishes "public"');
need(/^\s*directory\s*=\s*"netlify\/functions"/m.test(toml), 'netlify.toml functions directory is "netlify/functions"');
need(/^\s*command\s*=\s*".*tests\/functions\.test\.mjs/m.test(toml), "netlify.toml build runs the server tests");
need(!/SERVICE_ROLE|ANTHROPIC_API_KEY\s*=/.test(toml), "netlify.toml contains no secrets");

// functions: each exports a handler and a unique /api route
const routes = new Map();
for (const f of readdirSync(join(root, "netlify/functions")).filter((f) => f.endsWith(".mjs"))) {
  const m = await import(join(root, "netlify/functions", f));
  const path = m.config && m.config.path;
  need(typeof m.default === "function" && typeof path === "string" && path.startsWith("/api/"), `function ${f} exports a handler and an /api route (${path})`);
  need(!routes.has(path), `route ${path} is used once`);
  routes.set(path, f);
}
for (const r of ["/api/chat", "/api/scan", "/api/config", "/api/account"]) need(routes.has(r), `route ${r} exists`);

// migrations
const migs = readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
need(migs.every((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)), "migration file names are timestamped");
need(new Set(migs.map((f) => f.slice(0, 14))).size === migs.length, "migration timestamps are unique");

// web manifest
try {
  const man = JSON.parse(read("public/manifest.webmanifest"));
  need(Array.isArray(man.icons) && man.icons.every((i) => existsSync(join(root, "public", i.src))), "manifest icons exist");
} catch { problems.push("public/manifest.webmanifest is valid JSON"); }

// package.json scripts point at real files
const pkg = JSON.parse(read("package.json"));
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  for (const f of cmd.match(/(?:tools|tests)\/[\w./-]+\.(?:mjs|sh)/g) || []) need(existsSync(join(root, f)), `script "${name}" uses ${f}, which exists`);
}

// every environment variable the server reads is documented
const deploy = read("DEPLOY.md");
const envNames = new Set();
const walk = (d) => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
for (const f of walk("netlify").filter((f) => f.endsWith(".mjs"))) for (const m of read(f).matchAll(/(?:process\.env|env)\.([A-Z][A-Z0-9_]{3,})/g)) envNames.add(m[1]);
for (const n of envNames) need(deploy.includes(n) || (n.startsWith("RATE_LIMIT_") && deploy.includes("RATE_LIMIT_<ROUTE>")), `env var ${n} is documented in DEPLOY.md`);

// file paths mentioned in the docs exist
for (const doc of ["DEPLOY.md", "tests/browser/README.md"]) {
  for (const m of read(doc).matchAll(/`((?:public|netlify|supabase|tests|tools|\.github|docs)\/[\w./*-]+)`/g)) {
    const p = m[1];
    if (p.includes("*") || p.includes("<")) continue;
    if (p === "public/version.json") continue; // written at deploy time by the staging and release workflows
    need(existsSync(join(root, p)), `${doc} mentions ${p}, which exists`);
  }
}

// package-lock.json matches package.json exactly: pinned versions, public registry, sha512 integrity
try {
  const lock = JSON.parse(read("package-lock.json"));
  const dev = pkg.devDependencies || {}, deps = pkg.dependencies || {};
  need(lock.lockfileVersion === 3, "package-lock.json is lockfile version 3");
  need(JSON.stringify(lock.packages?.[""]?.devDependencies || {}) === JSON.stringify(dev) && JSON.stringify(lock.packages?.[""]?.dependencies || {}) === JSON.stringify(deps), "package-lock.json root matches package.json");
  for (const [n, v] of Object.entries({ ...dev, ...deps })) {
    need(/^\d+\.\d+\.\d+$/.test(v), `${n} is pinned to an exact version (${v})`);
    need(lock.packages[`node_modules/${n}`]?.version === v, `package-lock.json locks ${n} at ${v}`);
  }
  const entries = Object.entries(lock.packages).filter(([k]) => k);
  need(entries.every(([, e]) => /^https:\/\/registry\.npmjs\.org\//.test(e.resolved || "") && /^sha512-/.test(e.integrity || "")), `all ${entries.length} locked packages come from registry.npmjs.org with sha512 integrity`);
} catch (e) { problems.push("package-lock.json exists and is valid JSON (" + e.message + ")"); }

// workflow YAML parses (python3 + PyYAML if available; CI installs it)
if (existsSync(join(root, ".github/workflows"))) {
  for (const f of readdirSync(join(root, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f))) {
    try {
      execFileSync("python3", ["-c", "import sys,yaml; d=yaml.safe_load(open(sys.argv[1])); assert isinstance(d,dict) and 'jobs' in d and (True in d or 'on' in d)", join(root, ".github/workflows", f)], { stdio: "pipe" });
      ok.push(`workflow ${f} is valid YAML with jobs and triggers`);
    } catch (e) {
      if (/No module named|not found|ENOENT/.test(String(e.stderr || e.message))) console.warn(`! could not validate ${f}: python3 with PyYAML is not available`);
      else problems.push(`workflow ${f} is valid YAML with jobs and triggers`);
    }
  }
}

// workflow release controls (tools/check-workflows.py)
if (existsSync(join(root, ".github/workflows/release.yml"))) {
  try {
    const outp = execFileSync("python3", [join(root, "tools/check-workflows.py"), root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    for (const line of outp.trim().split("\n")) need(line.startsWith("ok "), line.replace(/^(ok|fail) /, ""));
  } catch (e) {
    if (/No module named|ENOENT/.test(String(e.stderr || e.message))) console.warn("! could not check workflow controls: python3 with PyYAML is not available");
    else problems.push("workflow control checks ran (" + String(e.stderr || e.message).split("\n").slice(-3).join(" ") + ")");
  }
}

for (const p of problems) console.error("✗ " + p);
console.log(`${problems.length ? "✗" : "✓"} config: ${ok.length} checks passed, ${problems.length} failed`);
process.exit(problems.length ? 1 : 0);
