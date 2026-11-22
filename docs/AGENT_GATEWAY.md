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
- Switched on by the platform flag `ai_gateway` (default off). The database's `feature_flags` table only accepts known
  keys, so turning it on needs a one-line migration adding `ai_gateway` to that check (not written or applied yet).
- Rate limit: route `gateway`, 120 calls per 10 minutes and 1,000 per day per person (override `RATE_LIMIT_GATEWAY_USER_10M`, `_1D`).

## Limits

8 steps per plan, 4,000-character plan, 48,000-character selected output (larger fails with advice; nothing is cut
silently), 9 s per plan, 4 s per database read, 1,000 rows per read.

## Monitoring

One log line per call: time, a hash of the person, step names, timings, row counts, outcome. Never values.
A persistent audit table is planned with the agent integration.

## Deploy and roll back

Deployed with the app (`npm run build:direct`, Cloudflare upload). With the flag off the route answers 503 and reads
nothing. Roll back by switching the flag off, or by redeploying the previous app build; there is no database change.
