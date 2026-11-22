/**
 * Doctine · execute_workflow: run a plan of registered, read-only capabilities and return only what the plan asks for.
 *
 * The model does not send code. It sends a small declarative plan:
 *   { "steps": [ { "id": "ldl", "call": "compare_lab_results", "args": { "test": "ldl", "from": "2023-11-01" } },
 *                { "id": "meds", "call": "get_medications", "args": { "status": "current" } } ],
 *     "return": [ { "step": "ldl", "path": "series" }, { "step": "meds", "path": "entries", "pick": ["name", "dose", "verification"] } ] }
 * An argument may take a value from an earlier step: { "$from": "docs", "path": "documents.0.date" }. Steps that don't
 * depend on each other run in parallel; dependencies run in order; cycles are refused.
 * Intermediate results stay here. Only the "return" selections go back to the model, within a size limit; when the
 * selection is too large the call fails with advice to narrow it, rather than silently dropping medical evidence.
 */
import { BY_NAME, validateArgs } from "./registry.mjs";
import { GatewayError } from "./db.mjs";

export const LIMITS = Object.freeze({ steps: 8, planBytes: 4000, outputBytes: 48_000, totalMs: 9000, returns: 8, pick: 20 });

const ID = /^[a-z][a-z0-9_]{0,23}$/;
const PATH = /^(?!.*(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|$))[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,5}$/;

function get(obj, path) {
  if (!path) return obj;
  let v = obj;
  for (const p of path.split(".")) {
    if (v == null || p === "__proto__" || p === "constructor" || p === "prototype") return undefined;
    v = Array.isArray(v) && /^\d+$/.test(p) ? v.at(+p) : Object.prototype.hasOwnProperty.call(v, p) ? v[p] : undefined;
  }
  return v;
}

/** Check the plan's shape and return its steps in an order that respects dependencies (as parallel "waves"). */
export function planWaves(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new GatewayError("bad_plan", "The plan must be an object with steps.");
  const size = JSON.stringify(plan).length;
  if (size > LIMITS.planBytes) throw new GatewayError("bad_plan", `The plan is too long (${size} characters; limit ${LIMITS.planBytes}).`);
  const extra = Object.keys(plan).filter((k) => k !== "steps" && k !== "return");
  if (extra.length) throw new GatewayError("bad_plan", `Unknown plan field: ${extra.join(", ")}.`);
  const steps = plan.steps;
  if (!Array.isArray(steps) || !steps.length) throw new GatewayError("bad_plan", "The plan needs at least one step.");
  if (steps.length > LIMITS.steps) throw new GatewayError("bad_plan", `At most ${LIMITS.steps} steps per plan.`);
  const ids = new Set(), deps = new Map();
  for (const s of steps) {
    if (!s || typeof s !== "object") throw new GatewayError("bad_plan", "Each step must be an object.");
    const bad = Object.keys(s).filter((k) => !["id", "call", "args"].includes(k));
    if (bad.length) throw new GatewayError("bad_plan", `Unknown step field: ${bad.join(", ")}.`);
    if (!ID.test(s.id || "")) throw new GatewayError("bad_plan", "Each step needs an id: lower-case letters, digits and _.");
    if (ids.has(s.id)) throw new GatewayError("bad_plan", `Step id "${s.id}" is used twice.`);
    ids.add(s.id);
    if (!BY_NAME.has(s.call)) throw new GatewayError("unknown_capability", `"${s.call}" is not a Doctine capability. Use search_capabilities to find one.`);
    const d = new Set();
    for (const v of Object.values(s.args || {})) collectRefs(v, d);
    deps.set(s.id, d);
  }
  for (const [id, d] of deps) for (const x of d) {
    if (!ids.has(x)) throw new GatewayError("bad_plan", `Step "${id}" uses "${x}", which is not a step in this plan.`);
    if (x === id) throw new GatewayError("bad_plan", `Step "${id}" depends on itself.`);
  }
  const waves = [], done = new Set();
  while (done.size < steps.length) {
    const wave = steps.filter((s) => !done.has(s.id) && [...deps.get(s.id)].every((x) => done.has(x)));
    if (!wave.length) throw new GatewayError("bad_plan", "The steps depend on each other in a circle.");
    wave.forEach((s) => done.add(s.id));
    waves.push(wave);
  }
  const ret = plan.return === undefined ? [{ step: steps.at(-1).id }] : plan.return;
  if (!Array.isArray(ret) || !ret.length || ret.length > LIMITS.returns) throw new GatewayError("bad_plan", `"return" must list 1 to ${LIMITS.returns} selections.`);
  for (const r of ret) {
    if (!r || !ids.has(r.step)) throw new GatewayError("bad_plan", "Each return selection must name a step of this plan.");
    if (r.path != null && !PATH.test(r.path)) throw new GatewayError("bad_plan", `Bad return path "${r.path}".`);
    if (r.pick != null && (!Array.isArray(r.pick) || r.pick.length > LIMITS.pick || !r.pick.every((p) => PATH.test(p)))) throw new GatewayError("bad_plan", "pick must be a short list of field names.");
    const bad = Object.keys(r).filter((k) => !["step", "path", "pick"].includes(k));
    if (bad.length) throw new GatewayError("bad_plan", `Unknown return field: ${bad.join(", ")}.`);
  }
  return { waves, ret };
}
function collectRefs(v, into) {
  if (v && typeof v === "object" && !Array.isArray(v) && "$from" in v) {
    if (typeof v.$from !== "string" || (v.path != null && !PATH.test(v.path)) || Object.keys(v).some((k) => k !== "$from" && k !== "path")) throw new GatewayError("bad_plan", "A reference is { \"$from\": \"<step id>\", \"path\": \"a.b.0\" }.");
    into.add(v.$from);
  } else if (Array.isArray(v)) v.forEach((x) => collectRefs(x, into));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectRefs(x, into));
}
function resolve(v, results) {
  if (v && typeof v === "object" && !Array.isArray(v) && "$from" in v) return get(results.get(v.$from), v.path || "");
  if (Array.isArray(v)) return v.map((x) => resolve(x, results));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, results)]));
  return v;
}
const pickFields = (v, pick) => {
  if (!pick) return v;
  const one = (o) => (o && typeof o === "object" ? Object.fromEntries(pick.map((p) => [p, get(o, p)]).filter(([, x]) => x !== undefined)) : o);
  return Array.isArray(v) ? v.map(one) : one(v);
};

/**
 * Run a plan for the signed-in person. ctx = { db: userDb(...), audit?: (entry) => void, now?: () => number }.
 * Returns { ok, results: [{ step, path, value }], steps: [{ id, call, ms, ok }], stats }.
 */
export async function executeWorkflow(plan, ctx) {
  const t0 = Date.now();
  const { waves, ret } = planWaves(plan);
  const results = new Map(), log = [];
  const deadline = t0 + LIMITS.totalMs;
  try {
    for (const wave of waves) await runWave(wave);
  } catch (e) {
    if (ctx.audit) ctx.audit({ kind: "execute_workflow", ok: false, error: e.code || "error", steps: log.map(({ id, call, ms, ok, error }) => ({ id, call, ms, ok, error })) });
    throw e;
  }
  async function runWave(wave) {
    await Promise.all(wave.map(async (s) => {
      const cap = BY_NAME.get(s.call);
      const s0 = Date.now();
      try {
        const args = validateArgs(cap, resolve(s.args || {}, results));
        const left = deadline - Date.now();
        if (left <= 0) throw new GatewayError("timeout", "The plan took too long. Ask for less at once.", 504);
        let timer;
        const out = await Promise.race([cap.run({ db: ctx.db }, args), new Promise((_, rej) => { timer = setTimeout(() => rej(new GatewayError("timeout", "The plan took too long. Ask for less at once.", 504)), left); })]).finally(() => clearTimeout(timer));
        results.set(s.id, out);
        log.push({ id: s.id, call: s.call, ms: Date.now() - s0, ok: true });
      } catch (e) {
        log.push({ id: s.id, call: s.call, ms: Date.now() - s0, ok: false, error: e.code || "error" });
        throw e instanceof GatewayError ? Object.assign(e, { step: s.id }) : Object.assign(new GatewayError("step_failed", `Step "${s.id}" failed.`, 500), { step: s.id });
      }
    }));
  }
  const out = ret.map((r) => ({ step: r.step, path: r.path || null, value: pickFields(get(results.get(r.step), r.path || ""), r.pick) }));
  const bytes = JSON.stringify(out).length;
  const stats = { ms: Date.now() - t0, steps: log.length, ...(ctx.db.stats ? ctx.db.stats() : {}), output_bytes: bytes };
  if (ctx.audit) ctx.audit({ kind: "execute_workflow", ok: bytes <= LIMITS.outputBytes, steps: log.map(({ id, call, ms, ok, error }) => ({ id, call, ms, ok, error })), stats });
  if (bytes > LIMITS.outputBytes) throw new GatewayError("result_too_large", `The selected results are too large (${bytes} characters; limit ${LIMITS.outputBytes}). Narrow the test name or dates, or return fewer fields with "pick". Nothing was dropped silently.`, 413);
  return { ok: true, results: out, steps: log, stats };
}
