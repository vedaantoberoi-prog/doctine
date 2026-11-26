"""
Doctine Model Lab · extraction metrics (lab reports, v1). Standard library only.

There is no single "score". Every number below is reported on its own, per split, per layout family and per hard-case
tag, because a model that is 95% right on easy layouts and silently wrong on decimal commas is not safe.

Row matching: a predicted row matches a gold row when the printed test names agree (case and punctuation ignored).
Repeated tests (the same test printed twice with different values) are matched in order, so both must be kept.

  row_precision / row_recall   rows found that exist / rows on the report that were found
  value_acc, unit_acc,         on matched rows: exact after normalising (thousands commas removed, µ = u, spaces)
  range_acc, flag_acc
  name_misread                 matched rows whose test name was misspelt (OCR), e.g. "HbAlc"
  hallucinated_rows            predicted rows with no counterpart on the report, or whose value is not in the source text
  decimal_comma: read / reported_unreadable / misread   (misread = a wrong number shown as a result: the unsafe case)
  date_acc, facility_acc       document fields
  perfect_doc_rate             every row found with every field right, nothing extra
"""
import re
from collections import defaultdict


def _name(s): return re.sub(r"[^a-z0-9]", "", (s or "").lower())
def _num(s): return (s or "").replace(",", "").strip() if re.fullmatch(r"[\d,]+(\.\d+)?", (s or "").strip()) else (s or "").strip()
def _unit(s): return re.sub(r"\s+", "", (s or "").replace("µ", "u").replace("μ", "u")).lower()
def _range(s): return re.sub(r"\s+", "", (s or "").replace("–", "-").replace("to", "-")).replace("<=", "<").lower()
def _flag(s): return {"h": "H", "high": "H", "l": "L", "low": "L"}.get((s or "").strip().lower(), "*" if (s or "").strip() else "")


def _in_source(value, doc):
    """A predicted value is supported only if the number appears in the text the reader was given."""
    v = _num(value)
    if not v: return False
    text = doc.get("source_text", doc["text"])
    plain = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)          # 11,418 -> 11418
    return re.search(r"(?<![\d.,])" + re.escape(v) + r"(?![\d])", plain) is not None or re.search(r"(?<![\d.,])" + re.escape(v.replace(".", ",")) + r"(?![\d])", text) is not None


def gold_value(g):
    """The true number. A decimal-comma row ("13,5") means 13.5."""
    return g["value"]


def match_rows(gold_rows, pred_rows):
    """Pairs (gold index, predicted index). Three passes: same name and same value; then same name; then a misspelt
    name (OCR: "HbAlc" for "HbA1c", similarity >= 0.75) with the same value. A row matched only by a misspelt name
    counts as found, and is counted again under name_misread."""
    from difflib import SequenceMatcher
    used_p, used_g, pairs = set(), set(), []
    def run(ok):
        for gi, g in enumerate(gold_rows):
            if gi in used_g: continue
            for pi, p in enumerate(pred_rows):
                if pi not in used_p and ok(g, p):
                    used_p.add(pi); used_g.add(gi); pairs.append((gi, pi)); break
    gname = lambda g: _name(g.get("printed_name") or g.get("test"))
    run(lambda g, p: _name(p.get("test")) == gname(g) and _num(p.get("value")) == _num(g["value"]))
    run(lambda g, p: _name(p.get("test")) == gname(g))
    run(lambda g, p: _num(p.get("value")) == _num(g["value"]) and SequenceMatcher(None, _name(p.get("test")), gname(g)).ratio() >= 0.75)
    pairs.sort()
    return pairs, [pi for pi in range(len(pred_rows)) if pi not in used_p]


def score_doc(doc, pred):
    g, p = doc["gold"], pred or {}
    grows, prows = g.get("lab_results", []), p.get("lab_results", []) or []
    pairs, extra = match_rows(grows, prows)
    r = defaultdict(int)
    r["gold_rows"], r["pred_rows"], r["matched"] = len(grows), len(prows), len(pairs)
    all_fields_ok = True
    for gi, pi in pairs:
        gr, pr = grows[gi], prows[pi]
        r["name_misread"] += _name(pr.get("test")) != _name(gr.get("printed_name") or gr.get("test"))
        v_ok = _num(pr.get("value")) == _num(gold_value(gr))
        if gr.get("unreadable_expected"):
            r["dc_rows"] += 1
            r["dc_read" if v_ok else "dc_misread"] += 1
        r["value_ok"] += v_ok
        r["unit_ok"] += _unit(pr.get("unit")) == _unit(gr.get("unit"))
        r["range_ok"] += _range(pr.get("range")) == _range(gr.get("range"))
        r["flag_ok"] += _flag(pr.get("flag")) == _flag(gr.get("flag"))
        all_fields_ok &= v_ok and _unit(pr.get("unit")) == _unit(gr.get("unit")) and _range(pr.get("range")) == _range(gr.get("range")) and _flag(pr.get("flag")) == _flag(gr.get("flag"))
        if not _in_source(pr.get("value"), doc):
            r["hallucinated"] += 1
    r["hallucinated"] += len(extra)
    matched_g = {gi for gi, _ in pairs}
    for gi, gr in enumerate(grows):
        if gr.get("unreadable_expected") and gi not in matched_g:
            r["dc_rows"] += 1; r["dc_reported"] += 1      # left out (the app tells the person a line couldn't be read)
    r["date_ok"] = int((p.get("date") or "") == (g.get("date") or ""))
    r["facility_ok"] = int(bool(g.get("facility")) and _name(g["facility"]) in _name(p.get("facility")))
    r["perfect"] = int(len(pairs) == len(grows) and not extra and all_fields_ok)
    return r


def summarise(rows):
    t = defaultdict(int)
    for r in rows:
        for k, v in r.items(): t[k] += v
    div = lambda a, b: round(a / b, 4) if b else None
    m = t["matched"]
    return {
        "documents": len(rows), "gold_rows": t["gold_rows"], "pred_rows": t["pred_rows"],
        "row_precision": div(m, t["pred_rows"]), "row_recall": div(m, t["gold_rows"]),
        "value_acc": div(t["value_ok"], m), "unit_acc": div(t["unit_ok"], m), "range_acc": div(t["range_ok"], m), "flag_acc": div(t["flag_ok"], m),
        "name_misread": t["name_misread"], "hallucinated_rows": t["hallucinated"], "hallucination_rate": div(t["hallucinated"], t["pred_rows"]),
        "decimal_comma": {"rows": t["dc_rows"], "read": t["dc_read"], "reported_unreadable": t["dc_reported"], "misread": t["dc_misread"]},
        "date_acc": div(t["date_ok"], len(rows)), "facility_acc": div(t["facility_ok"], len(rows)), "perfect_doc_rate": div(t["perfect"], len(rows)),
    }


def report(docs, preds):
    """docs: lab_report documents; preds: {id: prediction}. Returns overall, by family and by tag."""
    scored = [(d, score_doc(d, preds.get(d["id"]))) for d in docs]
    return {"overall": summarise([r for _, r in scored]),
            "by_family": {k: summarise([r for d, r in scored if d["family"] == k]) for k in sorted({d["family"] for d in docs})},
            "by_tag": {k: summarise([r for d, r in scored if k in d["tags"]]) for k in sorted({t for d in docs for t in d["tags"]})}}
