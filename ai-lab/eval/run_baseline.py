#!/usr/bin/env python3
"""
Doctine Model Lab · run a baseline over the extraction benchmark and write a dated report.

  python3 ai-lab/eval/run_baseline.py --model b0-app-parser --input text --split test
  python3 ai-lab/eval/run_baseline.py --model b0-app-parser --input ocr  --split all

Models:
  b0-app-parser   the lab-report reader shipped in the app today (public/index.html parseText), run with Node.
  (hosted models are evaluated by the same metrics once an API key exists; they are never called from here
   without one, and a model that wasn't run is reported as "not run", never as a score.)
Inputs: text (the PDF text layer) or ocr (Tesseract reading of the rendered page; run synth/ocr.py first).
"""
import argparse, datetime, json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(__file__))
from metrics import report

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DS = os.path.join(ROOT, "ai-lab", "datasets", "extraction-v1")


def load(split, inp):
    docs = []
    for sp in (["train", "val", "test"] if split == "all" else [split]):
        for line in open(os.path.join(DS, f"{sp}.jsonl")):
            d = json.loads(line)
            if d["kind"] != "lab_report": continue
            if inp == "ocr":
                p = os.path.join(DS, "ocr", d["id"] + ".txt")
                if not os.path.exists(p): sys.exit("ocr text missing: run ai-lab/synth/ocr.py")
                d["source_text"] = open(p).read()
            docs.append(d)
    return docs


def b0(docs):
    payload = "".join(json.dumps({"id": d["id"], "text": d.get("source_text", d["text"])}) + "\n" for d in docs)
    r = subprocess.run(["node", os.path.join(ROOT, "ai-lab", "baselines", "app_parser.mjs")], input=payload, capture_output=True, text=True, check=True)
    return {o["id"]: o["prediction"] for o in map(json.loads, r.stdout.splitlines())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="b0-app-parser", choices=["b0-app-parser"])
    ap.add_argument("--input", default="text", choices=["text", "ocr"])
    ap.add_argument("--split", default="test", choices=["train", "val", "test", "all"])
    ap.add_argument("--out", default=os.path.join(ROOT, "ai-lab", "reports"))
    a = ap.parse_args()
    docs = load(a.split, a.input)
    preds = b0(docs)
    rep = {"model": a.model, "input": a.input, "split": a.split, "dataset": "extraction-v1", "documents": len(docs),
           "date": datetime.date.today().isoformat(), "note": "Fictional synthetic documents only. Not clinical validation.", **report(docs, preds)}
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, f"{a.model}-{a.input}-{a.split}.json")
    json.dump(rep, open(path, "w"), indent=1, sort_keys=True)
    o = rep["overall"]
    print(f"{a.model} on {a.input}/{a.split}: {len(docs)} docs · rows P {o['row_precision']} R {o['row_recall']} · value {o['value_acc']} unit {o['unit_acc']} range {o['range_acc']} flag {o['flag_acc']} · hallucinated {o['hallucinated_rows']} · decimal-comma {o['decimal_comma']} · date {o['date_acc']} · perfect docs {o['perfect_doc_rate']}")


if __name__ == "__main__":
    main()
