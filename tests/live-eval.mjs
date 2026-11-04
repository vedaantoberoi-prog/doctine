/**
 * Doctine · LIVE medical evaluation of a deployed Doctine site. Uses the real AI and spends a little API credit.
 * Nothing here is mocked: every answer comes from the deployed /api/chat with the real model.
 *
 *   DOCTINE_URL=https://doctine-staging.netlify.app EVAL_ACCESS_TOKEN=… node tests/live-eval.mjs
 *
 * Options (environment variables):
 *   DOCTINE_URL          the site to evaluate (required). Must report environment "staging" or "eval" on /api/config.
 *   EVAL_ACCESS_TOKEN    the staging evaluation secret (required on staging). Gives the run its own limit; the public
 *                        anonymous limits are never raised for it.
 *   EXPECT_COMMIT        stop unless the site's /version.json names this commit (the staging workflow sets it)
 *   PRODUCTION_URL       the production address; the run refuses to start if DOCTINE_URL is the same site
 *   EVAL_PACED=yes       manual runs only: run without the token, paced under the public limit (~31 s per case,
 *                        about 40 minutes for all 75). Refused inside CI.
 *   EVAL_ONLY            comma-separated case ids or categories to run (e.g. "MED-001,self_harm")
 *   ALLOW_NON_STAGING_EVAL=yes   run against a site that does not report staging/eval (never sends the token there)
 *   REPORT_DIR           where to write medical-eval.json and medical-eval.md (default: reports)
 *
 * Exit code: 0 = no critical failures and no service errors; 1 = at least one; 2 = setup problem (nothing was sent).
 * Synthetic test messages only: never put real patient information in the case set.
 * Passing this does not make the assistant clinically validated. Every answer still needs clinician review.
 */
import { EVAL_CASES, EVAL_SET_VERSION } from "./medical-eval-cases.mjs";
import { grade, summarize } from "./medical-eval-grader.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const base = (process.env.DOCTINE_URL || "").replace(/\/$/, "");
const token = process.env.EVAL_ACCESS_TOKEN || "";
const outDir = process.env.REPORT_DIR || "reports";
const stop = (msg) => { console.error("Live evaluation not started: " + msg); process.exit(2); };
if (!base) stop("set DOCTINE_URL to the staging site.");
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
if (!hostOf(base)) stop(`DOCTINE_URL "${base}" is not a valid address.`);
if (process.env.PRODUCTION_URL && hostOf(process.env.PRODUCTION_URL) === hostOf(base)) stop("DOCTINE_URL is the production site. The evaluation runs on staging only, and the evaluation token is never sent to production.");
const getJson = async (path, headers = {}) => { const r = await fetch(base + path, { headers, signal: AbortSignal.timeout(20_000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

// 1. Confirm the target before sending anything sensitive (the token) to it.
let environment = "unknown";
try { environment = (await getJson("/api/config")).body.environment || "unset"; } catch (e) { stop(`could not read ${base}/api/config (${e.message}).`); }
const evalEnv = environment === "staging" || environment === "eval";
if (!evalEnv && process.env.ALLOW_NON_STAGING_EVAL !== "yes") stop(`the site reports environment "${environment}". Set DOCTINE_ENV=staging on the staging site, or ALLOW_NON_STAGING_EVAL=yes to run anyway (without the evaluation token).`);
const inCI = process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";
if (evalEnv && !token) {
  if (inCI || process.env.EVAL_PACED !== "yes") stop("EVAL_ACCESS_TOKEN is not set. Without it the 75 cases would run under the public anonymous limit (about 31 s each, roughly 40 minutes), so the run is refused. Set the EVAL_ACCESS_TOKEN secret on the GitHub \"staging\" environment, with the same value as the staging Netlify site. (For a slow manual run outside CI, set EVAL_PACED=yes.)");
  console.warn("! No evaluation token: running paced under the public limit because EVAL_PACED=yes (about 31 s per case).");
}
const useToken = !!token && evalEnv;
if (useToken) {
  const pre = await getJson("/api/chat?eval=1", { "x-doctine-eval-token": token }).catch((e) => ({ status: 0, body: { error: e.message } }));
  if (pre.body.eval_access !== true) stop(`the staging site did not accept EVAL_ACCESS_TOKEN (${pre.status} ${JSON.stringify(pre.body)}). The GitHub secret and the staging site's EVAL_ACCESS_TOKEN must be the same value of at least 32 characters, and the site's DOCTINE_ENV must be staging.`);
}
// Which commit is deployed: recorded in the report so the clinician sign-off and the release can be tied to it.
let deployedCommit = null;
try { const v = await getJson("/version.json"); deployedCommit = /^[0-9a-f]{40}$/.test(v.body.commit || "") ? v.body.commit : null; } catch {}
if (process.env.EXPECT_COMMIT && deployedCommit !== process.env.EXPECT_COMMIT) stop(`the site serves commit ${deployedCommit || "(unknown)"}, expected ${process.env.EXPECT_COMMIT}.`);
const gapMs = useToken ? 400 : 31_000;
const runId = "run-" + new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "-" + randomUUID().slice(0, 6);
const only = (process.env.EVAL_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const cases = only.length ? EVAL_CASES.filter((c) => only.includes(c.id) || only.includes(c.category)) : EVAL_CASES;
console.log(`Doctine live evaluation ${runId}: ${cases.length} cases against ${base} (environment ${environment}, commit ${deployedCommit || "unknown"}, ${useToken ? "evaluation access" : "public limits, paced"})`);

// 2. Run each case and grade it.
async function ask(tc) {
  const headers = { "content-type": "application/json", "x-doctine-eval-run": runId, "x-doctine-eval-case": tc.id };
  if (useToken) headers["x-doctine-eval-token"] = token;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const r = await fetch(base + "/api/chat", { method: "POST", headers, body: JSON.stringify({ messages: tc.messages }), signal: AbortSignal.timeout(60_000) });
      const body = await r.json().catch(() => ({}));
      if (r.status === 429 && attempt === 0) { const wait = Math.min(120, +r.headers.get("retry-after") || 60); console.log(`  rate limited; waiting ${wait}s`); await new Promise((ok) => setTimeout(ok, wait * 1000)); continue; }
      return { status: r.status, body, ms: Date.now() - t0 };
    } catch (e) { if (attempt) return { status: 0, body: { error: "network: " + e.message }, ms: Date.now() - t0 }; }
  }
}
const rows = [];
for (const tc of cases) {
  const res = await ask(tc);
  const g = grade(tc, res);
  rows.push({ ...g, ms: res.ms, expect: tc.expect, conversation: tc.messages, answer: res.body });
  const mark = g.result === "pass" ? "PASS" : g.critical ? "CRITICAL" : g.result.toUpperCase();
  console.log(`${mark.padEnd(8)} ${tc.id} [${tc.category}] urgency=${g.actual.urgency}${g.failures.length ? " · " + g.failures.map((f) => f.category).join(", ") : ""}`);
  await new Promise((ok) => setTimeout(ok, gapMs));
}

// 3. Reports: machine-readable JSON and a markdown sheet for clinician review.
const summary = summarize(rows);
// EVAL_TOOLING_CHECK=1 is for checking this script against the local dev server with the simulated AI. Such a run is
// labelled as a tooling check and the release gates refuse it as evidence.
const tooling = process.env.EVAL_TOOLING_CHECK === "1";
const report = { suite: "medical-eval", live: !tooling, kind: tooling ? "TOOLING CHECK against a simulated AI. Not a medical evaluation." : "LIVE (real deployed functions and the real AI model; nothing mocked)", run_id: runId, eval_set_version: EVAL_SET_VERSION,
  target: base, environment, deployed_commit: deployedCommit, case_set_size: EVAL_CASES.length, subset: only.length ? only : null, evaluation_access: useToken, started_note: "Automatic checks only. Not clinical validation.", generated_at: new Date().toISOString(), summary,
  results: rows };
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/medical-eval.json`, JSON.stringify(report, null, 2));
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = [`# Doctine medical evaluation — clinician review sheet`, ``,
  `Run \`${runId}\` · case set ${EVAL_SET_VERSION} · ${report.generated_at}`, `Evaluated commit: \`${deployedCommit || "unknown"}\` (copy this into the sign-off's \`commit\` field)`, `Target: ${base} (environment: ${environment}) · ${tooling ? "**TOOLING CHECK with a simulated AI — not a medical evaluation**" : "live AI, nothing mocked"}`, ``,
  `**Automatic result:** ${summary.pass} pass · ${summary.fail} fail · ${summary.error} error · **${summary.critical} critical**`, ``,
  `> Automatic checks catch only some problems. Read every answer. Record your verdict per case and sign at the end. This sheet is not clinical validation on its own.`, ``,
  `| Id | Category | Auto | Urgency | Failure categories |`, `|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.id} | ${r.category} | ${r.critical ? "**CRITICAL**" : r.result} | ${r.actual.urgency ?? "—"} | ${esc(r.failures.map((f) => f.category).join(", ")) || "—"} |`), ``,
  ...rows.flatMap((r) => [`## ${r.id} · ${r.category}`, ``,
    ...r.conversation.map((m) => `**${m.role === "user" ? "Person" : "Doctine (earlier turn)"}:** ${esc(m.content)}`), ``,
    `**Answer (urgency ${r.actual.urgency ?? "—"}${r.actual.safety ? ", safety " + r.actual.safety : ""}):**`, ``,
    "```", String(r.answer.reply || r.answer.error || "").trim(), ...(r.answer.sections || []).map((s) => `\n# ${s.title}\n${s.body}`), r.answer.question ? `\nQuestion: ${r.answer.question} ${(r.answer.options || []).map((o) => `[${o}]`).join(" ")}` : "", r.answer.uncertainty ? `\nUncertainty: ${r.answer.uncertainty}` : "", r.answer.safety_note ? `\nSafety note: ${r.answer.safety_note}` : "", "```", ``,
    `Automatic: **${r.result}**${r.failures.length ? " — " + r.failures.map((f) => `${f.category}${f.critical ? " (critical)" : ""}: ${f.detail}`).join("; ") : ""}`,
    r.expect.review ? `Reviewer focus: ${r.expect.review}` : "", ``,
    `Clinician verdict: ☐ safe ☐ safe with changes ☐ unsafe  — notes: ________________________________`, ``]),
  `---`, ``, `Reviewed by (name, registration no.): ____________________  Date: __________  Signature: __________`, ``,
  `Record the outcome in docs/medical-review/ (see TEMPLATE.md). Production release requires a signed review of the run being released.`].join("\n");
writeFileSync(`${outDir}/medical-eval.md`, md);
console.log(`\n${summary.pass}/${summary.total} passed automatic checks · ${summary.fail} failed · ${summary.error} errors · ${summary.critical} CRITICAL`);
console.log(`Reports: ${outDir}/medical-eval.json, ${outDir}/medical-eval.md. Every answer still needs clinician review.`);
process.exit(summary.critical || summary.error ? 1 : 0);
