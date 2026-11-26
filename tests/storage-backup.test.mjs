/** Doctine · tools/storage-backup.mjs against a simulated Supabase Storage (fictional files only, no network). */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { backupBuckets } from "../tools/storage-backup.mjs";

let passed = 0; const t = async (name, fn) => { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { console.log("  ✗ " + name + ": " + e.message); process.exitCode = 1; } };
const sha = (b) => createHash("sha256").update(b).digest("hex");

function storage(files, { missing = [], failDownload = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", auth: init.headers && (init.headers.apikey || "") });
    const u = new URL(url), m = u.pathname.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
    if (m) {
      const bucket = m[1]; if (missing.includes(bucket)) return new Response(JSON.stringify({ statusCode: "404", error: "Bucket not found" }), { status: 400 });
      const { prefix, limit, offset } = JSON.parse(init.body); const p = prefix ? prefix + "/" : "";
      const names = new Map();
      for (const path of Object.keys(files[bucket] || {})) if (path.startsWith(p)) { const rest = path.slice(p.length), [head, ...more] = rest.split("/"); names.set(head, more.length ? null : path); }
      const all = [...names.entries()].sort().map(([name, file]) => (file ? { name, id: "id-" + name, metadata: { size: files[bucket][file].length } } : { name, id: null }));
      return new Response(JSON.stringify(all.slice(offset, offset + limit)));
    }
    const d = u.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (d) { if (failDownload) return new Response("no", { status: 500 }); const body = (files[d[1]] || {})[decodeURIComponent(d[2])]; return body ? new Response(body) : new Response("nf", { status: 404 }); }
    return new Response("?", { status: 404 });
  };
  return { fetchImpl, calls };
}

const A = "a1000000-0000-4000-8000-000000000001", B = "a1000000-0000-4000-8000-000000000002";
const FILES = { "health-documents": { [`${A}/r1.pdf`]: Buffer.from("%PDF fictional 1"), [`${A}/scans/p 2.jpg`]: Buffer.from("jpeg-ish"), [`${B}/r.pdf`]: Buffer.from("%PDF fictional B") },
  "practitioner-credentials": { [`${B}/deg.pdf`]: Buffer.from("%PDF degree") } };

await t("copies every file in both buckets, through nested folders and pages, with a manifest of sizes and hashes", async () => {
  const out = mkdtempSync(join(tmpdir(), "sb-")); const s = storage(FILES);
  try {
    const m = await backupBuckets({ base: "https://x.supabase.co", key: "sb_secret_fictional", out, fetchImpl: s.fetchImpl, pageSize: 1 });
    for (const [bucket, files] of Object.entries(FILES)) {
      assert.equal(m.buckets[bucket].files.length, Object.keys(files).length, bucket);
      for (const [path, bytes] of Object.entries(files)) {
        assert.deepEqual(readFileSync(join(out, bucket, path)), bytes, path);
        assert.equal(m.buckets[bucket].files.find((f) => f.path === path).sha256, sha(bytes));
      }
    }
    assert.deepEqual(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).buckets, m.buckets);
    assert.ok(s.calls.every((c) => c.method === "GET" || /\/object\/list\//.test(c.url)), "read-only: only lists and downloads");
  } finally { rmSync(out, { recursive: true, force: true }); }
});
await t("a bucket that doesn't exist yet is noted, not a failure", async () => {
  const out = mkdtempSync(join(tmpdir(), "sb-")); const s = storage(FILES, { missing: ["practitioner-credentials"] });
  try { const m = await backupBuckets({ base: "https://x.supabase.co", key: "k", out, fetchImpl: s.fetchImpl }); assert.equal(m.buckets["practitioner-credentials"].missing, true); assert.equal(m.buckets["health-documents"].files.length, 3); }
  finally { rmSync(out, { recursive: true, force: true }); }
});
await t("a failed download fails the whole backup (no silent gaps)", async () => {
  const out = mkdtempSync(join(tmpdir(), "sb-"));
  try { await assert.rejects(backupBuckets({ base: "https://x.supabase.co", key: "k", out, fetchImpl: storage(FILES, { failDownload: true }).fetchImpl }), /download_failed/); }
  finally { rmSync(out, { recursive: true, force: true }); }
});
await t("names that could escape the folder are refused", async () => {
  const out = mkdtempSync(join(tmpdir(), "sb-"));
  try { await assert.rejects(backupBuckets({ base: "https://x.supabase.co", key: "k", out, buckets: ["health-documents"], fetchImpl: storage({ "health-documents": { [`${A}/../../etc/x`]: Buffer.from("x") } }).fetchImpl }), /unsafe_name/); }
  finally { rmSync(out, { recursive: true, force: true }); }
});
console.log(`${passed} storage backup tests passed`);
