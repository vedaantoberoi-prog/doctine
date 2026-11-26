#!/usr/bin/env python3
"""
Doctine Model Lab · build the supervised fine-tuning (SFT) set for doctine-labx (lab-report extraction).

Training documents come from the same generator as the benchmark, but:
  * only the TRAIN layout families and the train lab names are used (the benchmark's val and test layouts, and its
    held-out lab names, are never trained on, so the test split keeps measuring generalisation);
  * a different seed range, and every document is checked against the benchmark's val and test splits: identical text,
    identical text with the numbers masked, or a held-out lab name refuses the whole build.
Each example is {"messages": [system, user = the report text, assistant = the gold JSON]} in the read schema of
netlify/functions/scan.mjs (lab_results: test, value, unit, range, flag; date; facility). The decimal-comma rule is
taught explicitly: such a row is listed under "unreadable", never given a number.

  python3 ai-lab/train/make_sft.py --n 5000 --seed 1 --out ai-lab/train/data/sft-v1   (OCR text: add --ocr, needs tesseract)
"""
import argparse, hashlib, json, os, random, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "synth"))
import generate  # noqa: E402

SYSTEM = ("You read the text of an Indian lab report and return JSON only: {\"date\": \"YYYY-MM-DD or empty\", \"facility\": \"...\", "
          "\"lab_results\": [{\"test\", \"value\", \"unit\", \"range\", \"flag\"}], \"unreadable\": [\"...\"]}. Copy names, units and ranges exactly as "
          "printed; give values as plain numbers (11,418 becomes 11418). flag is only a flag printed on the report (H or L), never one you work out. Never invent a value. "
          "If a number can't be read with certainty (for example a decimal comma like 13,5), put the line in unreadable instead.")
BENCH = os.path.join(HERE, "..", "datasets", "extraction-v1")
TRAIN_FAMILIES = [f for f, s in generate.LAB_FAMILIES.items() if s == "train"]
mask = lambda t: re.sub(r"\s+", " ", re.sub(r"\d", "#", t)).strip()


def target(doc):
    rows, unreadable = [], []
    for r in doc["gold"]["lab_results"]:
        if r.get("unreadable_expected"): unreadable.append(r["printed_name"]); continue
        rows.append({"test": r["printed_name"], "value": r["value"], "unit": r["unit"], "range": r["range"], "flag": r["flag"]})
    return {"date": doc["gold"]["date"], "facility": doc["gold"]["facility"], "lab_results": rows, "unreadable": unreadable}


def bench_guard():
    held = [json.loads(l) for s in ("val", "test") for l in open(os.path.join(BENCH, f"{s}.jsonl"))]
    return {d["text"] for d in held}, {mask(d["text"]) for d in held}, set(generate.LABS_HELD_OUT)


def build(n, seed):
    rng = random.Random(f"sft:{seed}")
    exact, masked, held_names = bench_guard()
    out, seen = [], set()
    while len(out) < n:
        fam = TRAIN_FAMILIES[len(out) % len(TRAIN_FAMILIES)]
        d = generate.lab_doc(rng, 100000 + len(out), fam, "train")
        if d["text"] in exact or mask(d["text"]) in masked or d["gold"]["facility"] in held_names:
            raise SystemExit("refused: a training document overlaps the benchmark's val/test split")
        h = hashlib.sha256(d["text"].encode()).hexdigest()
        if h in seen: continue
        seen.add(h)
        out.append({"id": "sft1-" + h[:12], "family": fam, "messages": [
            {"role": "system", "content": SYSTEM}, {"role": "user", "content": d["text"]},
            {"role": "assistant", "content": json.dumps(target(d), ensure_ascii=False)}]})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5000); ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out", default=os.path.join(HERE, "data", "sft-v1"))
    a = ap.parse_args()
    ex = build(a.n, a.seed)
    k = int(len(ex) * 0.95)
    os.makedirs(a.out, exist_ok=True)
    for name, part in (("train", ex[:k]), ("dev", ex[k:])):
        with open(os.path.join(a.out, f"{name}.jsonl"), "w") as f:
            for e in part: f.write(json.dumps(e, ensure_ascii=False) + "\n")
    chars = sum(len(m["content"]) for e in ex for m in e["messages"])
    meta = {"examples": len(ex), "train": k, "dev": len(ex) - k, "seed": a.seed, "families": TRAIN_FAMILIES, "approx_tokens": chars // 4,
            "sha256": {p: hashlib.sha256(open(os.path.join(a.out, f"{p}.jsonl"), "rb").read()).hexdigest() for p in ("train", "dev")},
            "checked_against": "extraction-v1 val+test: no identical text, no identical text with numbers masked, no held-out lab names"}
    json.dump(meta, open(os.path.join(a.out, "MANIFEST.json"), "w"), indent=1)
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
