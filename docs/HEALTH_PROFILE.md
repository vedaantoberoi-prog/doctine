# Health profile and medical history (22 Nov 2026)

The **Health profile** screen (signed-in app only, `#health`) has six sections plus an optional women's health section:
personal information, body & lifestyle, medical history, medications, allergies & medical devices, family history.
The public website is not touched.

## Data

| What | Where | Notes |
|---|---|---|
| Personal details, measurements, lifestyle, explicit answers, women's health | `health_profiles` (new optional columns) | The account email (`auth.users`) is never changed; `contact_email` is separate. |
| Conditions, past illnesses, surgeries, hospital stays, other history, allergies, devices, family history | `health_records` (new) | One row per entry. `source` = user / clinician / document / import; `source_document_id` links to the person's own document. |
| Who changed which history record, how and when | `health_record_changes` (new) | Column names only, never content. Written by a trigger; owner can read; nobody can write directly. |
| Regular, occasional and stopped medicines | `medicines` (new optional columns) | Reuses the existing table and reminders. Stopped = existing status `completed`. |
| Weight history | `vital_readings` | A new weight saved in the profile adds a dated reading; earlier ones stay. |

Migration: `supabase/migrations/20261122000000_health_profile_history.sql` (additive only).
Rollback: `supabase/rollback/20261122000000_health_profile_history_down.sql` (removes the new data: back up first).
All new tables have forced row-level security with owner-only policies; anon has no access; account deletion removes
everything (tested in `tests/rls.test.sql`).

## Rules the app follows

- Nothing is inferred. Empty is never read as "no": each section has an explicit Yes / No / Not sure / Prefer not to say;
  allergies distinguish "No known allergies" from "Never been checked".
- Confirmed allergy, suspected allergy, intolerance and medicine side effect are separate. Severe allergies (not
  intolerances) are shown at the top of the profile.
- "Saved" appears only after the account confirms the write; otherwise the error is shown with "Try again".
- Duplicates are never merged: adding the same name again warns, and a second Save keeps both.
- Older free-text allergies and blood groups are kept and shown; converting them is the person's choice.
- An account on a database without the new table still loads; adding history then says it can't be saved yet.

## Doctine AI boundary

The assistant is still switched off for real users. When it is on, a chat uses the profile only if the person ticks
"Use my saved reports and profile" in that chat. The app then sends (`profileCtx` in `public/index.html`):
age, sex assigned at birth, allergies (kind, severity, reaction, source, date), current conditions and current medicines;
and only those past illnesses, surgeries, hospital stays, family entries and stopped medicines whose names match the
recent messages. Contact details are never sent; pregnancy only if allowed in the women's health section.
The server (`cleanContext` in `netlify/functions/chat.mjs`) keeps only known fields, cuts their length, and tells the
model: stopped medicines are history, ask to confirm old or undated entries, never fill in missing values, never
diagnose or infer risk from the profile or family history.

## Not done yet / limits

- Linking a manually entered condition to a later uploaded document is manual (choose "From a saved medical record").
  Automatic matching with a confirmation prompt is not built.
- Concurrent edits of the same record on two devices: the last save wins for that record.
- Tested on Chromium desktop and phone emulation; not on a real iPhone / Safari.
- DPDP Act 2023 and its Rules: this feature collects more sensitive health data, so the privacy notice and consent text
  should be reviewed by a qualified advisor before launch. No compliance claim is made here.
