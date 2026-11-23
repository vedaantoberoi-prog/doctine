# Assistant actions: design (23 Nov 2026)

Status (23 Nov 2026, evening): **the first action (a reminder time for a medicine already listed) is built and tested, behind the `ai_actions` switch, which is off.** It also needs `ORCHESTRATOR_SECRET` on the server (not set anywhere yet) and a doctor's review of the wording. Originally: design only. It answers one question: how can the records assistant do things
(set a reminder, add a medicine from a prescription, share a report with a doctor) without breaking the app's own
syncing of people's records, and without the AI ever acting on its own. The confirmation machinery it relies on is
built and tested (`netlify/lib/orchestrator/tools.mjs`); no action tool is registered.

## 1. The constraint: the app is the only writer of a person's records

How syncing works today (`public/index.html`, `cloudSync()`):

- The app keeps the person's records in memory, compares them with what it last synced (`CLOUD.snap`), and upserts each
  changed row in full: profile, consents, medicines, doses, readings, documents.
- It does not watch the database for changes made elsewhere; it only loads on sign-in.

So if the server wrote a row directly:

| Server writes… | What goes wrong |
|---|---|
| a change to an existing row (e.g. a medicine's reminder times) | the next sync of that row from the app overwrites it with the old values, silently |
| a new row (e.g. a new medicine) | the app doesn't show it until the next sign-in; on a second device the two copies drift |
| a delete | the app re-creates the row on its next sync |

Making the server a second writer would need row versions, conflict rules and live updates in the app: a large change
to the part of Doctine that holds people's records. Not worth it for the first actions.

## 2. Decision: the assistant proposes, the person confirms, the app writes

```
person asks ──► /api/assist classifies it as an action
                 │  (level 2 "request": never executed by the server)
                 ▼
         PLANNING → AWAITING_CONFIRMATION
         returns a proposal: { action, arguments, plain summary, confirmation token (5 min, single use,
                               bound to this person + action + exact arguments) }
                 │
   app shows a confirmation card with the exact change ("Add a reminder: Atorvastatin 10 mg, 9:00 pm daily")
   and Confirm / Edit / Cancel. Nothing happens without Confirm.
                 │ Confirm
                 ▼
   app calls /api/assist { confirm: token }  → server re-checks token, consent, arguments, freshness
                 │ approved
                 ▼
   the APP applies the change to its own state through the same code path as the person doing it by hand,
   then syncs as usual (one writer, no conflict)
                 │
   VERIFYING: app reports the synced row id; server checks the row now exists as proposed (read, as the person)
```

Why this shape:

- **One writer.** The record change goes through the code that already handles saving, validation, offline queueing,
  sync and undo. No new write path into health tables.
- **Meaningful, fresh confirmation.** The card shows the exact change in plain words; the token expires in 5 minutes,
  works once, and is useless for any other person, action or argument (tested).
- **The server still decides.** The model can only propose an action from a fixed list with a schema; the server
  checks the token, consent and arguments before approving; the app refuses anything it can't show on a card.
- **Verified after.** The final step reads the row back as the person and records the outcome in the trace.

## 3. Which actions, at which level

| Action | Level | Who executes | Notes |
|---|---|---|---|
| Draft questions for the doctor | 1 draft | nobody: shown only | already part of answers |
| Add a reminder for a medicine already listed | 2 request → app | app | first candidate; reversible |
| Add a medicine from a prescription the person uploaded | 2 request → app | app | card shows the line it came from; marked "added from a prescription" |
| Mark a dose taken / skipped | 2 request → app | app | reversible |
| Create a share link for one report | 3 execute after confirmation | server | doesn't touch synced tables; needs its own privacy review (expiry, revocation, access log) |
| Send anything outside Doctine (email, WhatsApp) | not planned | — | — |
| Change a dose, stop or start a medicine | never | — | the assistant never advises or performs medicine changes |
| Delete records, change consent or account settings | 4 human only | the person, in Settings | the assistant may point to the setting, nothing more |

## 4. What it needs (estimate: 2–3 days of work, plus review)

1. Orchestrator: classify "remind me…" as an action proposal instead of refusing; an `ACTION_TOOLS` registry (schema,
   level, plain-language summary, `verify`), each one switched on separately.
2. `/api/assist`: a `confirm` request that checks the token and returns `approved` with the exact arguments; a
   `verified` request that records the outcome. `ORCHESTRATOR_SECRET` must be set on the server (not yet set anywhere).
3. App: a confirmation card; on Confirm, apply through the existing add-reminder / add-medicine functions; report back.
4. Tests: proposal never changes data; expired, replayed, other-person and altered tokens refused; the app applies
   exactly the confirmed arguments; sync still has one writer; offline confirm is queued like a manual change.
5. A new switch `ai_actions` (off), and a doctor's review of the card wording for medicine-related actions.

## 5. Not decided yet (needs you)

- Whether share links are wanted at all, and for how long they should work.
- Whether any action should be available before the doctor review of answers (suggested: no).

## 6. What was built (23 Nov 2026)

- Server (`netlify/lib/orchestrator/actions.mjs`, `orchestrate.mjs`): "remind me … at 9 pm" is classified as an
  `add_reminder` proposal; the server reads the person's medicines and schedules (as the person), matches the medicine,
  checks the time (not already set, not "when needed", at most 12), and returns a proposal with a signed, single-use,
  5-minute confirmation (state AWAITING_CONFIRMATION). Unclear requests get a question back. Nothing is written.
- Confirm (`{confirm: …}`): token, person, medicine and time re-checked; returns `approved` with the exact change.
- App: a card with **Review and save** / **Not now**; on approval the app opens its own medicine editor with the time
  added (once a day becomes twice a day, and so on) and the person presses Save; after the next successful sync the app
  asks the server to verify (`{verify: …}`), which reads the schedule back as the person.
- Policy 2026-11-23.2 records this; the switch `ai_actions` is in migration `20261123070000_ai_pilot_budget`.
- Tests: 6 server tests (switch off, no secret, proposal, unclear requests, confirm with forged / altered / other-person
  tokens, verify) and 6 browser checks (card, confirmation sent, editor opened with the time, nothing saved before Save,
  verification after the save, "Not now").
