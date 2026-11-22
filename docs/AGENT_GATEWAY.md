# Doctine Agent Execution Gateway (prototype, 22 Nov 2026)

Read-only, off by default. Not yet connected to the assistant, which itself stays off until a doctor's review.

## Pieces

| File | Role |
|---|---|
| `netlify/lib/gateway/registry.mjs` | 13 typed, read-only capabilities over the real tables; discovery (`searchCapabilities`); argument validation |
| `netlify/lib/gateway/labs.mjs` | Lab value parsing, test-name matching, like-with-like comparison, timeline (pure functions) |
| `netlify/lib/gateway/executor.mjs` | `executeWorkflow`: declarative plans, dependency waves run in parallel, references, selection, limits, audit |
| `netlify/lib/gateway/db.mjs` | Reads AS the signed-in person (anon key + their token) so row-level security enforces ownership |
| `netlify/lib/gateway/tools.mjs` | The 2 model-facing tools with worked examples and data rules; the 13-tool conventional baseline |
| `netlify/functions/gateway.mjs` | `POST /api/gateway` `{op: search | execute | tools}` |
| `tests/gateway.test.mjs` | 25 tests, fictional data (part of `npm test`) |
| `tools/bench-gateway.mjs` | Deterministic A/B/C context-size benchmark, fictional data; results in `docs/GATEWAY_BENCHMARK.md` |

## Configuration

- Needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` (already set). It never uses `SUPABASE_SERVICE_ROLE_KEY`.
- Switched on by the platform flag `ai_gateway` (default off, Founder-only), added by
  `supabase/migrations/20261123000000_ai_gateway_flag.sql` (rollback in `supabase/rollback/`). Applied and switched on in
  **staging only** (23 Nov 2026). Not applied to production.
- Rate limit: route `gateway`, 120 calls per 10 minutes and 1,000 per day per person (override `RATE_LIMIT_GATEWAY_USER_10M`, `_1D`).

## Limits

8 steps per plan, 4,000-character plan, 48,000-character selected output (larger fails with advice; nothing is cut
silently), 9 s per plan, 4 s per database read, 1,000 rows per read.

## Monitoring

One log line per call: time, a hash of the person, step names, timings, row counts, outcome. Never values.
A persistent audit table is planned with the agent integration.

## Deploy and roll back

Deployed with the app (`npm run build:direct`, Cloudflare upload). With the flag off the route answers 503 and reads
nothing. Roll back by switching the flag off, or by redeploying the previous app build; the switch migration has its own rollback file.

## Staging verification (23 Nov 2026)

`tools/staging-seed.mjs` created two FICTIONAL staging accounts (`fictional-a@example.test`, `fictional-b@example.test`,
no password, marked fictional) through the real tables and the real extraction trigger. `tools/staging-replay.mjs`
ran every read the gateway's 22 test plans make, as each person (role `authenticated` with their id, so real row
security applies), then replayed the gateway on those rows: 17 of 17 checks passed (isolation, real columns, trigger-built
lab rows labelled unconfirmed, unit separation, missing reports, limits, no contact details, injection title as data).
Not covered: the HTTP route on a deployed staging site (staging does not run this branch).

## Decisions (23 Nov 2026)

- Plans run on Doctine's own server. Anthropic's programmatic tool calling is not used for health data (it is not
  eligible for zero data retention and keeps container data up to 30 days).
- Live benchmark: `tools/bench-live.mjs` (fictional data, spending cap) via `.github/workflows/bench-live.yml`; it runs
  once the repository secret `ANTHROPIC_API_KEY` exists. Clinician review: `docs/medical-review/gateway-review-pack.md`.
