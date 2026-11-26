/** Doctine · every model the server can route to is in the Model Lab registry (ai-lab/registry/models.json). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const reg = JSON.parse(readFileSync(new URL("../ai-lab/registry/models.json", import.meta.url), "utf8"));
const ids = new Set(reg.models.map((m) => m.id));
const sources = ["netlify/lib/ai.mjs", "netlify/lib/orchestrator/policy.mjs", "netlify/functions/scan.mjs", "netlify/lib/orchestrator/budget.mjs"];
let n = 0;
for (const f of sources) for (const m of readFileSync(new URL("../" + f, import.meta.url), "utf8").matchAll(/["'](claude-[a-z0-9-]+)["']/g)) { assert.ok(ids.has(m[1]), `${f} can use ${m[1]}, which is not in ai-lab/registry/models.json`); n++; }
assert.ok(n >= 4, "found the server's model names");
for (const m of reg.models) {
  assert.ok(["deployed", "configured_off", "candidate", "proposed"].includes(m.status), m.id + " status");
  assert.ok(m.ownership && m.tasks && m.tasks.length && m.evaluation, m.id + " is described");
  if (m.kind === "hosted_llm") assert.notEqual(m.status, "deployed", m.id + ": no hosted model is live (no AI key in production)");
}
import { execFileSync } from "node:child_process";
execFileSync(process.execPath, [new URL("../tools/model-registry-sync.mjs", import.meta.url).pathname, "--check"], { stdio: "inherit" });
const { infrastructure } = await import("../netlify/lib/orchestrator/info.mjs");
const inf = infrastructure({ env: {}, flags: {} });
assert.deepEqual(inf.models.map((m) => m.id), reg.models.map((m) => m.id), "the admin AI page lists the registry");
assert.ok(inf.evaluations.some((e) => e.model === "b0-app-parser" && e.input === "ocr"), "and the latest benchmark results");
assert.ok(!/sk-ant|sb_secret|eyJ/.test(JSON.stringify(inf)), "no key-like text");
console.log(`ai registry: ${n} model references checked against ${ids.size} registered models`);
