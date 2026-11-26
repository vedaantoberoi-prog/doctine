#!/usr/bin/env node
/**
 * Doctine · copies every file in the private storage buckets to a folder, with a manifest of sizes and SHA-256 hashes.
 * Used by .github/workflows/storage-backup.yml, which encrypts the folder and keeps it 30 days.
 *
 *   SUPABASE_URL=… STORAGE_BACKUP_KEY=… node tools/storage-backup.mjs <out-dir> [bucket …]
 *
 * Default buckets: health-documents, practitioner-credentials. Read-only: it only lists and downloads.
 * The repository is public, so it prints nothing about the files (no names, ids or counts), only "ok" or the kind of
 * failure. The manifest (inside the encrypted archive) lets a restore check every file byte for byte.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serviceHeaders } from "../netlify/lib/supabase-keys.mjs";

const BUCKETS = ["health-documents", "practitioner-credentials"];
const SAFE = /^[A-Za-z0-9._\-()/ ]+$/;
/* Only Supabase's own short error words (e.g. "Unauthorized", "InvalidJWT"), never file names or ids. */
const errCode = (t) => { try { const j = JSON.parse(t); const c = String(j.code || j.error || "").replace(/[^A-Za-z_ ]/g, "").slice(0, 40); return c ? ", " + c : ""; } catch { return ""; } };

export async function backupBuckets({ base, key, out, buckets = BUCKETS, fetchImpl = fetch, pageSize = 100 }) {
  const h = serviceHeaders(key);
  const manifest = { made_at: new Date().toISOString(), buckets: {} };
  async function list(bucket, prefix) {
    const items = [];
    for (let offset = 0; ; offset += pageSize) {
      const r = await fetchImpl(`${base}/storage/v1/object/list/${bucket}`, { method: "POST", headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ prefix, limit: pageSize, offset, sortBy: { column: "name", order: "asc" } }) });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        if ((r.status === 400 || r.status === 404) && /bucket not found/i.test(t)) return null;
        throw new Error(`list_failed (HTTP ${r.status}${errCode(t)})`);
      }
      const page = await r.json(); items.push(...page);
      if (page.length < pageSize) break;
    }
    return items;
  }
  async function walk(bucket, prefix, files) {
    const items = await list(bucket, prefix);
    if (items === null) return null;
    for (const it of items) {
      const path = prefix ? `${prefix}/${it.name}` : it.name;
      if (!SAFE.test(path) || path.includes("..")) throw new Error("unsafe_name");
      if (it.id == null) await walk(bucket, path, files); else files.push(path);   // folders have no id
    }
    return files;
  }
  for (const bucket of buckets) {
    const files = await walk(bucket, "", []);
    if (files === null) { manifest.buckets[bucket] = { missing: true, files: [] }; continue; }
    const entries = [];
    for (const path of files) {
      const r = await fetchImpl(`${base}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers: h });
      if (!r.ok) throw new Error(`download_failed (HTTP ${r.status}${errCode(await r.text().catch(() => ""))})`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const dest = join(out, bucket, path); mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, bytes, { mode: 0o600 });
      entries.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    manifest.buckets[bucket] = { files: entries };
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1), { mode: 0o600 });
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, ...b] = process.argv.slice(2);
  const base = String(process.env.SUPABASE_URL || "").replace(/\/$/, ""), key = String(process.env.STORAGE_BACKUP_KEY || "").trim();
  // Shape checks only (never the value): the usual copy-and-paste mistakes, each with a plain reason.
  const shape = !key ? "" : /[^\x21-\x7e]/.test(key) ? "it contains spaces, line breaks or hidden characters (was the masked key copied instead of the real one?)"
    : /^sb_publishable_/.test(key) ? "it is the publishable key; the secret key is needed"
    : /^eyJ/.test(key) ? (JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString() || "{}").role === "service_role" ? "" : "it is a legacy key but not the service_role one")
    : /^sb_secret_[A-Za-z0-9_-]{20,}$/.test(key) ? "" : "it doesn't look like a Supabase secret key (sb_secret_…)";
  if (shape) { console.error(`::error::STORAGE_BACKUP_KEY looks wrong: ${shape}. Copy it again with the copy button in Supabase → Project Settings → API Keys → Secret keys.`); process.exit(2); }
  if (!out || !base || !key) { console.error("::error::storage backup: SUPABASE_URL, STORAGE_BACKUP_KEY and an output folder are needed"); process.exit(2); }
  try { await backupBuckets({ base, key, out, buckets: b.length ? b : BUCKETS }); console.log("storage backup: ok"); }
  catch (e) { console.error(`::error::storage backup failed: ${/^(list_failed|download_failed|unsafe_name)/.test(e.message) ? e.message : "unexpected error"} (details withheld from this public log)`); process.exit(1); }
}
