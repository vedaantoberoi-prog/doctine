"""Doctine · failure drills. Each drill breaks one thing in a throw-away copy of the project, runs the check that
should catch it, and records whether that check failed (it must). Proves the gates can fail, not just pass.
  python3 tools/failure-drills.py            all drills (the two browser drills take a few minutes each)
  python3 tools/failure-drills.py 0 5 9      only those drill numbers
Writes reports/failure-drills.json. Exit 1 if any drill was MISSED. Never touches the real project files."""
import shutil, subprocess, os, json, sys, time, tempfile
SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = tempfile.mkdtemp(prefix="doctine-drills-")
D = [
 ("Syntax error in a function", "netlify/functions/chat.mjs", [("export const config = { path: \"/api/chat\" };", "export const config = { path: \"/api/chat\" ;")], ["node", "tools/check-syntax.mjs"]),
 ("A function loses its route", "netlify/functions/scan.mjs", [("export const config = { path: \"/api/scan\" };", "export const config = {};")], ["node", "tools/check-config.mjs"]),
 ("A real-looking Anthropic key is committed", "tools/dev-server.mjs", [("const root =", "const leaked = \"sk-ant-api03-" + "A"*40 + "\";\nconst root =")], ["node", "tools/scan-secrets.mjs"]),
 ("A new env var is used but not documented", "netlify/lib/ai.mjs", [("export function anthropicUrl(env = process.env) {", "export function anthropicUrl(env = process.env) {\n  void env.DOCTINE_UNDOCUMENTED_FLAG;")], ["node", "tools/check-config.mjs"]),
 ("Bundle imports a missing module", "netlify/functions/config.mjs", [("import { json } from \"../lib/ai.mjs\";", "import { json } from \"../lib/ai.mjs\";\nimport \"../lib/does-not-exist.mjs\";")], ["npm", "run", "-s", "build:check"]),
 ("Emergency helpline backstop removed", "netlify/functions/chat.mjs", [("if (add.length) ans.safety_note", "if (false) ans.safety_note")], ["node", "tests/functions.test.mjs"]),
 ("Evaluation access allowed on production", "netlify/lib/ratelimit.mjs", [("if (envName !== \"staging\" && envName !== \"eval\")", "if (false)")], ["node", "tests/functions.test.mjs"]),
 ("Evaluation log leaks the evaluation token", "netlify/lib/evallog.mjs", [("...meta }));", "...meta, token: req.headers.get(\"x-doctine-eval-token\") }));")], ["node", "tests/functions.test.mjs"]),
 ("Emergency rule for breathing removed", "netlify/lib/safety.mjs", [('{ id: "breathing", re: /', '{ id: "breathing", re: /(?!)')], ["node", "tests/functions.test.mjs"]),
 ("Row-level security not forced", "supabase/migrations/20261104000000_doctine_core.sql", [("    execute format('alter table public.%I force row level security', t);\n", "")], ["bash", "tests/run-db-tests.sh"]),
 ("Saved chats no longer require consent", "supabase/migrations/20261104010000_conversations_consent.sql", [("user_id = auth.uid() and public.chat_history_allowed());", "user_id = auth.uid());"), ("user_id = auth.uid() and public.chat_history_allowed());", "user_id = auth.uid());")], ["bash", "tests/run-db-tests.sh"]),
 ("Grader stops detecting dose-change advice", "tests/medical-eval-grader.mjs", [("if (ex.no_dose_change) {", "if (false) {")], ["node", "tests/eval-grader.test.mjs"]),
 ("Release gate treats a missing report as passed", "tools/release-report.mjs", [("if (!j) return { status: \"not_run\", details: [`${label}: no report`] };", "if (!j) return { status: \"passed\", details: [] };")], ["node", "tests/release-gates.test.mjs"]),
 ("Clinical sign-off accepted without a commit", "tools/release-report.mjs", [('if (!commit) problems.push("commit is missing");', '')], ["node", "tests/release-gates.test.mjs"]),
 ("Production approval removed from the release workflow", ".github/workflows/release.yml", [("    environment: production   #", "    #environment: production   #")], ["node", "tools/check-config.mjs"]),
 ("CI falls back to npm install", ".github/workflows/ci.yml", [("run: bash tools/npm-ci.sh", "run: npm install")], ["node", "tools/check-config.mjs"]),
 ("Lockfile no longer matches package.json", "package-lock.json", [('"version": "1.63.0"', '"version": "1.62.0"')], ["node", "tools/check-config.mjs"]),
 ("Staging no longer checks the evaluation token before deploying", ".github/workflows/staging.yml", [('[ "${#EVAL_ACCESS_TOKEN}" -ge 32 ]', '[ "${#EVAL_ACCESS_TOKEN}" -ge 0 ]')], ["node", "tools/check-config.mjs"]),
 ("Evaluation check endpoint accepts tokens on production", "netlify/functions/chat.mjs", [('return json({ eval_access: rle.who === "eval" && evalAccess(req) });', 'return json({ eval_access: !!req.headers.get("x-doctine-eval-token") });')], ["node", "tests/functions.test.mjs"]),
 ("Saved-chat account isolation guards removed (the original cross-account bug)", "public/index.html", [
    ("function resetHistory(){HIST.dead=true;HIST=newHist();", "function resetHistory(){"),
    ("const sb=CLOUD.sb,uid=h.uid;\n const alive=()=>!h.dead&&HIST===h&&CLOUD.uid===uid&&CLOUD.epoch===h.epoch&&historyOn();", "const sb=CLOUD.sb,uid=CLOUD.uid;\n const alive=()=>true;"),
    ("   if(t.uid!==uid||t.epoch!==h.epoch){h.pending.shift();continue}\n", "")], ["node", "tools/run-browser-tests.mjs"]),
 ("Mobile layout overflows", "public/index.html", [("</style>", "body{min-width:640px}</style>")], ["node", "tools/run-browser-tests.mjs"]),
]
only = sys.argv[1:] 
results = []
for i, (name, f, muts, cmd) in enumerate(D):
    if only and str(i) not in only: continue
    w = os.path.join(BASE, "w" + "-".join(only))
    shutil.rmtree(w, ignore_errors=True)
    shutil.copytree(SRC, w, ignore=shutil.ignore_patterns("node_modules", "reports", ".build-check"), symlinks=True)
    if os.path.exists(os.path.join(SRC, "node_modules")): os.symlink(os.path.join(SRC, "node_modules"), os.path.join(w, "node_modules"))
    p = os.path.join(w, f); s = open(p).read()
    if True:
        for a, b in muts:
            assert a in s, f"mutation target not found in {f}: {a[:60]}"
            s = s.replace(a, b, 1)
    open(p, "w").write(s)
    t0 = time.time()
    r = subprocess.run(cmd, cwd=w, capture_output=True, text=True, timeout=900, env={**os.environ, "REPORT_DIR": ""})
    out = (r.stdout + r.stderr).strip().splitlines()
    caught = r.returncode != 0
    hint = ([l for l in out if l.startswith("FAIL ") or l.lstrip().startswith("✗") or "FAILED" in l or "[ERROR]" in l or "ERROR:" in l] or [l for l in out if "error" in l.lower()])[:4]
    results.append({"drill": name, "file": f, "check": " ".join(cmd), "caught": caught, "exit": r.returncode, "evidence": hint, "s": round(time.time()-t0)})
    print(("CAUGHT " if caught else "MISSED ") + name, "|", " ".join(cmd), "| exit", r.returncode, "|", (hint[0][:140] if hint else ""), flush=True)
shutil.rmtree(BASE, ignore_errors=True)
os.makedirs(os.path.join(SRC, "reports"), exist_ok=True)
json.dump({"suite": "failure-drills", "drills": results, "caught": sum(r["caught"] for r in results), "missed": sum(not r["caught"] for r in results)}, open(os.path.join(SRC, "reports", "failure-drills.json"), "w"), indent=1)
sys.exit(1 if any(not r["caught"] for r in results) else 0)
