/**
 * Doctine · checks on the Oracle A1 configuration (infra/oracle-a1). Run: node tests/oracle-infra.test.mjs
 * Static checks only: the images themselves are built and verified on the VM (infra/oracle-a1/verify.sh).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";

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
  for (const f of [...readdirSync(dir).filter((f) => statSync(new URL(f, dir)).isFile()), ...readdirSync(new URL("terraform/", dir)).map((f) => "terraform/" + f)]) {
    const t = read(f);
    assert.ok(!/sk-ant-|sb_secret_|eyJhbGciOi|BEGIN (OPENSSH|RSA|EC) PRIVATE KEY|EVAL_ACCESS_TOKEN=[A-Za-z0-9]/.test(t), f);
  }
});
test("the weekly evaluation timer is off unless someone enables it (it costs AI credit)", () => {
  assert.match(read("doctine-eval.timer"), /NOT enabled by default/);
  assert.ok(!/doctine-eval/.test(init), "first boot never installs or enables the evaluation timer");
});

// The Resource Manager stack (infra/oracle-a1/terraform). Static checks: Terraform isn't installed here, so the stack's
// first real check is Oracle's own Plan job, which creates nothing.
const tf = ["main.tf", "variables.tf", "outputs.tf"].map((f) => read("terraform/" + f)).join("\n"), main = read("terraform/main.tf");
const resources = [...main.matchAll(/^resource "([a-z_]+)"/gm)].map((m) => m[1]);
test("stack: only network basics, one A1 instance and the free budget guard (no LB, database, bucket, vault)", () => {
  const allowed = new Set(["oci_core_vcn", "oci_core_internet_gateway", "oci_core_route_table", "oci_core_security_list", "oci_core_subnet", "oci_core_instance", "oci_budget_budget", "oci_budget_alert_rule"]);
  for (const r of resources) assert.ok(allowed.has(r), r);
  assert.equal(resources.filter((r) => r === "oci_core_instance").length, 1);
});
test("stack: the instance is A1.Flex, limited to 2 OCPU / 12 GB / 100 GB boot by validation", () => {
  assert.match(main, /shape\s+= "VM.Standard.A1.Flex"/);
  assert.match(tf, /var\.ocpus <= 2/); assert.match(tf, /var\.memory_gb <= 12/); assert.match(tf, /var\.boot_volume_gb <= 100/);
});
test("stack: inbound is SSH (22) from a single /32 only; no rule opens anything to the whole internet", () => {
  const ingress = [...main.matchAll(/ingress_security_rules \{([\s\S]*?)\n  \}/g)].map((m) => m[1]);
  assert.equal(ingress.length, 1);
  assert.match(ingress[0], /source\s+= var\.ssh_source_cidr/); assert.match(ingress[0], /min = 22\s+max = 22/);
  assert.match(tf, /endswith\(var\.ssh_source_cidr, "\/32"\)/);
});
test("stack: no secret variables; only a public SSH key, and a private key is refused", () => {
  const vars = [...tf.matchAll(/^variable "([a-z_]+)"/gm)].map((m) => m[1]);
  for (const v of vars) assert.ok(!/token|secret|password|api_key|private/.test(v), v);
  assert.match(tf, /!can\(regex\("PRIVATE KEY"/);
});
test("stack: legacy metadata endpoint off, first boot from cloud-init.yaml, and the zip builder includes it", () => {
  assert.match(main, /are_legacy_imds_endpoints_disabled = true/);
  assert.match(main, /file\("\$\{path\.module\}\/cloud-init\.yaml"\)/);
  assert.match(readFileSync(new URL("../tools/oracle-stack.mjs", import.meta.url), "utf8"), /cloud-init\.yaml/);
});

console.log(`${passed} oracle-infra tests passed${failed ? `, ${failed} failed` : ""}`);
if (failed) process.exit(1);
