/**
 * Doctine · keeps a Netlify site serving the deploy a workflow actually made and checked.
 *
 * Why: `netlify deploy --prod` publishes when Netlify finishes processing, not when the GitHub job ends. If a job is
 * stopped or times out while Netlify is still processing, that older deploy can publish later, over a newer one that
 * was already verified (this happened on staging on 5 Nov 2026: a 15-minute stuck deploy of 3d89bde published after
 * bc96457 had been deployed and checked).
 *
 *   node tools/netlify-guard.mjs cancel-stale         cancel this site's deploys that are still in progress
 *   node tools/netlify-guard.mjs confirm-live <id>    fail unless <id> is the site's published deploy
 *   node tools/netlify-guard.mjs cancel-run <run_id>  cancel unfinished deploys whose message names this workflow run
 *
 * Needs NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID. The token is sent only to api.netlify.com and never printed.
 */
const API = "https://api.netlify.com/api/v1";
// States of a deploy that hasn't finished: it can still publish itself when processing ends.
export const UNFINISHED = new Set(["new", "pending_review", "accepted", "enqueued", "building", "uploading", "uploaded", "preparing", "prepared", "processing", "processed"]);

export async function guard(cmd, arg, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const token = env.NETLIFY_AUTH_TOKEN, site = env.NETLIFY_SITE_ID;
  if (!token || !site) throw new Error("NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID are required");
  const call = async (method, path) => {
    const r = await fetchImpl(API + path, { method, headers: { authorization: "Bearer " + token, "user-agent": "doctine-netlify-guard" } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Netlify ${method} ${path.replace(/\/[0-9a-f]{24}(?=\/|$)/g, "/…")} answered HTTP ${r.status}`);
    return body;
  };
  const unfinished = async () => (await call("GET", `/sites/${site}/deploys?per_page=30`)).filter((d) => UNFINISHED.has(d.state));
  const cancel = async (list, why) => {
    for (const d of list) { await call("POST", `/deploys/${d.id}/cancel`); log(`cancelled ${why} deploy ${d.id} (${d.state}): ${d.title || "no message"}`); }
    if (!list.length) log(`no ${why} deploys to cancel`);
    return list.map((d) => d.id);
  };
  if (cmd === "cancel-stale") return cancel(await unfinished(), "unfinished");
  if (cmd === "cancel-run") {
    if (!/^\d+$/.test(String(arg || ""))) throw new Error("cancel-run needs the workflow run id");
    return cancel((await unfinished()).filter((d) => new RegExp(`\\brun ${arg}\\b`).test(d.title || "")), `this run's unfinished`);
  }
  if (cmd === "confirm-live") {
    if (!/^[0-9a-f]{24}$/.test(String(arg || ""))) throw new Error("confirm-live needs a Netlify deploy id");
    const s = await call("GET", `/sites/${site}`);
    const live = s.published_deploy && s.published_deploy.id;
    if (live !== arg) throw new Error(`the site's published deploy is ${live || "none"}, not ${arg}`);
    log(`confirmed: deploy ${arg} is the live deploy`);
    return live;
  }
  throw new Error("unknown command: " + cmd);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  guard(process.argv[2], process.argv[3]).catch((e) => { console.error("::error::" + e.message); process.exit(1); });
}
