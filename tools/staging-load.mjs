/**
 * Doctine · load test of the records assistant (/api/assist) on the deployed STAGING site, end to end through Netlify,
 * Supabase (row security on) and the evidence engine. One throw-away synthetic account is created at the start (with
 * fictional cholesterol reports and AI consent) and deleted at the end through /api/account.
 * No AI model is called unless staging has a provider key (then each request costs a little; capped by LOAD_MAX).
 *   SITE_URL=https://doctine-staging.netlify.app PRODUCTION_URL=https://app.doctine.com node tools/staging-load.mjs
 * Optional: LOAD_STEPS="1,5,10" (concurrency levels), LOAD_PER_STEP=10 (requests per level), LOAD_MAX=60.
 * Refuses any site that doesn't report environment "staging", and the production address. Never prints tokens.
 * Writes REPORT_DIR/staging-load.json and prints a table: per level p50 / p95 / max, errors, server-side ms.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";

const base = (process.env.SITE_URL || "").replace(/\/$/, "");
const stop = (m) => { console.error("Staging load test not started: " + m); process.exit(2); };
if (!base) stop("set SITE_URL to the staging site.");
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
if (process.env.PRODUCTION_URL && hostOf(process.env.PRODUCTION_URL) === hostOf(base)) stop("SITE_URL is the production site.");
const T = (ms = 30_000) => AbortSignal.timeout(ms);
const cfg = await (await fetch(base + "/api/config", { signal: T() })).json().catch(() => ({}));
if (cfg.environment !== "staging") stop(`the site reports environment "${cfg.environment}", not "staging".`);
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) stop("the staging site has no Supabase settings.");
const f = cfg.features || {};
if (!(f.ai_assistant && f.ai_gateway && f.ai_orchestrator)) stop("the records assistant is switched off on staging (ai_assistant, ai_gateway and ai_orchestrator must all be on).");

const SB = cfg.supabaseUrl, ANON = cfg.supabaseAnonKey;
const STEPS = String(process.env.LOAD_STEPS || "1,5,10").split(",").map((x) => Math.max(1, Math.min(20, +x || 1)));
const PER = Math.max(1, Math.min(30, +(process.env.LOAD_PER_STEP || 10))), MAX = Math.max(1, Math.min(200, +(process.env.LOAD_MAX || 60)));
const sb = async (path, { token, method = "GET", body, headers = {} } = {}) => {
  const r = await fetch(SB + path, { method, signal: T(), headers: { apikey: ANON, authorization: `Bearer ${token || ANON}`, ...(body ? { "content-type": "application/json" } : {}), prefer: "return=representation", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, json };
};
const must = (c, m) => { if (!c) throw new Error(m); };
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const run = Date.now().toString(36) + "-" + randomUUID().slice(0, 6);
let token = null;
const report = { site: base, commit: null, started: new Date().toISOString(), steps: [], errors: {}, account_deleted: false };
try {
  try { report.commit = (await (await fetch(base + "/version.json", { signal: T() })).json()).commit; } catch {}
  const email = `doctine-load+${run}@example.com`, password = randomBytes(18).toString("base64url");
  const su = await sb("/auth/v1/signup", { method: "POST", body: { email, password } });
  must(su.ok, "sign-up HTTP " + su.status);
  token = su.json.access_token || (su.json.session && su.json.session.access_token);
  must(token, 'no session after sign-up ("Confirm email" must be off on the staging project)');
  let r = await sb("/rest/v1/consents?on_conflict=user_id,kind", { token, method: "POST", body: [{ kind: "ai_chat", granted: true }], headers: { prefer: "return=representation,resolution=merge-duplicates" } });
  must(r.ok, "consent HTTP " + r.status);
  const reports = [["2024-12-10", "142", "44", "220"], ["2025-06-15", "131", "47", "205"], ["2026-05-20", "118", "50", "190"]];
  for (const [i, [date, ldl, hdl, tc]] of reports.entries()) {
    r = await sb("/rest/v1/documents", { token, method: "POST", body: { client_id: 9000 + i, title: `Synthetic lipid profile (load test) ${date}`, category: "Lab report", source: "upload", page_count: 1,
      document_date: date, provider: "Fictional Diagnostics", fields: { "LDL Cholesterol": `${ldl} mg/dL (ref < 100)`, "HDL Cholesterol": `${hdl} mg/dL (ref > 40)`, "Total Cholesterol": `${tc} mg/dL (ref < 200)` } } });
    must(r.ok, "document HTTP " + r.status);
  }
  console.log("synthetic account ready (3 fictional lipid reports, AI consent)");

  let sent = 0;
  const one = async (k) => {
    const t0 = performance.now();
    try {
      const res = await fetch(base + "/api/assist", { method: "POST", signal: T(40_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "compare my cholesterol levels over the last two years and explain what changed", share_records: true, request_id: `load-${run}-${k}` }) });
      const j = await res.json().catch(() => ({}));
      const ms = Math.round(performance.now() - t0);
      const ok = res.status === 200 && j.state === "COMPLETED" && j.answer && j.answer.kind === "records" && /142 mg\/dL/.test(j.answer.text || "");
      if (!ok) report.errors[`${res.status} ${j.error || j.state || ""}`.trim()] = (report.errors[`${res.status} ${j.error || j.state || ""}`.trim()] || 0) + 1;
      return { ok, ms, server_ms: j.trace && j.trace.total_ms, route: j.route && j.route.category, degraded: j.route && j.route.degraded, status: res.status };
    } catch (e) { report.errors[e.name] = (report.errors[e.name] || 0) + 1; return { ok: false, ms: Math.round(performance.now() - t0), status: 0 }; }
  };
  for (const c of STEPS) {
    const rows = [];
    for (let done = 0; done < PER && sent < MAX; ) {
      const batch = Math.min(c, PER - done, MAX - sent);
      rows.push(...(await Promise.all(Array.from({ length: batch }, (_, i) => one(`${c}-${done + i}`)))));
      done += batch; sent += batch;
    }
    const okRows = rows.filter((x) => x.ok), ms = okRows.map((x) => x.ms), sms = okRows.map((x) => x.server_ms).filter((x) => x >= 0);
    const step = { concurrency: c, requests: rows.length, ok: okRows.length, p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), max_ms: ms.length ? Math.max(...ms) : null,
      server_p50_ms: pct(sms, 0.5), server_p95_ms: pct(sms, 0.95), statuses: [...new Set(rows.map((x) => x.status))], degraded: [...new Set(rows.map((x) => x.degraded).filter(Boolean))] };
    report.steps.push(step);
    console.log(`concurrency ${c}: ${step.ok}/${step.requests} ok · end-to-end p50 ${step.p50_ms} ms, p95 ${step.p95_ms} ms, max ${step.max_ms} ms · inside the orchestrator p50 ${step.server_p50_ms} ms, p95 ${step.server_p95_ms} ms${step.degraded.length ? " · " + step.degraded.join(",") : ""}`);
  }
} catch (e) {
  report.failure = String(e.message).slice(0, 300); console.error("load test stopped: " + report.failure);
} finally {
  if (token) {
    try { const d = await fetch(base + "/api/account", { method: "DELETE", signal: T(60_000), headers: { authorization: `Bearer ${token}` } }); report.account_deleted = d.ok; }
    catch { report.account_deleted = false; }
    console.log(report.account_deleted ? "synthetic account deleted" : "WARNING: the synthetic account could not be deleted; remove doctine-load+" + run + "@example.com on staging");
  }
  report.finished = new Date().toISOString();
  const dir = process.env.REPORT_DIR || "reports"; mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/staging-load.json`, JSON.stringify(report, null, 1));
}
const failed = !!report.failure || !report.account_deleted || report.steps.some((s) => s.ok < s.requests);
console.log(failed ? `\nload test: problems (${JSON.stringify(report.errors)})` : "\nload test: all requests answered correctly");
process.exit(failed ? 1 : 0);
