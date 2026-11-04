/**
 * Doctine · runs one CI step and records its real outcome for the release report.
 *   node tools/run-step.mjs <report> "<label>" -- <command> [args…]
 * Appends { label, command, exit, status, ms, tail } to REPORT_DIR/<report>.json (default REPORT_DIR=reports) and
 * exits with the command's own exit code, so a failing step still fails the job. Output tails are stored only after
 * secret-looking strings are masked.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [report, label, sep, cmd, ...args] = process.argv.slice(2);
if (!report || !label || sep !== "--" || !cmd) { console.error('usage: node tools/run-step.mjs <report> "<label>" -- <command> [args…]'); process.exit(2); }
const dir = process.env.REPORT_DIR || "reports";
const mask = (s) => s.replace(/sk-ant-[\w-]{8,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|sb_secret_\w+|gh[pousr]_\w{20,}|nfp_\w{20,}/g, "[masked]");
const t0 = Date.now();
let tail = "";
const p = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], shell: false });
const keep = (d) => { tail = (tail + d).slice(-4000); };
p.stdout.on("data", (d) => { process.stdout.write(d); keep(d); });
p.stderr.on("data", (d) => { process.stderr.write(d); keep(d); });
p.on("error", (e) => { keep(String(e.message)); });
p.on("close", (code) => {
  const exit = code ?? 1;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${report}.json`;
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { suite: report, steps: [] };
  data.steps.push({ label, command: [cmd, ...args].join(" "), exit, status: exit === 0 ? "passed" : "failed", ms: Date.now() - t0, tail: mask(tail).split("\n").slice(-15).join("\n") });
  data.passed = data.steps.filter((s) => s.status === "passed").length; data.failed = data.steps.length - data.passed;
  writeFileSync(file, JSON.stringify(data, null, 2));
  process.exit(exit);
});
