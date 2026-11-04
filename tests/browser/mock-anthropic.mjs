/**
 * Doctine · stand-in for the Anthropic Messages API, used only by the browser tests.
 * It answers through the same tools the real functions force (respond / record_document / explain), with scripted,
 * realistic content, so the tests exercise the REAL /api/chat and /api/scan code: validation, emergency rules,
 * conversation state, error mapping and output cleaning. It does not judge medical quality; tests/live-eval.mjs does
 * that against the real model.
 * Control endpoint: POST /__mode {"status":401} makes the next requests fail with that HTTP status ({"status":200} resets).
 */
import { createServer } from "node:http";

const tool = (name, input) => ({ id: "msg_test", type: "message", role: "assistant", model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name, input }] });

function answerChat(body) {
  const msgs = body.messages || [];
  const last = String(msgs[msgs.length - 1]?.content || "").toLowerCase();
  const flagged = /safety check flagged/.test(body.system || "");
  const hasNotes = /Your notes from earlier/.test(body.system || "");
  if (flagged) return { reply: "This could be a medical emergency. Call 112 now or go to the nearest emergency department.", urgency: "emergency", current_emergency: true, sections: [] };
  if (/headache/.test(last) && msgs.length === 1)
    return { reply: "Headaches are very common and usually not serious. A couple of details will help me give better advice.", urgency: "routine", question: "How long have you had this headache?", options: ["Since today", "A few days", "More than a week"],
      state: { mode: "symptom", topic: "headache", known: [], missing: ["duration", "fever"] } };
  if (hasNotes && /few days|week/.test(last))
    return { reply: "A headache lasting a few days is often due to tension, poor sleep, dehydration or sinus congestion.", sections: [{ title: "When to see a doctor", body: "See a doctor soon if it keeps getting worse, or urgently with fever and a stiff neck." }],
      urgency: "routine", question: "Do you also have a fever?", options: ["Yes", "No"], state: { mode: "symptom", topic: "headache", known: ["a few days"], missing: ["fever"] } };
  if (/hba1c/.test(last)) return { reply: "HbA1c shows your average blood sugar over about three months. 5.7–6.4% is in the prediabetes range.", urgency: "routine", sections: [] };
  return { reply: "Here is some general health information about that. Ask me anything else you'd like to know.", urgency: "routine", sections: [] };
}

export function startMockAnthropic(port = 8790) {
  let forced = 200;
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/__mode") { forced = JSON.parse(raw).status || 200; res.end("{}"); return; }
    if (req.url === "/__seen") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(seen)); return; }
    if (req.url !== "/v1/messages" || !req.headers["x-api-key"]) { res.writeHead(401); res.end('{"error":{"type":"authentication_error"}}'); return; }
    if (forced !== 200) { res.writeHead(forced, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: forced === 400 ? "Your credit balance is too low" : "simulated failure" } })); return; }
    const body = JSON.parse(raw);
    const t = body.tools && body.tools[0] && body.tools[0].name;
    seen.push({ tool: t || "text", turns: (body.messages || []).length, hasNotes: /Your notes from earlier/.test(body.system || ""), flagged: /safety check flagged/.test(body.system || "") });
    let out;
    if (!t) out = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
    else if (t === "respond") out = tool("respond", answerChat(body));
    else if (t === "record_document") out = tool("record_document", {
      title: "Prescription – Dr. Sample Physician – 1 Nov 2026", type: "prescription", date: "2026-11-01", doctor: "Dr. Sample Physician", facility: "Sample Clinic",
      medicines: [{ raw: "Tab Pan-D 40 1-0-0 AC x5d", name: "Pan-D 40", form: "Tablet", strength: "40 mg", frequency: "1-0-0", timing: "Before food", duration: "5 days", confidence: "high", alternatives: [] },
                  { raw: "Tab Mon[?]-LC 0-0-1", name: "Montair-LC", frequency: "0-0-1", confidence: "low", alternatives: ["Montek-LC"] }],
      lab_results: [], diagnoses: ["Acidity"], unreadable: ["line 2, middle of the name"], overall_confidence: "medium", transcription: "Rx\nTab Pan-D 40 1-0-0 AC x5d\nTab Mon[?]-LC 0-0-1" });
    else if (t === "explain") out = tool("explain", { reply: "This is a prescription from Dr. Sample Physician for acidity.", sections: [{ title: "Your medicines", body: "Pan-D 40 reduces stomach acid; take it as written, before food." }], urgency: "routine",
      uncertainty: "The second medicine name wasn't fully readable, so confirm it with your pharmacist." });
    else { res.writeHead(400); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-test", ...out }));
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
}
