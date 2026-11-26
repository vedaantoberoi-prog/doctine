# Doctine — clinical safety and compliance

**This is an engineering map of obligations, not legal advice.** Every "legal decision" row below needs an Indian
healthcare and privacy lawyer. Sources were re-checked on 26 Nov 2026. Official sources are cited where one could be found;
where only secondary commentary was found, it is marked as such.

## 1. Clinical AI boundaries (enforced in product, not only in policy)

| AI may | AI must never | Where it's enforced today |
|---|---|---|
| Summarise a person's history; organise documents; extract values (marked "check this") | Act as the person's doctor, or counsel in place of a registered medical practitioner (RMP) | Assistant answers carry "not medical advice"; emergencies get fixed guidance instead of AI (`tests/functions.test.mjs`) |
| Give source-grounded educational information, with citations | Issue or change a prescription | No prescription feature exists; actions (`ai_actions`) are off and limited to the person's own reminders and records |
| Prepare a doctor-facing brief and point out missing information | Claim to be a doctor, or present an unverified diagnosis as confirmed | The 77-case evaluation (gate 6) has critical checks for a missed emergency, dose-change advice, child doses and a missing helpline. On **every** answer it also flags, as critical, any claim to be a doctor or to prescribe (added 26 Nov). Two cases test unverified diagnoses from a machine label or one lab value, and one tests a request for an antibiotic. |
| Support a registered doctor's evaluation | Make the final clinical decision | The doctor side is read-only; nothing an AI suggests is shown as the doctor's decision |

Production state: **all AI is off and there is no AI key.** Switching it on needs:
- an AI key in Cloudflare;
- a passing gate 6 (77 cases, zero critical failures);
- a doctor's signed review (`docs/medical-review/`);
- the owner's approval.

## 2. Compliance matrix

| # | Requirement | Official source | Applies from | Doctine component | Current implementation | Gap | Legal decision needed | Technical action |
|---|---|---|---|---|---|---|---|---|
| 1 | DPDP Act: notice, consent, purpose limitation, security safeguards, breach notification, erasure, grievance | DPDP Act 2023; DPDP Rules 2025, notified 13/14 Nov 2025 ([PIB](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)) | Phased (row 2) | Whole app | Consent records (append-only `consent_log`), export, account deletion, privacy policy | Formal notice in the Rules' format; grievance officer named; breach-notification procedure for the Board | Is Doctine a Significant Data Fiduciary? (health data at scale) | Notice text; grievance contact in the app; breach steps in INCIDENT_RESPONSE.md |
| 2 | DPDP Rules phasing: rules 1, 2, 17–21 from 13 Nov 2025; rule 4 (consent managers) from 13 Nov 2026; rules 3, 5–16, 22–23 (notice, security, breach, retention, children, rights) from **13 May 2027** | DPDP Rules 2025 (phasing as summarised by [SCC Online](https://www.scconline.com/blog/post/2025/11/14/meity-notified-digital-personal-data-protection-rules-2025/); confirm against the Gazette) | See left | All | — | Plan to be fully ready before 13 May 2027 | Confirm the dates against the Gazette text | Track in this matrix |
| 3 | Security safeguards and logs: reasonable safeguards; keep logs and personal data needed to investigate for at least one year (rule 6, Seventh Schedule, as summarised) | DPDP Rules 2025, rule 6 | 13 May 2027 | Server, database, hosting | Encryption in transit and at rest (Supabase); row-level security; admin audit log (append-only) | **Built 26 Nov, waiting for production approval:** every `/api` request leaves one line in `private.security_log` in the Mumbai database. The line holds route, status, IP, user-agent hash and the claimed account id, and is kept 370 days. **Still missing:** sign-ins themselves, which happen at Supabase Auth and not through Doctine's server, so they are covered only by Supabase's short log. | What exactly must be logged; whether Supabase's own sign-in logs must be kept too | Apply migration 20261128000000 (owner approval). For sign-ins: Supabase log drains (paid) or a sign-in hook |
| 4 | Cyber incident reporting to CERT-In within 6 hours; ICT logs kept 180 days, within India | CERT-In Directions, 28 Apr 2022, s.70B IT Act ([Khaitan summary](https://khaitanco.com/sites/default/files/2022-04/Ergo_30042022.pdf); official text on cert-in.org.in) | In force | Operations | 6-hour step in INCIDENT_RESPONSE.md | Same as row 3: API request logs will be kept 370 days in India once the migration is applied; sign-in logs are not | Does the direction apply to Doctine as a service provider? | Same as row 3 |
| 5 | Children: verifiable parental consent, with an exemption for healthcare | DPDP Rules 2025 (PIB summary) | 13 May 2027 | Sign-up, family profiles | No age gate; family profiles not built | Under-18 users are possible today | Whether the healthcare exemption covers a personal health record app | Age confirmation at sign-up; guardian-led family profiles |
| 6 | Telemedicine Practice Guidelines: only RMPs consult; identity of doctor and patient; consent; records; prescriptions rules (drug lists) | Telemedicine Practice Guidelines, 25 Mar 2020 (Board of Governors in supersession of MCI; Appendix 5 for technology platforms) ([MoHFW PDF](https://covid19dashboard.mohfw.gov.in/pdf/Telemedicine.pdf)) | In force | Doctor network (off), future consultations | Doctor verification against the NMR or a state council; no consultations, no prescriptions | Consultation flow, platform duties in Appendix 5, doctor identity shown to the patient | Read Appendix 5 against the planned consult flow | None until approved: consultations stay **designed only** |
| 7 | Professional conduct of doctors | Indian Medical Council (Professional Conduct) Regulations 2002 remain applicable; NMC's 2023 RMP Conduct Regulations were **held in abeyance** in Aug 2023 ([NMC](https://www.nmc.org.in/rules-regulations/national-medical-commission-registered-medical-practitioner-professional-conduct-regulations-2023-reg/), secondary: [Medical Dialogues](https://medicaldialogues.in/health-news/nmc/breaking-news-nmc-puts-its-controversial-registered-medical-practitioner-professional-conduct-regulations-2023-put-on-hold-116314)) | In force (2002) | Doctor profiles, any future fees | Doctors are not advertised to patients; no fees | Platform fees, referral rules, advertising limits | Fee model; what a doctor's profile may say | None until decided |
| 8 | Software as a medical device | CDSCO, Guidance on Medical Device Software under MDR 2017 (CDSCO/MD/GD/MDSW/01/2026) ([CDSCO](https://www.cdsco.gov.in/opencms/export/sites/CDSCO_WEB/Pdf-documents/Guidance-document-on-Medical-Device-Software-under-MDR-2017.pdf)) | Guidance in force | Records (likely outside it); AI assistant and scan reading (could fall inside it) | Storing, displaying and searching records is excluded from MDSW per the guidance. AI is off. | An AI that interprets a person's data for monitoring or management could be MDSW (Class A–C by condition severity) | Classification of the assistant's intended purpose before launch | Keep AI to education and organisation; write an intended-purpose statement; keep evaluation evidence (Indian population, bias) |
| 9 | ABDM: Health Data Management Policy; HIP and HIU duties if Doctine links to ABHA | NHA / ABDM HDM Policy ([ABDM](https://abdm.gov.in:8081/uploads/health_management_policy_bac9429a79.pdf)), HIP/HIU Guidelines ([ABDM](https://abdm.gov.in:8081/uploads/HIP_HIU_Guidelines_f85df336ec.pdf)) | Applies only on integration | Future ABHA linking | Not integrated | — | Whether to integrate (PHR app or HIU) | If yes: sandbox, consent artefacts, the HDM policy's security requirements |
| 10 | Guardian messaging: SMS templates registered on DLT (TRAI TCCCPR 2018) | TRAI regulations (official text not re-fetched in this session) | In force | Guardian alerts | No provider; the person sends from their own phone | Automated alerts | Provider contract | Live delivery adapter after contract |
| 11 | Payments to doctors and platform fees | Depends on the model (RBI payment aggregator rules, GST) | — | Not built | — | — | Whole model | None until decided |

## 3. What stays off until a decision is made

The following switches stay off until a lawyer has reviewed rows 6–8 and the owner has decided:
- `doctor_onboarding` and `record_sharing`;
- consultations, prescriptions and payments, which are not built;
- `ai_assistant`, `ai_orchestrator` and `ai_actions`, which also need the AI key and a doctor's sign-off.

None of these may be switched on "to test it" in production. Staging and fictional data exist for that.
