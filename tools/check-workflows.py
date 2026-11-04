"""Doctine · structural checks of the GitHub workflows (run by tools/check-config.mjs; needs python3 + PyYAML).
Checks the release controls that must never regress: which jobs depend on which, where secrets may appear, how
dependencies are installed, which environment protects each deploy, and that gates are enforced.
Prints one line per check: "ok <msg>" or "fail <msg>"."""
import sys, os, re, yaml
root = sys.argv[1]
W = os.path.join(root, ".github", "workflows")
out = []
def need(cond, msg): out.append(("ok " if cond else "fail ") + msg)
def load(n):
    with open(os.path.join(W, n)) as f: txt = f.read()
    return yaml.safe_load(txt), txt
def on(d): return d.get(True, d.get("on")) or {}
def needs(j): n = j.get("needs", []); return [n] if isinstance(n, str) else n
def runs(j): return "\n".join(str(s.get("run", "")) for s in j.get("steps", []))

ci, ci_t = load("ci.yml"); st, st_t = load("staging.yml"); rel, rel_t = load("release.yml"); rb, rb_t = load("rollback.yml")
all_t = {"ci.yml": ci_t, "staging.yml": st_t, "release.yml": rel_t, "rollback.yml": rb_t}

# dependencies are installed only from the lockfile
for n, t in all_t.items():
    need(not re.search(r"\bnpm (install|i)\b(?!.*--package-lock-only)", t), f"{n}: never runs `npm install` (only npm ci from the lockfile)")
need("tools/npm-ci.sh" in ci_t and "--package-lock-only" in ci_t, "ci.yml: installs with tools/npm-ci.sh and audits the committed lockfile")
# server secrets never appear in workflows
for n, t in all_t.items():
    need(not re.search(r"secrets\.(ANTHROPIC_API_KEY|AI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|RATE_LIMIT_SECRET)|^\s*(ANTHROPIC_API_KEY|AI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|RATE_LIMIT_SECRET)\s*:", t, re.M),
         f"{n}: no AI or database service keys are passed to any step")
need(not re.search(r"\$\{\{\s*secrets\.", ci_t), "ci.yml: uses no secrets at all")
need("EVAL_ACCESS_TOKEN" not in rel_t, "release.yml: never handles the evaluation token")
# CI: every test job uploads its report even on failure; the report job needs all five and enforces gates 1–5
cj = ci["jobs"]
for name in ["quality", "backend", "browser", "database", "security"]:
    ups = [s for s in cj[name]["steps"] if str(s.get("uses", "")).startswith("actions/upload-artifact")]
    need(ups and ups[-1].get("if") == "always()" and ups[-1]["with"]["name"] == f"report-{name}", f"ci.yml: {name} uploads report-{name} even when it fails")
need(sorted(needs(cj["report"])) == sorted(["quality", "backend", "browser", "database", "security"]) and cj["report"].get("if") == "always()", "ci.yml: the report job waits for all five jobs and always runs")
need("--require=1-5 --enforce" in runs(cj["report"]), "ci.yml: gates 1–5 are enforced")
need("workflow_call" in on(ci), "ci.yml: reusable by the Staging workflow")
# Staging
sj = st["jobs"]
need(set(on(st).keys()) <= {"push", "workflow_dispatch"} and on(st)["push"]["branches"] == ["main"], "staging.yml: runs on pushes to main (and by hand)")
need(sorted(needs(sj["deploy"])) == ["ci", "preflight"], "staging.yml: deploy waits for the settings check and CI")
need(needs(sj["verify"]) == ["deploy"], "staging.yml: verification runs after the deploy")
need(all(sj[j].get("environment") == "staging" for j in ["preflight", "deploy", "verify"]), "staging.yml: every job with secrets uses the staging environment")
need("EVAL_ACCESS_TOKEN" in runs(sj["preflight"]) and "-ge 32" in runs(sj["preflight"]), "staging.yml: the evaluation token is checked before anything is deployed")
need("NETLIFY_PRODUCTION_SITE_ID" not in str(sj["deploy"]), "staging.yml: the deploy job never sees the production site id")
need("--require=1-6 --enforce" in runs(sj["verify"]), "staging.yml: gates 1–6 are enforced")
need("PRODUCTION_URL" in str(sj["verify"]) and "EXPECT_COMMIT" in str(sj["verify"]), "staging.yml: the evaluation is pinned to the commit and refuses the production address")
need("tools/staging-e2e.mjs" in runs(sj["verify"]), "staging.yml: the end-to-end check with synthetic accounts runs on staging")
need("staging-e2e" not in rel_t.replace("staging-verification", ""), "release.yml: never runs the end-to-end check (it creates accounts) against production")
# Release
rj = rel["jobs"]
need(list(on(rel).keys()) == ["workflow_dispatch"], "release.yml: started only by hand")
need(needs(rj["deploy"]) == ["gates"] and rj["deploy"].get("environment") == "production", "release.yml: deploy needs the gates and the production environment's approval")
need("--require=1-7 --enforce" in runs(rj["gates"]), "release.yml: gates 1–7 are enforced")
need("refs/heads/main" in runs(rj["gates"]) and "merge-base --is-ancestor" in runs(rj["gates"]) and "docs/medical-review/" in runs(rj["gates"]), "release.yml: main only, and only sign-off files may change after staging")
need("RELEASE_SHA: \"${{ steps.staged.outputs.sha }}\"" in rel_t, "release.yml: gates are checked against the staging-verified commit")
need("EXPECT_COMMIT" in runs(rj["deploy"]) or "EXPECT_COMMIT" in str(rj["deploy"]), "release.yml: the production smoke check confirms the released commit")
# Rollback
need(rb["jobs"]["rollback"].get("environment") == "${{ inputs.target }}", "rollback.yml: needs the target environment's approval")
need("&& secrets.NETLIFY_PRODUCTION_SITE_ID ||" not in rb_t and "if [ \"$TARGET\" = production ]; then SITE=" in rb_t, "rollback.yml: the site is chosen explicitly (no silent fallback to the other site)")
need("getDeploy" in rb_t, "rollback.yml: checks the deploy belongs to the chosen site before restoring")
# deploys confirm with Netlify
for n, t in [("staging.yml", st_t), ("release.yml", rel_t)]:
    need("d.deploy_id" in t and "d.site_id!==process.env.NETLIFY_SITE_ID" in t and "public/version.json" in t, f"{n}: Netlify must confirm the deploy to the right site, and the deploy is stamped with its commit")
print("\n".join(out))
