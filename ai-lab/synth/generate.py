#!/usr/bin/env python3
"""
Doctine Model Lab · synthetic benchmark generator (extraction v1).

Makes FICTIONAL Indian medical documents with exact gold labels. No patient data, no copyrighted text: every name,
lab, doctor, value and layout here is invented by this file. Deterministic: the same --seed gives byte-identical output.

Two document kinds (the two extraction tasks in netlify/functions/scan.mjs, READ_TOOL):
  * lab_report    -> lab_results [{test, value, unit, range, flag}], date, facility
  * prescription  -> medicines  [{name, form, strength, frequency, timing, duration}], date, doctor, facility

Each document records its layout "family". Families are assigned to splits disjointly (train / val / test), and the
test split also uses lab and clinic names never seen in train, so a model can't pass the test by memorising layouts or
names. Hard cases are deliberate and tagged: comma thousands, H/L flags, "<200" ranges, decimal commas (the app's
parser must report these as unreadable, not misread them), missing units, missing dates, duplicated tests with
conflicting values, Hinglish timing, 1-0-1 dosing, and ambiguous strengths.

Usage:  python3 ai-lab/synth/generate.py --seed 20261126 --out ai-lab/datasets/extraction-v1
"""
import argparse, hashlib, json, os, random

# ---------------------------------------------------------------- lab tests (canonical name, variants, unit, range)
TESTS = [
    # canonical,             printed variants,                               unit,          low,   high,  decimals, dist(lo,hi)
    ("Haemoglobin",          ["Haemoglobin", "Hemoglobin", "Hb"],             "g/dL",        13.0,  17.0,  1, (9.0, 18.5)),
    ("Total Leucocyte Count", ["Total Leucocyte Count", "TLC", "WBC Count"],  "/cumm",       4000,  11000, 0, (2800, 16000)),
    ("Platelet Count",       ["Platelet Count", "Platelets"],                 "lakhs/cumm",  1.5,   4.5,   2, (0.9, 5.2)),
    ("Fasting Blood Sugar",  ["Fasting Blood Sugar", "Glucose Fasting", "FBS"], "mg/dL",     70,    100,   0, (68, 210)),
    ("HbA1c",                ["HbA1c", "Glycated Haemoglobin"],               "%",           4.0,   5.6,   1, (4.6, 11.2)),
    ("Total Cholesterol",    ["Total Cholesterol", "Cholesterol Total"],      "mg/dL",       None,  200,   0, (120, 290)),
    ("LDL Cholesterol",      ["LDL Cholesterol", "LDL Direct"],               "mg/dL",       None,  100,   0, (60, 210)),
    ("HDL Cholesterol",      ["HDL Cholesterol", "HDL"],                      "mg/dL",       40,    60,    0, (28, 75)),
    ("Triglycerides",        ["Triglycerides", "TG"],                         "mg/dL",       None,  150,   0, (70, 420)),
    ("Serum Creatinine",     ["Serum Creatinine", "Creatinine"],              "mg/dL",       0.7,   1.3,   2, (0.5, 2.4)),
    ("Blood Urea",           ["Blood Urea", "Urea"],                          "mg/dL",       15,    40,    0, (10, 85)),
    ("TSH",                  ["TSH", "Thyroid Stimulating Hormone"],          "uIU/mL",      0.4,   4.0,   2, (0.1, 9.5)),
    ("Vitamin D",            ["Vitamin D", "25-OH Vitamin D"],                "ng/mL",       30,    100,   1, (8, 60)),
    ("Vitamin B12",          ["Vitamin B12", "Cyanocobalamin"],               "pg/mL",       200,   900,   0, (120, 1100)),
    ("SGPT",                 ["SGPT", "ALT (SGPT)"],                          "U/L",         7,     56,    0, (12, 140)),
    ("Uric Acid",            ["Uric Acid", "Serum Uric Acid"],                "mg/dL",       3.5,   7.2,   1, (2.8, 9.8)),
    ("Sodium",               ["Sodium", "Serum Sodium"],                      "mmol/L",      135,   145,   0, (128, 149)),
]

LABS_SEEN = ["Sunrise Diagnostics", "Ganga Pathology Lab", "Nilgiri Labs", "Vedant Diagnostic Centre", "Kaveri Clinical Laboratory"]
LABS_HELD_OUT = ["Ashoka Path Labs", "Lotus Diagnostic Hospital"]   # appear only in the test split
DOCTORS_SEEN = ["Dr. A. K. Mehra", "Dr. Priya Raman", "Dr. S. Banerjee"]
DOCTORS_HELD_OUT = ["Dr. N. Iyer"]
CLINICS_SEEN = ["Shanti Clinic", "Care Plus Polyclinic"]
CLINICS_HELD_OUT = ["Arogya Family Clinic"]

# ---------------------------------------------------------------- medicines (fictional prescriptions, common Indian brands)
MEDS = [
    # printed name, form, strength options
    ("Dolo", "Tab", ["650"]),
    ("Pan-D", "Cap", [""]),
    ("Telma", "Tab", ["40", "80"]),
    ("Montair-LC", "Tab", [""]),
    ("Augmentin", "Tab", ["625"]),
    ("Glycomet", "Tab", ["500", "850"]),
    ("Atorva", "Tab", ["10", "20"]),
    ("Azithral", "Tab", ["500"]),
    ("Ascoril LS", "Syp", [""]),
    ("Shelcal", "Tab", ["500"]),
]
FREQ = [  # printed, normalised
    ("1-0-1", "twice daily"), ("1-1-1", "three times daily"), ("1-0-0", "once daily (morning)"), ("0-0-1", "once daily (night)"),
    ("OD", "once daily"), ("BD", "twice daily"), ("TDS", "three times daily"), ("HS", "at bedtime"), ("SOS", "when needed"),
]
TIMING = [("after food", "after food"), ("before food", "before food"), ("khane ke baad", "after food"), ("khane se pehle", "before food"), ("", "")]
DURATION = [("x 5d", "5 days"), ("x 7 days", "7 days"), ("x 1/52", "1 week"), ("x 1/12", "1 month"), ("for 3 days", "3 days"), ("", "")]

# ---------------------------------------------------------------- layout families and their split
LAB_FAMILIES = {
    "table":       "train",   # Test  Value  Unit  Range
    "colon":       "train",   # Test : Value Unit (Range)
    "flag_column": "train",   # Test  Value  H  Unit  Range
    "bio_ref":     "val",     # Test  Result  Units  Bio. Ref. Interval
    "two_page":    "test",    # table, split over two pages, with a repeated header
    "lessthan":    "test",    # ranges written "< 200"; decimal-comma rows (must be reported, not misread)
}
RX_FAMILIES = {"rx_lines": "train", "rx_numbered": "val", "rx_hinglish": "test"}


def fmt(v, d):
    return f"{v:.{d}f}" if d else str(int(round(v)))


def make_value(rng, t):
    lo, hi = t[6]
    return round(rng.uniform(lo, hi), t[5])


def flag_for(v, low, high):
    if low is not None and v < low: return "L"
    if high is not None and v > high: return "H"
    return ""


def range_str(low, high, d):
    if low is None: return f"< {fmt(high, d) if isinstance(high, float) else high}"
    return f"{fmt(low, d) if isinstance(low, float) else low} - {fmt(high, d) if isinstance(high, float) else high}"


def date_str(rng, style):
    y, m, d = rng.choice([2024, 2025, 2026]), rng.randint(1, 12), rng.randint(1, 28)
    iso = f"{y:04d}-{m:02d}-{d:02d}"
    printed = {"dmy_slash": f"{d:02d}/{m:02d}/{y}", "dmy_dash": f"{d:02d}-{m:02d}-{y}", "iso": iso}[style]
    return iso, printed


def lab_doc(rng, i, family, split):
    labs = LABS_HELD_OUT if split == "test" else LABS_SEEN
    facility = rng.choice(labs)
    n = rng.randint(4, 9)
    chosen = rng.sample(TESTS, n)
    has_date = rng.random() > 0.1
    iso, printed = date_str(rng, rng.choice(["dmy_slash", "dmy_dash", "iso"]))
    lines, gold, tags = [facility.upper() + (" PATHOLOGY" if "Path" not in facility and rng.random() < .3 else ""),
                         "Patient: Fictional Person " + str(i), f"Age/Sex: {rng.randint(20, 80)} Y / {rng.choice('MF')}"], [], []
    if has_date: lines.append(f"Report Date: {printed}")
    else: tags.append("no_date")
    header = {"table": "Test  Value  Unit  Reference Range", "colon": "", "flag_column": "Test  Result  Flag  Unit  Range",
              "bio_ref": "Test Name  Result  Units  Bio. Ref. Interval", "two_page": "Investigation  Value  Unit  Reference Range",
              "lessthan": "Test  Value  Unit  Reference Range"}[family]
    if header: lines.append(header)
    for k, t in enumerate(chosen):
        name = rng.choice(t[1]); v = make_value(rng, t); low, high, d = t[3], t[4], t[5]
        unit = t[2]; rs = range_str(low, high, d); fl = flag_for(v, low, high); vs = fmt(v, d)
        if t[0] == "Total Leucocyte Count" and v >= 1000 and rng.random() < .5: vs = f"{int(v):,}"; tags.append("comma_thousands")
        decimal_comma = family == "lessthan" and d and rng.random() < .25
        if decimal_comma: vs = vs.replace(".", ","); tags.append("decimal_comma")
        drop_unit = rng.random() < .06
        if drop_unit: unit = ""; tags.append("missing_unit")
        if family == "colon": line = f"{name} : {vs} {unit} ({rs})".replace("  ", " ")
        elif family == "flag_column": line = f"{name}  {vs}  {fl}  {unit}  {rs}" if fl else f"{name}  {vs}  {unit}  {rs}"
        elif family == "bio_ref": line = f"{name}  {vs}  {unit}  {rs}"
        else: line = f"{name}  {vs}  {unit}  {rs}"
        lines.append(" ".join(line.split()) if family != "colon" else line)
        if family == "two_page" and k == n // 2: lines += ["--- page 2 ---", facility.upper(), header]
        # Extraction is transcription: the gold flag is the one PRINTED on the report (only the flag_column layout prints
        # one), never a flag the reader works out from the range.
        g = {"test": t[0], "printed_name": name, "value": fmt(v, d), "unit": unit, "range": rs, "flag": fl if family == "flag_column" else ""}
        if decimal_comma: g["unreadable_expected"] = True
        gold.append(g)
    if rng.random() < .12:   # a repeated test with a different value: both must be kept, never merged
        t = chosen[0]; v2 = make_value(rng, t); g0 = gold[0]
        lines.append(" ".join(f"{g0['printed_name']} {fmt(v2, t[5])} {g0['unit']} {g0['range']}".split()))
        gold.append(dict(g0, value=fmt(v2, t[5]), flag="", unreadable_expected=False)); tags.append("conflicting_repeat")
    lines.append("*** End of report ***")
    return {"kind": "lab_report", "family": family, "split": split, "tags": sorted(set(tags)),
            "text": "\n".join(lines), "gold": {"type": "lab_report", "date": iso if has_date else "", "facility": facility, "lab_results": gold}}


def rx_doc(rng, i, family, split):
    doc = rng.choice(DOCTORS_HELD_OUT if split == "test" else DOCTORS_SEEN)
    clinic = rng.choice(CLINICS_HELD_OUT if split == "test" else CLINICS_SEEN)
    iso, printed = date_str(rng, "dmy_slash")
    lines = [doc + ", MBBS, MD", clinic, f"Reg. No. FICT/{rng.randint(10000, 99999)}", f"Date: {printed}", "Name: Fictional Person " + str(i), "Rx"]
    meds, tags = [], []
    for k, (name, form, strengths) in enumerate(rng.sample(MEDS, rng.randint(2, 4))):
        st = rng.choice(strengths); fp, fn = rng.choice(FREQ); tp, tn = rng.choice(TIMING if family == "rx_hinglish" else TIMING[:2] + TIMING[4:]); dp, dn = rng.choice(DURATION)
        ambiguous = st and rng.random() < .1
        shown = f"{name} {st}".strip() if not ambiguous else name
        if ambiguous: tags.append("strength_not_written")
        prefix = f"{k + 1}. " if family == "rx_numbered" else ""
        lines.append(" ".join(x for x in [prefix + form, shown, fp, tp, dp] if x))
        meds.append({"name": name, "form": {"Tab": "tablet", "Cap": "capsule", "Syp": "syrup"}[form], "strength": "" if ambiguous else st,
                     "frequency": fn, "timing": tn, "duration": dn})
        if tp and tp != tn: tags.append("hinglish_timing")
    lines += ["Adv: plenty of fluids", "F/U after 1 week" if rng.random() < .5 else ""]
    return {"kind": "prescription", "family": family, "split": split, "tags": sorted(set(tags)),
            "text": "\n".join(l for l in lines if l), "gold": {"type": "prescription", "date": iso, "doctor": doc, "facility": clinic, "medicines": meds}}


def build(seed, n_lab=180, n_rx=60):
    rng = random.Random(seed)
    docs = []
    fams = list(LAB_FAMILIES.items())
    for i in range(n_lab):
        fam, split = fams[i % len(fams)]
        docs.append(lab_doc(rng, i, fam, split))
    rfams = list(RX_FAMILIES.items())
    for i in range(n_rx):
        fam, split = rfams[i % len(rfams)]
        docs.append(rx_doc(rng, i, fam, split))
    for d in docs:
        d["id"] = "ext1-" + hashlib.sha256(d["text"].encode()).hexdigest()[:12]
    return docs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261126)
    ap.add_argument("--out", default="ai-lab/datasets/extraction-v1")
    a = ap.parse_args()
    docs = build(a.seed)
    os.makedirs(a.out, exist_ok=True)
    for split in ("train", "val", "test"):
        with open(os.path.join(a.out, f"{split}.jsonl"), "w") as f:
            for d in docs:
                if d["split"] == split: f.write(json.dumps(d, ensure_ascii=False, sort_keys=True) + "\n")
    print(json.dumps({s: sum(d["split"] == s for d in docs) for s in ("train", "val", "test")}))


if __name__ == "__main__":
    main()
