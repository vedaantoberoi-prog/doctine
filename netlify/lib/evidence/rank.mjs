/**
 * Doctine · lexical ranking and fusion. Pure functions.
 *   bm25(chunks, terms, { field })  Okapi BM25 (k1 1.2, b 0.75) over the person's own pieces; a multi-word term scores as
 *                                   a phrase only where its words appear together. field "content" = plain BM25,
 *                                   "contextual" = context line + content (contextual BM25).
 *   rrf(lists, { k })               Reciprocal Rank Fusion: ranks, not raw scores, are combined, so scores from different
 *                                   retrievers never need calibrating against each other.
 */
export const tokens = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9.]+/).map((t) => t.replace(/^\.+|\.+$/g, "")).filter(Boolean);

export function bm25(chunks, terms, { field = "contextual", k1 = 1.2, b = 0.75 } = {}) {
  const docs = chunks.map((c) => tokens(field === "contextual" ? `${c.context} ${c.content}` : c.content));
  const N = docs.length || 1, avg = docs.reduce((s, d) => s + d.length, 0) / N || 1;
  const qs = [...new Set(terms.map((t) => tokens(t).join(" ")).filter(Boolean))];
  const freq = (d, q) => {                        // occurrences of a word or of a whole phrase
    const w = q.split(" ");
    if (w.length === 1) return d.reduce((n, t) => n + (t === q ? 1 : 0), 0);
    let n = 0; for (let i = 0; i + w.length <= d.length; i++) if (w.every((x, j) => d.at(i + j) === x)) n++;
    return n;
  };
  const df = new Map(qs.map((q) => [q, docs.reduce((n, d) => n + (freq(d, q) > 0 ? 1 : 0), 0)]));
  return chunks.map((c, i) => {
    const d = docs.at(i); let score = 0; const matched = [];
    for (const q of qs) {
      const f = freq(d, q); if (!f) continue;
      const n = df.get(q), idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
      matched.push(q);
    }
    return { chunk: c, score, matched };
  }).filter((r) => r.score > 0).sort((x, y) => y.score - x.score || String(x.chunk.id).localeCompare(String(y.chunk.id)));
}

/** lists: [{ name, items: [{ key, ...anything }] }] in rank order. Returns [{ key, score, ranks: {list: rank} , item }]. */
export function rrf(lists, { k = 60 } = {}) {
  const acc = new Map();
  for (const { name, items } of lists) items.forEach((it, i) => {
    const e = acc.get(it.key) || { key: it.key, score: 0, ranks: {}, item: it };
    e.score += 1 / (k + i + 1); e.ranks[name] = i + 1; acc.set(it.key, e);
  });
  return [...acc.values()].sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key)));
}
