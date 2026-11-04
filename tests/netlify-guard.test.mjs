/** Doctine · tools/netlify-guard.mjs against a simulated Netlify API (no network). */
import assert from "node:assert/strict";
import { guard } from "../tools/netlify-guard.mjs";

let passed = 0; const t = async (name, fn) => { try { await fn(); passed++; console.log("  ✓ " + name); } catch (e) { console.log("  ✗ " + name + ": " + e.message); process.exitCode = 1; } };
const env = { NETLIFY_AUTH_TOKEN: "nfp_fake_token_for_tests", NETLIFY_SITE_ID: "site-1" };
const id = (n) => n.toString(16).padStart(24, "0");
function netlify(deploys, published) {
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ method: o.method, path: url.replace("https://api.netlify.com/api/v1", ""), auth: o.headers.authorization });
    const p = calls.at(-1).path;
    if (o.method === "GET" && p.startsWith("/sites/site-1/deploys")) return new Response(JSON.stringify(deploys));
    if (o.method === "GET" && p === "/sites/site-1") return new Response(JSON.stringify({ published_deploy: published ? { id: published } : null }));
    const m = p.match(/^\/deploys\/([0-9a-f]{24})\/cancel$/); if (o.method === "POST" && m) { deploys.find((d) => d.id === m[1]).state = "error"; return new Response("{}"); }
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls };
}
const quiet = () => {};

await t("cancels every deploy that is still in progress, and only those", async () => {
  const ds = [{ id: id(1), state: "ready", title: "staging aaa run 1" }, { id: id(2), state: "processing", title: "staging bbb run 2" }, { id: id(3), state: "uploading", title: "staging ccc run 3" }, { id: id(4), state: "error", title: "x" }];
  const n = netlify(ds); const out = await guard("cancel-stale", null, { env, fetchImpl: n.fetchImpl, log: quiet });
  assert.deepEqual(out, [id(2), id(3)]); assert.equal(n.calls.filter((c) => c.method === "POST").length, 2);
});
await t("cancel-run cancels only this run's unfinished deploy", async () => {
  const ds = [{ id: id(5), state: "processing", title: "staging aaa run 41927383854" }, { id: id(6), state: "processing", title: "staging bbb run 419273838540" }, { id: id(7), state: "ready", title: "staging ccc run 41927383854" }];
  const out = await guard("cancel-run", "41927383854", { env, fetchImpl: netlify(ds).fetchImpl, log: quiet });
  assert.deepEqual(out, [id(5)]);
});
await t("confirm-live passes when the deploy is the published one", async () => {
  assert.equal(await guard("confirm-live", id(8), { env, fetchImpl: netlify([], id(8)).fetchImpl, log: quiet }), id(8));
});
await t("confirm-live fails when another deploy is live", async () => {
  await assert.rejects(guard("confirm-live", id(8), { env, fetchImpl: netlify([], id(9)).fetchImpl, log: quiet }), /published deploy is 0+9, not 0+8/);
});
await t("refuses bad arguments instead of guessing", async () => {
  await assert.rejects(guard("confirm-live", "not-an-id", { env, fetchImpl: netlify([]).fetchImpl, log: quiet }), /deploy id/);
  await assert.rejects(guard("cancel-run", "abc", { env, fetchImpl: netlify([]).fetchImpl, log: quiet }), /run id/);
  await assert.rejects(guard("cancel-stale", null, { env: {}, fetchImpl: netlify([]).fetchImpl, log: quiet }), /required/);
});
await t("the token is sent only as a header to api.netlify.com and never appears in errors or logs", async () => {
  const lines = []; const n = netlify([{ id: id(1), state: "processing", title: "t" }]);
  await guard("cancel-stale", null, { env, fetchImpl: n.fetchImpl, log: (l) => lines.push(l) });
  assert.ok(n.calls.every((c) => c.auth === "Bearer nfp_fake_token_for_tests"));
  const failing = async () => new Response("{}", { status: 500 });
  const err = await guard("confirm-live", id(1), { env, fetchImpl: failing, log: quiet }).catch((e) => e.message);
  assert.ok(!lines.join(" ").includes("nfp_") && !err.includes("nfp_"), err);
});
console.log(`${passed} netlify-guard tests passed`);
