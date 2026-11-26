# Doctine — AI architecture and learning roadmap

26 Nov 2026. **Doctine does not have its own trained medical model.** No model weights are trained or fine-tuned on any
data. All AI in production is switched off, and there is no AI key. This document says what exists, what each piece is
technically, and the staged path to Doctine's own medical intelligence. The detailed designs live in
`AI_OPERATING_SYSTEM.md` (orchestrator), `EVIDENCE_ENGINE.md` (patient-record retrieval), `AGENT_GATEWAY.md` (tools)
and `netlify/lib/knowledge.mjs` (medical knowledge interface).

## 1. The ten techniques, and which ones Doctine uses

| Technique | Used? | Where |
|---|---|---|
| Prompt / system instructions | Yes | `netlify/lib/orchestrator/policy.mjs`: versioned with a content hash; a changed hash without a new version fails CI |
| In-context learning (examples in the prompt) | Minimal | Answer rules only. There are no patient examples in prompts. |
| Patient-specific structured memory | Yes, as **records**, not a transcript | Health profile, `health_records` with history, lab values, medicines, documents and pages |
| RAG over the patient's own records | Yes (built, off) | Evidence engine: lexical BM25 plus structured lab retrieval, run as the person under row-level security |
| RAG over medical knowledge | **Interface only** | `knowledge.mjs`: provider `none` by default. Doctine has no medical knowledge index. |
| Tool use and orchestration | Yes (built, off) | Orchestrator state machine; 16 read-only tools, levels 0–4; no write tool is enabled |
| Fine-tuning | No | — |
| Continued pretraining | No | — |
| Reinforcement / preference optimisation | No | — |
| Online / continual learning | **No, by design** | Nothing changes model behaviour in production without a versioned release |
| Training a foundation model from scratch | No | Not planned before stage D |

## 2. Patient-specific context

**Already in place**
- Every retrieval runs as the person, so another patient's rows can't enter the context. This was proven live on 26 Nov: see the security review.
- Values carry their source document, page and date.
- Conflicts stay side by side, and gaps are listed.
- Duplicates across uploads are noted.
- A cited document that has since been deleted is retrieved again before answering.
- The model sees only evidence ids, values, units, ranges, dates and types. It never sees titles, account ids or contact details.
- Retrieval needs consent (`ai_chat`, plus "Use my saved reports" for that chat).
- Deletion flows through: index rows are removed with the document by foreign key.

**Gaps**
- "Confirmed by a clinician" and "patient-entered" are not separate states for every fact; only lab values carry verification.
- There are no refresh or expiry rules, for example "a weight older than 12 months is stale".
- Shared doctor records are not part of any AI context yet. That is correct while sharing is off, and when it comes on it needs its own consent.

## 3. Medical knowledge RAG

There is no curated source library yet. Before connecting one, each source needs:
- publisher and title;
- publication or revision date and version;
- scope and evidence grade where available;
- the date it was ingested;
- a superseded flag.

The contract in `knowledge.mjs` already limits citations to passages actually retrieved (ids `K1…`), to https links on
an allow-list of publishers. Snippets from search results are never treated as evidence. Licensing must be settled before
ingestion (WHO, ICMR and MoHFW material, NHS or NIH terms).

## 4. Context assembly and evaluation

Built:
- deterministic classification (no model decides the category);
- date-range parsing;
- concept-to-test mapping;
- reciprocal rank fusion;
- a sufficiency verdict;
- a 27-second deadline;
- per-person token budgets.

`npm run eval:rag` (`docs/EVIDENCE_EVAL.md`) measures retrieval on fictional records. The answer grader (77 cases)
grades safety. Retrieval and answers are evaluated separately, as required.

Metrics not yet measured:
- citation accuracy against the source page;
- stale-fact rate;
- wrong-patient inclusion, measured as a metric. It is prevented by construction but not yet counted.

## 5. Learning without silent training

| Level | What may improve | How it's released |
|---|---|---|
| Patient level | That person's profile, corrections and approved preferences | It's their data, and they can edit or delete it. No model weights change. |
| Product level | Retrieval, context assembly, tool choice, prompts | Offline evaluation, then a versioned policy release. CI blocks an unversioned policy change. |
| Model level | Fine-tuning, preference optimisation, own models | **Not started.** Needs the governance in §6 first |

**Rule:** no patient record, doctor note, prescription or outcome is used to train or tune anything merely because it is
stored. AI traces keep only names, timings and counts, never health values (`private.ai_traces`).

## 6. Before any learning from doctors or outcomes

A doctor's decision or an outcome is not a clean label. It can carry confounding, selection bias, missing data,
non-adherence, wrong diagnoses and site-specific practice. A future clinical data pipeline needs all of these, in order:

1. A lawful basis and purpose-specific consent.
2. Data minimisation.
3. Review of the de-identification.
4. Quality checks.
5. Annotation standards.
6. Clinician adjudication.
7. Versioned datasets.
8. Train/test splits by patient and by time, so no patient's records appear on both sides and no future data predicts the past.
9. Independent validation.
10. Subgroup and bias analysis.
11. Silent prospective evaluation.
12. Controlled clinical deployment.
13. Monitoring after deployment.
14. Model rollback and incident response.

Models never modify themselves in production.

## 7. Staged roadmap

| Stage | Contents | State | Next concrete step |
|---|---|---|---|
| **A: current product intelligence** | Secure provider integration, patient context, grounded retrieval, document extraction, structured summaries, safe Q&A | Built and tested on fictional data; **off**, no key | Add an AI key (owner), pass gate 6 on staging, doctor sign-off. (Evaluation cases for doctor claims and unverified diagnoses were added on 26 Nov.) |
| **B: clinical data infrastructure** | Longitudinal structured records, standard terminology (LOINC for labs, SNOMED CT / ICD for conditions), FHIR-shaped export, provenance, doctor-reviewed annotations, outcome tracking, consent governance | Records and provenance exist; no terminology mapping; doctor network built but off | Map lab tests to LOINC codes in `lab_results`; decide on ABDM integration |
| **C: evaluation and narrow models** | Curated datasets, extraction and summary models, retrieval reranking, task-specific fine-tuning, clinical benchmarks | Not started | Only after B, with the §6 pipeline and consented data |
| **D: proprietary medical intelligence** | Own architecture, domain training, external clinical validation, model governance | Not started | Do not spend here before A–C prove out |
