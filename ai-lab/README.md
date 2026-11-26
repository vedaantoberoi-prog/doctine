# Doctine Model Lab

This is where Doctine builds and measures its own models. It is kept apart from the app on purpose:
- Nothing in here is bundled into the app.
- Nothing here runs in production.
- Nothing here needs a GPU, a network connection or an AI key to test.

The CI "Backend tests" job runs `python3 -m unittest discover -s ai-lab/tests` and `node tests/ai-registry.test.mjs`.

**Status (26 Nov 2026).**
- Doctine has **no trained model weights**.
- The evaluation system and the first benchmark are built, and the app's current reader has been measured (below).
- No model has been trained, and nothing here has been clinically validated.

## What is owned, by whom

| Layer | Owner | Where |
|---|---|---|
| Prompts, read schema, routing, validation, consent and permission checks | Doctine (application logic) | `netlify/functions/scan.mjs`, `netlify/lib/orchestrator/` |
| Lab-report reader in the app | Doctine (rule-based code, no weights) | `public/index.html` `parseText` = model `b0-app-parser` |
| Benchmark `extraction-v1` | Doctine (synthetic, generated here) | `datasets/extraction-v1/` |
| Hosted models (Claude Sonnet, Haiku, Opus) | Anthropic; switched off, no key | `registry/models.json` |
| `doctine-labx-v0` | Would be Doctine-trained adapter weights on a third-party open-weight base | proposed, not built |

## Layout

```
ai-lab/
  registry/datasets.json   every dataset allowed in the lab, with SHA-256, origin, licence, consent basis, split rule
  registry/models.json     every model Doctine runs or evaluates: owner, location, tasks, status, evaluation, limits
  synth/generate.py        seeded generator of fictional Indian lab reports and prescriptions with exact gold labels
  synth/ocr.py             renders each document as a photo-like image and reads it back with Tesseract (real OCR errors)
  datasets/extraction-v1/  train / val / test (JSONL) and ocr/ texts; never patient data
  baselines/app_parser.mjs runs the app's own parseText, loaded from public/index.html at run time (never copied)
  eval/metrics.py          field-level metrics; no single "score"
  eval/run_baseline.py     runs a model over a split and writes reports/<model>-<input>-<split>.json
  tests/test_lab.py        hashes, determinism, leakage, fictional-only, metric behaviour, baseline reproduces
  train/make_sft.py        builds the training set (train layouts and names only; refuses any overlap with val/test)
  train/train_lora.py      the LoRA run for a rented GPU; --dry-run checks data and config anywhere
```

The server's copy of the registry and latest results (`netlify/lib/model-registry.generated.mjs`, made by `tools/model-registry-sync.mjs`) feeds the admin console's AI page. CI fails if that copy is out of date.

## Benchmark `extraction-v1`

The benchmark has 240 fictional documents:
- **180 lab reports**, in six layouts. 17 common tests carry realistic Indian units (`lakhs/cumm`, `/cumm`, `uIU/mL`) and Indian date formats.
- **60 prescriptions**, in three layouts. They use common Indian brands, 1-0-1 dosing, OD/BD/TDS/HS/SOS and Hinglish timing ("khane ke baad").

Hard cases are deliberate and tagged:
- thousands written with commas;
- decimal commas, which must be reported as unreadable, never misread;
- missing units and missing dates;
- the same test printed twice with different values (both must be kept);
- ranges written as "< 200";
- reports split over two pages;
- prescriptions with no strength written.

Leakage rules are enforced by the tests:
- Each layout family belongs to exactly one split.
- Lab, clinic and doctor names in the test split never appear in train.
- No test document has a train twin, even with its numbers masked.

When real, consented, de-identified documents are ever approved, they will be split by patient and by date, so that no patient's records appear on both sides and no later document predicts an earlier one.

## Baseline results: the reader in the app (`b0-app-parser`), 26 Nov 2026

The test split has 60 lab reports in layouts never seen in train. Text-layer input is a PDF's own text; OCR input is a Tesseract 5.3.4 reading of the rendered page, the same engine the app runs on the device.

| Measure | Text layer | OCR |
|---|---|---|
| Row precision (rows shown that are on the report) | 1.000 | 0.997 |
| Row recall (rows on the report that were found) | 0.914 | 0.715 (was 0.713) |
| Value accuracy on found rows | 1.000 | 1.000 |
| Unit accuracy on found rows | 1.000 | 0.933 (was 0.926) |
| Decimal-comma rows (19): read / reported unreadable / **misread** | 0 / 19 / **0** | 0 / 19 / **0** |
| Unmatched rows (misspelt test names, values correct) | 0 | 1 |
| Report date correct | 0.983 | 0.983 |
| Whole document perfect | 0.567 | 0.100 |

**Fixed the same day in the app's reader (no model):**
- the "Test : value unit (range)" layout went from row recall 0.04 to 0.985 (text layer, 30 reports);
- a stray full stop or colon after a unit is dropped;
- an OCR range like "7:2" is left out rather than shown as "3.5 – 7".

The test split above has none of those layouts, so its numbers barely move; across all 180 reports, OCR recall went from 0.647 to 0.777. The full breakdowns by layout and by hard case are in `reports/`.

What the numbers say:
- The current reader is **safe**: it has never shown a wrong number on this benchmark.
- It is **incomplete**: on photographed reports it finds about 7 rows in 10, and only 1 report in 10 comes out whole.
- That incompleteness is the gap a learned model must close **without** giving up the zero-misread property.

## First Doctine model: proposal

**Task.** Lab-report extraction from OCR or PDF text into the existing read schema: test, value, unit, range and the printed flag. This beats the other candidates for a first model:
- **Prescription extraction** is mostly handwriting. It needs a vision model and real, consented, clinician-labelled photos, which Doctine doesn't have.
- **Timeline summarisation** is generation. It is hard to grade automatically, and that's where a doctor's review is the bottleneck.
- **Lab extraction** has a measured baseline and a precise field-level metric. Synthetic training data is lawful, a small text-only model is enough, and the output can be checked number by number against the page.

**Cheaper step first.** Part of the gap is plain code. The colon layout (recall 0.04) can be fixed in `parseText` without any model, and that fix should ship first. The model is for what code can't do well: OCR noise, misspelt test names, broken columns, and layouts nobody wrote a rule for.

**Base model, licence checked 26 Nov 2026.**
- **First choice: Qwen3-1.7B** (Apache-2.0, 32K context, 100+ languages stated).
- **Comparison: Qwen3-4B** (Apache-2.0).
- **Phi-4-mini-instruct** (MIT) is a comparison only: its model card does not list Hindi.

Re-check licences and newer releases on the day the experiment starts.

**Method.** LoRA (r 16, all attention and MLP projections) on the instruct model, with JSON output constrained to the schema. QLoRA (4-bit) applies only to the 4B comparison. No continued pretraining, and no training on patient data.

**Data needed.**
1. **Synthetic training data:** about 5,000 documents from a training-only generator, with new layouts, more tests (target 150) and more OCR variation. It is generated separately and checked for overlap against this test split.
2. **Before any release:** a clinician-checked set of 200–500 real reports. These must be de-identified, collected with explicit consent for this purpose, and used for evaluation only at first. This needs your decision, the consent text and the lawyer's review.

**Compute estimate (the data size is measured, the speed is assumed).**
- The training set builder (`train/make_sft.py`) makes 5,000 examples of about 1.9 M tokens. Three epochs is about 5.4 M training tokens.
- At an assumed 2,000–4,000 tokens/s for LoRA on a 1.7B model on one 24 GB GPU (L4 or A10G class), that is roughly 0.4–0.75 GPU-hours per run.
- For the 4B model with QLoRA, roughly 1.5–3 GPU-hours per run.
- The training set must first be widened (more tests, more layouts, OCR text) or the model will learn the generator, not lab reports. That makes it larger and the runs longer.
- Inference needs about 4 GB for the 1.7B model in bf16, or about 1.5 GB quantised.

**Promotion bar.** The model is promoted only if, on the extraction-v1 test split with OCR input:
- misread values stay at **0**;
- row recall beats the baseline (above 0.715);
- the perfect-document rate beats the baseline (above 0.100);
- no layout family or hard-case tag gets worse.

It then runs in shadow, beside the current reader, where people never see its output, before any controlled release.

## How a model gets from experiment to people

1. **Register.** The dataset goes in `registry/datasets.json`, with its hash, origin, licence and consent basis.
2. **Train.** Training runs outside this repository's CI, on a rented GPU. It has a fixed config, seed and dataset hash, and the run log is kept.
3. **Evaluate and document.** The candidate is evaluated with `eval/` on the frozen test split, with results by family and by tag. Its model card is written in `registry/models.json` (status `candidate`).
4. **Review.** A clinician reviews the errors. The owner approves.
5. **Shadow run.** The model runs on real traffic, its output is not shown, and it is compared with the baseline. This needs the AI and privacy approvals in DOCTINE_CLINICAL_SAFETY_AND_COMPLIANCE.md.
6. **Release.** Release is controlled, behind a switch, with the previous reader kept for rollback. Models never update their own weights in production.
