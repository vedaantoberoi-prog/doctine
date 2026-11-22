/**
 * Doctine · AI policy release gate.
 *   node tools/ai-policy-gate.mjs            → fails if the policy in the code isn't the version recorded in
 *                                              docs/ai-policy/manifest.json (rules or prompts changed without a new version)
 *   node tools/ai-policy-gate.mjs --deploy   → also refuses a deploy that changes the released policy between Friday 12:00
 *                                              and Sunday 23:59 India time, unless AI_POLICY_WINDOW_OVERRIDE="<reason>" is set
 * Exit 0 = pass, 1 = blocked. Prints the reason; never prints secrets.
 */
import { readFileSync } from "node:fs";
import { POLICY, POLICY_HASH } from "../netlify/lib/orchestrator/policy.mjs";

export function gate({ manifest, hash = POLICY_HASH, version = POLICY.version, deploy = false, now = new Date(), override = "" }) {
  const problems = [];
  if (!manifest || !manifest.current) problems.push("docs/ai-policy/manifest.json has no `current` entry");
  else {
    if (manifest.current.version !== version) problems.push(`policy version in code is ${version}, manifest says ${manifest.current.version}`);
    if (manifest.current.hash !== hash) problems.push(`policy content changed (hash ${hash}, manifest ${manifest.current.hash}): bump POLICY.version and record it in the manifest with a changelog line`);
    if (!(manifest.history || []).some((h) => h.version === version && h.hash === hash)) problems.push(`no changelog entry for ${version} with hash ${hash}`);
  }
  if (deploy && manifest && (!manifest.released || manifest.released.hash !== hash)) {
    const ist = new Date(now.getTime() + 5.5 * 3600e3), day = ist.getUTCDay(), hour = ist.getUTCHours();
    const frozen = (day === 5 && hour >= 12) || day === 6 || day === 0;
    if (frozen && !String(override).trim()) problems.push("this deploy changes the AI policy and it is Friday afternoon or the weekend (IST): deploy policy changes Monday to Friday morning, or set AI_POLICY_WINDOW_OVERRIDE with a reason");
  }
  return { ok: !problems.length, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = JSON.parse(readFileSync(new URL("../docs/ai-policy/manifest.json", import.meta.url), "utf8"));
  const r = gate({ manifest, deploy: process.argv.includes("--deploy"), override: process.env.AI_POLICY_WINDOW_OVERRIDE || "" });
  if (r.ok) console.log(`AI policy gate: pass (${POLICY.version}, ${POLICY_HASH})`);
  else { console.error("AI policy gate: BLOCKED\n - " + r.problems.join("\n - ")); process.exit(1); }
}
