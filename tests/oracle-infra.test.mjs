/**
 * Doctine · checks on the Oracle A1 configuration (infra/oracle-a1). Run: node tests/oracle-infra.test.mjs
 * Static checks only: the images themselves are built and verified on the VM (infra/oracle-a1/verify.sh).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../infra/oracle-a1/", import.meta.url), read = (f) => readFileSync(new URL(f, dir), "utf8");
let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("  ✓", name); } catch (e) { failed++; console.error("  ✗", name, "\n     ", e.message.split("\n")[0]); } };
const compose = read("compose.yaml"), dockerfile = read("evaluator.Dockerfile"), init = read("cloud-init.yaml");
// services: blocks under "services:"
const services = Object.fromEntries([...compose.matchAll(/^  ([a-z-]+):\n((?:    .*\n|\n)+)/gm)].map((m) => [m[1], m[2]]));

test("the evaluator image copies every file the evaluation imports (and nothing else from the app)", () => {
  const copied = (dockerfile.match(/^COPY (.+) \.\/tests\/$/m) || [])[1].split(" ").map((f) => f.replace("tests/", ""));
  const need = new Set(["live-eval.mjs"]), queue = ["live-eval.mjs"];
  while (queue.length) for (const m of readFileSync(new URL("./" + queue.pop(), import.meta.url), "utf8").matchAll(/from "\.\/([^"]+)"/g)) if (!need.has(m[1])) { need.add(m[1]); queue.push(m[1]); }
  assert.deepEqual([...need].sort(), [...copied].sort());
});
test("no service publishes a port, runs privileged, or uses the host network", () => {
  assert.ok(Object.keys(services).length >= 2);
  assert.ok(!/^\s+ports:/m.test(compose) && !/privileged:\s*true/.test(compose) && !/network_mode:\s*host/.test(compose));
});
test("every service: non-root, read-only, all capabilities dropped, no-new-privileges, memory/CPU/process limits", () => {
  for (const [name, body] of Object.entries(services)) for (const re of [/user: "10001:10001"/, /read_only: true/, /cap_drop: \[ALL\]/, /no-new-privileges:true/, /mem_limit: /, /cpus: /, /pids_limit: /])
    assert.match(body, re, `${name}: ${re}`);
});
test("the limits fit 12 GB with room for the system", () => {
  const gb = Object.values(services).map((b) => /mem_limit: (\d+)(m|g)/.exec(b)).map((m) => (m[2] === "g" ? +m[1] : +m[1] / 1024)).reduce((a, b) => a + b, 0);
  assert.ok(gb <= 8, `${gb} GB`);
});
test("the evaluator targets staging and names production so it can refuse it; the token comes from a file outside git", () => {
  assert.match(services.evaluator, /DOCTINE_URL: https:\/\/doctine-staging\.pages\.dev/);
  assert.match(services.evaluator, /PRODUCTION_URL: https:\/\/app\.doctine\.com/);
  assert.match(services.evaluator, /env_file: \/etc\/doctine\/evaluator\.env/);
  assert.match(services["llm-bench"], /network_mode: none/);
});
test("first boot: SSH keys only, no root login, automatic security updates, no Docker remote API", () => {
  for (const re of [/PasswordAuthentication no/, /PermitRootLogin no/, /Unattended-Upgrade "1"/, /"no-new-privileges":true/]) assert.match(init, re);
  assert.ok(!/tcp:\/\/|2375|2376/.test(init));
});
test("no secrets or key material anywhere in infra/oracle-a1", () => {
  for (const f of readdirSync(dir)) {
    const t = read(f);
    assert.ok(!/sk-ant-|sb_secret_|eyJhbGciOi|BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|EVAL_ACCESS_TOKEN=[A-Za-z0-9]/.test(t), f);
  }
});
test("the weekly evaluation timer is off unless someone enables it (it costs AI credit)", () => {
  assert.match(read("doctine-eval.timer"), /NOT enabled by default/);
  assert.ok(!/doctine-eval/.test(init), "first boot never installs or enables the evaluation timer");
});

console.log(`${passed} oracle-infra tests passed${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exit(1);
