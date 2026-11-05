# Doctine — deployment guide

## What's in the project

```
public/                      the website (Netlify publishes this folder)
  index.html                 the app
  manifest.webmanifest, icons/, sw.js
netlify/functions/           server functions (each one is an /api route)
  chat.mjs     → /api/chat      health assistant (POST), connection test (GET ?test=1)
  scan.mjs     → /api/scan      read photos of documents, explain a document
  config.mjs   → /api/config    public Supabase settings for sign-in
  account.mjs  → /api/account   delete the signed-in person's account (DELETE)
netlify/lib/                 shared server code (bundled into the functions, not a route)
  ai.mjs                     Anthropic call, timeouts, error codes, in-memory fallback limiter
  ratelimit.mjs              shared rate limits (per account, per IP, daily AI budget) via Supabase
  safety.mjs                 emergency rules checked before every chat reply
  knowledge.mjs              optional medical-knowledge retrieval (off unless configured)
supabase/migrations/         run in order:
  20261104000000_doctine_core.sql            tables, row-level security, private storage
  20261104010000_conversations_consent.sql   saved chats, only with the person's consent
  20261104020000_rate_limits.sql             shared rate-limit counters (server-only)
tests/
  functions.test.mjs         server tests, run on every deploy (no key or credit needed)
  safety-cases.mjs           the emergency-rule evaluation set (61 cases), including known gaps
  run-db-tests.sh            database tests in a throw-away Postgres: security, saved chats, rate limits
  browser/                   app tests in headless Chromium (workflows, account isolation, persistence, demo mode)
  medical-eval-cases.mjs     the live medical evaluation set (75 cases with ids and expected behaviour)
  medical-eval-grader.mjs    grades live answers; eval-grader.test.mjs proves it fails unsafe answers
  live-eval.mjs              runs the evaluation against the real staging assistant (uses API credit)
tools/
  check-syntax.mjs, check-config.mjs, scan-secrets.mjs   code-quality and secret checks
  dev-server.mjs             local server: the page plus the real functions
  run-browser-tests.mjs      runs every browser suite against the dev server
  smoke-check.mjs            checks a deployed site (staging or production)
  run-step.mjs               records a CI step's real exit code for the release report
  npm-ci.sh                  installs dev tools from the lockfile (fails if it is missing)
  check-workflows.py         checks the release controls in the workflows (run by check-config.mjs)
  failure-drills.py          breaks things on purpose to prove each check fails
  release-report.mjs         release gates 1–7 → report.json, REPORT.md, GitHub run summary
  sync-safety-rules.mjs      copies the emergency rules into the web page after you edit safety.mjs
.github/workflows/           ci.yml, staging.yml, release.yml, rollback.yml (section 9)
docs/medical-review/         clinician sign-off records (TEMPLATE.md)
netlify.toml                 build, functions and security headers
package.json, package-lock.json   scripts and exactly pinned dev-only tools (Playwright, esbuild); the functions need no npm packages
```

## 1. Deploy with Git or the Netlify CLI (not drag-and-drop)

Drag-and-drop deploys publish files only. They **do not deploy functions**, which is why `/api/chat` and `/api/scan` currently return "not found" on the live site.

**Option A, Git (recommended):** push this folder to a GitHub repository, then in Netlify go to **Site configuration → Build & deploy → Link repository**. Netlify reads `netlify.toml`: it publishes `public/`, deploys `netlify/functions/`, and runs the server tests first (a failing test stops the deploy).

**Option B, CLI:** install Node 20, then in this folder:
```
npm install -g netlify-cli
netlify login
netlify link            # choose fabulous-mermaid-f39b30
netlify deploy --prod
```

## 2. Environment variables

Netlify → **Site configuration → Environment variables**. Set the scope to include **Functions**. Redeploy after changing any of them.

| Variable | Needed for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | chat and scanning | console.anthropic.com → API keys. Add credit under Billing. |
| `AI_MODEL` (optional) | chat model | A Claude model id. Default `claude-sonnet-5-5`. |
| `AI_SCAN_MODEL` (optional) | scanning model | Defaults to `AI_MODEL` if that's a Claude model. |
| `SUPABASE_URL` | accounts and storage | Supabase → Project settings → API → Project URL |
| `SUPABASE_ANON_KEY` | accounts and storage | Same page → `anon` `public` key. Safe in browsers; the database rules protect data. |
| `SUPABASE_SERVICE_ROLE_KEY` | account deletion and shared rate limits | Same page → `service_role` key. **Secret: it bypasses row-level security, so it can read every person's health records.** Set it only as a Netlify environment variable. Never put it in the website or any browser code, never commit it, and never print it or include it in logs (application logs, CI logs or support messages). |
| `RATE_LIMIT_SECRET` (required on staging and production) | rate limits | `openssl rand -hex 32`. Used to hash user ids and IP addresses before they're counted. If it is unset, the code falls back to the service-role key. Don't rely on that: it ties two secrets together, and rotating the service-role key would reset every counter. |
| `AI_DAILY_REQUEST_CAP` (optional) | spending protection | Maximum AI requests per day across everyone (chat + scanning). Default 3000. |
| `RATE_LIMIT_REQUIRE_SHARED` (optional) | spending protection | `true` refuses AI requests while the shared limiter can't be reached, instead of falling back to per-instance limits. Emergency messages still get fixed 112 guidance. |
| `RATE_LIMIT_<ROUTE>_<WHO>_<WINDOW>` (optional) | tuning | Override a limit, e.g. `RATE_LIMIT_CHAT_USER_10M=60`, `RATE_LIMIT_CHAT_IP_1D=100`, `RATE_LIMIT_SCAN_USER_1H=30`. Defaults are in `netlify/lib/ratelimit.mjs`. |
| `KNOWLEDGE_PROVIDER` (optional) | reference sources in answers | Leave unset: answers come from the AI's general knowledge and say so. Set to `http` only once you have a retrieval service (see `netlify/lib/knowledge.mjs`). |
| `AUTH_GOOGLE` (optional) | "Continue with Google" | `true` shows the Google button. Set it only after step 6 of section 3 is done for **this** site's Supabase project, or the button leads to an error page. Anything other than `true` hides it. |
| `DOCTINE_ENV` | which site this is | `production` on the live site, `staging` on the staging site, `development` locally. Reported by `/api/config` so checks can confirm the target. Evaluation access works only on `staging` or `eval`. |
| `EVAL_ACCESS_TOKEN` (staging only) | the live medical evaluation | A random string of at least 32 characters (`openssl rand -hex 32`). Lets evaluation runs use their own limit (300 an hour, still inside the daily AI budget). **Never set it on production**; it is ignored there anyway. |
| `ANTHROPIC_BASE_URL` (tests only) | browser tests | Points the functions at the local AI stand-in. Ignored when `DOCTINE_ENV=production`. Never set it on a deployed site. |
| `KNOWLEDGE_URL`, `KNOWLEDGE_TOKEN`, `KNOWLEDGE_ALLOWED_DOMAINS`, `KNOWLEDGE_TIMEOUT_MS` (optional) | the retrieval service | Its address, an optional token, the publisher domains you allow (default: who.int, icmr.gov.in, mohfw.gov.in, nhs.uk, nih.gov, cdc.gov), and a timeout in ms (default 4000). |

`AI_API_KEY` is accepted as another name for `ANTHROPIC_API_KEY`.

Without the three Supabase variables, the app keeps its browser-only demo accounts, and rate limits are per function instance only (not real protection; see section 5).

**Rules for every secret** (`ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RATE_LIMIT_SECRET`, `EVAL_ACCESS_TOKEN`, `KNOWLEDGE_TOKEN`, `NETLIFY_AUTH_TOKEN`):
- Store it only in Netlify environment variables or GitHub secrets, never in the repository, the website or browser code.
- Never print it, echo it, paste it into chat or tickets, or write it to any log. The functions log outcomes only: an error code, a status, which rule fired. They never log keys, request bodies or health information, and the server tests check that no response contains a secret value.
- Log operator actions and their outcomes (who did what, when, and whether it worked), not the secrets used to do them.
- If a secret may have been exposed (committed, logged, shared), rotate it at its provider first, then update Netlify or GitHub and redeploy. Deleting the text afterwards is not enough.
- Use different values on staging and production.

**Which keys reach the browser:** only `SUPABASE_URL` and `SUPABASE_ANON_KEY`, through `/api/config`. Both are designed to be public; the database rules protect the data. `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RATE_LIMIT_SECRET`, `EVAL_ACCESS_TOKEN` and `KNOWLEDGE_TOKEN` are used only inside the functions. The server tests check that no published file mentions them and that no response contains their values.

## 3. Supabase setup

1. Create a project at supabase.com (choose the Mumbai region for India).
2. **SQL Editor** → run the three files in `supabase/migrations/` in date order. (Or `supabase db push` with the Supabase CLI.) They need PostgreSQL 15 or later; Supabase projects use 15 or 17. Together they create:
   - all the tables, each with row-level security on, so a person can reach only their own rows;
   - links between tables that the database itself refuses to cross between people;
   - a trigger that turns each AI reading into lab results and prescription items;
   - the consent history;
   - the private `health-documents` bucket, with owner-only folder rules;
   - saved chats, which the database refuses to store unless the person has switched on "Save my chats";
   - shared rate-limit counters in a private schema that the public API doesn't expose, usable only with the service-role key.

   Because the tables use *forced* row-level security, the Supabase dashboard's table view (signed in as an admin) shows no health rows. That is intended. If you ever need operator access to health data, use the service-role key only from a secure script run by a named person, for a stated reason. **Never print or log the key itself**: keep it in an environment variable or a secrets manager, not in the script, the command line, shell history or any output. Record the *action*: who, when, why, which records, and the outcome. Never record the key or the health data you read.
3. **Authentication → URL configuration**: set **Site URL** to your Netlify address and add it under **Redirect URLs** (used by confirmation and password-reset emails).
4. **Authentication → Providers → Email**: keep **Confirm email** on for production.
5. **Authentication → Emails → SMTP**: set up your own email sender before launch. Supabase's built-in sender is rate-limited and meant only for testing.
6. **Sign in with Google (optional).** Do this once per Supabase project (staging and production each need it).
   1. In the Google Cloud Console, create (or choose) a project for Doctine. Under **Google Auth Platform → Branding**, set the app name *Doctine*, a support email and the app's home page (`https://doctine.com`), privacy policy and terms links. Under **Audience**, choose **External**. While the app is in *Testing*, only the test users you list can sign in; publish it before launch.
   2. **Data access**: keep the default scopes only (`openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`). Doctine needs nothing else from Google.
   3. **Clients → Create client → Web application**. Under **Authorised JavaScript origins** add the site (`https://app.doctine.com` for production, `https://doctine-staging.netlify.app` for staging). Under **Authorised redirect URIs** add the Supabase callback shown in step 4 (`https://<project-ref>.supabase.co/auth/v1/callback`). Create, then copy the **Client ID** and **Client secret**. The secret goes only into Supabase, never into Netlify, GitHub, the page or a chat.
   4. Supabase → **Authentication → Sign In / Providers → Google**: switch it on, paste the Client ID and secret, and save. The callback URL to give Google is shown on the same panel.
   5. Netlify → that site's environment variables → set `AUTH_GOOGLE=true`, then redeploy (the Staging or Release workflow).

   People who use "Continue with Google" tick the same agreement as an email sign-up; it is recorded in `consents` when their account first opens, and a choice they change later is never overwritten. A Google account and an email account with the same address are the same Doctine account only if Supabase links them (Supabase links verified identities by email automatically).

## 4. Check it after deploying

Open each of these in a browser:

| Address | Expected |
|---|---|
| `/api/chat?test=1` | `{"ok":true,"provider":"anthropic","model":"…"}`. This makes one tiny real request. An error names the problem, e.g. `invalid_key` or `insufficient_credits`. |
| `/api/scan` | `{"ok":true,…}` (checks the key is set) |
| `/api/config` | your Supabase URL and anon key (or `"accounts":"browser_demo"`), and `"environment"`: `production` on the live site |

Or run all of these at once: `SITE_URL=https://your-site EXPECT_ENV=production node tools/smoke-check.mjs`.

Then in the app: **Settings → Test AI connection**, create an account, scan a prescription, and ask a question in Chat.

## 5. Rate limits and spending protection

With Supabase configured, limits are shared by every function instance:
- **Signed-in people** are limited per account: chat 60 per 10 minutes and 400 a day; scanning 30 an hour and 150 a day.
- **Everyone else** is limited per IP address: chat 20 per 10 minutes and 100 a day; scanning 8 an hour and 30 a day.
- **Account deletion** is limited to 5 attempts an hour.
- **All AI requests together** stop at `AI_DAILY_REQUEST_CAP` a day (default 3000).

Requests are counted before the AI is called, so failed AI calls still count; this stops retry storms from running up the bill. Malformed requests are refused before counting.

If the shared limiter can't be reached, the functions fall back to in-memory limits, which each function instance counts separately. That is not real protection, so set `RATE_LIMIT_REQUIRE_SHARED=true` once you rely on it. In every case, emergency wording still gets fixed 112 guidance. Also set a monthly spend limit in the Anthropic Console as a final backstop.

## 6. Tests

Run these on your own computer with Node 20 (`npm ci` once, then `npx playwright install chromium` for the browser tests). They are also what CI runs (section 9).

| Command | What it checks | Real or simulated |
|---|---|---|
| `npm run check` | Syntax of every script and the page's inline scripts; configuration (routes, migrations, manifest, documented variables, workflows); secret scan. | Static checks |
| `npm run build:check` | Every function bundles the way Netlify bundles it. | Real esbuild |
| `npm run test:server` | 68 server tests: chat, scanning, emergency rules, rate limits, evaluation access, account deletion, secrets. Also runs on every Netlify deploy. | AI, Supabase and the limiter **simulated** |
| `npm run eval:grader` | The medical-evaluation grader fails unsafe answers (missed emergencies, dose changes, child doses, missing helplines). | Offline, no AI |
| `npm run test:db` | The migrations in a brand-new Postgres: RLS on and forced on every health table, two-account isolation, consent for saved chats, deletion cascades, rate-limit counters. | **Real PostgreSQL** with small stand-ins for Supabase's auth and storage schemas |
| `npm run test:browser` | 112 checks in headless Chromium: sign-up, sign-in, every page, chat and follow-ups, emergency banner, error states, upload and scanner, medicines and reminders, account isolation, two-device persistence, mobile layout. See `tests/browser/README.md`. | **Real functions**; AI and Supabase **simulated** |
| `DOCTINE_URL=… EVAL_ACCESS_TOKEN=… npm run eval:live` | The 75 medical evaluation cases against the **real** staging assistant. Writes `reports/medical-eval.json` and a clinician review sheet `reports/medical-eval.md`. | **Live**: real functions and real AI |
| `SITE_URL=… node tools/staging-e2e.mjs` | On the **staging** site and its Supabase project, with two synthetic accounts created and deleted in the run: sign-up and sign-in, profile and consent, document record and private upload, medicines, reminders and doses, cross-account isolation of rows and files, refused writes in another person's name, signed-out access, saved-chat consent, `/api/chat` signed in, account deletion through `/api/account` (nothing left behind), and the account route's rate limit. Refuses production. | **Live** |
| `SITE_URL=… EXPECT_ENV=staging npm run smoke` | A deployed site is up, is the right environment, and reaches the AI. | **Live** |
| `python3 tools/failure-drills.py` | 21 drills that each break one thing in a throw-away copy and require the matching check to fail. They include a syntax error, a leaked key, a removed emergency rule, RLS not forced, chats saved without consent, the cross-account chat bug, mobile overflow, a gate that passes missing evidence, a sign-off without a commit, production approval removed, an `npm install` fallback, and a lockfile out of sync. | Real checks on deliberately broken copies |
| `npm run test:gates` | The release gates block missing, failed, simulated or unsigned evidence. | Offline |
| `npm run report` | Turns the JSON reports in `reports/` into the release report. | — |

Set `REPORT_DIR=reports` to have each suite write its JSON report.

The emergency rules in `safety.mjs` are tested deterministically: the same text always gives the same result. That shows the rules do what they say. It says nothing about how good the AI's medical answers are; only the live evaluation plus a clinician's review can speak to that, and even that is a sample, not clinical validation. After editing `safety.mjs`, run `node tools/sync-safety-rules.mjs`; the server tests fail if the page's copy differs. The database stand-ins in `tests/supabase-stubs.sql` imitate only the parts of Supabase the migrations use. Never run them on a real project. **Never use real patient data in any test, including staging.**

## 7. What each part does, and where your data goes

- **Demo accounts** (no Supabase settings, and always inside Claude): everything stays in that browser on that device, labelled "Demo · this browser only". Nothing is uploaded to a Doctine account. The password check is a convenience, not security.
- **Doctine accounts** (Supabase configured): records, medicines, doses and page images are saved to the person's own account, protected by row-level security and a private bucket. If a change can't be saved, a red banner says so with the reason, keeps retrying, offers "Try again now", and warns before the page is closed or the person signs out. Signing out clears that person's data and cached page images from the page.
- **AI chat:** each message is sent through `/api/chat` to Anthropic to get an answer. Saved records go along only if the person ticks "Use my saved reports" in that chat. Inside Claude, messages go to Claude on the viewer's own account instead.
- **Medical knowledge retrieval:** off unless `KNOWLEDGE_PROVIDER` is set. Doctine has no medical knowledge database today. With it off, answers come from the AI's general knowledge and say so; with it on, an answer can cite only passages actually retrieved from your approved domains.
- **Saved chats:** off unless the person switches on **Settings → Save my chats** (Doctine accounts only). The database refuses to store chats without that consent. Unsaved messages belong to one person and one sign-in; signing out, switching accounts, deleting the account or switching saving off discards them, so they can never be written into someone else's account. A chat shows "saved" only after Supabase has confirmed it.

## 8. Moving from browser accounts

People who used the earlier demo accounts on the same browser see **Settings → Records saved in this browser** after they sign in with a real account. They choose the old account and enter its password, and the records are copied in. Nothing moves without that step, and sample data is never stored, so it can't be copied.

## 9. CI/CD

```
 pull request / branch push ──► CI ─────────────────────────────────────────────────► report (gates 1–5)
                                quality · backend · browser · database · security

 push to main ──► Staging: settings check ─┐
                           CI ─────────────┴─► deploy STAGING (stamped with the commit) ─► smoke check ─► live medical evaluation ─► report (gates 1–6)

 by hand, on main ──► Release: same code as a successful Staging run? ─► gates 1–7 from that run + committed sign-off ─► "production" approval ─► deploy ─► smoke check
```

| Workflow | When | What it can touch |
|---|---|---|
| `.github/workflows/ci.yml` | every pull request and branch push; reused by Staging | nothing outside the runner: no secrets, AI and Supabase simulated, throw-away Postgres |
| `.github/workflows/staging.yml` | push to `main` (or by hand, on `main`) | the staging Netlify site only |
| `.github/workflows/release.yml` | by hand, on `main`, with a Staging run id | the production site, after every gate passes and a reviewer approves the `production` environment |
| `.github/workflows/rollback.yml` | by hand, on `main` | restores an earlier deploy on staging or production, with that environment's approval |

**What the pipeline guarantees** (each point is checked on every CI run by `tools/check-workflows.py`, and broken on purpose by `tools/failure-drills.py`):
- Dependencies are installed only with `npm ci` from the committed `package-lock.json`. If the lockfile is missing, the install step fails with a message saying so. Nothing falls back to `npm install`. `npm audit` reads the committed lockfile.
- CI has no secrets. No workflow ever handles `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` or `RATE_LIMIT_SECRET`; those live only in Netlify.
- **Netlify credits.** Each deploy costs credits (15 of the free plan's 300 a month; visitors cost almost nothing). Staging redeploys only when something that can change the app changes: not for `website/`, `README.md`, `DEPLOY.md` or clinician sign-offs. The Release workflow accepts exactly those files on top of the staging-verified commit. If credits run out, published sites stay online, but deploys pause until the monthly reset.
- Deploys can't be overtaken by an older one. Netlify publishes a `--prod` deploy when its own processing finishes, even if the GitHub job has already stopped. So before deploying, the Staging and Release workflows cancel that site's deploys that are still in progress; afterwards they confirm with Netlify that *this* deploy is the live one; if the deploy step fails or is stopped, they cancel its own unfinished deploy; and Staging checks at the end of verification that the site still serves the verified commit (`tools/netlify-guard.mjs`).
- Staging starts with a settings check: the auth token is present; `EVAL_ACCESS_TOKEN` is present and 32+ characters; the staging and production site ids and addresses differ. If any fails, nothing is deployed.
- Each deploy writes `public/version.json` with its commit. The smoke checks and the evaluation confirm the site serves exactly that commit, and Netlify must confirm the deploy (deploy id and site id).
- The evaluation token goes only to a site that reports `staging`, never to `PRODUCTION_URL`. It is checked (`/api/chat?eval=1`, no AI call) before the 75 cases start. Production smoke checks refuse to run if the token is set, and confirm production refuses evaluation access.
- A release must start from `main`. The Staging run it names must be a successful run of `staging.yml` on `main`, and the commit it verified must be an ancestor of the release commit. Only files in `docs/medical-review/` may differ. The gates are re-checked from that run's own reports, and then the `production` environment's reviewers must approve.

**Release gates.** A gate passes only when its report exists and shows zero failures. A missing report counts as "not run", never as passed. So does a missing step: if Gitleaks or `npm audit` didn't run, gate 5 fails.

| Gate | Passes when |
|---|---|
| 1 Code quality | each of these steps ran and passed: `npm ci` from the lockfile; syntax and configuration checks; functions bundle; page safety rules match the server |
| 2 Backend tests | all server tests, grader tests and release-gate tests pass (labelled *mocked*) |
| 3 Browser tests | all browser suites pass (labelled *real functions, AI and Supabase simulated*) |
| 4 Database security | the migrations apply and every RLS, consent, deletion and rate-limit test passes on real Postgres |
| 5 Security | each ran and passed: secret scan of the tree; Gitleaks over the whole history (download checksum-verified); `npm audit --package-lock-only` (high and critical); no server secret names in `public/` |
| 6 Staging verified | the staging smoke check and the staging end-to-end check (synthetic accounts) passed against the deployed https staging site, serving the commit under release. A **live** run of the **whole** case set, on that same site and commit, has **0 critical failures and 0 service errors**. Simulated, local, partial or production runs are refused. Non-critical failures are listed for the clinician |
| 7 Clinical sign-off | `docs/medical-review/<run id>.md` is committed. Its `run_id` matches the evaluation run, and its `commit` is the full 40-character commit that run evaluated (and that is being released). It names a reviewer and a registration number, has a valid review date (not before the evaluation, not in the future), and says exactly `decision: approved`. A person then approves the `production` environment |

The registration number is recorded as written. Doctine does not check it with any medical council; whoever approves the `production` environment is responsible for knowing who the reviewer is.

Critical evaluation failures are: a missed emergency, a missing Tele-MANAS line for self-harm, advice to change a medicine dose, a numeric dose for a child, forbidden content, or no answer at all to an emergency. The report is written to `reports/report.json` and `reports/REPORT.md` and shown on each run's summary page.

## 10. Environments

| | Development | Staging | Production |
|---|---|---|---|
| Netlify site | none (`npm run dev`) | a **separate** site, e.g. `doctine-staging` | `fabulous-mermaid-f39b30` |
| Supabase | none (demo accounts), or a personal dev project | a **separate** Supabase project | the production project |
| `DOCTINE_ENV` | `development` | `staging` | `production` |
| Anthropic key | your own, in `.env.local` (never committed) | a staging key with a low monthly limit | the production key |
| `EVAL_ACCESS_TOKEN` | — | set (32+ characters) | **never** |
| Data | synthetic | **synthetic test accounts only** | real people |

Keep every key different between staging and production, so a leaked staging key can't touch real data.

**Local development:** `cp .env.example .env.local`, fill in development values (or leave the Supabase ones empty for demo accounts), then `npm ci` and `npm run dev` → http://localhost:8888, with the real functions. The dev server refuses to start with `DOCTINE_ENV=production`. Before pushing, run `npm test`, plus `npm run test:db` and `npm run test:browser` if you changed the database or the page.

**Pull requests:** CI runs automatically. Protect `main` so it can merge only when the **Release report (gates 1–5)** check is green.

**Changing a dependency:** edit the exact version in `package.json`, run `npm install` (this is the one place it's used: it rewrites the lockfile), and commit both files. `npm run check` fails if they disagree, or if any version isn't exact.

### Set up staging (once)

1. **Supabase:** create a second project (e.g. `doctine-staging`, Mumbai region). In its SQL Editor, run the three files in `supabase/migrations/` in date order. Under Authentication → URL configuration, set the Site URL to the staging address. Under **Authentication → Providers → Email**, switch **Confirm email OFF on this staging project only**, so the end-to-end check's synthetic accounts can sign in straight away. Keep it ON in production.
2. **Netlify site:** **Add new site → Import an existing project**, pick the same repository, name it `doctine-staging`. Then **Site configuration → Build & deploy → Continuous deployment → Stop builds**, because GitHub deploys it.
3. **Netlify variables for staging** (Site configuration → Environment variables, scope including Functions):

   | Variable | Value |
   |---|---|
   | `DOCTINE_ENV` | `staging` |
   | `EVAL_ACCESS_TOKEN` | the output of `openssl rand -hex 32` (keep it; GitHub needs the same value) |
   | `ANTHROPIC_API_KEY` | a separate staging key with a low monthly spend limit |
   | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | from the **staging** Supabase project |
   | `RATE_LIMIT_SECRET` | another `openssl rand -hex 32` |
   | `RATE_LIMIT_REQUIRE_SHARED` | `true` |
   | `AI_DAILY_REQUEST_CAP` | e.g. `500` (the evaluation uses about 80 a run) |

4. **Netlify variables for production:** `DOCTINE_ENV=production`, plus the production values of the same keys (section 2). **Do not** set `EVAL_ACCESS_TOKEN` or `ANTHROPIC_BASE_URL`. Then stop Netlify's own Git builds on production too, so only the Release workflow publishes it.
5. **GitHub:** set up the environments, secrets and variables in section 11.
6. **First run:** **Actions → Staging → Run workflow** on `main`. All three jobs should go green: *Staging settings*, *Deploy to staging*, *Verify staging*. If it fails, the first error line names the missing setting.

## 11. GitHub settings

**Settings → Environments**
- `staging`: deployment branches **main only**.
- `production`: **Required reviewers** (at least one person other than the author; tick "Prevent self-review"), deployment branches **main only**.

**Settings → Branches → main:** require a pull request, and require the status check **Release report (gates 1–5)**.

**Settings → Actions → General:** workflow permissions **Read repository contents** (the workflows ask for nothing more).

| Name | Kind | Where | Value |
|---|---|---|---|
| `NETLIFY_AUTH_TOKEN` | secret | environment `staging` and environment `production` | Netlify → User settings → Applications → Personal access tokens. Netlify tokens act for your whole account, so keep them only in these two environments |
| `EVAL_ACCESS_TOKEN` | secret | environment `staging` **only** | exactly the value set on the staging Netlify site |
| `NETLIFY_STAGING_SITE_ID` | variable | repository | staging site's **Site ID** (Site configuration → General) |
| `NETLIFY_PRODUCTION_SITE_ID` | variable | repository | production site's Site ID |
| `STAGING_URL` | variable | repository | e.g. `https://doctine-staging.netlify.app` |
| `PRODUCTION_URL` | variable | repository | `https://fabulous-mermaid-f39b30.netlify.app` |

Site ids and addresses are not secrets. They are repository variables so that every workflow can check staging and production are different sites. `ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` never go into GitHub at all. GitHub masks secrets in logs, and the scripts never print them.

## 12. Releasing to production

1. **Merge to `main`.** The Staging workflow checks the settings, runs CI, deploys staging stamped with the commit, then runs the smoke check, the end-to-end check with synthetic accounts, and the live evaluation (all 75 cases). Finally it enforces gates 1–6. Wait until all jobs are green.
2. **Get the review sheet.** Open that Staging run → **Artifacts → staging-verification** → `medical-eval.md`. At its top are the **run id** and the **evaluated commit** (full 40 characters). Give it to the doctor; they read every answer.
3. **Record the sign-off.** Copy `docs/medical-review/TEMPLATE.md` to `docs/medical-review/<run id>.md`. Fill in `run_id`, the full `commit`, `reviewer`, `registration`, `date` (YYYY-MM-DD) and `decision`. Commit and merge it to `main`. Commits that only touch `docs/medical-review/` don't start a new Staging run. If the doctor asked for changes, make them and start again from step 1. The new run gets a new run id and a new review.
4. **Start the release.** **Actions → Release to production → Run workflow**, branch `main`, `staging_run_id` = the number at the end of that Staging run's URL.
5. **Gates job.** It stops if the run isn't a successful `staging.yml` run on `main`, or if any code changed since that run's commit. It also stops if any of gates 1–7 isn't passed.
6. **Approve.** A required reviewer opens the run and approves the `production` deployment.
7. **Deploy job.** It records the live deploy id (for rollback), deploys, requires Netlify's confirmation, then runs the production smoke check. That check confirms `environment: production`, that the site serves the released commit, and that evaluation access is refused. The release is done only when this job is green. If the smoke check fails, roll back (section 13).

## 13. Rollback

- **From GitHub (recommended):** **Actions → Rollback → Run workflow** on `main`. Choose `production` or `staging` and paste the deploy id. The Release run prints the previous one under "Previous production deploy". The workflow checks the deploy belongs to that site, restores it, requires Netlify's confirmation, and runs the smoke check. It needs the same environment approval as a release.
- **From Netlify:** the site → **Deploys** → the last good deploy → **Publish deploy**.
- Database migrations are not rolled back automatically. Write a new migration that undoes the change, test it with `npm run test:db`, and apply it to staging before production.

## 14. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Install step: "package-lock.json is missing" | the lockfile wasn't committed. Run `npm install` locally and commit `package-lock.json`. |
| `npm ci`: lockfile out of sync | `package.json` was edited without updating the lockfile. Run `npm install` and commit both files. |
| Gate shows `not_run`, or "required step was not run" | that job or step didn't run (skipped, cancelled or crashed). Open its log. |
| *Staging settings* fails | the error names the missing secret or variable, or says staging and production are the same site. |
| Smoke check: `environment is "unset"` | `DOCTINE_ENV` isn't set on that Netlify site, or it wasn't redeployed after setting it. |
| Smoke check: "serves …, expected …" | the deploy didn't go live, or a cache served an older one. Re-run the job. |
| Smoke check: "the site refused the token" | `EVAL_ACCESS_TOKEN` differs between GitHub and the staging site, is shorter than 32 characters, or `DOCTINE_ENV` isn't `staging`. |
| "Live evaluation not started: EVAL_ACCESS_TOKEN is not set" | add the secret to the `staging` environment. Running without it is refused in CI, because 75 cases would take about 40 minutes under the public limit. |
| End-to-end: "no session after sign-up" | "Confirm email" is still on in the **staging** Supabase project. Turn it off there (never in production). |
| End-to-end: "cleanup: synthetic account … NOT deleted" | delete that `doctine-e2e+…@example.com` user in the staging Supabase dashboard (Authentication → Users). |
| Many `service_error` results | the staging Anthropic key has no credit, or `AI_DAILY_REQUEST_CAP` was reached. |
| "Netlify did not confirm a deploy" | the CLI didn't return a deploy id for that site. Check the token and site id, and the Netlify deploy log. |
| Database job: "PostgreSQL server binaries not found" | set `PGBIN` to the folder that holds `initdb`. |
| Gitleaks fails on a test value | if it is truly fake, add that exact string to `.gitleaks.toml`; if it is real, rotate the key first, then remove it from the history. |
| Gate 7: "sign-off is for commit …" / "commit is missing" | the sign-off must name the full evaluated commit from the top of `medical-eval.md`. |
| Gate 7: "review date … is before the evaluation ran" / "in the future" / "not a valid date" | use the actual review date as YYYY-MM-DD. |
| Release: "code changed since staging verified" | something besides `docs/medical-review/` was merged after that Staging run. Use the newer Staging run, which needs its own review. |

## 15. Running the app on Cloudflare Pages

The same app and server functions also run on Cloudflare Pages (free plan, commercial use allowed), so the app doesn't depend on Netlify's deploy credits.

- `functions/api/[[path]].js` routes `/api/config`, `/api/account`, `/api/chat` and `/api/scan` to the handlers in `netlify/functions/`. It copies Cloudflare's settings into `process.env` and takes the visitor's IP from `cf-connecting-ip`. Tests: `tests/cloudflare-adapter.test.mjs`.
- `wrangler.toml` sets the output folder (`public`) and the `nodejs_compat` flag (needed for `process` and `node:crypto`).
- Build command: `node tools/cloudflare-build.mjs`. It runs the server tests, stamps `public/version.json` with the commit, and writes `public/_headers` (the same security headers as `netlify.toml`).
- **Production branch: `app-release`, not `main`.** Moving `app-release` to a commit is the release step, so pushes to `main` never reach real users by themselves. Switch off preview deployments for other branches.
- **Settings** (Cloudflare → the Pages project → Settings → Variables and secrets, Production). Use the production values from section 2:
  - `DOCTINE_ENV=production`
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` (secret)
  - `RATE_LIMIT_SECRET` (secret)
  - `RATE_LIMIT_REQUIRE_SHARED=true`
  - `AI_DAILY_REQUEST_CAP`
  - `AUTH_GOOGLE=true`
  - `ANTHROPIC_API_KEY` (secret), only once the medical evaluation and clinician sign-off are done. Without it, chat and scanning say the assistant isn't available yet, and emergencies still get the fixed 112 guidance.
  - Never set `EVAL_ACCESS_TOKEN` here.

