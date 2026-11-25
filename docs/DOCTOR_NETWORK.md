# Doctine doctor network and clinical intelligence

Status: **phase 1 built (doctor identity, credentials, verification)**, behind the `doctor_onboarding` switch, which is off.
Nothing is shown to patients. There are no consultations, prescriptions or payments. Last updated 26 Nov 2026.

## 1. Where this starts from (inspected 25–26 Nov 2026)

- **App**: one web app (`public/index.html`) packaged for Android (Capacitor) and Mac (Tauri). The admin console lives at
  `/admin`. Server functions are in `netlify/functions`, and the same code runs on Cloudflare Pages
  (`functions/api/[[path]].js`).
- **Accounts and data**: one Supabase project per environment. Health data lives in `public.*` tables with forced
  row-level security (owner only). Staff and server data lives in `private.*`, reached only through security-definer
  functions the server calls with the service key.
- **Patient record today**: the health profile (seven sections, with a history table whose `source` already
  distinguishes user, clinician, document and import), documents with extracted fields, prescriptions as read from
  documents (the `doctor` field is free text), medicines and schedules, dose events, lab results, vitals and the
  evidence index. None of it is linked to a verified practitioner.
- **AI**: the assistant (off), the read-only gateway, the orchestrated assistant with source-linked facts, and versioned
  AI policies with traces. All of it is off for real users until a doctor has reviewed it.
- **Guardian**: deterministic safety foundation (on in production since 25 Nov; no messaging provider). It is untouched
  here. Its future link to the medical record is the emergency summary (section 7).
- **Doctor features before this change**: none. No practitioner identity, encounter, appointment or doctor role existed.

So the first coherent slice is **phase 1, practitioner identity and verification**. Everything later (workspace,
consultations, the pre-consultation brief, prescriptions) needs a verified practitioner to attach to.

## 2. Phase 1: what exists now

| Part | Where |
|---|---|
| Rules: statuses, transitions, profile cleaning, evidence check, file-type sniffing, council and specialty lists | `netlify/lib/doctors/verification.mjs` |
| The doctor's API: status, save, upload, remove, submit | `netlify/functions/doctor.mjs` (`/api/doctor`) |
| The doctor's page | `public/doctor/` (`app.doctine.com/doctor/`) |
| The verification queue | Admin console → Doctor network → Doctor verification (`public/admin/admin.js`, `netlify/functions/admin.mjs`) |
| Database, bucket, permissions, switch | `supabase/migrations/20261126000000_doctor_onboarding.sql` (rollback in `supabase/rollback/`) |
| Tests | `tests/doctor.test.mjs` (17), `tests/doctor.test.sql` (on real PostgreSQL), `tests/browser/doctor.test.mjs` (19), admin server and browser tests |

### Verification state machine

```
NOT_STARTED ──submit──▶ DOCUMENTS_SUBMITTED ──start review──▶ UNDER_REVIEW ──verify (evidence)──▶ VERIFIED
     ▲                        │  ▲                                 │   │                            │  │
     │                        │  └──────── return to queue ────────┘   │                  suspend  │  │ 12 months
     │                        └──────── reject ──────▶ REJECTED ◀── reject                    ▼    ▼
     │                                                     │                              SUSPENDED  EXPIRED_REQUIRES_REVERIFICATION
     └──────────── doctor corrects and resubmits ──────────┴──────── (from REJECTED or EXPIRED) ◀──────────┘
```

The list is enforced twice: by the code and by `private.practitioner_allowed_transition`. A test checks that the two
lists are identical. Doctors can only submit. Only staff with `doctors.verify` change a status. A reviewer can never
change the status of their own application. Expiry runs automatically, on the next read, 12 months after verification.

### What "Verified" means, and what it doesn't

A reviewer has checked, on the **official register**, that the name, registration number and council match, and that
the registration is active. They have also matched the photo ID. They record which register (the NMC's National
Medical Register, or the State Medical Council register), the date (within the last 30 days), an optional register
reference and notes. The database refuses a verification without all of that. This follows the Telemedicine Practice
Guidelines' requirement that platforms do due diligence on a registered medical practitioner (RMP) before listing them
(§5.2).

It is **not** a rating, does not list the doctor anywhere, and does not permit consultations (nothing in Doctine offers
one yet). Specialties, languages, experience and the bio are self-reported and labelled as such in the admin console.

### Reviewer checklist (draft SOP; to be reviewed by counsel)

1. Open the application. Use the credential files, never a copy sent by email.
2. Search the register. For an NMC-listed doctor, use the National Medical Register. Otherwise use the State Medical
   Council's online register named on the application.
3. Confirm the name, registration number, council and **active** status. If anything differs, reject with a clear
   reason the doctor can act on.
4. Compare the photo ID with the name (and photo, where the register shows one).
5. Verify, recording the register, date, reference and notes. Never verify from memory or a phone call alone.
6. Suspend on a credible complaint, a register change or an expired registration. Reinstate only after checking again.

### Privacy and security in phase 1

- Credential files are in the private bucket `practitioner-credentials`, with no browser policies. Only the server
  writes them. Staff open them through a 60-second signed link, and every opening is written to the audit log
  (`doctor.document_open`). File types are read from the bytes (PDF, JPEG, PNG; at most 5 MB). Each file's SHA-256 is
  stored.
- A file the doctor removes is hidden from them but kept, because it is evidence. The history is append-only (a
  trigger refuses edits and deletes). Deleting the doctor's account deletes the application, its files' records and
  its history. Deleting a reviewer's account keeps the history and blanks the reviewer's id.
- Admin access needs two-step sign-in (as for the rest of the console). The `doctors.view` and `doctors.verify`
  permissions are not in any default set. The switch is Founder-only.
- The doctor page asks people to mask their Aadhaar number. Aadhaar is never required.
- **Open item**: files stay in storage when an account is deleted. The account-deletion flow should remove the
  `practitioner-credentials/<user id>/` folder. Agree the retention period with counsel first.

## 3. The full plan (phases), mapped to this codebase

| Phase | What | Builds on | Blocked by |
|---|---|---|---|
| 1 ✅ | Doctor identity, credentials, verification | this change | — |
| 2 | Doctor workspace: dashboard, patient list *only for patients who shared with them*, read-only record viewer | `/doctor`, the evidence index, documents | A sharing consent (section 5) and phase 3's encounter |
| 3 | Consultation workflow: appointment → encounter (FHIR Encounter), modes, status, notes, follow-up | phase 1 | Legal sign-off on the platform's role; consent capture (TPG §3.4); audio/video provider; payment model |
| 4 | Pre-consultation brief: source-linked, time-aware summary the patient reviews, then the doctor reviews | orchestrator (facts with sources), health-profile history, lab trends | Doctor review of the AI; the AI key; phase 3 |
| 5 | Structured prescription: a doctor-authored, immutable e-prescription with the registration number (TPG §3.2.5, §3.7.4 lists O/A/B; Schedule X and NDPS never) | phase 3 | Counsel; NMC advisory on digital signatures (Oct 2026) |
| 6 | Outcome capture: follow-up, patient-reported and clinician-assessed outcomes, revised assessments (never deleted, superseded) | phases 3 and 5, health-profile history pattern | — |
| 7 | Clinical intelligence infrastructure: dataset registry, eligibility and consent checks, de-identification, labelling, versioned datasets, an evaluation harness with no leakage from the future | AI traces, evidence eval | DPDP research exemption (Rule 16) and ethics review |
| 8 | Doctine-specific models for narrow tasks (extraction, normalisation, missing-information detection) | phase 7 | Data, evaluation, clinical validation |

### The source of truth: a time-aware, source-linked record

The longitudinal record (symptom → consultation → assessment → prescription → investigation → follow-up → outcome) is
modelled as **rows with provenance and validity periods**, never as model memory. Every clinical statement carries:

- source (patient-reported, doctor-entered, AI-extracted, imported, clinician-verified, research-adjudicated);
- author and time;
- the time it was true for (for example, a medicine's start and end);
- a status (provisional, confirmed, revised, superseded or entered-in-error);
- a link to the document or encounter it came from.

An AI summary is a separate artefact. It never overwrites the record. Corrections create a new row and supersede the
old one (`health_record_changes` already works this way).

### FHIR R4 mapping (for future exchange; implementing FHIR does not mean ABDM integration)

| Doctine | FHIR R4 |
|---|---|
| `private.practitioners`, credential files, verification events | Practitioner (+ qualification), PractitionerRole, DocumentReference, Provenance |
| health profile, history entries | Patient, Condition, AllergyIntolerance, FamilyMemberHistory, Procedure |
| medicines / schedules / doses | MedicationStatement, MedicationRequest (once a doctor prescribes), MedicationAdministration |
| lab results, vitals | Observation, DiagnosticReport |
| documents | DocumentReference |
| consultations (phase 3) | Appointment, Encounter, CarePlan, ServiceRequest |
| consents (section 5) | Consent |

ABDM participation (HIP/HIU registration, consent manager flows, ABHA) has to be registered and certified separately.
Doctine does not claim any ABDM connection.

## 4. Compliance checklist (needs qualified Indian healthcare counsel; nothing here is legal advice)

| # | Item | Applies to | Status |
|---|---|---|---|
| 1 | Telemedicine Practice Guidelines 2020 (Board of Governors in supersession of MCI, now NMC): platform due diligence before listing an RMP; display name, qualification, registration number and contact (§5.1–5.2); grievance mechanism (§5.6) | phases 1–3 | Phase 1 implements the check and its record. Display waits for phase 3 |
| 2 | §5.4: AI/ML platforms may not counsel patients or prescribe; only the RMP does, directly | phases 4–5 | Design constraint. The AI drafts for the doctor, never for the patient |
| 3 | Consent: implied when the patient starts the consultation; explicit (recorded) when a doctor or caregiver starts it (§3.4) | phase 3 | To build |
| 4 | Prescribing limits by mode and first versus follow-up consult (§3.6, §4.1; lists O, A and B; Schedule X and NDPS prohibited) | phase 5 | To build as hard rules, plus counsel review |
| 5 | Record keeping by the RMP: interaction logs, data used, prescriptions (§3.7.2) | phases 3–5 | To build. Retention periods from counsel |
| 6 | NMC registration rules in flux: the National Medical Register is integrating state registers (unified portal targeted Oct–Dec 2026); a draft UID for every RMP (Aug 2026); licences proposed to be valid for 5 years | phase 1 | The SOP allows NMR or state register. Re-check before launch |
| 7 | DPDP Act 2023 and DPDP Rules 2025: most obligations apply from about May 2027 (18 months after 14 Nov 2025). Security safeguards, breach notice, deletion with 48 hours' notice, logs kept for at least a year, research exemption with conditions | all | Plan the consent scopes (section 5) and retention now |
| 8 | ABDM Health Data Management Policy and HIP/HIU guidelines: consent artefacts, purpose-bound access | phases 2–3, exchange | Only if Doctine registers with ABDM |
| 9 | Doctor agreement: independence, clinical responsibility, documentation, prescriptions, confidentiality, data access, retention, grievances, refunds, misconduct, suspension, payments | phase 3 | Fields listed. **Drafting by counsel** |
| 10 | Fees: doctor-set fee shown before booking; any platform fee, commission or split must be cleared (NMC professional conduct rules on fee-splitting) | phase 3 | No percentage assumed. Settlement design waits for counsel |
| 11 | Consumer protection, refunds, payment-aggregator (RBI) rules and app-store health-app policies | phase 3 | To review |
| 12 | Doctors' identity documents: privacy notice, retention, access log | phase 1 | Access log built. **Privacy notice needed before the switch goes on** |

## 5. Patient control: separate permission scopes (to build with phase 2/3)

1. Storing the personal health record (exists: the account).
2. Sharing selected records with a named doctor, for a named encounter, until a set date (revocable).
3. Sharing with a healthcare provider.
4. Research use of eligible data.
5. Model development.
6. Product analytics (exists: "Help improve Doctine", off by default).

These are never bundled. Each share writes an access log the patient can see. A doctor sees only what was shared for
their encounter.

## 6. Measuring clinical AI honestly (phase 7 design notes)

- **Retrospective**: rebuild exactly what was known at consultation time. The evaluation harness must refuse any input
  dated after the encounter, so the future can't leak in. Tasks: summary accuracy, relevant-history recall, medication
  extraction, missing-information detection.
- **Silent prospective**: run in the workflow with output hidden from the doctor, only where approved.
- **Doctor-assistance**: time saved, completeness of history, reconciliation accuracy, follow-up completion.
- **Clinical impact**: safety, false positives and false negatives, unnecessary investigations, delayed care,
  performance across groups, drift.
- A prescription is a label for "what was prescribed", never for "what was right". Outcomes come from follow-up and
  clinician-assessed results, with the source recorded.

## 7. Guardian link (later)

An emergency summary (allergies, current medicines, conditions, emergency contacts), shared with consent during an
open Guardian incident. It is read-only, time-limited and audited. No change to Guardian in this phase.

## 8. Research basis (re-checked 25–26 Nov 2026)

- Telemedicine Practice Guidelines, 25 Mar 2020 (MoHFW and Board of Governors): §3.2, §3.4, §3.6, §3.7, §4.1, §5.1–5.7,
  Annexures 1 and 2. https://covid19dashboard.mohfw.gov.in/pdf/Telemedicine.pdf
- NMC National Medical Register status: unified portal targeted for 15 Oct 2026, full commissioning by 31 Dec 2026;
  public search once live, completeness depends on state registers. (ThePrint, 2 Oct 2026)
  https://theprint.in/health/pan-india-portal-for-doctors-registration-likely-to-be-ready-by-next-yr-1-66l-registered-on-nmr-so-far/3059927/
- NMC draft UID for RMPs, 11 Aug 2026 (draft; licence validity 5 years). (Business Standard, 20 Aug 2026)
  https://www.business-standard.com/india-news/nmc-proposes-unique-id-number-for-doctors-to-practise-anywhere-in-india-126082000334_1.html
- ABDM HIP/HIU guidelines (consent-based access). https://abdm.gov.in:8081/uploads/HIP_HIU_Guidelines_f85df336ec.pdf
- WHO, Ethics and governance of AI for health: guidance on large multi-modal models (Jan 2024).
  https://www.who.int/publications/i/item/9789240084759
- FDA, proposed regulatory framework for AI/ML-based software as a medical device (lifecycle, validation,
  monitoring). https://www.fda.gov/media/122535/download
- DPDP Rules 2025 (phased commencement). https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/
- NMC advisory on remote authentication of medical records with digital signatures (Oct 2026), relevant to phase 5.

## 9. Turning phase 1 on

1. Apply `20261126000000_doctor_onboarding` (staging first; production only with explicit approval).
2. Publish a privacy notice for doctors' documents (reviewed by counsel) and link it from `/doctor`.
3. Grant `doctors.view` / `doctors.verify` to the reviewer(s) (Admin → Leadership) and walk them through the checklist.
4. The Founder switches **Doctor sign-up and verification** on (Admin → Feature switches).
