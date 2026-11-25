/* Doctine · for doctors (app.doctine.com/doctor). Phase 1 of the doctor network: a doctor's professional details,
 * credential files and verification status.
 *
 * This page holds no privileges. It signs in with the normal Doctine account (Supabase Auth, publishable key) and sends
 * the person's own token to /api/doctor, where the server and the database decide everything. Credential files go to
 * private storage that browsers can't read back; only Doctine reviewers open them, and each opening is logged.
 * Nothing here makes a doctor visible to patients, and there are no consultations yet.
 */
"use strict";
(() => {
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtD = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const dt = (v, time = true) => (v && !Number.isNaN(Date.parse(v)) ? (time ? fmt : fmtD).format(new Date(v)) : "—");
const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const TONE = { NOT_STARTED: "none", DOCUMENTS_SUBMITTED: "info", UNDER_REVIEW: "warn", VERIFIED: "good", REJECTED: "bad", SUSPENDED: "bad", EXPIRED_REQUIRES_REVERIFICATION: "warn" };
const FIELD = { full_name: "Full name", registration_number: "Registration number", registration_council: "Council", registration_year: "Year of registration", qualifications: "At least one qualification",
  specialties: "At least one specialty", languages: "At least one language", declaration: "The declaration", "doc:registration_certificate": "Registration certificate (file)", "doc:degree_certificate": "Degree certificate (file)", "doc:photo_id": "Photo ID (file)" };
const MODE = { text: "Text", audio: "Audio", video: "Video" };

const S = { sb: null, cfg: null, app: null, opt: null, busy: false, sharing: null, code: null, patients: null, open: null };
function toast(msg, bad = false) { const t = document.createElement("div"); t.className = "toast" + (bad ? " bad" : ""); t.setAttribute("role", "status"); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 4200); }
async function token() { const { data } = await S.sb.auth.getSession(); return data.session && data.session.access_token; }
async function api(method, body) {
  const t = await token(); if (!t) { gate(); throw Object.assign(new Error("signed_out"), { code: "signed_out" }); }
  const r = await fetch("/api/doctor", { method, headers: { authorization: "Bearer " + t, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401) gate("Please sign in again."); throw Object.assign(new Error(j.error || "error"), { code: j.error, status: r.status, message: j.message, fields: j.fields, missing: j.missing }); }
  return j;
}

async function boot() {
  try { S.cfg = await (await fetch("/api/config", { cache: "no-store" })).json(); } catch { S.cfg = null; }
  if (!S.cfg || !S.cfg.supabaseUrl || !window.supabase) return page(`<h1>Not available</h1><p>This site isn't connected to its account service.</p>`);
  if (S.cfg.features && S.cfg.features.doctor_onboarding === false) return closed();
  S.sb = window.supabase.createClient(S.cfg.supabaseUrl, S.cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  S.sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") gate(); });
  await enter();
}
const page = (inner) => { $("#root").innerHTML = `<main class="gate"><div class="card"><div class="mark" aria-hidden="true">D</div>${inner}</div></main>`; };
const closed = () => page(`<h1>Doctor sign-up isn't open yet</h1><p>Doctine is preparing its doctor network. Verified doctors will be able to apply here.</p><div class="row"><a class="btn" href="/">Go to Doctine</a></div>`);

async function enter() {
  if (!(await token())) return gate();
  try { const j = await api("GET"); S.app = j.application; S.opt = j.options; S.sharing = j.sharing || null; }
  catch (e) { if (e.code === "switched_off") return closed(); if (e.code === "signed_out" || e.status === 401) return; return page(`<h1>Something went wrong</h1><p>${esc(e.message || "Please try again in a moment.")}</p><div class="row"><button class="btn" id="re">Try again</button></div>`), ($("#re").onclick = enter); }
  render();
}

function gate(msg) {
  $("#root").innerHTML = `<main class="gate"><form class="card" id="signin" novalidate><div class="mark" aria-hidden="true">D</div>
    <h1>Doctine for doctors</h1>
    <p>Apply to join Doctine's doctor network. Sign in with your Doctine account; we'll check your medical registration against the official register before anything else.</p>
    ${msg ? `<div class="callout" style="margin-bottom:10px">${esc(msg)}</div>` : ""}
    <label class="f" for="em">Email</label><input id="em" type="email" autocomplete="username" required>
    <label class="f" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
    <p class="err" id="gerr" role="alert"></p>
    <button class="btn primary" style="width:100%;margin-top:14px;min-height:38px" type="submit">Sign in</button>
    <p class="hint" style="margin-top:12px">No account yet, or you use Google? Create or open your account at <a href="/">app.doctine.com</a> first, then come back to this page.</p>
  </form></main>`;
  $("#signin").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const b = $("#signin button[type=submit]"); b.disabled = true; $("#gerr").textContent = "";
    const { error } = await S.sb.auth.signInWithPassword({ email: $("#em").value.trim(), password: $("#pw").value });
    b.disabled = false;
    if (error) { $("#gerr").textContent = /confirm/i.test(error.message) ? "Please confirm your email address first." : "That email and password didn't match."; return; }
    enter();
  });
}

/* ───────────── the application ───────────── */
function render() {
  const a = S.app, o = S.opt, st = a.status, tx = (o.status_text || {})[st] || { label: st, doctor: "" }, ed = !!a.editable;
  const quals = a.qualifications && a.qualifications.length ? a.qualifications : ed ? [{ degree: "", institution: "", year: "" }] : [];
  const chip = (name, list, chosen, label = (x) => x) => list.map((x) => `<label><input type="checkbox" name="${name}" value="${esc(x)}" ${(chosen || []).includes(x) ? "checked" : ""} ${ed ? "" : "disabled"}><span>${esc(label(x))}</span></label>`).join("");
  const docs = a.documents || [];
  const missing = a.missing || [];
  $("#root").innerHTML = `<div class="dwrap">
    <div class="dtop"><div class="mark" aria-hidden="true">D</div><h1>Doctine for doctors</h1><button class="btn sm ghost" id="so">Sign out</button></div>
    <section class="card"><div class="card-b"><div class="row"><span class="st ${TONE[st] || "none"}" id="status">${esc(tx.label)}</span>${st === "VERIFIED" && a.expires_at ? `<span class="muted">until ${dt(a.expires_at, false)}</span>` : ""}</div>
      <p style="margin:8px 0 0">${esc(tx.doctor)}</p>
      ${a.status_reason ? `<div class="callout warn" style="margin-top:8px"><span><b>From the Doctine reviewer:</b> ${esc(a.status_reason)}</span></div>` : ""}
      <p class="hint" style="margin-top:8px">Being verified doesn't list you for patients: consultations aren't open on Doctine yet. Verification checks your registration only; it isn't a rating.</p></div></section>

    ${st === "VERIFIED" && S.sharing && S.sharing.on ? sharedSection() : ""}
    <form id="app" novalidate>
    <section class="card dsec"><div class="card-h"><div><h3>Medical registration</h3><p>Exactly as it appears on your registration certificate and the register.</p></div></div><div class="card-b">
      <label class="f" for="full_name">Full name</label><input id="full_name" maxlength="120" value="${esc(a.full_name || "")}" ${ed ? "" : "disabled"} autocomplete="name">
      <div class="dgrid"><div><label class="f" for="registration_number">Registration number</label><input id="registration_number" maxlength="40" value="${esc(a.registration_number || "")}" ${ed ? "" : "disabled"}></div>
        <div><label class="f" for="registration_year">Year of registration</label><input id="registration_year" type="number" inputmode="numeric" min="1940" max="${new Date().getFullYear()}" value="${esc(a.registration_year || "")}" ${ed ? "" : "disabled"}></div></div>
      <label class="f" for="registration_council">Council</label><select id="registration_council" ${ed ? "" : "disabled"}><option value="">Choose…</option>${o.councils.map((c) => `<option ${a.registration_council === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <p class="err" data-err="full_name registration_number registration_year registration_council"></p></div></section>

    <section class="card dsec"><div class="card-h"><div><h3>Qualifications</h3><p>Your MBBS (or equivalent) and any postgraduate degrees.</p></div></div><div class="card-b" id="quals">
      ${quals.map((q, i) => qrow(q, i, ed)).join("")}
      ${ed ? `<div><button class="btn sm" type="button" id="addq">Add a qualification</button></div>` : ""}<p class="err" data-err="qualifications"></p></div></section>

    <section class="card dsec"><div class="card-h"><div><h3>Practice</h3><p>Self-reported. Not shown to anyone yet.</p></div></div><div class="card-b">
      <span class="f">Specialties (up to 5)</span><div class="chips">${chip("specialties", o.specialties, a.specialties)}</div>
      <span class="f">Languages you consult in</span><div class="chips">${chip("languages", o.languages, a.languages)}</div>
      <span class="f">Consultation modes you'd offer later</span><div class="chips">${chip("consultation_modes", o.modes, a.consultation_modes, (m) => MODE[m] || m)}</div>
      <label class="f" for="experience_years">Years of clinical experience</label><input id="experience_years" type="number" inputmode="numeric" min="0" max="70" value="${esc(a.experience_years ?? "")}" ${ed ? "" : "disabled"} style="max-width:140px">
      <label class="f" for="bio">About you (optional)</label><textarea id="bio" maxlength="1200" ${ed ? "" : "disabled"} placeholder="Your clinical interests and where you practise.">${esc(a.bio || "")}</textarea>
      <p class="err" data-err="specialties languages consultation_modes experience_years"></p></div></section>

    <section class="card dsec"><div class="card-h"><div><h3>Documents</h3><p>PDF, JPEG or PNG, up to 5 MB each. Stored privately; only Doctine reviewers checking your registration open them, and every opening is logged.</p></div></div><div class="card-b">
      ${Object.entries(o.document_kinds).map(([k, d]) => { const mine = docs.filter((x) => x.kind === k);
        return `<div class="dkind" data-kind="${k}"><b>${esc(d.label)}</b>${d.required ? "" : ` <span class="muted">(optional)</span>`}<div class="hint" style="margin:2px 0 0">${esc(d.hint)}</div>
          ${mine.map((x) => `<div class="dfile"><span class="nm">${esc(x.file_name)} <span class="muted">${kb(x.size_bytes)} · uploaded ${dt(x.uploaded_at)}</span></span>${ed ? `<button class="btn sm ghost" type="button" data-rm="${esc(x.id)}">Remove</button>` : ""}</div>`).join("")}
          ${ed ? `<label class="btn sm" style="margin-top:6px;display:inline-flex"><input type="file" accept="application/pdf,image/jpeg,image/png" data-up="${k}" style="position:absolute;width:1px;height:1px;opacity:0">${mine.length ? "Add another file" : "Upload"}</label>` : ""}</div>`; }).join("")}</div></section>

    <section class="card dsec"><div class="card-b">
      <label class="decl"><input type="checkbox" id="declaration" ${a.declaration_at ? "checked" : ""} ${ed ? "" : "disabled"}><span>I confirm these details are true and these documents are mine. I understand Doctine will check my registration on the official register (the NMC's National Medical Register or my State Medical Council's register) and will keep these documents and a record of the check.</span></label>
      <p class="err" data-err="declaration"></p></div></section>

    ${ed && missing.length && a.exists ? `<div class="callout" style="margin-top:12px"><span><b>Still needed before you can submit:</b><ul class="missing">${missing.map((m) => `<li>${esc(FIELD[m] || m)}</li>`).join("")}</ul></span></div>` : ""}
    ${ed ? `<div class="dfoot"><button class="btn" type="submit" id="save">Save</button><button class="btn primary" type="button" id="submit">Submit for verification</button></div>` : ""}
    </form>

    ${(a.history || []).length ? `<section class="card dsec"><div class="card-h"><div><h3>History</h3></div></div><div class="card-b"><ul class="timeline">${a.history.map((h) => `<li><b>${esc(((o.status_text || {})[h.to] || { label: h.to }).label)}</b> <span class="muted">${h.by === "doctor" ? "by you" : h.by === "system" ? "automatically" : "by a Doctine reviewer"} · ${dt(h.at)}</span>${h.reason && h.by !== "doctor" ? `<div>${esc(h.reason)}</div>` : ""}</li>`).join("")}</ul></div></section>` : ""}
    <p class="hint" style="margin-top:16px">Questions about your application: write to Doctine from the app (Settings → Help and feedback). Never send patient information.</p>
  </div>`;
  $("#so").onclick = async () => { await S.sb.auth.signOut({ scope: "local" }); gate(); };
  wireShared();
  if (!ed) return;
  const addq = $("#addq"); if (addq) addq.onclick = () => { const box = $("#quals"); const n = $$(".qrow", box).length; if (n >= 8) return toast("At most 8 qualifications.", true); addq.parentElement.insertAdjacentHTML("beforebegin", qrow({ degree: "", institution: "", year: "" }, n, true)); wireQ(); };
  wireQ();
  $("#app").onsubmit = (e) => { e.preventDefault(); save(); };
  $("#submit").onclick = submit;
  $$("[data-rm]").forEach((b) => b.onclick = () => removeDoc(b.dataset.rm));
  $$("[data-up]").forEach((i) => i.onchange = () => { if (i.files && i.files[0]) upload(i.dataset.up, i.files[0]); });
  const sp = $$("input[name=specialties]"); sp.forEach((c) => c.onchange = () => { if (sp.filter((x) => x.checked).length > 5) { c.checked = false; toast("Choose up to 5 specialties.", true); } });
}

/* ───────────── records patients shared with this doctor (switch `record_sharing`) ───────────── */
const SRC = { user: "patient", patient: "patient", clinician: "clinician", document: "from a document", import: "imported", ai_extracted: "AI-read from a report" };
const src = (x) => `<span class="tag" title="Where this came from">${esc(SRC[x] || x || "patient")}</span>`;
const PURPOSE = { consultation: "a consultation", second_opinion: "a second opinion", follow_up: "a follow-up", other: "something else" };
function sharedSection() {
  const sc = S.sharing.scopes || {};
  const pts = S.patients;
  return `<section class="card dsec" id="shared"><div class="card-h"><div><h3>Records shared with you</h3><p>Patients choose what to share, for how long, and can stop at any time. Each time you open something it's recorded, and the patient can see it.</p></div></div><div class="card-b">
    <div class="row">${S.code ? `<span>Your sharing code: <b class="mono" id="code" style="letter-spacing:.08em">${esc(S.code.slice(0, 5) + "-" + S.code.slice(5))}</b></span><span class="muted">Give it to a patient; they enter it in Doctine under “Share with a doctor”.</span>` : `<button class="btn sm" type="button" id="getcode">Show my sharing code</button>`}</div>
    <div class="row" style="margin-top:10px"><button class="btn sm" type="button" id="loadpts">${pts ? "Refresh" : "Show patients sharing with me"}</button></div>
    ${pts ? (pts.length ? `<div class="tbl-wrap" style="margin-top:8px"><table><thead><tr><th>Patient</th><th>Shared for</th><th>Until</th><th>Open</th></tr></thead><tbody>${pts.map((x) => `<tr><td><b>${esc(x.patient.name)}</b><div class="muted">${x.patient.age != null ? esc(x.patient.age) + " years" : ""}${x.patient.sex_at_birth ? " · " + esc(x.patient.sex_at_birth) : ""}</div>${x.note ? `<div class="muted">“${esc(x.note)}”</div>` : ""}</td><td>${esc(PURPOSE[x.purpose] || x.purpose)}</td><td>${dt(x.expires_at)}</td><td><div class="row" style="gap:4px">${x.scopes.map((k) => `<button class="btn sm ${S.open && S.open.share_id === x.id && S.open.scope === k ? "primary" : ""}" type="button" data-pr="${esc(x.id)}|${esc(k)}">${esc((sc[k] || { label: k }).label)}</button>`).join("")}</div></td></tr>`).join("")}</tbody></table></div>` : `<p class="hint" style="margin-top:8px">Nobody is sharing their record with you right now.</p>`) : ""}
    ${S.open && S.open.data ? sharedView(S.open) : ""}</div></section>`;
}
function sharedView(o) {
  const d = o.data.data, sc = (S.sharing.scopes || {})[o.scope] || { label: o.scope }, items = (d && d.items) || [];
  const head = `<div class="callout" style="margin-top:12px"><span><b>${esc(sc.label)}</b> · ${esc(o.data.patient.name)} · shared until ${dt(o.data.shared_until)}. Read just now from the patient's live record; this opening is in their access log. Items marked “AI-read from a report” or “patient” are not clinician-verified: check them with the patient or the report.</span></div>`;
  let body = "";
  if (o.scope === "profile") body = d ? `<dl class="dl ro"><dt>Name</dt><dd>${esc(d.full_name || "—")}</dd><dt>Age</dt><dd>${d.age != null ? esc(d.age) + " (born " + esc(d.date_of_birth) + ")" : "—"}</dd><dt>Sex at birth</dt><dd>${esc(d.sex_at_birth || "—")}</dd><dt>Gender</dt><dd>${esc(d.gender || "—")}</dd><dt>Blood group</dt><dd>${esc(d.blood_group || "—")}</dd><dt>Height / weight</dt><dd>${d.height_cm ? esc(d.height_cm) + " cm" : "—"} / ${d.weight_kg ? esc(d.weight_kg) + " kg" : "—"}${d.measured_on ? ` <span class="muted">(${esc(d.measured_on)})</span>` : ""}</dd></dl>${src("patient")}` : `<p class="hint">The patient hasn't filled in their basic details.</p>`;
  else if (o.scope === "allergies") body = (items.length ? `<ul class="timeline">${items.map((a) => `<li><b>${esc(a.title)}</b> <span class="muted">${esc([a.category, a.certainty, a.severity, a.reaction].filter(Boolean).join(" · "))}</span> ${src(a.source)}</li>`).join("")}</ul>` : `<p class="hint">No allergies recorded${d.answer ? ` (patient's answer: ${esc(d.answer)})` : ""}.</p>`) + (d.free_text ? `<p>Also written by the patient: “${esc(d.free_text)}”</p>` : "");
  else if (o.scope === "medicines") body = items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Medicine</th><th>Dose</th><th>Status</th><th>Dates</th><th>Why / notes</th><th>Source</th></tr></thead><tbody>${items.map((m) => `<tr><td><b>${esc(m.name)}</b>${m.generic_name ? `<div class="muted">${esc(m.generic_name)}</div>` : ""}<div class="muted">${esc([m.strength, m.form, m.route].filter(Boolean).join(" · "))}</div></td><td>${esc(m.dose)}${m.instructions ? `<div class="muted">${esc(m.instructions)}</div>` : ""}</td><td>${esc(m.status)}${m.category === "occasional" ? " (occasional)" : ""}</td><td>${esc(m.start_date || "?")} → ${esc(m.end_date || (m.status === "stopped" ? "?" : "now"))}</td><td>${esc([m.reason, m.prescriber && "by " + m.prescriber, m.stop_reason && "stopped: " + m.stop_reason].filter(Boolean).join(" · ") || "—")}</td><td>${src(m.source)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">No medicines recorded.</p>`;
  else if (o.scope === "history") body = items.length ? `<ul class="timeline">${items.map((h) => `<li><span class="muted">${esc(h.kind.replace(/_/g, " "))}</span> <b>${esc(h.title)}</b> <span class="muted">${esc([h.category, h.status, h.certainty, h.severity, h.onset && "since " + h.onset].filter(Boolean).join(" · "))}</span> ${src(h.source)}</li>`).join("")}</ul>` : `<p class="hint">No history recorded.</p>`;
  else if (o.scope === "labs") body = items.length ? `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Test</th><th>Value</th><th>Reference</th><th>Report</th><th>Source</th></tr></thead><tbody>${items.map((l) => `<tr><td>${esc(l.date || "—")}</td><td>${esc(l.test)}</td><td><b>${esc(l.value ?? "—")}</b> ${esc(l.unit || "")}${l.flag ? ` <span class="st warn">${esc(l.flag)}</span>` : ""}</td><td>${esc(l.reference_range || "—")}</td><td>${esc(l.report || "—")}</td><td>${src(l.source)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">No test results recorded.</p>`;
  else if (o.scope === "documents") body = items.length ? `<ul class="timeline">${items.map((x) => `<li><b>${esc(x.title)}</b> <span class="muted">${esc([x.category, x.date, x.provider, x.pages && x.pages + " page(s)"].filter(Boolean).join(" · "))}</span></li>`).join("")}</ul><p class="hint">Titles only: files aren't shared yet. Ask the patient to show you a report if you need it.</p>` : `<p class="hint">No documents.</p>`;
  return head + `<div style="margin-top:8px">${body}</div>`;
}
function wireShared() {
  const gc = $("#getcode"); if (gc) gc.onclick = async () => { try { S.code = (await api("POST", { action: "share_code" })).code; render(); } catch (e) { toast(e.message || "Not available.", true); } };
  const lp = $("#loadpts"); if (lp) lp.onclick = async () => { try { S.patients = (await api("POST", { action: "patients" })).patients; S.open = null; render(); } catch (e) { toast(e.message || "Not available.", true); } };
  $$("[data-pr]").forEach((b) => b.onclick = async () => {
    const [share_id, scope] = b.dataset.pr.split("|");
    try { const data = await api("POST", { action: "patient_record", share_id, scope }); S.open = { share_id, scope, data }; render(); const el = $("#shared"); if (el) el.scrollIntoView({ block: "start" }); }
    catch (e) { if (e.status === 404) { toast("This share has ended.", true); S.patients = null; S.open = null; render(); } else toast(e.message || "Couldn't open it.", true); }
  });
}
const qrow = (q, i, ed) => `<div class="qrow"><div><label class="f" for="qd${i}">Degree</label><input id="qd${i}" data-q="degree" maxlength="80" placeholder="MBBS" value="${esc(q.degree || "")}" ${ed ? "" : "disabled"}></div>
  <div><label class="f" for="qi${i}">Institution</label><input id="qi${i}" data-q="institution" maxlength="160" value="${esc(q.institution || "")}" ${ed ? "" : "disabled"}></div>
  <div><label class="f" for="qy${i}">Year</label><input id="qy${i}" data-q="year" type="number" inputmode="numeric" min="1940" max="${new Date().getFullYear()}" value="${esc(q.year || "")}" ${ed ? "" : "disabled"}></div>
  ${ed ? `<button class="btn sm ghost" type="button" data-qx aria-label="Remove this qualification">Remove</button>` : ""}</div>`;
function wireQ() { $$("[data-qx]").forEach((b) => b.onclick = () => b.closest(".qrow").remove()); }

function collect() {
  const v = (id) => $("#" + id).value;
  const checked = (n) => $$(`input[name=${n}]:checked`).map((x) => x.value);
  return {
    full_name: v("full_name"), registration_number: v("registration_number"), registration_council: v("registration_council"), registration_year: v("registration_year"),
    qualifications: $$(".qrow").map((r) => ({ degree: $("[data-q=degree]", r).value, institution: $("[data-q=institution]", r).value, year: $("[data-q=year]", r).value }))
      .filter((q) => q.degree.trim() || q.institution.trim() || String(q.year).trim()),
    specialties: checked("specialties"), languages: checked("languages"), consultation_modes: checked("consultation_modes"),
    experience_years: v("experience_years"), bio: v("bio"), declaration: $("#declaration").checked,
  };
}
function showErrors(fields) {
  $$("[data-err]").forEach((p) => { p.textContent = ""; });
  for (const [k, msg] of Object.entries(fields || {})) {
    const key = k.startsWith("qualifications") ? "qualifications" : k;
    const p = $$("[data-err]").find((x) => x.dataset.err.split(" ").includes(key)); if (p) p.textContent = (p.textContent ? p.textContent + " " : "") + msg;
  }
}
async function save({ quiet = false } = {}) {
  if (S.busy) return false; S.busy = true;
  try { const j = await api("POST", { action: "save", profile: collect() }); S.app = j.application; render(); if (!quiet) toast("Saved."); return true; }
  catch (e) { if (e.fields) { showErrors(e.fields); toast("Please check the highlighted details.", true); } else toast(e.message || "Not saved. Please try again.", true); return false; }
  finally { S.busy = false; }
}
async function submit() {
  if (!(await save({ quiet: true }))) return;
  if ((S.app.missing || []).length) return toast("Some details or files are still needed (listed above).", true);
  if (S.busy) return; S.busy = true;
  try { const j = await api("POST", { action: "submit" }); S.app = j.application; render(); toast("Submitted. A Doctine reviewer will check your registration."); }
  catch (e) { toast(e.code === "incomplete" ? "Some details or files are still needed." : e.message || "Not submitted. Please try again.", true); }
  finally { S.busy = false; }
}
async function upload(kind, file) {
  if (file.size > S.opt.max_file_bytes) return toast("Files can be at most 5 MB.", true);
  if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) return toast("Upload a PDF, JPEG or PNG.", true);
  await save({ quiet: true });                                  // keep what was typed: the page re-renders after the upload
  const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
  toast("Uploading…");
  try { const j = await api("POST", { action: "upload", kind, file_name: file.name, data }); S.app = j.application; render(); toast("Uploaded."); }
  catch (e) { toast(e.message || "The file wasn't uploaded. Please try again.", true); }
}
async function removeDoc(id) {
  await save({ quiet: true });
  try { const j = await api("POST", { action: "remove_document", id }); S.app = j.application; render(); toast("Removed from your application."); }
  catch (e) { toast(e.message || "Not removed.", true); }
}

boot();
})();
