/**
 * Doctine · /api/scan  (Netlify Function)
 *
 * action "read":    photos of a medical document  → structured reading + automatic title
 * action "explain": a document reading + the chat  → a full, plain-language explanation
 *
 * Shares its Anthropic call, rate limit and error mapping with /api/chat (netlify/lib/ai.mjs).
 * Needs ANTHROPIC_API_KEY in Netlify → Site configuration → Environment variables.
 * Optional: AI_SCAN_MODEL (defaults to AI_MODEL when that is a Claude model, else claude-sonnet-5-5).
 * The key stays on the server; the browser never sees it.
 */

import { json, settings as sharedSettings, clientIp, callClaude as sharedCall, str, arr, conf as cf } from "../lib/ai.mjs";
import { aiSwitchedOff } from "../lib/settings.mjs";
import { checkRate } from "../lib/ratelimit.mjs";

const TIME_LIMIT_MS = 26000;
const MAX_BODY = 6_000_000;
const MAX_IMAGES = 4;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const settings = () => sharedSettings("scan");

/* ------------------------------------------------------------------ */
/* Instructions                                                         */
/* ------------------------------------------------------------------ */

const READ_PROMPT = `You read photographed medical documents for Doctine, an Indian personal health records app. Most are prescriptions handwritten by Indian doctors, often hurried, on printed letterheads, sometimes partly in Hindi or another Indian language. Others are lab reports, imaging reports, discharge summaries and pharmacy bills.

Transcribe faithfully and structure. Never give medical advice here. A wrong medicine name or dose can cause harm, so honesty about uncertainty matters more than completeness.

- Separate the printed letterhead (doctor, degrees, registration number, clinic, address, phones) from the handwriting. Prescriptions start after "Rx".
- Notation: Tab/T. tablet, Cap capsule, Syp/Syr syrup, Inj injection, Oint ointment, Gtt drops. OD once daily, BD twice, TDS thrice, QID four times, HS bedtime, SOS when needed, STAT now, "1-0-1" = morning-afternoon-night (½ = half). AC before food, PC after food, "khane se pehle/baad" before/after food. "x 5d" 5 days, "1/52" 1 week, "1/12" 1 month. c/o complaints, k/c/o known case of, Dx/Imp diagnosis, Adv advised, F/U follow-up.
- Indian medicines are mostly brand names (Dolo, Pan-D, Augmentin, Montair-LC, Telma). Use brand knowledge only when the visible letters support it. If several fit, give the best as name, the others as alternatives, and set confidence medium or low.
- Never invent a dose, strength, frequency or duration that is not written; leave it empty.
- Unreadable words: write [?] in the transcription and list where they are in "unreadable".
- Lab reports: each test with value, unit, reference range and the report's own flag. Do not interpret.
- Dates are DD/MM/YYYY in India; give YYYY-MM-DD only when unambiguous.
- title: a short name for the record, like "Prescription – Dr. R. K. Sinha – 28 Oct 2026" or "CBC report – Lal PathLabs – 2 Sep 2026" (type, then doctor or lab, then date; leave out what is unknown).
Record everything with the record_document tool.`;

const EXPLAIN_PROMPT = `You are Doctine's health assistant for people in India. The person has attached a medical document (its reading is below, made from a photo of their paper) and is asking about it.

Explain in plain, warm language a non-medical adult understands, using the document's own details:
- what the document is and who wrote it;
- the diagnosis or findings, and what they usually mean;
- each medicine: what it is generally used for, and how the paper says to take it (repeat the dose exactly as written; never suggest a different dose, stopping, or starting anything);
- tests advised or results, and what high/low values generally indicate;
- follow-up and sensible questions to ask the doctor.
Where the reading is marked medium or low confidence, or a word was unreadable, say so and tell them to confirm that item with their doctor or pharmacist. Do not diagnose beyond what the document says. If anything suggests an emergency (chest pain, breathing difficulty, stroke signs, severe bleeding, very high fever in an infant, suicidal thoughts), set urgency to "emergency" and tell them to call 112.
Use short paragraphs. Put the main answer in "reply" and details in "sections" (e.g. "Diagnosis", "Your medicines", "Tests", "Questions for your doctor"). Answer follow-up questions directly, still grounded in the document. Reply with the explain tool.`;

/* ------------------------------------------------------------------ */
/* Tool schemas                                                         */
/* ------------------------------------------------------------------ */

const conf = { type: "string", enum: ["high", "medium", "low"] };
const S = { type: "string" };
const READ_TOOL = {
  name: "record_document",
  description: "Record the reading of the medical document.",
  input_schema: {
    type: "object",
    properties: {
      title: S,
      type: { type: "string", enum: ["prescription", "lab_report", "imaging_report", "discharge_summary", "bill_or_receipt", "other"] },
      date: S, doctor: S, facility: S, patient: S,
      medicines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            raw: S, name: S, form: S, strength: S, frequency: S, timing: S, duration: S, instructions: S,
            confidence: conf, alternatives: { type: "array", items: S },
          },
          required: ["raw", "name", "confidence"],
        },
      },
      lab_results: {
        type: "array",
        items: { type: "object", properties: { test: S, value: S, unit: S, range: S, flag: S, confidence: conf }, required: ["test", "value"] },
      },
      diagnoses: { type: "array", items: S },
      complaints: { type: "array", items: S },
      tests_advised: { type: "array", items: S },
      advice: { type: "array", items: S },
      follow_up: S,
      phones: { type: "array", items: { type: "object", properties: { number: S, label: S }, required: ["number"] } },
      unreadable: { type: "array", items: S },
      overall_confidence: conf,
      transcription: { type: "string", description: "Full text in reading order, [?] for unreadable words. At most about 3000 characters." },
    },
    required: ["title", "type", "medicines", "overall_confidence", "transcription"],
  },
};
const EXPLAIN_TOOL = {
  name: "explain",
  description: "Answer the person about their document.",
  input_schema: {
    type: "object",
    properties: {
      reply: S,
      sections: { type: "array", items: { type: "object", properties: { title: S, body: S }, required: ["title", "body"] } },
      uncertainty: { type: "string", description: "What the reading or this answer can't tell them; empty if nothing." },
      safety_note: S,
      urgency: { type: "string", enum: ["routine", "same_day", "emergency"] },
      question: { type: "string", description: "Optional follow-up question to offer; empty if none." },
      options: { type: "array", items: S },
    },
    required: ["reply", "urgency"],
  },
};

async function callClaude(cfg, { system, content, tool, maxTokens }) {
  const r = await sharedCall(cfg, { system, messages: content, tool, maxTokens, timeoutMs: TIME_LIMIT_MS });
  if (r.error === "ai_error") console.error("[scan] provider error");
  return r;
}

/* ------------------------------------------------------------------ */
/* Cleaning model output (never trust it blindly)                        */
/* ------------------------------------------------------------------ */


function cleanDoc(d) {
  d = d && typeof d === "object" ? d : {};
  return {
    title: str(d.title, 120),
    type: ["prescription", "lab_report", "imaging_report", "discharge_summary", "bill_or_receipt", "other"].includes(d.type) ? d.type : "other",
    date: str(d.date, 20), doctor: str(d.doctor, 120), facility: str(d.facility, 160), patient: str(d.patient, 120),
    medicines: arr(d.medicines).map((m) => ({
      raw: str(m && m.raw, 200), name: str(m && m.name, 100), form: str(m && m.form, 40), strength: str(m && m.strength, 60),
      frequency: str(m && m.frequency, 60), timing: str(m && m.timing, 60), duration: str(m && m.duration, 60),
      instructions: str(m && m.instructions, 200), confidence: cf(m && m.confidence),
      alternatives: arr(m && m.alternatives, 4).map((a) => str(a, 100)).filter(Boolean),
    })).filter((m) => m.name || m.raw),
    lab_results: arr(d.lab_results, 60).map((l) => ({
      test: str(l && l.test, 80), value: str(l && l.value, 40), unit: str(l && l.unit, 30),
      range: str(l && l.range, 60), flag: str(l && l.flag, 10), confidence: cf(l && l.confidence),
    })).filter((l) => l.test),
    diagnoses: arr(d.diagnoses).map((x) => str(x, 200)).filter(Boolean),
    complaints: arr(d.complaints).map((x) => str(x, 200)).filter(Boolean),
    tests_advised: arr(d.tests_advised).map((x) => str(x, 120)).filter(Boolean),
    advice: arr(d.advice).map((x) => str(x, 240)).filter(Boolean),
    follow_up: str(d.follow_up, 200),
    phones: arr(d.phones, 8).map((p) => ({ number: str(p && p.number, 30), label: str(p && p.label, 40) })).filter((p) => p.number),
    unreadable: arr(d.unreadable, 20).map((x) => str(x, 160)).filter(Boolean),
    overall_confidence: cf(d.overall_confidence),
    transcription: str(d.transcription, 4000),
  };
}

function cleanAnswer(a) {
  a = a && typeof a === "object" ? a : {};
  const reply = str(a.reply, 6000);
  if (!reply) return null;
  return {
    reply,
    sections: arr(a.sections, 8).map((s) => ({ title: str(s && s.title, 80), body: str(s && s.body, 4000) })).filter((s) => s.title && s.body),
    uncertainty: str(a.uncertainty, 1200),
    safety_note: str(a.safety_note, 600),
    urgency: ["routine", "same_day", "emergency"].includes(a.urgency) ? a.urgency : "routine",
    question: str(a.question, 200),
    options: arr(a.options, 4).map((o) => str(o, 80)).filter(Boolean),
  };
}

/* ------------------------------------------------------------------ */
/* Handler                                                              */
/* ------------------------------------------------------------------ */

export default async (req, context) => {
  const cfg = settings();
  if (req.method === "GET") {
    const ok = !!cfg.key;
    return json(ok ? { ok: true, provider: "anthropic", model: cfg.model } : { ok: false, error: "not_configured", missing: ["ANTHROPIC_API_KEY"] });
  }
  if (req.method !== "POST") return json({ error: "invalid" }, 405);
  if (!cfg.key) return json({ error: "not_configured", missing: ["ANTHROPIC_API_KEY"] }, 503);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "invalid" }, 400); }

  const ip = clientIp(req, context);
  const action = body && body.action;
  if (action !== "read" && action !== "explain") return json({ error: "invalid" }, 400);
  const rl = await checkRate(req, context, action === "read" ? "scan" : "explain", { ai: true });
  if (!rl.allowed) return json({ error: rl.error, retry_after: rl.retryAfter }, rl.status);
  // Reading a document's images, or explaining a saved document, is for signed-in accounts only: it sends health
  // documents to the AI provider and costs more than a chat message. (Evaluation runs on staging are exempt.)
  const accountsOn = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) || /^prod/i.test(process.env.DOCTINE_ENV || "");
  if (accountsOn && rl.who !== "user" && rl.who !== "eval") return json({ error: "sign_in_required", message: "Please sign in to read documents." }, 401);

  // Switched off in the admin console (or maintenance mode): checked here, on the server, not just hidden in the app.
  if (await aiSwitchedOff()) return json({ error: "ai_paused", message: "Reading documents is paused at the moment. You can still type the details in yourself." }, 503);

  if (action === "read") {
    const images = arr(body.images, MAX_IMAGES + 1);
    if (!images.length || images.length > MAX_IMAGES) return json({ error: "invalid" }, 400);
    for (const im of images) {
      if (!im || !IMAGE_TYPES.has(im.media_type) || typeof im.data !== "string" || im.data.length > 2_800_000 || !/^[A-Za-z0-9+/=]+$/.test(im.data.slice(0, 200))) {
        return json({ error: "invalid" }, 400);
      }
    }
    const content = [{
      role: "user",
      content: [
        ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })),
        { type: "text", text: images.length > 1 ? `These ${images.length} images are pages of one document, in order. Read it.` : "Read this document." },
      ],
    }];
    const r = await callClaude(cfg, { system: READ_PROMPT, content, tool: READ_TOOL, maxTokens: 3000 });
    if (r.error) return json(r, r.error === "ai_timeout" ? 504 : 502);
    return json({ doc: cleanDoc(r.input) });
  }

  // explain
  const doc = cleanDoc(body.doc);
  const msgs = arr(body.messages, 20)
    .map((m) => ({ role: m && m.role === "assistant" ? "assistant" : "user", content: str(m && m.content, 2000) }))
    .filter((m) => m.content);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "invalid" }, 400);
  // The API needs alternating turns that start with the user: merge neighbours with the same role.
  const turns = [];
  for (const m of msgs) {
    if (turns.length && turns[turns.length - 1].role === m.role) turns[turns.length - 1].content += "\n\n" + m.content;
    else turns.push({ ...m });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length) return json({ error: "invalid" }, 400);
  turns[0].content = "The document, as read from my photo:\n" + JSON.stringify(doc) + "\n\n" + turns[0].content;

  const r = await callClaude(cfg, { system: EXPLAIN_PROMPT, content: turns, tool: EXPLAIN_TOOL, maxTokens: 2000 });
  if (r.error) return json(r, r.error === "ai_timeout" ? 504 : 502);
  const ans = cleanAnswer(r.input);
  if (!ans) return json({ error: "bad_output" }, 502);
  return json(ans);
};

export const config = { path: "/api/scan" };
