/**
 * Doctine · /api/chat  (Netlify Function) — the general health assistant.
 *
 * POST { messages: [{role, content}], state?: object, context?: { profile?, records? } }
 *   → { reply, sections, urgency, question, options, uncertainty, safety_note, record_claims, safety, state }
 * GET  ?test=1  → one tiny real request to check the key and model: { ok, provider, model } or { error }
 * GET  ?eval=1  → { eval_access: true | false } for the x-doctine-eval-token header (staging pipeline; no AI call)
 *
 * Needs ANTHROPIC_API_KEY (Netlify → Site configuration → Environment variables, scope Functions).
 * Optional AI_MODEL (a Claude model id). Error codes match the ones the app already explains.
 * Optional knowledge retrieval (netlify/lib/knowledge.mjs): off unless KNOWLEDGE_PROVIDER is set. Answers cite
 * only passages that were actually retrieved, returned as `sources`; with no provider, `sources` is empty.
 */
import { json, settings, limited, clientIp, readJson, callClaude, str, arr } from "../lib/ai.mjs";
import { emergencyCheck, emergencyGuidance } from "../lib/safety.mjs";
import { retrieve } from "../lib/knowledge.mjs";
import { aiSwitchedOff } from "../lib/settings.mjs";
import { checkRate, evalAccess } from "../lib/ratelimit.mjs";
import { evalLog } from "../lib/evallog.mjs";

const MAX_BODY = 120_000;
const MAX_TURNS = 20;

const SYSTEM = `You are Doctine's health assistant, for people in India. You give clear, warm, accurate general health information in plain language that a non-medical adult understands.

What you are, and are not
- You are an AI assistant, not a doctor. Never say or imply you are a doctor.
- Never give a definitive diagnosis from chat. You may say what a pattern of symptoms is "often" or "commonly" linked to, as possibilities, and say what would tell them apart.
- Never prescribe, never tell someone to start, stop or change the dose of a medicine. You may explain what a medicine is generally used for and general precautions, and tell them to ask their doctor or pharmacist.
- Never invent test results, records, studies, guidelines or sources. If you don't know, say so.
- A confident-sounding answer is not medical certainty. Say clearly what you can't know from a chat.

Three kinds of conversation
A. General questions (conditions, terms, medicines, prevention, tests): answer directly and accurately. No questions back unless something essential is ambiguous.
B. Personal symptoms: be a careful listener. Use what they have already told you. Ask at most ONE follow-up question per turn, choosing the single missing detail that most changes the advice (often: who it is and their age, how long, how severe, what makes it better or worse, associated symptoms, relevant conditions or pregnancy, medicines taken). Do not run the same checklist for every symptom and do not ask what they already answered. Still give useful information in every reply: what it commonly is, what helps safely, what to watch for, and when to see a doctor (today, soon, or routinely). Offer 2–4 short answer options for your question when they help.
C. Their records: if saved records are provided, use only those values. Every statement based on a record goes in record_claims with that record's id. Keep general medical knowledge in the reply and sections, so record facts and general knowledge stay distinct. If a record value is incomplete or unclear, say so.

Urgency
- "emergency": possible heart attack, stroke, severe breathing difficulty, unconsciousness, seizure, severe bleeding, anaphylaxis, poisoning or overdose, suicidal thoughts or self-harm, a very unwell infant, pregnancy with bleeding or severe pain, or anything similar. Lead with: call 112 now or go to the nearest emergency department. For suicidal thoughts also give Tele-MANAS 14416 (1-800-891-4416), free and 24×7. Keep the rest short.
- "same_day": should see a doctor today (e.g. high fever with stiff neck or confusion, dehydration in a child or older adult, worsening pain, symptoms in pregnancy).
- "routine": everything else.
Use Indian context where it helps (112, Tele-MANAS, common Indian medicine brand names, local foods), without stereotyping.

Style
- Lead with the answer in "reply" (2–5 short paragraphs). Put optional detail in "sections" (e.g. "What it could be", "What helps", "When to see a doctor"). No markdown headings or tables; plain sentences and short lines.
- "uncertainty": what this answer can't tell them (empty if nothing important).
- "state": brief notes for the next turn — mode (general | symptom | record), topic, facts the person has told you, and what you still need. Keep it short.
Reply only through the respond tool.`;

const S = { type: "string" };
const TOOL = {
  name: "respond",
  description: "Answer the person.",
  input_schema: {
    type: "object",
    properties: {
      reply: S,
      sections: { type: "array", items: { type: "object", properties: { title: S, body: S }, required: ["title", "body"] } },
      urgency: { type: "string", enum: ["routine", "same_day", "emergency"] },
      current_emergency: { type: "boolean", description: "Only when Doctine's safety check flagged the message: true if it describes something happening to someone now, false if it is a general or past question." },
      question: { type: "string", description: "One follow-up question, or empty." },
      options: { type: "array", items: S },
      uncertainty: S,
      safety_note: S,
      record_claims: { type: "array", items: { type: "object", properties: { text: S, source: { type: "string", description: "Record id such as R1" } }, required: ["text", "source"] } },
      citations: { type: "array", description: "Ids (K1, K2…) of reference passages you actually relied on. Empty if none were provided or used.", items: S },
      state: {
        type: "object",
        properties: { mode: { type: "string", enum: ["general", "symptom", "record"] }, topic: S, known: { type: "array", items: S }, missing: { type: "array", items: S } },
      },
    },
    required: ["reply", "urgency"],
  },
};

function cleanState(s) {
  s = s && typeof s === "object" && !Array.isArray(s) ? s : null;
  if (!s) return null;
  return {
    mode: ["general", "symptom", "record"].includes(s.mode) ? s.mode : "general",
    topic: str(s.topic, 120),
    known: arr(s.known, 12).map((x) => str(x, 160)).filter(Boolean),
    missing: arr(s.missing, 6).map((x) => str(x, 120)).filter(Boolean),
  };
}

function cleanContext(c) {
  c = c && typeof c === "object" ? c : null;
  if (!c) return null;
  const out = {};
  const p = c.profile && typeof c.profile === "object" ? c.profile : null;
  if (p) {
    const prof = {};
    if (Number.isFinite(+p.age) && +p.age >= 0 && +p.age < 130) prof.age = Math.round(+p.age);
    const al = arr(p.allergies, 10).map((x) => str(x, 60)).filter(Boolean);
    if (al.length) prof.allergies = al;
    if (Object.keys(prof).length) out.profile = prof;
  }
  const recs = arr(c.records, 10).map((r) => ({
    id: str(r && r.id, 6), title: str(r && r.title, 120), date: str(r && r.date, 20), test: str(r && r.test, 80), value: str(r && r.value, 120),
  })).filter((r) => /^R\d{1,2}$/.test(r.id) && r.test);
  if (recs.length) out.records = recs;
  return Object.keys(out).length ? out : null;
}

function cleanAnswer(a, recordIds, passages = []) {
  a = a && typeof a === "object" ? a : {};
  const reply = str(a.reply, 6000);
  if (!reply) return null;
  return {
    reply,
    sections: arr(a.sections, 6).map((s) => ({ title: str(s && s.title, 80), body: str(s && s.body, 3000) })).filter((s) => s.title && s.body),
    urgency: ["routine", "same_day", "emergency"].includes(a.urgency) ? a.urgency : "routine",
    question: str(a.question, 220),
    options: arr(a.options, 4).map((o) => str(o, 60)).filter(Boolean),
    uncertainty: str(a.uncertainty, 1000),
    safety_note: str(a.safety_note, 600),
    // A claim about the person's records is shown only if it names a record that was actually sent.
    record_claims: arr(a.record_claims, 8).map((c) => ({ text: str(c && c.text, 400), source: str(c && c.source, 6) })).filter((c) => c.text && recordIds.has(c.source)),
    state: cleanState(a.state),
    current_emergency: a.current_emergency,
    // A source is shown only if the model cites a passage that was really retrieved for this question.
    sources: [...new Set(arr(a.citations, 6).map((c) => str(c, 4)))].map((id) => passages.find((p) => p.id === id)).filter(Boolean)
      .map((p) => ({ title: p.title, publisher: p.publisher, url: p.url, published: p.published })),
  };
}

export default async (req, context) => {
  const cfg = settings("chat");
  const url = new URL(req.url);

  if (req.method === "GET") {
    // Evaluation-access check for the staging pipeline: says only whether this request's token is accepted here.
    // No AI call. Counted like any other request (wrong tokens get the small "test" limit, so guessing is slow).
    if (url.searchParams.get("eval") === "1") {
      const rle = await checkRate(req, context, "test");
      if (!rle.allowed) return json({ error: rle.error }, rle.status);
      return json({ eval_access: rle.who === "eval" && evalAccess(req) });
    }
    if (url.searchParams.get("test") !== "1") return json({ error: "invalid" }, 400);
    if (!cfg.key) return json({ ok: false, error: "not_configured", missing: ["ANTHROPIC_API_KEY"] });
    const rlt = await checkRate(req, context, "test");
    if (!rlt.allowed) return json({ ok: false, error: rlt.error }, rlt.status);
    const r = await callClaude(cfg, { system: "Reply with the single word: ok", messages: [{ role: "user", content: "ping" }], maxTokens: 5, timeoutMs: 15000 });
    return r.error ? json({ ok: false, ...r }) : json({ ok: true, provider: "anthropic", model: cfg.model });
  }
  if (req.method !== "POST") return json({ error: "invalid" }, 405);

  const parsed = await readJson(req, MAX_BODY);
  if (parsed.error) return json({ error: parsed.error }, parsed.status);
  const body = parsed.body || {};

  // Validate and normalise the conversation.
  const msgs = arr(body.messages, MAX_TURNS + 1);
  if (!msgs.length || msgs.length > MAX_TURNS) return json({ error: "invalid" }, 400);
  const turns = [];
  for (const m of msgs) {
    const role = m && m.role === "assistant" ? "assistant" : m && m.role === "user" ? "user" : null;
    const content = typeof (m && m.content) === "string" ? m.content.trim() : "";
    if (!role || !content) continue;
    if (content.length > 2000) return json({ error: "too_large" }, 413);
    if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].content += "\n\n" + content;
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "invalid" }, 400);

  const ctx = cleanContext(body.context);
  const state = cleanState(body.state);
  const recordIds = new Set((ctx && ctx.records ? ctx.records : []).map((r) => r.id));
  const latest = turns[turns.length - 1].content;
  const flags = emergencyCheck(latest);

  // Safety first: emergency wording gets fixed guidance even if the AI can't be reached.
  if (!cfg.key) return flags.length ? json({ ...emergencyGuidance(flags), state, ai_unavailable: "not_configured" }) : json({ error: "not_configured", missing: ["ANTHROPIC_API_KEY"] }, 503);
  const rl = await checkRate(req, context, "chat", { ai: true });
  const t0 = Date.now();
  const logged = (resp, meta) => { evalLog(req, rl, { route: "chat", status: resp.status, rule_flags: flags, ms: Date.now() - t0, ...meta }); return resp; };
  if (!rl.allowed) return flags.length ? json({ ...emergencyGuidance(flags), state, ai_unavailable: rl.error })
    : new Response(JSON.stringify({ error: rl.error, retry_after: rl.retryAfter }), { status: rl.status, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(rl.retryAfter || 60) } });
  // With real accounts switched on, the assistant answers signed-in accounts only. Emergency wording still gets the
  // fixed guidance, so nobody is left without it. (Evaluation runs on staging are exempt.)
  const accountsOn = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) || /^prod/i.test(process.env.DOCTINE_ENV || "");
  if (accountsOn && rl.who !== "user" && rl.who !== "eval") return flags.length ? json({ ...emergencyGuidance(flags), state, ai_unavailable: "sign_in_required" }) : json({ error: "sign_in_required", message: "Please sign in to use the assistant." }, 401);

  // Switched off in the admin console (or maintenance mode): enforced here on the server. Emergency guidance still works.
  if (await aiSwitchedOff()) return flags.length ? json({ ...emergencyGuidance(flags), state, ai_unavailable: "ai_paused" }) : json({ error: "ai_paused", message: "The assistant is paused at the moment." }, 503);

  let system = SYSTEM;
  if (state) system += `\n\nYour notes from earlier in this conversation (written by you; the person may have corrected them since):\n${JSON.stringify(state)}`;
  if (ctx) system += `\n\nSaved information the person chose to share for this chat (entered or confirmed by them; not verified by Doctine):\n${JSON.stringify(ctx)}`;
  else system += `\n\nThe person has not shared any saved records or profile in this chat. Do not refer to records.`;
  if (flags.length) system += `\n\nDoctine's safety check flagged possible emergency wording (${flags.join(", ")}) in the latest message. Treat this as urgent unless the message clearly isn't about a current situation (e.g. a general question). Lead with emergency guidance.`;

  // Optional reference passages (skipped for emergencies, where speed matters most).
  const started = Date.now();
  const kb = flags.length ? { provider: "none", status: "skipped", version: "", passages: [] } : await retrieve({ query: [state && state.topic, latest].filter(Boolean).join(" — "), mode: state ? state.mode : "general" });
  if (kb.passages.length) {
    system += `\n\nReference passages retrieved for this question from sources Doctine's operators selected. Use them where relevant, list the ids you relied on in citations, and never cite anything that is not here:\n` +
      kb.passages.map((p) => `[${p.id}] ${p.title} — ${p.publisher}${p.published ? " (" + p.published + ")" : ""}\n${p.text}`).join("\n\n");
  } else {
    system += `\n\nNo reference passages are available for this answer. Answer from general medical knowledge, do not cite or name specific documents, guidelines or studies as if you had read them, and leave citations empty.`;
  }
  const r = await callClaude(cfg, { system, messages: turns, tool: TOOL, maxTokens: 1600, timeoutMs: Math.max(8000, 25000 - (Date.now() - started)) });
  if (r.error) {
    if (flags.length) return logged(json({ ...emergencyGuidance(flags), state, ai_unavailable: r.error }), { error: r.error, urgency: "emergency", safety: "rule" });
    return logged(json(r, r.error === "ai_timeout" ? 504 : r.error === "ai_rate_limited" ? 429 : 502), { error: r.error });
  }
  const ans = cleanAnswer(r.input, recordIds, kb.passages);
  if (!ans) {
    if (flags.length) return logged(json({ ...emergencyGuidance(flags), state, ai_unavailable: "bad_output" }), { error: "bad_output", urgency: "emergency", safety: "rule" });
    return logged(json({ error: "bad_output" }, 502), { error: "bad_output" });
  }
  const current = ans.current_emergency;
  delete ans.current_emergency;
  if (flags.length && current !== false) {
    // The rules fired and the model did not clearly say this is a general question: emergency it is.
    ans.urgency = "emergency";
    ans.safety = "rule";
    // Deterministic backstop: the emergency number and, for self-harm, the Tele-MANAS helpline are always present,
    // whatever wording the model chose.
    const said = [ans.reply, ans.safety_note, ...ans.sections.map((s) => s.body)].join(" ");
    const add = [];
    if (!/\b112\b/.test(said)) add.push("If this is happening now, call 112 or go to the nearest emergency department.");
    if (flags.includes("self_harm") && !/14416/.test(said)) add.push("You can call Tele-MANAS on 14416 (free, 24×7) to talk to a trained counsellor.");
    if (add.length) ans.safety_note = [ans.safety_note, ...add].filter(Boolean).join(" ");
  } else if (flags.length) {
    // A general question that mentions emergency symptoms ("what are the signs of a stroke?").
    ans.safety_note = (ans.safety_note ? ans.safety_note + " " : "") + (flags.includes("self_harm")
      ? "If you’re having thoughts of harming yourself now, call Tele-MANAS on 14416 (free, 24×7) or 112."
      : "If this is happening to someone now, call 112 straight away.");
  } else if (ans.urgency === "emergency") ans.safety = "model";
  return logged(json({ ...ans, knowledge: kb.status, ...(kb.version ? { knowledge_version: kb.version } : {}), state: ans.state || state }),
    { urgency: ans.urgency, safety: ans.safety || "", current_emergency: current === undefined ? null : current, follow_up: !!ans.question, sections: ans.sections.length, sources: ans.sources.length, knowledge: kb.status });
};

export const config = { path: "/api/chat" };
