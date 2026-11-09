/**
 * Doctine · smoke check of a deployed site (staging after each staging deploy, production right after release).
 *   SITE_URL=https://… EXPECT_ENV=staging EXPECT_COMMIT=<sha> [EVAL_ACCESS_TOKEN=…] node tools/smoke-check.mjs
 * Checks: the page loads and is Doctine; security headers; /api/config reports the expected environment and only
 * public settings; /api/scan is configured; /api/chat?test=1 reaches the real AI (one tiny request); an emergency
 * message gets 112 guidance; /version.json names the expected commit (EXPECT_COMMIT); evaluation access works on staging
 * with the configured token (EVAL_ACCESS_TOKEN) and is refused on production. The token is sent only when the site
 * reports environment "staging" and EXPECT_ENV is "staging".
 * Writes REPORT_DIR/smoke-<env>.json. Exit 1 on any failure. Never prints secrets.
 */
import { mkdirSync, writeFileSync } from "node:fs";

const base = (process.env.SITE_URL || "").replace(/\/$/, "");
const expectEnv = process.env.EXPECT_ENV || "staging";
const expectCommit = process.env.EXPECT_COMMIT || "";
const evalToken = process.env.EVAL_ACCESS_TOKEN || "";
if (!base) { console.error("Set SITE_URL."); process.exit(2); }
if (expectEnv === "production" && evalToken) { console.error("Refusing: EVAL_ACCESS_TOKEN must never be sent to production. Unset it for production smoke checks."); process.exit(2); }
const checks = [];
const check = async (name, fn) => {
  try { const detail = await fn(); checks.push({ name, status: "passed", detail: detail || "" }); console.log("PASS", name, detail ? "· " + detail : ""); }
  catch (e) { checks.push({ name, status: "failed", detail: String(e.message).slice(0, 300) }); console.log("FAIL", name, "·", e.message); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const get = (p, init) => fetch(base + p, { ...init, signal: AbortSignal.timeout(30_000) });

await check("home page loads and is Doctine", async () => {
  const r = await get("/"); must(r.ok, "HTTP " + r.status); const t = await r.text(); must(/<title>[^<]*Doctine/i.test(t), "title is not Doctine");
  for (const h of ["x-content-type-options", "x-frame-options", "referrer-policy", "strict-transport-security"]) must(r.headers.get(h), "missing header " + h);
  return "security headers present";
});
let cfg = {};
await check(`/api/config reports environment "${expectEnv}" and only public settings`, async () => {
  const r = await get("/api/config"); must(r.ok, "HTTP " + r.status); const raw = await r.text(); cfg = JSON.parse(raw);
  must(cfg.environment === expectEnv, `environment is "${cfg.environment}"`);
  must(!/service_role|SERVICE_ROLE|sk-ant-/.test(raw), "secret material in /api/config");
  if (cfg.supabaseAnonKey) must(!/^sb_secret_/.test(cfg.supabaseAnonKey), "a secret key is being served as the public key");
  if (cfg.supabaseAnonKey) { const role = JSON.parse(Buffer.from(cfg.supabaseAnonKey.split(".")[1] || "", "base64url").toString() || "{}").role; must(!role || role === "anon", "the public key is not an anon key (role " + role + ")"); }
  return `accounts: ${cfg.accounts}`;
});
let commit = null;
await check(expectCommit ? `the site serves commit ${expectCommit.slice(0, 12)}` : "the site says which commit it serves", async () => {
  const r = await get("/version.json", { headers: { "cache-control": "no-cache" } });
  if (!expectCommit && r.status === 404) return "no /version.json (a deploy from before commit stamping); not checked";
  must(r.ok, "/version.json HTTP " + r.status);
  const j = await r.json(); commit = /^[0-9a-f]{40}$/.test(j.commit || "") ? j.commit : null;
  must(commit, "/version.json has no full commit id");
  if (expectCommit) must(commit === expectCommit, `serves ${commit.slice(0, 12)}, expected ${expectCommit.slice(0, 12)}`);
  return commit;
});
if (expectEnv === "staging") await check("evaluation access works with the configured token", async () => {
  must(evalToken, "EVAL_ACCESS_TOKEN is not set for this check");
  must(cfg.environment === "staging", "not sending the token: the site does not report staging");
  const r = await get("/api/chat?eval=1", { headers: { "x-doctine-eval-token": evalToken } });
  const j = await r.json().catch(() => ({}));
  // Only a 200 with eval_access:false means the token itself was refused. Anything else (rate limited, limiter
  // unavailable, a server error) is reported as it is, so a busy or broken limiter isn't mistaken for a wrong token.
  must(r.ok || j.eval_access !== undefined, `the site didn't answer the token check (HTTP ${r.status}${j.error ? ", " + j.error : ""}). This is not a token problem${j.error === "limiter_unavailable" ? ": the shared rate limiter (Supabase) couldn't be reached" : ""}.`);
  must(j.eval_access === true, "the site refused the token: EVAL_ACCESS_TOKEN differs between GitHub and the staging site, is shorter than 32 characters, or DOCTINE_ENV is not staging");
  return "accepted";
});
if (expectEnv === "production") await check("production refuses evaluation access", async () => {
  const fake = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const j = await (await get("/api/chat?eval=1", { headers: { "x-doctine-eval-token": fake } })).json();
  must(j.eval_access === false, "unexpected reply " + JSON.stringify(j)); return "refused";
});
await check("scanner is configured", async () => { const j = await (await get("/api/scan")).json(); must(j.ok, j.error || "not ok"); return "model " + j.model; });
await check("chat reaches the real AI", async () => { const j = await (await get("/api/chat?test=1")).json(); must(j.ok, j.error || "not ok"); return "model " + j.model; });
await check("an emergency message gets 112 guidance", async () => {
  const r = await get("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "my father can't breathe properly" }] }) });
  const j = await r.json(); must(r.ok, "HTTP " + r.status + " " + (j.error || "")); must(j.urgency === "emergency", "urgency " + j.urgency);
  must(/112/.test([j.reply, j.safety_note].join(" ")), "no 112"); return j.ai_unavailable ? "fixed guidance (AI unavailable: " + j.ai_unavailable + ")" : "AI answer with rule backstop";
});
await check("unknown API methods are refused", async () => { const r = await get("/api/account", { method: "GET" }); must(r.status === 405, "HTTP " + r.status); });

const failed = checks.filter((c) => c.status === "failed").length;
const out = process.env.REPORT_DIR;
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/smoke-${expectEnv}.json`, JSON.stringify({ suite: "smoke-" + expectEnv, kind: "LIVE against the deployed site", target: base, environment: cfg.environment || null, commit, passed: checks.length - failed, failed, checks, at: new Date().toISOString() }, null, 2)); }
console.log(`\nsmoke (${expectEnv}): ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
