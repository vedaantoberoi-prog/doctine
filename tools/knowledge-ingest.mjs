#!/usr/bin/env node
/**
 * Doctine · load trusted medical guidance into the knowledge store (migration 20261130000000_knowledge.sql).
 *
 *   node tools/knowledge-ingest.mjs <file.md | folder>...              check and split, print a summary (changes nothing)
 *   node tools/knowledge-ingest.mjs <...> --out bundle.json            also write what would be loaded
 *   node tools/knowledge-ingest.mjs <...> --apply                      load into the database in SUPABASE_URL
 *
 * Each source is one Markdown file that starts with front matter saying where it came from and under what licence:
 *   ---
 *   publisher: Ministry of Health and Family Welfare
 *   title: Hypertension — patient information
 *   url: https://example.gov.in/page
 *   licence: Government Open Data Licence – India
 *   licence_url: https://data.gov.in/government-open-data-license-india
 *   published: 2025-06-01        # optional, YYYY-MM-DD
 *   language: en                 # optional
 *   version: 2025-06             # optional; a new version is a new source to approve
 *   ---
 *   ## Heading
 *   Text exactly as published…
 *
 * Rules: https url, a named licence, at least one passage; text that tries to instruct an AI is refused. Everything
 * loads as a DRAFT: the assistant uses a source only after a doctor approves it in the admin console (AI → Medical
 * sources), with their name and the review date. Loading a source again sends it back to draft.
 * --apply needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment of the machine running this (never in
 * the app, never pasted into a chat). The key is never printed.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";

const INSTRUCTION_LIKE = /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,20}\b(instructions?|prompts?|rules)\b|\b(system prompt|developer mode|you are now|act as an?|jailbreak)\b/i;
const MAX = 1200, MIN = 20;

export function parseSource(text, name = "source") {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(String(text));
  if (!m) throw new Error(`${name}: starts without front matter (--- publisher, title, url, licence ---)`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*?)\s*(\s#\s.*)?$/.exec(line.trim());
    if (kv && kv[2]) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  const need = ["publisher", "title", "url", "licence"].filter((k) => !meta[k]);
  if (need.length) throw new Error(`${name}: missing ${need.join(", ")} in front matter`);
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(meta.url)) throw new Error(`${name}: url must be https`);
  if (meta.licence_url && !/^https:\/\//i.test(meta.licence_url)) throw new Error(`${name}: licence_url must be https`);
  if (meta.published && !/^\d{4}-\d{2}-\d{2}$/.test(meta.published)) throw new Error(`${name}: published must be YYYY-MM-DD`);
  if (meta.language && !/^[a-z]{2}(-[A-Z]{2})?$/.test(meta.language)) throw new Error(`${name}: language must look like en or hi-IN`);
  if (meta.version && !/^[0-9A-Za-z.+-]{1,40}$/.test(meta.version)) throw new Error(`${name}: version may use letters, digits, . + -`);
  if (INSTRUCTION_LIKE.test(m[2])) throw new Error(`${name}: contains text that tries to instruct an AI; not loaded`);
  const chunks = chunk(m[2]);
  if (!chunks.length) throw new Error(`${name}: no passages of at least ${MIN} characters`);
  if (chunks.length > 2000) throw new Error(`${name}: more than 2000 passages; split the file`);
  const source = { publisher: meta.publisher, title: meta.title, url: meta.url, licence: meta.licence, licence_url: meta.licence_url || "",
    published: meta.published || "", language: meta.language || "en", version: meta.version || "1" };
  return { source, chunks };
}

/** Split by headings, then by paragraphs, into passages of at most 1,200 characters. Each keeps its heading. */
export function chunk(body) {
  const out = [];
  let heading = null, buf = "";
  const flush = () => { const t = buf.replace(/\s+/g, " ").trim(); if (t.length >= MIN) out.push({ heading, content: t }); buf = ""; };
  // a heading line starts a new section, whether or not a blank line follows it
  const paras = [];
  for (const block of String(body).split(/\r?\n\s*\r?\n/)) {
    let cur = [];
    for (const line of block.split(/\r?\n/)) {
      if (/^#{1,6}\s+\S/.test(line.trim())) { if (cur.length) paras.push(cur.join("\n")); paras.push(line.trim()); cur = []; }
      else cur.push(line);
    }
    if (cur.join("").trim()) paras.push(cur.join("\n"));
  }
  for (const para of paras) {
    const h = /^#{1,6}\s+(.+)$/.exec(para.trim());
    if (h) { flush(); heading = h[1].trim().slice(0, 300); continue; }
    let p = para.trim();
    if (!p) continue;
    if (buf && buf.length + p.length + 1 > MAX) flush();
    while (p.length > MAX) {                      // one very long paragraph: cut at a sentence end
      const cut = Math.max(p.lastIndexOf(". ", MAX), MAX / 2);
      buf = p.slice(0, cut + 1); flush(); p = p.slice(cut + 1).trim();
    }
    buf = buf ? buf + "\n" + p : p;
  }
  flush();
  return out;
}

function files(paths) {
  const out = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) out.push(...files(readdirSync(p).map((f) => join(p, f)).filter((f) => statSync(f).isDirectory() || extname(f) === ".md")));
    else if (extname(p) === ".md") out.push(p);
  }
  return out;
}

async function apply(bundle, env) {
  const base = String(env.SUPABASE_URL || "").replace(/\/$/, ""), key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!/^https:\/\//.test(base) || !key) throw new Error("--apply needs SUPABASE_URL (https) and SUPABASE_SERVICE_ROLE_KEY in this machine's environment");
  const headers = /^sb_secret_/.test(key) ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
  console.log(`loading ${bundle.length} source(s) into ${new URL(base).host} as drafts`);
  for (const b of bundle) {
    const r = await fetch(`${base}/rest/v1/rpc/knowledge_ingest`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ p_source: b.source, p_chunks: b.chunks }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${b.source.title}: refused (${r.status}) ${j && j.message ? String(j.message).slice(0, 200) : ""}`);
    console.log(`  ✓ ${b.source.title}: ${j.passages} passages, draft (approve it in the admin console)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2), paths = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  if (!paths.length) { console.error("usage: node tools/knowledge-ingest.mjs <file.md | folder>... [--out bundle.json] [--apply]"); process.exit(2); }
  const bundle = [];
  let bad = 0;
  for (const f of files(paths)) {
    try { const b = parseSource(readFileSync(f, "utf8"), f); bundle.push(b); console.log(`ok  ${f}: ${b.source.publisher} — ${b.source.title} (${b.chunks.length} passages, ${b.source.licence})`); }
    catch (e) { bad++; console.error(`no  ${e.message}`); }
  }
  if (out) writeFileSync(out, JSON.stringify(bundle, null, 1));
  if (bad) { console.error(`${bad} file(s) refused; nothing loaded`); process.exit(1); }
  if (args.includes("--apply")) await apply(bundle, process.env).catch((e) => { console.error(e.message); process.exit(1); });
  else console.log(`${bundle.length} source(s) checked; nothing loaded (add --apply to load as drafts)`);
}
