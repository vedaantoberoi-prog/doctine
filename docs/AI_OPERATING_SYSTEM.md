# Doctine AI operating system: Intelligence Orchestrator (23 Nov 2026)

Status (23 Nov 2026, 03:40 IST): **live on staging (5f13ab6) and production (8944f81), switched off.** The switch
migrations `20261123000000_ai_gateway_flag` and `20261123030000_ai_orchestrator_flag` are applied to both databases
(hash-checked, with approval); `ai_assistant`, `ai_gateway` and `ai_orchestrator` are all off on production, so
`/api/assist` answers 503 "switched off" and the chat is unchanged. On staging the two fictional accounts have AI
consent for testing. The assistant stays switched off for real people until a doctor has reviewed its answers. Nothing
here claims DPDP, clinical or security compliance; those need their own validation.

It extends the existing system and duplicates none of it: one sign-in (Supabase), one record store, one retrieval
pipeline (the evidence engine through the Agent Execution Gateway), one admin console, one chat. The orchestrator is a
control layer around them.

## 1. Audit: how a request flowed before this work

| Step | Before | Gap |
|---|---|---|
| Chat | Browser builds a small context (≤ 10 matching values) → `/api/chat` → one Claude call with a forced reply tool | The model sees only what the browser picked; no server-side retrieval |
| Records retrieval | Gateway (`/api/gateway`, 16 read-only capabilities) and evidence engine (`investigate_records`) exist | Not connected to the chat |
| Identity | Supabase token checked per request; row-level security on every table | No identity envelope; consent checked in the browser only |
| Safety | Fixed emergency rules before the model (`safety.mjs`) | No request classification beyond emergencies; no output validation against records |
| Control | Rate limits, AI switch, maintenance mode | No state machine, no tool levels, no routing, no traces, no versioned policy |

## 2. What is built

```
/api/assist  (switches: ai_assistant AND ai_gateway AND ai_orchestrator)
RECEIVED → AUTHENTICATED (Supabase token → identity envelope)
  → CLASSIFIED (deterministic: emergency · other_person · injection · action_request · record_question · general_health · unclear)
     └ emergency → ESCALATED (fixed guidance, no records, no model)
  → CONTEXT_RESOLVED (consents read from the database as the person; unreadable = no)
  → PERMISSION_CHECKED (role + row security + ai_chat consent + "Use my saved reports" for this chat)
     └ refused / not a records question → fixed text → COMPLETED
  → RETRIEVING (investigate_records via the tool gateway, as the person; 1 retry on a transient error)
  → PLANNING (model route A–D from the evidence)
  → VERIFYING (every cited document still exists; if one was deleted, retrieve once more)
  → GENERATING_RESPONSE (facts built by code from the evidence; the model writes only a validated explanation)
  → COMPLETED                     any stage → FAILED (timeout, retrieval failure) or ABORTED (the person cancelled)
```

| Part | File | What it enforces |
|---|---|---|
| Policy (versioned) | `netlify/lib/orchestrator/policy.mjs`, `docs/ai-policy/manifest.json`, `tools/ai-policy-gate.mjs` | Every rule and prompt in one object with a content hash. A changed hash without a new version and changelog entry fails the tests. A deploy that changes the released policy is refused Friday 12:00 – Sunday (IST) unless an override reason is given. Rollback = deploy the previous commit. |
| Classification | `classify.mjs` | No model decides the category, so a crafted message can't change it. |
| State machine | `state.mjs` | Only the transitions above; per-stage time limits, bounded retries for transient errors only, cancellation, a 27 s deadline; one span per stage with allow-listed attributes (no values), exportable as OpenTelemetry JSON. |
| Identity and permissions | `identity.mjs` | Envelope from the verified token only; the account id is non-enumerable (never in logs, prompts or tool arguments); role `patient` reads own records only; consent and the per-chat sharing choice are the purpose check; fail closed. |
| Tool registry and execution gateway | `tools.mjs` | Levels 0 read · 1 draft · 2 request · 3 execute after confirmation · 4 human only. All 16 capabilities are level 0; **no write tool is enabled** (server-side writes would race the app's own sync). Arguments naming a person or account are refused. Level 2–3 calls need a server-signed, 5-minute, single-use token bound to the person, tool and arguments (tested with a fictional tool). Audit per call: names, timings, counts. |
| Model routing | `router.mjs` | A deterministic (no model) · B light (`AI_MODEL_LIGHT`) · C standard (`AI_MODEL`) · D careful (`AI_MODEL_HIGH`: conflicts, unit changes, long histories). If the model can't be used, **never a weaker one**: the person gets the facts, labelled as without explanation. Providers are an interface; only Anthropic is wired. |
| Minimisation and validation | `validate.mjs` | The model sees evidence ids, tests, values, units, ranges, dates, document types, pages and verification; no titles, account ids or contact details. Its output must match the schema, cite only existing `E#`, write no number absent from the evidence, and contain no diagnosis claim, medicine-change advice or contact details. One retry with the reasons; otherwise it is not shown. |
| Cost, budgets, cache, idempotency | `budget.mjs` | Tokens always counted; cost only where a price is configured (never guessed). Per-person daily token budget. Answer cache keyed by person + policy version + model + question + evidence fingerprint (a changed record changes the key). A repeated request id returns the first answer without a second model call; failures are not replayed. All per server instance (best effort); the hard rate limit stays the shared database one (`assist` route added). |
| Admin | `info.mjs`, `/api/admin` action `ai_infrastructure`, console page "AI infrastructure" (health.view), switch "Orchestrated records assistant" (Founder only) | Configuration only: policy version and hash, switches, provider key set or not (never the key), routing, tools and levels, states, limits. |
| App | `public/index.html` `send()` / `assistReply()` | With the switch on and "Use my saved reports" ticked, records questions go to `/api/assist`; facts, AI explanation, doctor questions and sources are separate sections; general questions and everything else still use `/api/chat`. Switch off: the chat is unchanged. |
| Database | `supabase/migrations/20261123030000_ai_orchestrator_flag.sql` (+ rollback) | Adds the off-by-default `ai_orchestrator` switch, Founder-only. No health data touched. **Not applied anywhere yet.** Without it, the switch reads as off. |
| Evidence engine (extended) | `investigate.mjs` | Duplicate uploads (same test, date and value in two documents) are listed and noted, not treated as a change. |

## 3. First workflow: "compare my cholesterol levels over the last two years and explain what changed"

The server resolves "last two years" from today's date, retrieves only the person's lab values and document text in that
period, links each value to its page where page text exists, groups by test and unit, and builds the factual lines
(values, dates, differences, conflicts, gaps) itself. The model, if available and within budget, adds a short
explanation citing `E#`, a separate general-knowledge note and up to four questions for the doctor; all of it is
validated first.

| Failure case | Behaviour (tested in `tests/orchestrator.test.mjs`) |
|---|---|
| No reports | "Nothing recorded", explicitly not a normal result; no model call |
| Unreadable report | Listed under missing as having no readable text |
| Missing date | Shown apart, "not compared: the report has no date" |
| Inconsistent units | mg/dL and mmol/L kept as separate groups, never converted; routed to D |
| Duplicate upload | Flagged as possibly the same report uploaded twice; not a conflict or a change |
| Conflicting values | Both shown side by side; neither picked; routed to D |
| Another person's report | Refused before any record is read; `user_id`/`patient_id` in the body ignored; every read used the person's own token |
| Prompt injection | In the message: refused, nothing read. In a document: left out of the evidence, reported, never sent to the model |
| Provider unavailable | Facts given, `degraded: provider_unavailable`, one call only (no cheaper fallback) |
| Retrieval fails | One retry; then FAILED with "your records couldn't be read"; no model call, nothing invented |
| Invalid structured output | One retry with the reasons; if still invalid (invented number, diagnosis), not shown |
| The person cancels | ABORTED; during retrieval the model is never called |
| Document deleted mid-request | Detected in VERIFYING, retrieved again, nothing from it shown |

## 4. Test results (run 23 Nov 2026, this machine, fictional data)

| Suite | Result |
|---|---|
| `tests/orchestrator.test.mjs` | 38 / 38 passed (includes the 13 failure cases, confirmations, validation, routing, cache, idempotency, policy gate, a 40-request load check) |
| `npm test` (all server suites, config, release gates, adapters) | all passed (orchestrator 38, gateway 25, evidence 9, admin 24, functions 79, config 171 …) |
| `tests/run-db-tests.sh` (real PostgreSQL) | all suites passed, including the new switch checks |
| Switch migration rollback (throw-away PostgreSQL) | applies, rolls back, reapplies |
| Browser suites (`node tools/run-browser-tests.mjs`) | 725 / 725 passed, including the new `assist` suite (11) and the admin "AI infrastructure" page |
| Staging replay (`tools/staging-assist-replay.mjs`, rows read from staging as fictional account A with row security, rolled back) | refused without consent (the staging account has no `ai_chat` consent row); with consent, completes; found and fixed: a provider exception failed the request instead of degrading |
| `npm run eval:rag` | retrieval metrics unchanged; proof of concept 18 / 18 |

Load, measured on staging (23 Nov 2026, `staging-load.yml` run 45148818494, commit 52d635f, no AI provider configured, 30
requests at 1, 5 and 10 at a time, one throw-away synthetic account created and deleted): **30 / 30 answered
correctly**; end-to-end p50 about 4.5 s, p95 6.1–9.2 s; inside the orchestrator p50 about 2.0 s, p95 2.1–3.7 s.
The stored traces show why: each step with one database call takes about 400 ms (sign-in check 416, consents 375,
verification 379, retrieval 939 for two rounds), while Doctine's own logic takes under 10 ms. Both databases are in
Mumbai (ap-south-1); staging's Netlify functions run far from it. Production runs on Cloudflare near people in India,
so its round trips should be much shorter, but that is not measured yet. Change made: the consent lookup now runs
alongside the sign-in check (one round trip less). Further option: move staging's functions to an Indian region.
The earlier in-process figure (p95 about 70 ms) measured Doctine's logic only.

## 5. Not done, and why

- **Write actions** (reminders, sharing): designed in `docs/ASSISTANT_ACTIONS_DESIGN.md` (the assistant proposes, the person
  confirms, the app writes); the confirmation machinery is built and tested; no action is enabled.
- **Live model evaluation**: needs the `ANTHROPIC_API_KEY` repository secret (you add it) and a doctor to score answers
  (`docs/medical-review/gateway-review-pack.md`). The policy is marked draft until then.
- **Traces in a store**: done (migration `20261123050000_ai_traces`): one row per request with codes, timings, tokens and cost, no person or content, kept 30 days, shown on the admin "AI infrastructure" page. No external OpenTelemetry collector is configured.
- **Caregiver access, other providers, embeddings**: each is a privacy decision for you.

## 6. Turning it on (needs your approval at each step)

1. Review and apply `20261123030000_ai_orchestrator_flag.sql` to staging, then production (hash-checked, as before).
2. Deploy the app. Everything stays off: the new switch starts off.
3. On staging only, switch on `ai_assistant`, `ai_gateway`, `ai_orchestrator` and test with the fictional accounts.
4. Doctor review of answers. Only then consider production.

Rollback: switch `ai_orchestrator` off (instant); or deploy the previous commit; or run
`supabase/rollback/20261123030000_ai_orchestrator_flag_down.sql`.
