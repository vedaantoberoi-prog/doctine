# Browser tests

These drive the real `public/index.html` in headless Chromium.

```
npm install && npx playwright install chromium
node tools/run-browser-tests.mjs        # all suites; with REPORT_DIR=reports it writes reports/browser.json
```

`tools/run-browser-tests.mjs` starts two things first:
- `tests/browser/mock-anthropic.mjs`, a stand-in for the Anthropic API that answers through the same tools the real
  functions force, with scripted answers and a control endpoint for forcing errors;
- `tools/dev-server.mjs`, which serves the page and runs the **real** Netlify functions (validation, emergency rules,
  rate limits, error mapping, output cleaning), pointed at the stand-in through `ANTHROPIC_BASE_URL`.

| Suite | What it covers | What is simulated |
|---|---|---|
| `tests/browser/workflows.test.mjs` | sign-up, sign-in, wrong password, sign-out, every page, chat with follow-ups, emergency banner, AI error states (bad key, busy, no credit, network), consent off, upload and scanner, record viewer, explain a report, medicines and reminders, account switching, mobile at 375 px (43 checks) | the AI |
| `tests/browser/isolation.test.mjs` | one person's unsaved or failed chats and records never reach another account (20 checks) | Supabase (`fake-supabase-strict.js`) and the AI |
| `tests/browser/persistence.test.mjs` | two-device persistence and visible save failures (28 checks) | Supabase (`fake-supabase-strict.js`) and the AI |
| `tests/browser/app.test.mjs` | demo-account mode: chat, scanning, medicines, export, mobile (21 checks) | API responses, in the browser |

`fake-supabase-strict.js` binds every request to the sign-in active when it was sent, and refuses rows owned by
someone else, like Supabase's row-level security. It is not Supabase: real RLS is tested on PostgreSQL by
`tests/run-db-tests.sh`, and real Supabase Auth and Storage only on staging.

Every suite ends with a "no JavaScript errors" check and exits non-zero on any failure.
