#!/usr/bin/env python3
"""
Doctine Model Lab · turn synthetic documents into photographed-style images and read them back with Tesseract, the
same engine the app runs on the device (tesseract.js 5 wraps Tesseract 5). This gives the benchmark REAL OCR errors
(1/l, 0/O, lost decimal points, broken columns) instead of invented ones.

Rendering is seeded: font size, slight rotation, blur and noise vary per document but repeat exactly for a given seed.
Output: <dataset>/ocr/<id>.txt and <dataset>/ocr/MANIFEST.json (engine version, settings). Images are not kept.

Needs: Pillow and the `tesseract` command. Optional for CI: the benchmark runs on the text layer without it.
"""
import argparse, json, os, random, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"]


def render(text, rng, path):
    font = ImageFont.truetype(rng.choice([f for f in FONTS if os.path.exists(f)]), rng.choice([20, 22, 24]))
    lines = text.split("\n")
    w = 60 + max(int(font.getlength(l)) for l in lines) + 60
    h = 60 + len(lines) * int(font.size * 1.6) + 60
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    y = 60
    for l in lines:
        d.text((60, y), l, fill=rng.randint(0, 60), font=font); y += int(font.size * 1.6)
    if rng.random() < .5: img = img.rotate(rng.uniform(-1.2, 1.2), expand=True, fillcolor=255)
    if rng.random() < .4: img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.4, 1.0)))
    if rng.random() < .4:
        px = img.load()
        for _ in range(int(w * h * 0.002)): px[rng.randrange(img.width), rng.randrange(img.height)] = rng.randint(0, 120)
    img.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default="ai-lab/datasets/extraction-v1")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    out = os.path.join(a.dataset, "ocr"); os.makedirs(out, exist_ok=True)
    ver = subprocess.run(["tesseract", "--version"], capture_output=True, text=True).stdout.split("\n")[0]
    n = 0
    with tempfile.TemporaryDirectory() as tmp:
        for split in ("train", "val", "test"):
            for line in open(os.path.join(a.dataset, f"{split}.jsonl")):
                d = json.loads(line)
                rng = random.Random(f"{a.seed}:{d['id']}")
                pages = d["text"].split("--- page 2 ---")
                texts = []
                for k, page in enumerate(pages):
                    img = os.path.join(tmp, f"{d['id']}-{k}.png"); render(page.strip("\n"), rng, img)
                    r = subprocess.run(["tesseract", img, "-", "--psm", "6", "-l", "eng"], capture_output=True, text=True)
                    texts.append(r.stdout.strip())
                with open(os.path.join(out, d["id"] + ".txt"), "w") as f: f.write("\n--- page 2 ---\n".join(texts) + "\n")
                n += 1
    json.dump({"engine": ver, "psm": 6, "lang": "eng", "seed": a.seed, "documents": n, "note": "Rendered from the synthetic text, read back by Tesseract. Fictional data only."},
              open(os.path.join(out, "MANIFEST.json"), "w"), indent=1)
    print(f"ocr: {n} documents ({ver})")


if __name__ == "__main__":
    sys.exit(main())
