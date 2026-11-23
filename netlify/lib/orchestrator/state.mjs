/**
 * Doctine · the enforced workflow state machine and its trace.
 *
 * Every request is one run that moves only along TRANSITIONS; any other move throws, so a stage can't be skipped (for
 * example, retrieval before the permission check). Each stage has a time limit, transient failures may be retried a
 * fixed number of times, the caller's AbortSignal cancels the run between and during stages (no further model or
 * database calls), and the whole run has a deadline. The trace is one span per stage with timings and a few
 * allow-listed attributes (counts, codes, versions), never a value from anyone's records; toOtel() exports it in
 * OpenTelemetry's JSON shape.
 */
import { randomBytes } from "node:crypto";

export const STATES = ["RECEIVED", "AUTHENTICATED", "CLASSIFIED", "CONTEXT_RESOLVED", "PERMISSION_CHECKED", "RETRIEVING", "PLANNING",
  "AWAITING_CONFIRMATION", "EXECUTING", "VERIFYING", "GENERATING_RESPONSE", "COMPLETED", "FAILED", "ABORTED", "ESCALATED"];
export const TERMINAL = new Set(["COMPLETED", "FAILED", "ABORTED", "ESCALATED", "AWAITING_CONFIRMATION"]);
export const TRANSITIONS = Object.freeze({
  RECEIVED: ["AUTHENTICATED"],
  AUTHENTICATED: ["CLASSIFIED"],
  CLASSIFIED: ["CONTEXT_RESOLVED", "ESCALATED"],
  CONTEXT_RESOLVED: ["PERMISSION_CHECKED"],
  PERMISSION_CHECKED: ["RETRIEVING", "PLANNING", "EXECUTING", "VERIFYING", "GENERATING_RESPONSE"],   // EXECUTING only with a valid confirmation; VERIFYING when the app reports an action saved
  RETRIEVING: ["PLANNING"],
  PLANNING: ["AWAITING_CONFIRMATION", "EXECUTING", "VERIFYING", "GENERATING_RESPONSE"],
  AWAITING_CONFIRMATION: [],
  EXECUTING: ["VERIFYING"],
  VERIFYING: ["GENERATING_RESPONSE", "RETRIEVING"],                                    // RETRIEVING again only when records changed mid-request
  GENERATING_RESPONSE: ["COMPLETED"],
  COMPLETED: [], FAILED: [], ABORTED: [], ESCALATED: [],
});
const ANYTIME = ["FAILED", "ABORTED"];

export class RunError extends Error {
  constructor(code, message, { state, retryable = false } = {}) { super(message || code); this.code = code; this.state = state; this.retryable = retryable; }
}

// attributes that may appear in a trace: never free text, never record values
const ATTR = new Set(["category", "risk", "intent", "route", "model", "provider", "outcome", "error", "attempt", "retries", "evidence_items", "documents", "series",
  "conflicts", "missing", "sufficiency", "tokens_in", "tokens_out", "cost_usd", "cache", "consent", "purpose", "tool", "level", "rows", "policy_version",
  "degraded", "deleted_mid_request", "validation", "violations", "index_mode", "duplicates", "status"]);
const safeAttrs = (a = {}) => Object.fromEntries(Object.entries(a).filter(([k, v]) => ATTR.has(k) && v !== undefined && (typeof v !== "string" || v.length <= 64) && (typeof v !== "object" || v === null || Array.isArray(v) && v.every((x) => typeof x === "string" && x.length <= 40))));

export function createRun({ signal, deadlineMs = 27000, stageMs = {}, retries = {}, now = Date.now } = {}) {
  const traceId = randomBytes(16).toString("hex");
  const t0 = now();
  const spans = [];
  let state = "RECEIVED", current = { name: "RECEIVED", start: t0, attrs: {} }, retryCount = 0;
  const history = ["RECEIVED"];

  const close = (end = now()) => { if (current) { spans.push({ ...current, end, ms: end - current.start, span_id: randomBytes(8).toString("hex") }); current = null; } };
  function checkLive() {
    if (signal && signal.aborted) throw new RunError("cancelled", "The request was cancelled.", { state });
    if (now() - t0 > deadlineMs) throw new RunError("deadline", "The request took too long.", { state });
  }
  function to(next, attrs) {
    if (TERMINAL.has(state)) throw new RunError("invalid_transition", `${state} is final`, { state });
    if (!(TRANSITIONS[state] || []).includes(next) && !ANYTIME.includes(next)) throw new RunError("invalid_transition", `${state} → ${next} is not allowed`, { state });
    if (next === "RETRIEVING" && history.filter((s) => s === "RETRIEVING").length >= 2) throw new RunError("invalid_transition", "records changed again; not retrying", { state });
    close();
    state = next; history.push(next);
    current = { name: next, start: now(), attrs: safeAttrs(attrs) };
    if (TERMINAL.has(next)) close();
  }
  const note = (attrs) => { const target = current || spans.at(-1); if (target) Object.assign(target.attrs, safeAttrs(attrs)); };

  /** Run one stage: transition, then fn() under the stage's time limit, retrying transient failures; cancellable. */
  async function stage(next, fn, attrs) {
    checkLive();
    to(next, attrs);
    const limit = Math.min(stageMs[next] || deadlineMs, Math.max(1, deadlineMs - (now() - t0)));
    const max = retries[next] || 0;
    for (let attempt = 0; ; attempt++) {
      checkLive();
      let timer, onAbort;
      try {
        const out = await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new RunError("stage_timeout", `${next} took longer than ${limit} ms`, { state: next, retryable: true })), limit); }),
          new Promise((_, rej) => { if (signal) { onAbort = () => rej(new RunError("cancelled", "The request was cancelled.", { state: next })); signal.addEventListener("abort", onAbort, { once: true }); } }),
        ]);
        if (attempt) note({ retries: attempt });
        return out;
      } catch (e) {
        const err = e instanceof RunError ? e : new RunError(e && e.code || "stage_error", e && e.message, { state: next, retryable: !!(e && (e.retryable || e.code === "unavailable" || e.code === "timeout")) });
        if (err.code !== "cancelled" && err.retryable && attempt < max) { retryCount++; continue; }
        throw err;
      } finally { clearTimeout(timer); if (signal && onAbort) signal.removeEventListener("abort", onAbort); }
    }
  }

  return {
    traceId, get state() { return state; }, history, to, stage, note, checkLive,
    get retries() { return retryCount; },
    finish(end, attrs) { if (attrs) note(attrs); if (!TERMINAL.has(state)) to(end); else close(); return trace(); },
    trace,
  };
  function trace() {
    const all = current ? [...spans, { ...current, end: null, ms: now() - current.start }] : spans;
    return { trace_id: traceId, state, path: history.slice(), total_ms: now() - t0, spans: all.map(({ name, ms, attrs }) => ({ name, ms, ...(Object.keys(attrs).length ? { attrs } : {}) })) , _raw: all };
  }
}

/** OpenTelemetry JSON (OTLP/HTTP) shape for one run's trace; attributes are already filtered. */
export function toOtel(t, { service = "doctine-orchestrator", version = "" } = {}) {
  const ns = (ms) => String(BigInt(Math.round(ms)) * 1000000n);
  const kv = (o) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === "number" ? { doubleValue: v } : typeof v === "boolean" ? { boolValue: v } : { stringValue: Array.isArray(v) ? v.join(",") : String(v) } }));
  return { resourceSpans: [{ resource: { attributes: kv({ "service.name": service, "service.version": version }) },
    scopeSpans: [{ scope: { name: "doctine.orchestrator" }, spans: t._raw.map((s) => ({ traceId: t.trace_id, spanId: s.span_id || "0000000000000000", name: s.name, kind: 1,
      startTimeUnixNano: ns(s.start), endTimeUnixNano: ns(s.end ?? s.start + s.ms), attributes: kv(s.attrs || {}),
      status: { code: s.name === "FAILED" ? 2 : 1 } })) }] }] };
}
