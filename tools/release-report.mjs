/**
 * Doctine · release report and release gates.
 *   node tools/release-report.mjs [--require=1-5|1-6|1-7] [--enforce]
 * Reads the JSON reports the CI jobs wrote into REPORT_DIR (default: reports), evaluates gates 1–7 and writes
 *   REPORT_DIR/report.json   machine-readable
 *   REPORT_DIR/REPORT.md     human-readable (also appended to the GitHub step summary when GITHUB_STEP_SUMMARY is set)
 * A gate is "passed" only when its report exists AND shows zero failures. A missing report is "not_run", never
 * "passed". With --enforce the script exits 1 unless every required gate passed.
 *
 * Gates
 *   1 Code quality       syntax, configuration, dependency install, build bundles      (quality.json)
 *   2 Backend tests      function, medical-grader and release-gate tests (mocked AI)   (backend.json, eval-grader.json, release-gates.json)
 *   3 Browser tests      Playwright against the real functions (simulated AI/Supabase) (browser.json)
 *   4 Database security  RLS, consent, deletion on real PostgreSQL                     (database.json)
 *   5 Security checks    secret scans, dependency audit                                (security.json)
 *   6 Staging verified   smoke check + end-to-end with synthetic accounts + LIVE medical evaluation with 0 critical,
 *                        0 errors, all on the deployed staging site and the commit under release
 *                        (smoke-staging.json, staging-e2e.json, medical-eval.json)
 *   7 Clinical sign-off  docs/medical-review/<run id>.md with "decision: approved"      (plus GitHub environment approval)
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";

const dir = process.env.REPORT_DIR || "reports";
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1];
const [lo, hi] = (arg("require") || "1-5").split("-").map(Number);
const required = new Set(Array.from({ length: (hi || lo) - lo + 1 }, (_, i) => lo + i));
const enforce = process.argv.includes("--enforce");
const load = (f) => { const p = `${dir}/${f}`; if (!existsSync(p)) return null; try { return JSON.parse(readFileSync(p, "utf8")); } catch { return { _corrupt: true }; } };

const gate = (n, name, evidence, fn) => {
  let status = "not_run", details = [];
  try { const r = fn(); status = r.status; details = r.details || []; } catch (e) { status = "failed"; details = ["report unreadable: " + e.message]; }
  return { gate: n, name, required: required.has(n), status, evidence, details };
};
/* The steps each step-based gate must contain. A step that was removed from the workflow, skipped, or never
   recorded fails the gate: a gate can't pass on fewer checks than it promises. */
const REQUIRED_STEPS = {
  quality: ["Install dependencies (npm ci, lockfile)", "Syntax check", "Configuration check", "Function bundles build", "Safety rules in sync"],
  security: ["Doctine secret scan (working tree)", "Gitleaks (git history, redacted)", "npm audit (high+, lockfile)", "No server secrets in public/"],
};
const fromSteps = (j, must = []) => {
  if (!j) return { status: "not_run", details: ["no report"] };
  if (j._corrupt || !Array.isArray(j.steps) || !j.steps.length) return { status: "failed", details: ["report empty or corrupt"] };
  const bad = j.steps.filter((s) => s.status !== "passed");
  const missing = must.filter((l) => !j.steps.some((s) => s.label === l));
  return { status: bad.length || missing.length ? "failed" : "passed",
    details: [...j.steps.map((s) => `${s.status === "passed" ? "✓" : "✗"} ${s.label}${s.status === "passed" ? "" : ` (exit ${s.exit})`}`), ...missing.map((l) => `✗ ${l}: required step was not run`)] };
};
const SHA = /^[0-9a-f]{40}$/;
/* A live target: an https address that isn't this machine. Rejects local dev servers and tooling runs. */
const liveTarget = (u) => { try { const x = new URL(u); return x.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(x.hostname) && !x.hostname.endsWith(".localhost"); } catch { return false; } };
const host = (u) => { try { return new URL(u).host; } catch { return ""; } };
const fromCounts = (j, label) => {
  if (!j) return { status: "not_run", details: [`${label}: no report`] };
  if (j._corrupt) return { status: "failed", details: [`${label}: report corrupt`] };
  const ok = j.failed === 0 && j.passed > 0;
  return { status: ok ? "passed" : "failed", details: [`${label}: ${j.passed} passed, ${j.failed} failed${j.kind ? ` — ${j.kind}` : ""}`] };
};
const both = (...rs) => ({ status: rs.some((r) => r.status === "failed") ? "failed" : rs.every((r) => r.status === "passed") ? "passed" : "not_run", details: rs.flatMap((r) => r.details) });

/* Gate 7. The sign-off must name the exact evaluation run and the exact (full) commit that run evaluated, a reviewer,
   a registration number and a valid date, and say "decision: approved". The registration number is recorded as
   written: Doctine does not verify it with a medical council. */
function checkSignoff(med, releaseSha, readFile = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null), today = new Date()) {
  if (!med || !med.run_id) return { status: "not_run", details: ["no live evaluation run to sign off"] };
  if (!/^run-[\w-]{1,80}$/.test(med.run_id)) return { status: "failed", details: [`evaluation run id ${JSON.stringify(med.run_id)} is malformed`] };
  const f = `docs/medical-review/${med.run_id}.md`;
  const t = readFile(f);
  if (t == null) return { status: "not_run", details: [`${f} does not exist — a clinician has not signed off this run`] };
  const field = (k) => ((t.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m")) || [])[1] || "").replace(/#.*$/, "").trim();
  const placeholder = (v) => !v || /^<.*>$/.test(v) || /^_+$/.test(v);
  const problems = [];
  const reviewer = field("reviewer"), reg = field("registration"), date = field("date"), commit = field("commit"), decision = field("decision");
  if (field("run_id") !== med.run_id) problems.push(`run_id is "${field("run_id") || "missing"}", but the evaluation run is ${med.run_id}`);
  if (!commit) problems.push("commit is missing");
  else if (!SHA.test(commit)) problems.push(`commit "${commit}" is not a full 40-character commit id`);
  else {
    if (commit !== med.deployed_commit) problems.push(`sign-off is for commit ${commit.slice(0, 12)}, but the evaluation ran on ${String(med.deployed_commit || "an unknown commit").slice(0, 12)}`);
    if (releaseSha && commit !== releaseSha) problems.push(`sign-off is for commit ${commit.slice(0, 12)}, but the commit under release is ${releaseSha.slice(0, 12)}`);
  }
  if (placeholder(reviewer)) problems.push("reviewer name is missing");
  if (placeholder(reg)) problems.push("medical registration number is missing");
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || !d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) problems.push(`review date "${date || "missing"}" is not a valid YYYY-MM-DD date`);
  else {
    const evalDay = med.generated_at ? Date.parse(med.generated_at.slice(0, 10)) : NaN;
    if (d.getTime() > today.getTime() + 36 * 3600_000) problems.push(`review date ${date} is in the future`);
    if (Number.isFinite(evalDay) && d.getTime() < evalDay - 24 * 3600_000) problems.push(`review date ${date} is before the evaluation ran`);
  }
  if (decision !== "approved") problems.push(`decision is "${decision || "missing"}", not "approved"`);
  const details = [`reviewer: ${reviewer || "—"} · registration ${reg || "—"} (as written; not independently verified) · ${date || "no date"}`, `run ${field("run_id") || "—"} · commit ${commit || "—"} · decision ${decision || "—"}`, ...problems.map((p) => "✗ " + p)];
  return { status: problems.length ? "failed" : "passed", details };
}

const quality = load("quality.json"), backend = load("backend.json"), grader = load("eval-grader.json"), gatesT = load("release-gates.json"), browser = load("browser.json"),
  database = load("database.json"), security = load("security.json"), smoke = load("smoke-staging.json"), e2e = load("staging-e2e.json"), med = load("medical-eval.json");

const gates = [
  gate(1, "Code quality", "quality.json", () => fromSteps(quality, REQUIRED_STEPS.quality)),
  gate(2, "Backend tests (mocked AI and Supabase)", "backend.json, eval-grader.json, release-gates.json", () => both(fromCounts(backend, "functions"), fromCounts(grader, "medical grader"), fromCounts(gatesT, "release gates"))),
  gate(3, "Browser tests (real functions; AI and Supabase simulated)", "browser.json", () => {
    const r = fromCounts(browser, "browser");
    if (browser && browser.suites) r.details.push(...browser.suites.map((s) => `${s.failed ? "✗" : "✓"} ${s.suite}: ${s.passed} passed, ${s.failed} failed (${s.kind})`));
    return r;
  }),
  gate(4, "Database security (real PostgreSQL)", "database.json", () => {
    if (!database) return { status: "not_run", details: ["database tests were not executed — database security is NOT verified"] };
    const files = database.files || [];
    const bad = files.filter((f) => f.status !== "passed");
    return { status: files.length && !bad.length ? "passed" : "failed", details: [database.kind, ...files.map((f) => `${f.status === "passed" ? "✓" : "✗"} ${f.file}: ${f.checks_passed ?? "?"} checks${f.error ? " — " + f.error : ""}`)] };
  }),
  gate(5, "Security checks", "security.json", () => fromSteps(security, REQUIRED_STEPS.security)),
  gate(6, "Staging verification (live)", "smoke-staging.json, staging-e2e.json, medical-eval.json", () => {
    const s = fromCounts(smoke, "staging smoke check");
    const want = process.env.RELEASE_SHA || "";
    if (smoke && !smoke._corrupt) {
      if (!liveTarget(smoke.target)) { s.status = "failed"; s.details.push(`smoke check target ${smoke.target} is not a deployed https site`); }
      if (smoke.environment !== "staging") { s.status = "failed"; s.details.push(`smoke check ran against environment "${smoke.environment}", not staging`); }
      if (!SHA.test(smoke.commit || "")) { s.status = "failed"; s.details.push("smoke check did not confirm which commit is deployed"); }
      else if (want && smoke.commit !== want) { s.status = "failed"; s.details.push(`staging serves ${smoke.commit.slice(0, 12)}, expected ${want.slice(0, 12)}`); }
    }
    const e = fromCounts(e2e, "staging end-to-end (synthetic accounts)");
    if (e2e && !e2e._corrupt) {
      if (!liveTarget(e2e.target) || e2e.environment !== "staging") { e.status = "failed"; e.details.push("the end-to-end check did not run against the deployed staging site"); }
      if (smoke && !smoke._corrupt && host(e2e.target) !== host(smoke.target)) { e.status = "failed"; e.details.push("the end-to-end check and the smoke check ran against different sites"); }
      if (!SHA.test(e2e.commit || "") || (want && e2e.commit !== want)) { e.status = "failed"; e.details.push("the end-to-end check did not run on the commit under release"); }
      for (const c of (e2e.checks || []).filter((c) => c.status !== "passed")) e.details.push(`✗ ${c.name}: ${c.detail}`);
    }
    if (!med) return both(s, e, { status: "not_run", details: ["live medical evaluation: no report"] });
    const d = [];
    let st = "passed";
    if (!med.live) { st = "failed"; d.push("medical evaluation report is not a live run (" + med.kind + ")"); }
    if (!["staging", "eval"].includes(med.environment)) { st = "failed"; d.push(`medical evaluation ran against environment "${med.environment}", not staging`); }
    if (!liveTarget(med.target)) { st = "failed"; d.push(`medical evaluation target ${med.target} is not a deployed https site`); }
    if (smoke && !smoke._corrupt && host(med.target) !== host(smoke.target)) { st = "failed"; d.push("the smoke check and the evaluation ran against different sites"); }
    if (!SHA.test(med.deployed_commit || "")) { st = "failed"; d.push("the evaluation did not record which commit was deployed"); }
    else {
      d.push(`evaluated commit ${med.deployed_commit}`);
      if (want && med.deployed_commit !== want) { st = "failed"; d.push(`the evaluation ran on ${med.deployed_commit.slice(0, 12)}, but the commit under release is ${want.slice(0, 12)}`); }
      if (smoke && smoke.commit && smoke.commit !== med.deployed_commit) { st = "failed"; d.push("the smoke check and the evaluation saw different commits"); }
    }
    if (med.subset || !med.case_set_size || (med.summary && med.summary.total !== med.case_set_size)) { st = "failed"; d.push(`the evaluation did not run the whole case set (${med.summary && med.summary.total}/${med.case_set_size || "?"} cases${med.subset ? ", subset " + med.subset.join(",") : ""})`); }
    if (!Array.isArray(med.results) || !med.summary || med.summary.total !== med.results.length || !med.results.length) { st = "failed"; d.push("evaluation results are missing or inconsistent with the summary"); }
    const m = med.summary || {};
    d.push(`live medical evaluation ${med.run_id}: ${m.pass} pass, ${m.fail} fail, ${m.error} error, ${m.critical} CRITICAL`);
    if (m.critical) { st = "failed"; d.push("critical: " + med.results.filter((r) => r.critical).map((r) => `${r.id} (${r.failures.filter((f) => f.critical).map((f) => f.category).join(", ")})`).join("; ")); }
    if (m.error) { st = "failed"; d.push("service errors during evaluation: " + med.results.filter((r) => r.result === "error").map((r) => r.id).join(", ")); }
    if (m.fail && !m.critical) d.push(`${m.fail} non-critical failures need clinician review: ${Object.entries(m.failure_categories || {}).map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    return both(s, e, { status: st, details: d });
  }),
  gate(7, "Clinical sign-off", "docs/medical-review/<run id>.md", () => checkSignoff(med, process.env.RELEASE_SHA || "")),
];

const blocking = gates.filter((g) => g.required && g.status !== "passed");
const decision = blocking.length ? "blocked" : "pass";
const report = { generated_at: new Date().toISOString(), commit: process.env.GITHUB_SHA || null, ref: process.env.GITHUB_REF || null, run: process.env.GITHUB_RUN_ID || null,
  required_gates: [...required], decision, blocking: blocking.map((g) => ({ gate: g.gate, name: g.name, status: g.status })), gates,
  note: "Automated checks only. Mocked and simulated suites are labelled as such. Nothing here is clinical validation." };
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 2));
const icon = { passed: "✅", failed: "❌", not_run: "⏸️" };
const md = [`## Doctine release report`, ``,
  `**Decision: ${decision === "pass" ? "✅ required gates passed" : "⛔ BLOCKED"}** · required gates ${[...required].join(", ")}${report.commit ? ` · commit \`${report.commit.slice(0, 12)}\`` : ""}`, ``,
  `| Gate | Check | Status | Required |`, `|---|---|---|---|`,
  ...gates.map((g) => `| ${g.gate} | ${g.name} | ${icon[g.status]} ${g.status} | ${g.required ? "yes" : "no"} |`), ``,
  ...gates.flatMap((g) => [`### ${g.gate}. ${g.name} — ${g.status}`, ...g.details.map((d) => `- ${d}`), ``]),
  `> ${report.note}`, ``].join("\n");
writeFileSync(`${dir}/REPORT.md`, md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
console.log(md);
process.exit(enforce && blocking.length ? 1 : 0);
