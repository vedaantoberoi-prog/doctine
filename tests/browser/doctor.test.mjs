/**
 * Doctine · the doctor page (/doctor), in a real browser. Supabase sign-in is simulated by fake-supabase-strict.js and
 * /api/doctor by a stand-in that keeps the application in memory with the same rules as the database (editable only
 * before submission; three documents and the declaration required). The server and database rules themselves are tested
 * in tests/doctor.test.mjs and tests/doctor.test.sql. Fictional doctor and documents only.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { SCOPES } from "../../netlify/lib/doctors/sharing.mjs";
import { STATUS_TEXT, COUNCILS, SPECIALTIES, LANGUAGES, MODES, DOCUMENT_KINDS, MAX_FILE_BYTES } from "../../netlify/lib/doctors/verification.mjs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const out = [];
const check = (name, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + name + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
const errs = [];
const OPTIONS = { councils: COUNCILS, specialties: SPECIALTIES, languages: LANGUAGES, modes: MODES, document_kinds: DOCUMENT_KINDS, status_text: STATUS_TEXT, max_file_bytes: MAX_FILE_BYTES };

async function open({ on = true, width = 1280, verified = false } = {}) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message)); pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|status of 4\d\d/.test(m.text())) errs.push(m.text()); });
  const log = { calls: [], direct: [] };
  const app = { status: "NOT_STARTED", exists: false, editable: true, documents: [], history: [], qualifications: [], specialties: [], languages: [], consultation_modes: [] };
  if (verified) Object.assign(app, { status: "VERIFIED", exists: true, editable: false, full_name: "Dr Meera Fictional", expires_at: new Date(Date.now() + 300 * 864e5).toISOString() });
  const missing = () => [...["full_name", "registration_number", "registration_council", "registration_year"].filter((k) => !app[k]), ...(app.qualifications.length ? [] : ["qualifications"]),
    ...(app.specialties.length ? [] : ["specialties"]), ...(app.languages.length ? [] : ["languages"]), ...(app.declaration_at ? [] : ["declaration"]),
    ...["registration_certificate", "degree_certificate", "photo_id"].filter((k) => !app.documents.some((d) => d.kind === k)).map((k) => "doc:" + k)];
  const view = () => ({ ...app, missing: missing() });
  await pg.route("**/*", async (r) => {
    const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", environment: "staging", features: { doctor_onboarding: on } }) });
    if (u.endsWith("/api/doctor")) {
      const send = (status, j) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(j) });
      if (!/^Bearer tok-/.test(r.request().headers().authorization || "")) return send(401, { error: "unauthorized" });
      if (!on) return send(503, { error: "switched_off" });
      if (r.request().method() === "GET") { log.calls.push({ action: "GET" }); return send(200, { available: true, application: view(), options: OPTIONS, sharing: { on: verified, scopes: SCOPES } }); }
      const body = JSON.parse(r.request().postData() || "{}"); log.calls.push(body);
      if (body.action === "share_code") return send(200, { code: "ABCDEFGHJK" });
      if (body.action === "patients") return send(200, { patients: [{ id: "f8000000-0000-0000-0000-0000000000s1", patient: { name: "Asha Patient Fictional", age: 36, sex_at_birth: "female" }, scopes: ["medicines", "labs"], purpose: "second_opinion", note: "Fictional cough", expires_at: new Date(Date.now() + 864e5).toISOString() }] });
      if (body.action === "patient_record") return send(200, { scope: body.scope, patient: { name: "Asha Patient Fictional" }, shared_until: new Date(Date.now() + 864e5).toISOString(), read_at: new Date().toISOString(),
        data: body.scope === "medicines" ? { items: [{ name: "Fictional amlodipine", strength: "5 mg", dose: "1 daily", status: "active", start_date: "2026-08-01", source: "patient" }] }
          : { items: [{ test: "HbA1c", value: "5.6", unit: "%", date: "2026-11-10", report: "Fictional blood report", source: "ai_extracted" }] } });
      if (body.action === "save") {
        if (!app.editable) return send(400, { error: "invalid", message: "the application can not be changed while it is " + app.status });
        const p = body.profile; Object.assign(app, { exists: true, full_name: p.full_name || null, registration_number: (p.registration_number || "").toUpperCase() || null, registration_council: p.registration_council || null,
          registration_year: p.registration_year ? +p.registration_year : null, qualifications: p.qualifications.map((q) => ({ ...q, year: +q.year })), specialties: p.specialties, languages: p.languages, consultation_modes: p.consultation_modes,
          experience_years: p.experience_years === "" ? null : +p.experience_years, bio: p.bio || null, declaration_at: p.declaration ? app.declaration_at || new Date().toISOString() : null });
        return send(200, { application: view() });
      }
      if (body.action === "upload") { app.exists = true; app.documents.push({ id: "f4000000-0000-0000-0000-00000000000" + app.documents.length, kind: body.kind, file_name: body.file_name, mime: "application/pdf", size_bytes: Math.round(body.data.length * 0.75), uploaded_at: new Date().toISOString() }); return send(200, { application: view() }); }
      if (body.action === "remove_document") { app.documents = app.documents.filter((d) => d.id !== body.id); return send(200, { application: view() }); }
      if (body.action === "submit") { if (missing().length) return send(400, { error: "incomplete", missing: missing() });
        Object.assign(app, { status: "DOCUMENTS_SUBMITTED", editable: false }); app.history.push({ from: "NOT_STARTED", to: "DOCUMENTS_SUBMITTED", by: "doctor", reason: null, at: new Date().toISOString() }); return send(200, { application: view() }); }
      return send(400, { error: "invalid_action" });
    }
    if (u.startsWith(BASE)) return r.continue();
    log.direct.push(u); return r.abort();
  });
  await pg.goto(BASE + "/doctor/");
  await pg.waitForSelector(".gate, .dwrap", { timeout: 10000 }); await pg.waitForTimeout(200);
  return { ctx, pg, log, app };
}
const text = (pg, s) => pg.evaluate((q) => document.querySelector(q)?.innerText || "", s);
const settle = async (pg) => { await pg.waitForTimeout(250); await pg.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {}); };

// switched off
let { ctx, pg, log } = await open({ on: false });
check("with the switch off, the page says doctor sign-up isn't open and asks nothing", /isn't open yet/.test(await text(pg, ".gate h1")) && !(await pg.$("#pw")) && !log.calls.length);
await ctx.close();

// sign in and fill in
({ ctx, pg, log } = await open());
check("signed out: the sign-in form, pointing new people to app.doctine.com to create an account", !!(await pg.$("#signin #pw")) && (await text(pg, "#signin")).includes("app.doctine.com"));
await pg.evaluate(async () => { const c = window.supabase.createClient("https://x.supabase.co", "anon"); await c.auth.signUp({ email: "dr.asha.fictional@example.test", password: "fictional-pass-1", options: { data: {} } }); });
await pg.reload(); await pg.waitForSelector(".dwrap #full_name", { timeout: 10000 });
check("signed in: the application form, status 'Not submitted', and a clear note that nobody is listed for patients yet", (await text(pg, "#status")) === "Not submitted" && /consultations aren't open/i.test(await text(pg, ".dwrap")));
check("the council list is the official councils, the specialties and languages are fixed lists", (await pg.$$eval("#registration_council option", (o) => o.length)) === COUNCILS.length + 1 && (await pg.$$eval("input[name=specialties]", (x) => x.length)) === SPECIALTIES.length);
await pg.fill("#full_name", "Dr Asha Fictional"); await pg.fill("#registration_number", "mmc/2010/12345"); await pg.fill("#registration_year", "2010");
await pg.selectOption("#registration_council", "Maharashtra Medical Council");
await pg.fill("#qd0", "MBBS"); await pg.fill("#qi0", "Fictional Medical College"); await pg.fill("#qy0", "2009");
await pg.check('input[name=specialties][value="General physician"]'); await pg.check('input[name=languages][value="English"]'); await pg.check('input[name=consultation_modes][value="video"]');
for (const s of SPECIALTIES.slice(1, 6)) await pg.check(`input[name=specialties][value="${s}"]`).catch(() => {});
check("at most 5 specialties can be ticked", (await pg.$$eval("input[name=specialties]:checked", (x) => x.length)) === 5);
await pg.click("#save"); await settle(pg);
const saved = log.calls.find((c) => c.action === "save");
check("Save sends the details as typed (no id of any kind; the server takes the person from the sign-in)", !!saved && saved.profile.full_name === "Dr Asha Fictional" && saved.profile.qualifications[0].institution === "Fictional Medical College" && !("user_id" in saved) && !("p_user" in saved));
check("after saving, the page lists what's still needed: the declaration and the three documents", /Still needed/.test(await text(pg, ".dwrap")) && /Photo ID \(file\)/.test(await text(pg, ".dwrap")) && /The declaration/.test(await text(pg, ".dwrap")));
await pg.click("#submit"); await settle(pg);
check("Submit with something missing sends nothing to submit", !log.calls.some((c) => c.action === "submit"));
const pdf = { name: "registration.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\n% fictional\n") };
for (const kind of ["registration_certificate", "degree_certificate", "photo_id"]) { await pg.setInputFiles(`input[data-up=${kind}]`, { ...pdf, name: kind + ".pdf" }); await settle(pg); await pg.waitForSelector(`[data-kind=${kind}] .dfile`); }
const up = log.calls.filter((c) => c.action === "upload");
check("each document uploads as its own kind, as base64 of the file", up.length === 3 && up.every((c) => /^data:application\/pdf;base64,/.test(c.data)) && up.map((c) => c.kind).join() === "registration_certificate,degree_certificate,photo_id");
check("…and typed details survive the upload (saved first)", (await pg.inputValue("#full_name")) === "Dr Asha Fictional");
await pg.setInputFiles("input[data-up=other]", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }); await pg.waitForTimeout(200);
check("a text file is refused in the page before upload", log.calls.filter((c) => c.action === "upload").length === 3);
await pg.check("#declaration"); await pg.click("#submit"); await settle(pg);
check("with everything in place, Submit sends it and the status becomes 'Submitted'", log.calls.some((c) => c.action === "submit") && (await text(pg, "#status")) === "Submitted");
check("once submitted, the details are read-only and there is no Save or upload", await pg.$eval("#full_name", (i) => i.disabled) && !(await pg.$("#save")) && !(await pg.$("input[data-up]")));
check("the history shows the submission", /Submitted/.test(await text(pg, ".timeline")) && /by you/.test(await text(pg, ".timeline")));
await ctx.close();

// a verified doctor with record sharing on
({ ctx, pg, log } = await open({ verified: true }));
await pg.evaluate(async () => { const c = window.supabase.createClient("https://x.supabase.co", "anon"); await c.auth.signUp({ email: "dr.meera.fictional@example.test", password: "fictional-pass-1", options: { data: {} } }); });
await pg.reload(); await pg.waitForSelector("#shared", { timeout: 10000 });
check("a verified doctor sees “Records shared with you”, and that each opening is visible to the patient", /each time you open something it's recorded/i.test(await text(pg, "#shared")));
await pg.click("#getcode"); await settle(pg);
check("…their sharing code, shown in two groups", (await text(pg, "#code")) === "ABCDE-FGHJK");
await pg.click("#loadpts"); await settle(pg);
check("…the patients sharing with them, with what they shared and why", /Asha Patient Fictional/.test(await text(pg, "#shared")) && /a second opinion/.test(await text(pg, "#shared")) && (await pg.$$("[data-pr]")).length === 2);
await pg.click('[data-pr$="|labs"]'); await settle(pg);
const lt = await text(pg, "#shared");
check("opening a part shows it with where each value came from, and says it was logged", lt.includes("HbA1c") && /AI-read from a report/i.test(lt) && /in their access log/.test(lt) && /not clinician-verified/.test(lt));
check("…requested for the share and part clicked only (no patient id is sent)", log.calls.some((c) => c.action === "patient_record" && c.scope === "labs" && c.share_id === "f8000000-0000-0000-0000-0000000000s1" && !("patient_id" in c)));
await pg.click("#so"); await settle(pg);
check("signing out clears the shared records from the page", !(await pg.$("#shared")) && !/Asha Patient Fictional|HbA1c/.test(await pg.evaluate(() => document.body.innerText)) && !!(await pg.$("#signin")));
await ctx.close();
({ ctx, pg } = await open());
await pg.evaluate(async () => { const c = window.supabase.createClient("https://x.supabase.co", "anon"); await c.auth.signUp({ email: "dr.unverified@example.test", password: "fictional-pass-1", options: { data: {} } }); });
await pg.reload(); await pg.waitForSelector(".dwrap #full_name", { timeout: 10000 });
check("a doctor who isn't verified sees no shared-records section", !(await pg.$("#shared")));
await ctx.close();

// layout
for (const w of [320, 390, 1024]) {
  ({ ctx, pg } = await open({ width: w }));
  await pg.evaluate(async () => { const c = window.supabase.createClient("https://x.supabase.co", "anon"); await c.auth.signUp({ email: "dr.layout@example.test", password: "fictional-pass-1", options: { data: {} } }); });
  await pg.reload(); await pg.waitForSelector(".dwrap #full_name", { timeout: 10000 });
  const o = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (process.env.SHOTS && w === 390) await pg.screenshot({ path: `${process.env.SHOTS}/doctor-390.png`, fullPage: true });
  check(`${w}px: no sideways scrolling`, o <= 1, "overflow " + o);
  await ctx.close();
}
const html = readFileSync(new URL("../../public/doctor/index.html", import.meta.url), "utf8"), js = readFileSync(new URL("../../public/doctor/doctor.js", import.meta.url), "utf8");
check("no secrets or privileged key names in the page's code; no inline script; Supabase pinned with integrity", !/sb_secret_|service_role|SERVICE_ROLE/.test(js + html) && !/<script>(?!\s*<\/script>)/.test(html) && /integrity="sha384-/.test(html));
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} doctor page checks passed, ${failed} FAILED` : `all ${out.length} doctor page checks passed`);
process.exitCode = failed ? 1 : 0;
