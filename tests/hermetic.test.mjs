/**
 * Doctine · the server tests must pass when a deployed site's settings are present in the environment, as they are
 * inside a Netlify build (`netlify deploy --build` runs the tests with the site's variables). This runs
 * tests/functions.test.mjs with obviously fake staging-like settings and requires it to pass.
 */
import { spawnSync } from "node:child_process";

const fake = {
  DOCTINE_ENV: "staging", SUPABASE_URL: "https://example-not-real.supabase.co", SUPABASE_ANON_KEY: "fake-anon",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role", ANTHROPIC_API_KEY: "fake-anthropic", RATE_LIMIT_SECRET: "f".repeat(64),
  EVAL_ACCESS_TOKEN: "e".repeat(64), RATE_LIMIT_REQUIRE_SHARED: "true", AI_DAILY_REQUEST_CAP: "500",
};
const r = spawnSync(process.execPath, [new URL("./functions.test.mjs", import.meta.url).pathname], { encoding: "utf8", env: { PATH: process.env.PATH, ...fake } });
const last = (r.stdout || "").trim().split("\n").pop();
console.log(`server tests with a site's settings present: ${last} (exit ${r.status})`);
if (r.status !== 0) console.error((r.stdout + r.stderr).split("\n").filter((l) => l.includes("✗")).join("\n"));
process.exit(r.status === 0 ? 0 : 1);
