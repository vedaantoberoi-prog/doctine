/**
 * Doctine · evaluation logging (staging only). For requests that passed evaluation access (see evalAccess in
 * ratelimit.mjs), one JSON line of METADATA is written to the function log: run and case ids, status, urgency, which
 * safety rules fired, whether a follow-up question was asked, timing and error codes. Never message text, answers,
 * records or personal details.
 */
const clean = (v, n = 40) => String(v || "").replace(/[^\w.-]/g, "").slice(0, n);
export function evalLog(req, rl, meta) {
  if (!rl || rl.who !== "eval") return;
  console.log(JSON.stringify({ evt: "doctine_eval", run: clean(req.headers.get("x-doctine-eval-run")), case: clean(req.headers.get("x-doctine-eval-case")), ...meta }));
}
