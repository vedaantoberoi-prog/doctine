# Doctine medical evidence engine (23 Nov 2026)

Status: built and tested on fictional data. **Applied to staging and production on 23 Nov 2026** (hash-checked, with approval), and the app
that saves PDF page text is live (commit 45d42fb). Production's 2 existing documents have no values, AI reading or page
text, so they show as not searchable; new PDF uploads are indexed with their pages. The gateway stays switched off. The assistant stays switched off. Nothing here sends health data to any new provider.

## 1. Audit: what existed

| Area | Found in the code | Gap for evidence retrieval |
|---|---|---|
| Text PDFs | Read page by page in the browser (pdf.js 3.11.174), parsed into lab rows the person confirms | Page text was thrown away after parsing |
| Scanned PDFs and photos | Sent to Claude (`/api/scan`), which returns structured fields and one transcription (≤ ~3,000 characters, no page split); local OCR fallback for up to 5 pages | No page numbers for AI transcriptions |
| Storage | `documents` (confirmed `fields`, untouched AI `extraction`), `lab_results` rebuilt by trigger, originals in private storage | Lab values are text; no collection date apart from the document date |
| Search | Client-side filter over the person's own reports | No full-text index, no ranking |
| Embeddings and vectors | None; production extensions: plpgsql, pgcrypto, uuid-ossp, pg_stat_statements, vault (no pgvector) | — |
| AI access to records | Browser picks ≤ 10 matching values; server cleans them | Can't see across years of records |
| Ownership | Forced row-level security on every health table | Reused as the isolation boundary |

## 2. Architecture (what is built)

```
question → understand (query.mjs) → plan: intent, concepts → tests + terms, dates, budget
  → retrieve in parallel, AS THE PERSON (row security):
       structured: lab observations (labs.mjs)        lexical: contextual BM25 over the index, one query per concept
       metadata:   documents (type, date, provider)   semantic: not configured (no embedding provider chosen)
  → fuse with Reciprocal Rank Fusion (rank.mjs)
  → assemble evidence (investigate.mjs): values first (authoritative), linked to their page; passages next;
    duplicates dropped; conflicts kept side by side; instruction-like text left out; gaps listed
  → sufficiency verdict → evidence package (E1…En) + factual lines with citations + telemetry
  → the model writes the reply under ANSWER_RULES (tools.mjs)
```

Gateway capabilities added: `investigate_records`, `search_medical_records`, `retrieve_source_evidence` (16 in total).

## 3. Ingestion and index (migration `20261123010000_evidence_index.sql`, rollback beside it)

- `document_pages`: page text kept at upload (the app now saves the PDF text layer it already reads; AI transcriptions
  can be added the same way). Owner-only.
- `document_chunks`: built **only by database triggers** from the person's own records, rebuilt on every change and
  removed with the document (foreign keys): incremental indexing, versioning by replacement, deletion propagation and
  no stale entries, without a job queue. People cannot write pieces directly.
- Chunking is document-aware: one piece per lab row keeping name, value, unit, range and flag together; one per
  prescription line; diagnoses/complaints/advice/tests advised as sections; page text split on line breaks (~700
  characters). Pieces of one table or page share `parent_key` (parent-child), opened with `retrieve_source_evidence`.
- Contextual retrieval: each piece stores its original `content` unchanged and, separately, a `context` line built
  **only from the document's own details** (type, title, provider, date, page, section), so it can't add facts.
  Model-written context (Anthropic's Contextual Retrieval approach) is a later option: it would send document text to
  the model at indexing time and needs evaluating first.
- `search_document_chunks(terms)`: PostgreSQL full-text candidates for very large records (row security applies).
  BM25 scoring itself runs in the gateway over the person's own pieces.
- `document_index_status`: per document, searchable or not, pieces, page text present.

## 4. Decisions and why

| Topic | Decision | Reason |
|---|---|---|
| Vector search | Interface ready, **not configured** | No embedding provider is set up; choosing one means sending health text to another processor, which is a privacy decision for you. Anthropic has no embedding model of its own; its documentation points to Voyage AI. Add pgvector and a versioned `embedding_model` column only after a measured gain on this evaluation. |
| BM25 | In the gateway over the person's own pieces; PostgreSQL full-text search as a candidate filter | A person's record is small (hundreds to a few thousand pieces); exact BM25 is cheap and needs no new infrastructure. |
| Reranking | Not added | No cross-encoder is available here, and the fused ranking already reaches Recall@10 = 1.00 on the evaluation; reranking needs a measured gain to justify cost and latency. |
| GraphRAG | Not built | Exact values come from structured queries; relationships needed now (value ↔ page, medicine ↔ condition) are links, not a graph. Revisit for whole-history summaries over very large records. |
| Standards | Internal model; FHIR/LOINC/UCUM mappings at export | No interoperability need yet; units are compared by spelling only and never converted. |
| Query expansion | Reviewable concept table (`CONCEPTS` in query.mjs), not model-generated | Deterministic, testable, never treated as clinical equivalence; a clinician should review it. |

## 5. Evaluation (`npm run eval:rag`, results in `docs/EVIDENCE_EVAL.md`)

Fictional corpus (16 documents over 2023–2026 for person A, 1 for person B), indexed by the real SQL; 12 questions with
graded relevance. Document-level results:

| Set-up | Recall@10 | nDCG@10 | MRR |
|---|---|---|---|
| A naive keyword | 0.74 | 0.75 | 0.83 |
| B BM25 | 0.73 | 0.77 | 0.92 |
| C contextual BM25 | 0.73 | 0.77 | 0.92 |
| D + query understanding, multi-query RRF | 1.00 | 0.92 | 0.96 |
| F + structured channel | 1.00 | 0.95 | 0.96 |
| E full pipeline | 0.99 | 0.90 | 0.89 |

The gain comes from query understanding (everyday words like "kidneys" and "sugar", the paraphrase "low density
lipoprotein", "dyslipidaemia"). Contextual lines add nothing measurable on this small corpus because titles already
carry the context; they matter more for page text from long reports. Proof of concept ("Compare my historical cholesterol
results…"): 18 of 18 checks pass (units kept apart, values linked to pages, undated report apart, other person's data
absent, injected instructions left out, gaps and sufficiency stated, telemetry recorded).

Not yet measured: vector set-ups, reranking, answer quality (faithfulness, citation precision) with a real model, and
clinician review. The live harness (`tools/bench-live.mjs`) and review pack are ready.

## 6. Security and privacy

- Isolation: every read uses the person's own token; the database filters rows before anything reaches the gateway or
  the model. Tested in SQL (`tests/evidence.test.sql`), in the gateway tests and in the evaluation.
- Index pieces can only be built by the database from the person's own records: nobody can plant text in another
  person's index, and nobody can add page text to someone else's document (tested).
- Prompt injection: document text is data. Instruction-like passages are excluded from evidence and reported; the model
  can only run fixed, read-only capabilities.
- Deletion: deleting a document, its pages or the account removes every index piece (tested).
- DPDP Act 2023: page text is more health data kept in the same project and region as the rest; consent text and any
  future embedding provider need the privacy review. No compliance claim is made.

## 7. Deploy and roll back

1. Review the migration. 2. Apply to staging, run `tests/evidence.test.sql` there and a staging replay. 3. Apply to
production with approval; existing documents are indexed by the migration itself. 4. Deploy the app (saves page text).
Rollback: `supabase/rollback/20261123010000_evidence_index_down.sql` (removes the index and kept page text; documents,
AI readings and results are untouched). The app keeps working without the table (tested).

## Staging verification (23 Nov 2026)

On the staging database, as the fictional accounts with row security on: all 11 of person A's existing documents were
indexed by the migration (39 pieces: 38 lab rows, 1 prescription line) and all show as searchable; person A sees 0
pieces of anyone else and person B sees none of A's; the phrase search for "ldl cholesterol" finds 7 pieces.
In a rolled-back probe: new page text was indexed with its page, a corrected value replaced the old piece, person B
could not add page text to A's document, and deleting the document left 0 pieces.

## 8. Per deliverable

| Deliverable | Reused | New | Tests |
|---|---|---|---|
| Ingestion, chunking, index | pdf.js page reading, AI extraction, row security | `document_pages`, `document_chunks`, triggers, app saves page text | `tests/evidence.test.sql` (all pass), browser persistence (55/55) |
| BM25, hybrid, fusion, query understanding | — | `netlify/lib/evidence/rank.mjs`, `query.mjs` | `tests/evidence-lib.test.mjs` (9/9) |
| Structured + temporal retrieval | `labs.mjs` comparison rules | date ranges, disagreement detection | evaluation, gateway tests |
| Evidence assembly, sufficiency, answer rules | gateway | `investigate.mjs`, `ANSWER_RULES` | evaluation proof of concept (18/18) |
| Agent integration | Agent Execution Gateway | 3 capabilities | gateway tests (25/25), live harness (mock) |
| Dependencies introduced | none | — | — |

## 9. Used by the orchestrator

The Intelligence Orchestrator (`/api/assist`, docs/AI_OPERATING_SYSTEM.md) reaches this engine only through the gateway capability `investigate_records`, as the signed-in person. Added for it: duplicate uploads (same test, date and value in two documents) are listed in `duplicates` and noted in the factual lines.
