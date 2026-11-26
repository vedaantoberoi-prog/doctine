"""Doctine Model Lab · tests (standard library only; no GPU, no network, no API key).
Run: python3 -m unittest discover -s ai-lab/tests -v
"""
import hashlib, json, os, re, subprocess, sys, unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LAB = os.path.join(ROOT, "ai-lab")
sys.path.insert(0, os.path.join(LAB, "synth")); sys.path.insert(0, os.path.join(LAB, "eval"))
import generate, metrics  # noqa: E402

DS = os.path.join(LAB, "datasets", "extraction-v1")
load = lambda s: [json.loads(l) for l in open(os.path.join(DS, f"{s}.jsonl"))]


class Dataset(unittest.TestCase):
    def test_registry_hashes_match_the_files(self):
        reg = json.load(open(os.path.join(LAB, "registry", "datasets.json")))
        ds = next(d for d in reg["datasets"] if d["id"] == "extraction-v1")
        for split, meta in ds["files"].items():
            path = os.path.join(DS, f"{split}.jsonl")
            self.assertEqual(hashlib.sha256(open(path, "rb").read()).hexdigest(), meta["sha256"], split)
            self.assertEqual(sum(1 for _ in open(path)), meta["documents"], split)
        self.assertFalse(ds["contains_patient_data"])

    def test_generator_is_deterministic_and_matches_the_committed_files(self):
        docs = generate.build(20261126)
        for split in ("train", "val", "test"):
            want = "".join(json.dumps(d, ensure_ascii=False, sort_keys=True) + "\n" for d in docs if d["split"] == split)
            self.assertEqual(want, open(os.path.join(DS, f"{split}.jsonl")).read(), split)

    def test_no_leakage_between_splits(self):
        s = {k: load(k) for k in ("train", "val", "test")}
        fam = {k: {d["family"] for d in v} for k, v in s.items()}
        self.assertFalse(fam["train"] & fam["test"]); self.assertFalse(fam["val"] & fam["test"]); self.assertFalse(fam["train"] & fam["val"])
        names = lambda docs: {d["gold"].get("facility") for d in docs} | {d["gold"].get("doctor") for d in docs if d["gold"].get("doctor")}
        self.assertFalse(names(s["train"]) & names(s["test"]), "a lab, clinic or doctor name is in both train and test")
        norm = lambda t: re.sub(r"\s+", " ", re.sub(r"\d", "#", t)).strip()
        self.assertFalse({norm(d["text"]) for d in s["train"]} & {norm(d["text"]) for d in s["test"]}, "a test document has a train twin")
        ids = [d["id"] for v in s.values() for d in v]; self.assertEqual(len(ids), len(set(ids)))

    def test_only_fictional_people(self):
        for split in ("train", "val", "test"):
            for d in load(split):
                self.assertIn("Fictional Person", d["text"]); self.assertNotRegex(d["text"], r"@|\+91|\b\d{10}\b|\b\d{4} \d{4} \d{4}\b")

    def test_gold_matches_the_text(self):
        for d in load("train") + load("test"):
            for r in d["gold"].get("lab_results", []):
                self.assertTrue(metrics._in_source(r["value"], d), (d["id"], r))


class Metrics(unittest.TestCase):
    doc = {"id": "x", "text": "Hb 13.5 g/dL 13.0 - 17.0\nTLC 11,418 /cumm 4000 - 11000\nTSH 4,12 uIU/mL 0.40 - 4.00", "tags": [], "family": "t",
           "gold": {"date": "2026-01-02", "facility": "Fictional Lab", "lab_results": [
               {"printed_name": "Hb", "value": "13.5", "unit": "g/dL", "range": "13.0 - 17.0", "flag": ""},
               {"printed_name": "TLC", "value": "11418", "unit": "/cumm", "range": "4000 - 11000", "flag": ""},
               {"printed_name": "TSH", "value": "4.12", "unit": "uIU/mL", "range": "0.40 - 4.00", "flag": "", "unreadable_expected": True}]}}

    def test_a_perfect_reading_is_perfect(self):
        p = {"date": "2026-01-02", "facility": "FICTIONAL LAB", "lab_results": [dict(r, test=r["printed_name"]) for r in self.doc["gold"]["lab_results"]]}
        s = metrics.summarise([metrics.score_doc(self.doc, p)])
        self.assertEqual((s["row_precision"], s["row_recall"], s["value_acc"], s["perfect_doc_rate"], s["hallucinated_rows"]), (1.0, 1.0, 1.0, 1.0, 0))
        self.assertEqual(s["decimal_comma"]["read"], 1)

    def test_a_wrong_number_is_a_misread_and_an_invented_row_is_a_hallucination(self):
        p = {"lab_results": [{"test": "Hb", "value": "15.3", "unit": "g/dL", "range": "13.0 - 17.0"}, {"test": "TSH", "value": "412", "unit": "uIU/mL", "range": "0.40 - 4.00"},
                             {"test": "Ferritin", "value": "88", "unit": "ng/mL", "range": ""}]}
        s = metrics.summarise([metrics.score_doc(self.doc, p)])
        self.assertEqual(s["decimal_comma"]["misread"], 1)
        self.assertEqual(s["hallucinated_rows"], 3, "15.3 and 412 are not on the page; Ferritin is not on the report")
        self.assertLess(s["value_acc"], 1); self.assertEqual(s["perfect_doc_rate"], 0)

    def test_leaving_out_an_unreadable_line_is_reported_not_counted_as_misread(self):
        p = {"lab_results": [dict(r, test=r["printed_name"]) for r in self.doc["gold"]["lab_results"][:2]]}
        s = metrics.summarise([metrics.score_doc(self.doc, p)])
        self.assertEqual(s["decimal_comma"], {"rows": 1, "read": 0, "reported_unreadable": 1, "misread": 0})

    def test_ocr_misspelt_names_still_match_by_value_and_are_counted(self):
        d = dict(self.doc, gold=dict(self.doc["gold"], lab_results=[{"printed_name": "HbA1c", "value": "6.9", "unit": "%", "range": "4.0 - 5.6", "flag": ""}]), text="HbAlc 6.9 % 4.0 - 5.6")
        s = metrics.summarise([metrics.score_doc(d, {"lab_results": [{"test": "HbAlc", "value": "6.9", "unit": "%", "range": "4.0 - 5.6"}]})])
        self.assertEqual((s["row_recall"], s["name_misread"], s["hallucinated_rows"]), (1.0, 1, 0))


class Baseline(unittest.TestCase):
    def test_the_app_parser_runs_from_the_app_file_and_reads_a_table(self):
        r = subprocess.run(["node", os.path.join(LAB, "baselines", "app_parser.mjs")], input=json.dumps({"id": "a", "text": "Fictional Lab\nReport Date: 02/01/2026\nHaemoglobin 12.1 g/dL 13.0 - 17.0"}) + "\n",
                           capture_output=True, text=True, check=True)
        out = json.loads(r.stdout)
        self.assertEqual(out["prediction"]["lab_results"], [{"test": "Haemoglobin", "value": "12.1", "unit": "g/dL", "range": "13.0 - 17.0", "flag": ""}])
        self.assertEqual(out["prediction"]["date"], "2026-01-02")

    def test_committed_baseline_reports_reproduce(self):
        for inp in ("text",) + (("ocr",) if os.path.exists(os.path.join(DS, "ocr", "MANIFEST.json")) else ()):
            path = os.path.join(LAB, "reports", f"b0-app-parser-{inp}-test.json")
            before = json.load(open(path))["overall"]
            subprocess.run([sys.executable, os.path.join(LAB, "eval", "run_baseline.py"), "--input", inp, "--split", "test", "--out", os.path.join(LAB, "reports", ".check")], check=True, capture_output=True)
            after = json.load(open(os.path.join(LAB, "reports", ".check", f"b0-app-parser-{inp}-test.json")))["overall"]
            self.assertEqual(before, after, inp)


class Registry(unittest.TestCase):
    def test_no_model_is_called_doctine_trained(self):
        for m in json.load(open(os.path.join(LAB, "registry", "models.json")))["models"]:
            if m["status"] == "deployed" and m["kind"] != "rule_based": self.fail(m["id"] + " is listed as deployed")
            self.assertNotRegex(m["ownership"].lower(), r"^doctine-trained")


if __name__ == "__main__":
    unittest.main()
