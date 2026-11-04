# Doctine

Doctine is an India-first personal health records app with an AI health assistant. People can scan and store prescriptions and lab reports, keep track of their medicines and dose reminders, and ask health questions in plain language.

> **Not a medical device, and not clinically validated.** Doctine gives general health information. It does not diagnose, and it is no substitute for a doctor. In an emergency, call **112**. For mental-health support, call Tele-MANAS on **14416**.

## What's here

| Folder | What it holds |
|---|---|
| `public/` | the web app (one page, installable) |
| `netlify/functions/` | the server: `/api/chat`, `/api/scan`, `/api/config`, `/api/account` |
| `netlify/lib/` | shared server code: AI calls, emergency rules, rate limits |
| `supabase/migrations/` | the database: tables, row-level security, private file storage |
| `tests/` | server, database, browser and medical-evaluation tests |
| `tools/` | checks, the local dev server, smoke tests and the release report |
| `.github/workflows/` | CI, staging, release and rollback |
| `docs/medical-review/` | clinician sign-off records |

## Run it locally

Needs Node 20.

```
cp .env.example .env.local     # fill in development values only; leave Supabase empty for demo accounts
npm ci
npm run dev                    # http://localhost:8888, with the real server functions
```

## Test it

```
npm test                       # syntax, config, secret scan, server, grader and release-gate tests
npm run test:db                # database security tests (needs PostgreSQL 15+ server binaries)
npx playwright install chromium && npm run test:browser
```

The server and browser tests simulate the AI and Supabase, and say so in their reports. Only the live evaluation on staging uses the real model.

## Deploying

Everything (environments, secrets, staging, releases, rollback) is in **[DEPLOY.md](DEPLOY.md)**. In short:

- **Pull requests:** CI runs the five test jobs and the release report (gates 1–5).
- **Push to `main`:** the Staging workflow deploys a separate staging site. It then runs a smoke check, an end-to-end check with synthetic accounts, and the live medical evaluation (gates 1–6).
- **Production:** started by hand. It needs a clinician's committed sign-off for the exact evaluated commit (gate 7) and a reviewer's approval. It is never deployed automatically.

Don't link a Netlify site to this repository with Netlify's own Git builds. The workflows deploy it; see DEPLOY.md sections 1 and 10.

## Security

- Secrets (`ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and the rest) live only in Netlify or GitHub settings. Never commit them, print them, or put them in browser code.
- Use synthetic data only in development and staging. Never use real patient information in tests.
- To report a security problem, contact the repository owner privately. Please don't open a public issue.
