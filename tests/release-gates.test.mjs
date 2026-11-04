/**
 * Doctine · tests for the release gates (tools/release-report.mjs). Each test builds a small set of reports in a
 * temporary folder and checks the decision, so a gate can't quietly start passing things it should block.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../tools/release-report.mjs", import.meta.url).pathname;
const results = []; let passed = 0;
const test = (name, fn) => { try { fn(); passed++; results.push({ name, status: "passed" }); console.log("  ✓", name); } catch (e) { results.push({ name, status: "failed", error: String(e.message).slice(0, 300) }); console.error("  ✗", name, "\n     ", e.message.split("\n")[0]); } };

const SHA = "0123456789abcdef0123456789abcdef01234567", OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const QUALITY = ["Install dependencies (npm ci, lockfile)", "Syntax check", "Configuration check", "Function bundles build", "Safety rules in sync"];
const SECURITY = ["Doctine secret scan (working tree)", "Gitleaks (git history, redacted)", "npm audit (high+, lockfile)", "No server secrets in public/"];
const steps = (labels) => ({ steps: labels.map((label) => ({ label, status: "passed", exit: 0 })) });
const STAGING = "https://doctine-staging.netlify.app";
const good = () => ({
  "quality.json": steps(QUALITY), "security.json": steps(SECURITY),
  "backend.json": { passed: 67, failed: 0, kind: "mocked" }, "eval-grader.json": { passed: 13, failed: 0 }, "release-gates.json": { passed: 15, failed: 0 },
  "browser.json": { passed: 112, failed: 0, suites: [] },
  "database.json": { kind: "real PostgreSQL", files: [{ file: "rls.test.sql", status: "passed", checks_passed: 31 }] },
  "smoke-staging.json": { passed: 5, failed: 0, target: STAGING, environment: "staging", commit: SHA, kind: "LIVE" },
  "staging-e2e.json": { passed: 14, failed: 0, target: STAGING, environment: "staging", commit: SHA, checks: [] },
  "medical-eval.json": { live: true, environment: "staging", run_id: "run-1", kind: "LIVE", target: STAGING, deployed_commit: SHA, generated_at: "2026-11-03T20:00:00Z", case_set_size: 2,
    summary: { total: 2, pass: 2, fail: 0, error: 0, critical: 0, failure_categories: {} }, results: [{ id: "A", result: "pass", failures: [] }, { id: "B", result: "pass", failures: [] }] },
});
const SIGNOFF = `run_id: run-1\ncommit: ${SHA}\nreviewer: Dr Test Reviewer\nregistration: TEST-REG-0000\ndate: 2026-11-04\ndecision: approved\n`;
const without = (line) => SIGNOFF.split("\n").filter((l) => !l.startsWith(line + ":")).join("\n");
const swap = (a, b) => SIGNOFF.replace(a, b);
function run(files, { require = "1-7", signoff = SIGNOFF, sha = SHA } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doctine-gates-"));
  try {
    mkdirSync(join(dir, "reports")); for (const [f, v] of Object.entries(files)) if (v !== undefined) writeFileSync(join(dir, "reports", f), typeof v === "string" ? v : JSON.stringify(v));
    if (signoff) { mkdirSync(join(dir, "docs/medical-review"), { recursive: true }); writeFileSync(join(dir, "docs/medical-review/run-1.md"), signoff); }
    const r = spawnSync(process.execPath, [script, `--require=${require}`, "--enforce"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, REPORT_DIR: "reports", RELEASE_SHA: sha } });
    const rep = JSON.parse(readFileSync(join(dir, "reports/report.json"), "utf8"));
    return { exit: r.status, rep, status: (n) => rep.gates.find((g) => g.gate === n).status };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("release gates");
test("all evidence present and clean: every gate passes", () => { const r = run(good()); assert.equal(r.exit, 0); assert.equal(r.rep.decision, "pass"); });
test("a missing report is 'not_run' and blocks, never passes", () => { const f = good(); delete f["database.json"]; const r = run(f); assert.equal(r.status(4), "not_run"); assert.equal(r.exit, 1); });
test("a missing count-based report (backend, browser, smoke) is 'not_run', never passed", () => {
  for (const [f, g] of [["browser.json", 3], ["backend.json", 2], ["eval-grader.json", 2], ["smoke-staging.json", 6]]) { const x = good(); delete x[f]; const r = run(x); assert.equal(r.status(g), "not_run", f); assert.equal(r.exit, 1, f); }
  const x = good(); delete x["quality.json"]; assert.equal(run(x).status(1), "not_run");
});
test("one failing CI step fails gate 1", () => { const f = good(); f["quality.json"].steps[1] = { label: "Syntax check", status: "failed", exit: 1 }; assert.equal(run(f).status(1), "failed"); });
test("a required step that was never run fails its gate (e.g. Gitleaks or npm audit skipped)", () => {
  for (const label of ["Gitleaks (git history, redacted)", "npm audit (high+, lockfile)"]) { const f = good(); f["security.json"].steps = f["security.json"].steps.filter((x) => x.label !== label); assert.equal(run(f).status(5), "failed", label); }
  const f = good(); f["quality.json"].steps = f["quality.json"].steps.filter((x) => !x.label.startsWith("Install")); assert.equal(run(f).status(1), "failed");
});
test("one failing database file fails gate 4", () => { const f = good(); f["database.json"].files.push({ file: "conversations.test.sql", status: "failed", checks_passed: 3 }); assert.equal(run(f).status(4), "failed"); });
test("zero tests run is not a pass", () => { const f = good(); f["browser.json"] = { passed: 0, failed: 0 }; assert.equal(run(f).status(3), "failed"); });
test("a corrupt report fails its gate", () => { const f = good(); f["backend.json"] = "{not json"; assert.equal(run(f).status(2), "failed"); });
test("a single critical evaluation failure blocks gate 6, whatever the pass count", () => {
  const f = good(); f["medical-eval.json"].summary = { total: 75, pass: 74, fail: 1, error: 0, critical: 1, failure_categories: { missed_emergency: 1 } };
  f["medical-eval.json"].results = [{ id: "RULE-001", critical: true, result: "fail", failures: [{ category: "missed_emergency", critical: true }] }];
  const r = run(f); assert.equal(r.status(6), "failed"); assert.equal(r.exit, 1);
});
test("service errors during the evaluation block gate 6", () => { const f = good(); f["medical-eval.json"].summary.error = 2; f["medical-eval.json"].results = [{ id: "MED-001", result: "error", failures: [] }]; assert.equal(run(f).status(6), "failed"); });
test("a tooling-check (simulated AI) evaluation is refused as evidence", () => { const f = good(); f["medical-eval.json"].live = false; assert.equal(run(f).status(6), "failed"); });
test("an evaluation run against production is refused as evidence", () => { const f = good(); f["medical-eval.json"].environment = "production"; assert.equal(run(f).status(6), "failed"); });
test("a smoke check or evaluation against a local or non-https site is refused", () => {
  let f = good(); f["smoke-staging.json"].target = "http://localhost:8888"; assert.equal(run(f).status(6), "failed");
  f = good(); f["medical-eval.json"].target = "http://127.0.0.1:8899"; assert.equal(run(f).status(6), "failed");
  f = good(); f["medical-eval.json"].target = "https://other-site.netlify.app"; assert.equal(run(f).status(6), "failed", "smoke and evaluation on different sites");
});
test("gate 6 requires the deployed commit to be the commit under release", () => {
  let f = good(); delete f["medical-eval.json"].deployed_commit; assert.equal(run(f).status(6), "failed");
  f = good(); f["medical-eval.json"].deployed_commit = OTHER; assert.equal(run(f).status(6), "failed");
  f = good(); f["smoke-staging.json"].commit = OTHER; assert.equal(run(f).status(6), "failed");
  assert.equal(run(good(), { sha: OTHER }).status(6), "failed");
});
test("a partial evaluation (EVAL_ONLY subset or fewer cases than the set) is refused", () => {
  let f = good(); f["medical-eval.json"].subset = ["MED-001"]; assert.equal(run(f).status(6), "failed");
  f = good(); f["medical-eval.json"].case_set_size = 75; assert.equal(run(f).status(6), "failed");
});
test("evaluation results that don't match the summary are refused", () => { const f = good(); f["medical-eval.json"].results = []; assert.equal(run(f).status(6), "failed"); });
test("gate 6 requires the staging end-to-end check, on the staging site and the commit under release", () => {
  let f = good(); delete f["staging-e2e.json"]; assert.equal(run(f).status(6), "not_run");
  f = good(); f["staging-e2e.json"].failed = 1; f["staging-e2e.json"].checks = [{ name: "B sees none of A's records", status: "failed", detail: "x" }]; const r = run(f); assert.equal(r.status(6), "failed"); assert.ok(r.rep.gates[5].details.some((d) => /B sees none/.test(d)));
  f = good(); f["staging-e2e.json"].commit = OTHER; assert.equal(run(f).status(6), "failed");
  f = good(); f["staging-e2e.json"].target = "https://elsewhere.netlify.app"; assert.equal(run(f).status(6), "failed");
});
test("non-critical failures don't block, but are listed for the clinician", () => {
  const f = good(); f["medical-eval.json"].summary = { total: 2, pass: 1, fail: 1, error: 0, critical: 0, failure_categories: { missing_follow_up: 1 } };
  const r = run(f); assert.equal(r.status(6), "passed"); assert.ok(r.rep.gates[5].details.some((d) => /clinician review/.test(d)));
});
test("no sign-off file: gate 7 not run, release blocked", () => { const r = run(good(), { signoff: null }); assert.equal(r.status(7), "not_run"); assert.equal(r.exit, 1); });
const g7 = (signoff, opts = {}) => { const r = run(good(), { signoff, ...opts }); return { status: r.status(7), details: r.rep.gates[6].details.join(" | "), exit: r.exit }; };
test("gate 7: a missing commit is refused", () => { const r = g7(without("commit")); assert.equal(r.status, "failed"); assert.match(r.details, /commit is missing/); });
test("gate 7: an empty commit is refused", () => { assert.equal(g7(swap(`commit: ${SHA}`, "commit: ")).status, "failed"); });
test("gate 7: a short or abbreviated commit is refused", () => { const r = g7(swap(`commit: ${SHA}`, `commit: ${SHA.slice(0, 12)}`)); assert.equal(r.status, "failed"); assert.match(r.details, /full 40-character/); });
test("gate 7: a sign-off for a different commit is refused", () => { const r = g7(swap(`commit: ${SHA}`, `commit: ${OTHER}`)); assert.equal(r.status, "failed"); assert.match(r.details, /evaluation ran on/); });
test("gate 7: a sign-off that matches the evaluation but not the commit under release is refused", () => { assert.equal(g7(SIGNOFF, { sha: OTHER }).status, "failed"); });
test("gate 7: a missing or invalid date is refused", () => {
  assert.match(g7(without("date")).details, /not a valid YYYY-MM-DD date/);
  for (const bad of ["2026-02-30", "04/11/2026", "2026-13-01", "yesterday"]) assert.equal(g7(swap("date: 2026-11-04", "date: " + bad)).status, "failed", bad);
  assert.match(g7(swap("date: 2026-11-04", "date: 2099-01-01")).details, /in the future/);
  assert.match(g7(swap("date: 2026-11-04", "date: 2026-10-01")).details, /before the evaluation ran/);
});
test("gate 7: a missing reviewer is refused (including the template placeholder)", () => {
  assert.match(g7(without("reviewer")).details, /reviewer name is missing/);
  assert.equal(g7(swap("reviewer: Dr Test Reviewer", "reviewer: <full name>")).status, "failed");
});
test("gate 7: a missing registration number is refused", () => {
  assert.match(g7(without("registration")).details, /registration number is missing/);
  assert.equal(g7(swap("registration: TEST-REG-0000", "registration: <medical council and registration number>")).status, "failed");
});
test("gate 7: a sign-off naming a different evaluation run is refused", () => { const r = g7(swap("run_id: run-1", "run_id: run-2")); assert.equal(r.status, "failed"); assert.match(r.details, /evaluation run is run-1/); });
test("gate 7: pending, rejected, changes_required or missing decisions are refused", () => {
  for (const d of ["pending", "rejected", "changes_required", "Approved", "approved?"]) assert.equal(g7(swap("decision: approved", "decision: " + d)).status, "failed", d);
  assert.equal(g7(without("decision")).status, "failed");
});
test("gate 7: the report says the registration number was not independently verified", () => { assert.match(g7(SIGNOFF).details, /not independently verified/); });
test("gate 7: the filled-in template passes only when every field is real", () => {
  const tpl = readFileSync(new URL("../docs/medical-review/TEMPLATE.md", import.meta.url), "utf8");
  assert.equal(g7(tpl).status, "failed", "the unedited template never passes");
  const filled = tpl.replace(/^run_id:.*$/m, "run_id: run-1").replace(/^commit:.*$/m, `commit: ${SHA}`).replace(/^reviewer:.*$/m, "reviewer: Dr Test Reviewer")
    .replace(/^registration:.*$/m, "registration: TEST-REG-0000").replace(/^date:.*$/m, "date: 2026-11-04").replace(/^decision:.*$/m, "decision: approved   # approved | changes_required | rejected");
  assert.equal(g7(filled).status, "passed", g7(filled).details);
});
test("CI scope (gates 1–5) passes without staging evidence, and says gates 6–7 were not run", () => {
  const f = good(); delete f["medical-eval.json"]; delete f["smoke-staging.json"];
  const r = run(f, { require: "1-5", signoff: null }); assert.equal(r.exit, 0); assert.equal(r.status(6), "not_run"); assert.equal(r.status(7), "not_run");
});

const failed = results.filter((r) => r.status === "failed").length;
console.log(`\n${passed} release-gate tests passed${failed ? `, ${failed} FAILED` : ""}`);
if (process.env.REPORT_DIR) { mkdirSync(process.env.REPORT_DIR, { recursive: true }); writeFileSync(process.env.REPORT_DIR + "/release-gates.json", JSON.stringify({ suite: "release-gates", kind: "offline", passed, failed, results }, null, 2)); }
process.exit(failed ? 1 : 0);
