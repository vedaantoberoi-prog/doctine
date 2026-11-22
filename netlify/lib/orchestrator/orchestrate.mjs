/**
 * Doctine · the Intelligence Orchestrator: one request, start to finish, through the enforced state machine.
 *
 *   RECEIVED → AUTHENTICATED → CLASSIFIED → CONTEXT_RESOLVED → PERMISSION_CHECKED → RETRIEVING → PLANNING → VERIFYING
 *   → GENERATING_RESPONSE → COMPLETED        (emergency: CLASSIFIED → ESCALATED; any stage → FAILED or ABORTED)
 *
 * It adds control around what already exists and duplicates none of it: identity is the person's Supabase sign-in,
 * records come only through the Agent Execution Gateway's `investigate_records` (the evidence engine), emergencies use
 * the same fixed rules as /api/chat, and the model only writes an explanation of evidence the server has already
 * assembled. The facts the person sees (values, dates, conflicts, gaps) are always built from the evidence by code.
 */
import { emergencyGuidance } from "../safety.mjs";
import { POLICY, PROMPT_VERSION } from "./policy.mjs";
import { classify } from "./classify.mjs";
import { createRun, RunError } from "./state.mjs";
import { loadConsents, decide } from "./identity.mjs";
import { route, UNAVAILABLE } from "./router.mjs";
import { minimiseEvidence, validateExplanation, EXPLAIN_TOOL, mask } from "./validate.mjs";
import { cacheKey } from "./budget.mjs";

const REFUSAL = {
  other_person: "I can only read the records in your own signed-in account. I can't look up anyone else's reports, even with their name or an ID.",
  injection: "I can't change how I work or what I can see. I only read your own records, and only when you choose to share them. Ask me about your reports and I'll help.",
  action_not_available: "I can't change, send, share or book anything yet. I can read and explain your own records.",
  consent_required: "To answer this, Doctine needs your permission to use its AI assistant. You can switch it on in Settings.",
  share_not_chosen: "To answer from your reports, tick “Use my saved reports and profile in this chat” under the chat, then ask again.",
  use_chat: "That's a general health question rather than one about your records. The main Doctine assistant answers those.",
  clarify: "Which of your results or reports would you like me to look at? For example: “compare my cholesterol over the last two years”.",
};
/** Test names as people know them ("LDL cholesterol", "HbA1c"), for text the person reads. */
export const label = (t) => String(t || "").replace(/\b(ldl|hdl|vldl|tsh|egfr|crp|alt|ast|alp|t3|t4)\b/g, (x) => x.toUpperCase()).replace(/\bnon hdl\b/gi, "non-HDL").replace(/\bhba1c\b/gi, "HbA1c")
  .replace(/^(\s*)([a-z])/, (m, w, c) => w + c.toUpperCase());
const SAFETY_NOTE = "A difference between two results is arithmetic, not a diagnosis. Please talk to your doctor about any change, and don't start, stop or change a medicine because of these numbers.";

/** The deterministic part of every records answer: built by code from the evidence, never by the model. */
export function compose(inv) {
  const undated = inv.series.flatMap((s) => s.undated.map((u) => ({ test: s.test, value_text: u.value_text, evidence: u.evidence })));
  const notCompared = inv.series.flatMap((s) => s.not_compared.map((u) => ({ test: s.test, value_text: u.value_text, why: u.why, evidence: u.evidence })));
  const cautions = inv.series.flatMap((s) => s.cautions.map((c) => `${s.test}: ${c}`));
  const sections = { sufficiency: inv.sufficiency, records_show: inv.lines, cautions, conflicts: inv.conflicts, duplicates: inv.duplicates || [], undated, not_compared: notCompared,
    missing: inv.missing, safety_note: SAFETY_NOTE };
  const out = [];
  if (inv.sufficiency.verdict === "none") out.push(`I couldn't find matching results in your records${inv.plan.dates.from ? ` between ${inv.plan.dates.from} and ${inv.plan.dates.to}` : ""}. That isn't a normal result: it means nothing was recorded or readable.`);
  else { out.push("What your records show:"); out.push(...inv.lines.map(label)); }
  for (const c of cautions) out.push("Note: " + label(c));
  for (const c of inv.conflicts) out.push(`Conflict (${label(c.test)}, ${c.date || "no date"}): ${c.values.map((v) => v.value_text).join(" vs ")}. ${c.note}`);
  for (const u of undated) out.push(`Not compared (${label(u.test)}): ${u.value_text} [${u.evidence}], because the report has no date.`);
  for (const u of notCompared) out.push(`Not compared (${label(u.test)}): ${u.value_text} [${u.evidence}], ${u.why}.`);
  // tests never found in the period are one calm line, not a list of "missing" items
  const never = inv.missing.filter((m) => /no result recorded/.test(m.why)).map((m) => label(m.what).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()));
  if (never.length && inv.sufficiency.verdict !== "none") out.push(`Not found in your records for this period: ${never.join(", ")}. That doesn't mean they are normal; they may not have been tested.`);
  const partly = [], other = [];
  for (const m of inv.missing.filter((m) => !/no result recorded/.test(m.why))) {
    const x = /^not in (\d+) lab report/.exec(m.why);
    if (x) partly.push(`${label(m.what).replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())} (${x[1]} report${x[1] === "1" ? "" : "s"})`);
    else if (m.what === "documents without searchable text") other.push(`${m.documents.length === 1 ? "1 document couldn't" : m.documents.length + " documents couldn't"} be read (no readable text or results), so ${m.documents.length === 1 ? "it isn't" : "they aren't"} included above: ${m.documents.join(", ")}.`);
    else if (m.what === "text that tried to give instructions") other.push(`Some text in ${m.documents.join(", ")} looked like instructions to the AI. It was left out and treated only as document content.`);
    else if (m.what === "document text") other.push("Only your saved results were searched; the text of your documents isn't searchable yet.");
    else other.push(`${label(m.what).replace(/^./, (c) => c.toUpperCase())}: ${m.why}.`);
  }
  if (partly.length) out.push(`Not measured in some of your lab reports from this period: ${partly.join(", ")}.`);
  out.push(...other);
  if (inv.sufficiency.verdict !== "none") out.push(SAFETY_NOTE);
  return { sections, text: out.join("\n") };
}

const evidenceOut = (inv) => inv.evidence.map((e) => ({ id: e.id, document_id: e.document_id, document_title: e.document_title, document_type: e.document_type, date: e.date, page: e.page,
  section: e.section, original_text: e.original_text, verification: e.verification, kind: e.kind }));

async function verifyDocs(envelope, inv) {
  const ids = [...new Set(inv.evidence.map((e) => e.document_id))];
  if (!ids.length) return { deleted: [] };
  const rows = await envelope.db.select("documents", { columns: "id", filters: [["id", "in", ids]] });
  const have = new Set(rows.map((r) => r.id));
  return { deleted: ids.filter((id) => !have.has(id)) };
}

/**
 * input: { message, share_records, request_id?, today? }
 * deps:  { authenticate(): envelope|null, tools (createToolGateway), provider, budget, cache, idem, env, signal, log, now }
 * Returns { status, body }. Never throws.
 */
export async function assist(input, deps) {
  const { tools, provider, budget, cache, idem, env = process.env, signal, log = () => {}, now = Date.now } = deps;
  const run = createRun({ signal, deadlineMs: POLICY.limits.request_ms, stageMs: POLICY.limits.stage_ms, retries: POLICY.limits.retries, now });
  const msg = typeof (input && input.message) === "string" ? input.message.trim() : "";
  const reqId = typeof (input && input.request_id) === "string" && /^[\w-]{8,64}$/.test(input.request_id) ? input.request_id : null;
  let envelope = null, cls = null, rt = null, usage = { tokens_in: 0, tokens_out: 0, cost_usd: null }, cacheState = "none", degraded = null, outcome = null;
  const done = (status, body) => {
    const trace = run.trace();
    log({ at: new Date(now()).toISOString(), route: "assist", who: envelope ? envelope.subject : null, state: trace.state, path: trace.path, outcome, category: cls && cls.category,
      route_category: rt && rt.category, model: rt && rt.model, degraded, ...usage, cache: cacheState, ms: trace.total_ms, retries: run.retries, policy_version: POLICY.version,
      spans: trace.spans.map((s) => [s.name, s.ms]) });
    const { _raw, ...pub } = trace;
    return { status, body: { ...body, state: trace.state, request_id: reqId, policy_version: PROMPT_VERSION, trace: pub } };
  };
  const reply = (kind, text, extra = {}) => ({ answer: { kind, text, ...extra } });

  try {
    if (!msg || msg.length > POLICY.limits.message_chars) { outcome = "bad_request"; run.to("FAILED", { error: "bad_request" }); return done(400, { error: "bad_request", message: "Send a message of up to 2,000 characters." }); }

    envelope = await run.stage("AUTHENTICATED", () => deps.authenticate());
    if (!envelope) { outcome = "unauthorized"; run.to("FAILED", { error: "unauthorized" }); return done(401, { error: "unauthorized", message: "Please sign in again." }); }

    // idempotency: the same request id from the same person returns the first result (no second model call or bill)
    const idemKey = reqId && envelope.subject + "|" + reqId;
    if (idemKey && idem) { const prev = idem.get(idemKey); if (prev) { outcome = "replayed"; const r = await prev; return { status: r.status, body: { ...r.body, replayed: true } }; } }
    let settle; if (idemKey && idem) idem.set(idemKey, new Promise((r) => (settle = r)));
    const finish = (status, body) => { const out = done(status, body); if (settle) settle(out); if (status !== 200 && idemKey && idem) idem.delete(idemKey); return out; };   // only successful answers are replayed

    try {
      cls = await run.stage("CLASSIFIED", () => classify(msg, { today: input.today }));
      run.note({ category: cls.category, risk: cls.risk });
      if (cls.category === "emergency") {
        outcome = "escalated"; run.to("ESCALATED", { outcome: "emergency_guidance" });
        const g = emergencyGuidance(cls.emergency_flags);
        return finish(200, { ...reply("emergency", g.reply, { urgency: "emergency", flags: cls.emergency_flags }), route: { category: "A", reason: "emergency guidance is fixed text" } });
      }

      await run.stage("CONTEXT_RESOLVED", () => loadConsents(envelope));
      run.note({ consent: envelope.consents.ai_chat ? "ai_chat" : "none" });
      const perm = await run.stage("PERMISSION_CHECKED", () => decide(envelope, cls, { shareRecords: input.share_records === true }));
      run.note({ outcome: perm.allowed ? "allowed" : perm.code, purpose: perm.purpose });
      if (!perm.allowed || cls.category !== "record_question") {
        const code = !perm.allowed ? perm.code : cls.category === "general_health" ? "use_chat" : "clarify";
        outcome = !perm.allowed ? "denied" : code; rt = { category: "A", reason: "fixed text" };
        await run.stage("GENERATING_RESPONSE", () => null);
        run.finish("COMPLETED");
        return finish(200, { ...reply(perm.allowed ? "redirect" : "refusal", REFUSAL[code], { code }), route: rt });
      }

      // records: through the existing gateway capability only, as the signed-in person
      const retrieve = () => run.stage("RETRIEVING", async () => { const r = await tools.execute(envelope, "investigate_records", { question: msg, ...(cls.plan && cls.plan.dates && cls.plan.dates.from ? { from: cls.plan.dates.from, to: cls.plan.dates.to } : {}) }); if (r.status !== "done") throw new RunError("tool_refused", r.error); return r.result; });
      let inv = await retrieve();
      run.note({ evidence_items: inv.evidence.length, series: inv.series.length, conflicts: inv.conflicts.length, missing: inv.missing.length, sufficiency: inv.sufficiency.verdict, index_mode: inv.telemetry.index_mode, duplicates: (inv.duplicates || []).length });
      rt = await run.stage("PLANNING", () => route(cls, inv, { env }));
      run.note({ route: rt.category, model: rt.model || undefined });
      let check = await run.stage("VERIFYING", () => verifyDocs(envelope, inv));
      if (check.deleted.length) {
        // a cited document was deleted while we worked: retrieve again, once, so nothing deleted is shown
        run.note({ deleted_mid_request: check.deleted.length });
        inv = await retrieve();
        rt = await run.stage("PLANNING", () => route(cls, inv, { env }));
        check = await run.stage("VERIFYING", () => verifyDocs(envelope, inv));
        if (check.deleted.length) throw new RunError("records_changed", "Your records changed while answering.", { state: "VERIFYING" });
      }

      const base = compose(inv);
      const gen = await run.stage("GENERATING_RESPONSE", async () => {
        if (rt.category === "A") return { explanation: null };
        if (!provider || !provider.configured) { degraded = "provider_not_configured"; return { explanation: null }; }
        if (budget && !budget.allows(envelope.subject, 6000)) { degraded = "daily_budget_reached"; return { explanation: null }; }
        const key = cache && cacheKey({ subject: envelope.subject, model: rt.model, question: msg, inv });
        const hit = key && cache.get(key);
        if (hit) { cacheState = "hit"; return hit; }
        cacheState = cache ? "miss" : "none";
        const pkg = JSON.stringify({ question: mask(msg), evidence_package: minimiseEvidence(inv) });
        let note = "";
        for (let attempt = 0; attempt <= (POLICY.limits.retries.GENERATING_RESPONSE || 0); attempt++) {
          run.checkLive();
          let r;
          try { r = await provider.call(rt.model, { system: POLICY.prompts.orchestrator_system, messages: [{ role: "user", content: pkg + note }], tool: EXPLAIN_TOOL,
            maxTokens: POLICY.limits.max_output_tokens, timeoutMs: POLICY.limits.stage_ms.GENERATING_RESPONSE - 1000, signal }); }
          catch { r = { error: signal && signal.aborted ? "cancelled" : "provider_threw" }; }   // a provider failing in any way never fails the request
          r = r && typeof r === "object" ? r : { error: "bad_output" };
          if (r.usage && budget) { const u = budget.record(envelope.subject, rt.model, r.usage, env); usage = { tokens_in: usage.tokens_in + u.tokens_in, tokens_out: usage.tokens_out + u.tokens_out, cost_usd: u.cost_usd == null ? usage.cost_usd : +((usage.cost_usd || 0) + u.cost_usd).toFixed(6) }; }
          if (r.error === "cancelled" || (signal && signal.aborted)) throw new RunError("cancelled", "The request was cancelled.");
          if (r.error && r.error !== "bad_output") { degraded = UNAVAILABLE.has(r.error) ? "provider_unavailable" : "provider_error"; run.note({ error: r.error }); return { explanation: null }; }
          const v = r.error ? { ok: false, violations: ["no_structured_output"] } : validateExplanation(r.input, inv, { question: msg });
          run.note({ validation: v.ok ? "passed" : "rejected", violations: v.ok ? undefined : v.violations, attempt });
          if (v.ok) {
            const out = { explanation: r.input.explanation, general_knowledge: r.input.general_knowledge || null, doctor_questions: r.input.doctor_questions || [], cited: r.input.cited };
            if (key) cache.set(key, out);
            return out;
          }
          note = `\n\nYour previous explain_records output was rejected by Doctine's checks (${v.violations.join(", ")}). Return a corrected explain_records call that cites only existing E# ids and writes no number that isn't in the evidence package.`;
        }
        degraded = "invalid_model_output";
        return { explanation: null };
      });
      outcome = degraded ? "completed_degraded" : "completed";
      run.finish("COMPLETED", { degraded: degraded || undefined, tokens_in: usage.tokens_in, tokens_out: usage.tokens_out, cache: cacheState });
      const explanationText = gen.explanation ? `\n\nWhat this may mean (AI explanation, check with your doctor):\n${gen.explanation}${gen.general_knowledge ? `\n\nGeneral information (not about your records): ${gen.general_knowledge}` : ""}` : "";
      return finish(200, {
        ...reply(inv.sufficiency.verdict === "none" ? "not_found" : "records", base.text + explanationText, { sections: { ...base.sections, explanation: gen.explanation || null, general_knowledge: gen.general_knowledge || null, doctor_questions: gen.doctor_questions || [] } }),
        evidence: evidenceOut(inv), route: { category: rt.category, model: rt.category === "A" || degraded ? null : rt.model, reason: rt.reason, ...(degraded ? { degraded, note: "The explanation was left out; the facts above come straight from your records." } : {}) },
        usage, cache: cacheState,
      });
    } catch (e) { throw Object.assign(e, { finish }); }
  } catch (e) {
    const fin = e.finish || done;
    if (e instanceof RunError && e.code === "cancelled") { outcome = "cancelled"; if (run.state !== "ABORTED") safeTo(run, "ABORTED"); return fin(499, { error: "cancelled", message: "Stopped." }); }
    const inRetrieval = run.state === "RETRIEVING" || run.state === "VERIFYING";
    outcome = inRetrieval ? "retrieval_failed" : "failed";
    safeTo(run, "FAILED", { error: e.code || "error" });
    if (inRetrieval) return fin(503, { error: "retrieval_failed", message: "Your records couldn't be read just now, so I haven't answered. Please try again in a moment." });
    return fin(e.code === "deadline" ? 504 : 500, { error: e.code === "deadline" ? "timeout" : "server_error", message: "Something went wrong. Please try again." });
  }
}
function safeTo(run, s, a) { try { run.to(s, a); } catch { /* already final */ } }
