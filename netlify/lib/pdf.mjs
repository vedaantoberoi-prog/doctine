/**
 * Doctine · a small PDF writer for admin reports (no dependencies). A4 pages, the standard Helvetica fonts, headings,
 * paragraphs and simple tables, with page numbers. Text is limited to the Windows-1252 character set that the built-in
 * PDF fonts cover; anything else is replaced.
 */
const W = 595.28, H = 841.89, M = 48;
const WIDTH = { // Helvetica advance widths (per 1000 em) for printable ASCII; others use 556
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191, "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556, "@": 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667,
  L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 278, "\\": 278, "]": 278, "^": 469,
  _: 556, "`": 333, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333,
  s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, "{": 334, "|": 260, "}": 334, "~": 584, "·": 278, "–": 556, "—": 1000, "’": 222, "“": 333, "”": 333, "…": 1000,
};
const CP1252 = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };
const clean = (t) => String(t == null ? "" : t).replace(/[→↑↓▲▼■]/g, (c) => ({ "→": "->", "↑": "+", "↓": "-", "▲": "+", "▼": "-", "■": "=" }[c])).replace(/₹/g, "Rs ");
const width = (t, size, bold) => [...clean(t)].reduce((a, c) => a + (WIDTH[c] || 556), 0) * size / 1000 * (bold ? 1.06 : 1);
const enc = (t) => [...clean(t)].map((c) => {
  const code = CP1252[c] || c.charCodeAt(0);
  if (code > 255 || (code < 32)) return "?";
  if (c === "(" || c === ")" || c === "\\") return "\\" + c;
  return code > 126 ? "\\" + code.toString(8).padStart(3, "0") : c;
}).join("");

export function makePdf({ title, subtitle, blocks }) {
  const pages = []; let ops = [], y = H - M;
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = H - M; };
  const text = (x, yy, s, size = 10, bold = false, gray = 0.1) => ops.push(`${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${enc(s)}) Tj ET`);
  const need = (h) => { if (y - h < M + 20) newPage(); };
  const wrap = (s, size, maxW, bold) => {
    const out = []; let line = "";
    for (const word of clean(s).split(/\s+/)) { const t = line ? line + " " + word : word; if (width(t, size, bold) > maxW && line) { out.push(line); line = word; } else line = t; }
    if (line) out.push(line); return out;
  };
  text(M, y - 18, title, 20, true, 0.08); y -= 30;
  if (subtitle) { for (const l of wrap(subtitle, 9.5, W - 2 * M)) { text(M, y - 10, l, 9.5, false, 0.4); y -= 13; } }
  y -= 8; ops.push(`0.8 G 0.6 w ${M} ${y} m ${W - M} ${y} l S`); y -= 14;
  for (const b of blocks) {
    if (b.h) { need(40); y -= 6; text(M, y - 12, b.h, 13, true, 0.08); y -= 22; }
    if (b.p) for (const l of wrap(b.p, 9.5, W - 2 * M)) { need(14); text(M, y - 10, l, 9.5, false, 0.3); y -= 13.5; }
    if (b.table) {
      const { cols, rows, align = [] } = b.table, n = cols.length, cw = (W - 2 * M) / n, rh = 16;
      const head = () => { need(rh * 2); ops.push(`0.95 g ${M} ${y - rh} ${W - 2 * M} ${rh} re f`); cols.forEach((c, i) => { const s = String(c); const x = align[i] === "r" ? M + cw * (i + 1) - 6 - width(s, 8, true) : M + cw * i + 6; text(x, y - 11, s, 8, true, 0.35); }); y -= rh; };
      head();
      for (const r of rows) {
        if (y - rh < M + 20) { newPage(); head(); }
        r.forEach((c, i) => { let s = String(c == null ? "" : c); while (s.length > 1 && width(s, 9, false) > cw - 10) s = s.slice(0, -2) + "…"; const x = align[i] === "r" ? M + cw * (i + 1) - 6 - width(s, 9) : M + cw * i + 6; text(x, y - 11.5, s, 9); });
        ops.push(`0.9 G 0.4 w ${M} ${y - rh} m ${W - M} ${y - rh} l S`); y -= rh;
      }
      y -= 10;
    }
  }
  newPage();
  // assemble
  const objs = []; const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(""), pagesObj = add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = [];
  pages.forEach((p, i) => {
    const foot = `0.5 g BT /F1 8 Tf ${M} 28 Td (${enc(title + " - page " + (i + 1) + " of " + pages.length)}) Tj ET`;
    const stream = [...p, foot].join("\n");
    const c = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info << /Producer (Doctine) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
