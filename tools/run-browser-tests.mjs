/**
 * Doctine · runs every browser suite. Starts the stand-in Anthropic API and the dev server (real functions), runs
 * each suite in its own process, and writes reports/browser.json when REPORT_DIR is set.
 *   node tools/run-browser-tests.mjs            (needs: npm install && npx playwright install chromium)
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const MOCK_PORT = 8790, DEV_PORT = 8888;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY_TEST || "test-key-not-real";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.DOCTINE_ENV = "test";
for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) delete process.env[k]; // demo-account mode
process.env.PORT = String(DEV_PORT);

const { startMockAnthropic } = await import("../tests/browser/mock-anthropic.mjs");
const { startDevServer } = await import("./dev-server.mjs");
const mock = await startMockAnthropic(MOCK_PORT);
const dev = await startDevServer(DEV_PORT);
const base = `http://localhost:${DEV_PORT}`;

const SUITES = [
  ["workflows", "tests/browser/workflows.test.mjs", "real functions; Anthropic simulated"],
  ["isolation", "tests/browser/isolation.test.mjs", "Supabase simulated with ownership rules"],
  ["persistence", "tests/browser/persistence.test.mjs", "Supabase simulated with ownership rules"],
  ["app", "tests/browser/app.test.mjs", "API responses simulated in the browser"],
];
const results = [];
for (const [name, file, kind] of SUITES) {
  const t0 = Date.now();
  const outText = await new Promise((ok) => {
    let buf = "";
    const p = spawn(process.execPath, [file], { env: { ...process.env, DOCTINE_BASE: base, DOCTINE_MOCK_AI: `http://127.0.0.1:${MOCK_PORT}` } });
    p.stdout.on("data", (d) => { buf += d; process.stdout.write(d); });
    p.stderr.on("data", (d) => { buf += d; process.stderr.write(d); });
    p.on("close", (code) => ok({ buf, code }));
  });
  const checks = outText.buf.split("\n").filter((l) => /^(PASS|FAIL) /.test(l)).map((l) => ({ status: l.startsWith("PASS") ? "passed" : "failed", name: l.slice(5) }));
  const failed = checks.filter((c) => c.status === "failed").length + (outText.code !== 0 && !checks.some((c) => c.status === "failed") ? 1 : 0);
  results.push({ suite: name, kind, exit: outText.code, passed: checks.length - checks.filter((c) => c.status === "failed").length, failed, ms: Date.now() - t0, checks });
  console.log(`\n== ${name}: ${checks.length - failed} passed, ${failed} failed (exit ${outText.code})\n`);
}
mock.close(); dev.close();
const total = results.reduce((a, r) => ({ passed: a.passed + r.passed, failed: a.failed + r.failed }), { passed: 0, failed: 0 });
if (process.env.REPORT_DIR) { mkdirSync(process.env.REPORT_DIR, { recursive: true }); writeFileSync(process.env.REPORT_DIR + "/browser.json", JSON.stringify({ suite: "browser", ...total, suites: results }, null, 2)); }
console.log(`browser: ${total.passed} passed, ${total.failed} failed`);
process.exit(total.failed ? 1 : 0);
