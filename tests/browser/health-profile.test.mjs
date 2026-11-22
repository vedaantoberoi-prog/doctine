/**
 * Doctine · the complete health profile (22 Nov 2026), through the real screens, with Supabase simulated
 * (fake-supabase-strict.js: each signed-in person reads and writes only their own rows). Fictional people only.
 *   1 new account: personal details, conditions, past illness, surgery, medicines, allergy, family; reload; all there
 *   2 an account from before this update: its profile and medicines are untouched; new history is added beside them
 *   3 editing a medicine's dose   4 removing one allergy with confirmation   5 a second person sees none of it
 *   6 phone layout                7 what Doctine AI would receive           8 the sample account
 * plus validation, "Saved" only after the database confirms, unsafe text, and a database without the new table.
 * The database rules themselves (row-level security, checks, change log) are tested in tests/rls.test.sql.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { addMed, editProfile, addRecord, openSection } from "./med-helper.mjs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const results = [], errs = [];
const check = (name, ok, detail = "") => { const line = (ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""); results.push(line); console.log(line); };
const b = await chromium.launch();
async function device(seedDb, vp = { width: 1280, height: 900 }, extra = {}) {
  const ctx = await b.newContext({ viewport: vp, ...extra });
  if (seedDb) await ctx.addInitScript((db) => { if (!localStorage.getItem("__sbdb")) localStorage.setItem("__sbdb", db); }, seedDb);
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message)); pg.on("dialog", (d) => d.accept());
  await pg.route("**/*", async (r) => { const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase" }) });
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(700);
  return { ctx, pg };
}
const register = async (pg, name, email) => { await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", name); await pg.fill("input[name=email]", email); await pg.fill("input[name=pw]", "fictional-pass-1"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await pg.waitForTimeout(600); };
const signIn = async (pg, email) => { await pg.fill("input[name=email]", email); await pg.fill("input[name=pw]", "fictional-pass-1"); await pg.click("#lf button.pri"); await pg.waitForTimeout(1200); };
const signOut = async (pg) => { await pg.evaluate("document.getElementById('out').click()"); await pg.waitForTimeout(600); };
const db = (pg) => pg.evaluate(() => window.__sbdb.tables);
const W = (pg, ms) => pg.waitForTimeout(ms);

// ===== 1. A new account fills in the profile =====
let { ctx, pg } = await device(null);
await register(pg, "Kavya Rao", "kavya@example.test");
await pg.evaluate("go('health')"); await W(pg, 150);
check("the health profile opens inside the signed-in app, with the six sections and no women's section until it applies",
  JSON.stringify(await pg.$$eval("[data-hpsec]", (x) => x.map((b) => b.dataset.hpsec))) === JSON.stringify(["personal", "body", "history", "meds", "allergy", "family"]));
check("a new account's overview shows nothing invented", /Not added yet/.test(await pg.textContent(".hp-ovw")) && /None added/.test(await pg.textContent(".hp-ovw")) && !(await pg.$(".hp-alert")));

// validation: nothing is saved while a field is wrong
await editProfile(pg, "personal", { phone: "call me later", cemail: "not-an-email", dob: "2999-01-01" }, { wait: 500 });
check("wrong phone, email and date are explained next to each field and nothing is saved",
  (await pg.$$("#hpsf-personal [aria-invalid=true]")).length === 3 && /country code/.test(await pg.textContent("#hpsf-personal")) && !(await db(pg)).health_profiles?.some((p) => p.phone));
await editProfile(pg, "personal", { phone: "+91 98765 43210", cemail: "kavya.contact@example.test", dob: "1990-02-14", sex: "female", gender: "female", blood: "O+", city: "Bengaluru", country: "India", ecName: "Ravi Rao", ecRel: "Husband", ecPhone: "+91 90000 11111" }, { wait: 1500 });
let t = await db(pg), hp = t.health_profiles?.[0] || {};
check("personal details are saved to the account", hp.phone === "+91 98765 43210" && hp.contact_email === "kavya.contact@example.test" && hp.sex_at_birth === "female" && hp.blood_group === "O+" && hp.emergency_name === "Ravi Rao" && hp.city === "Bengaluru");
check("'Saved' appears only after the account confirmed it", (await pg.textContent("#hps-personal")).includes("Saved to your account"));
check("the contact email is separate: the sign-in email is unchanged", await pg.evaluate("CLOUD.email") === "kavya@example.test" && hp.contact_email !== "kavya@example.test");
check("with sex assigned at birth female, the optional women's health section appears", (await pg.$('[data-hpsec="women"]')) !== null);

await editProfile(pg, "body", { h: "162", w: "58", diet: "eggetarian", activity: "light", sleepH: "6.5", smoking: "never", alcohol: "occasional" }, { wait: 300 });
await pg.fill("#hpsf-body [name=alcoholD]", "Once a month"); await pg.click("#hpsf-body button[type=submit]"); await W(pg, 1500);
t = await db(pg); hp = t.health_profiles[0];
check("body and lifestyle are saved, with BMI explained as a screening number", hp.height_cm == 162 && hp.weight_kg == 58 && hp.lifestyle.diet === "eggetarian" && hp.lifestyle.alcoholD === "Once a month" && hp.lifestyle.smoking === "never"
  && /screening number/.test(await pg.textContent("#hps-body")) && /not a diagnosis/.test(await pg.textContent("#hps-body")));
check("an unanswered habit stays unanswered (not stored as 'no')", !("tobacco" in hp.lifestyle) && !("subst" in hp.lifestyle));
check("the weight is also kept as a dated reading", (t.vital_readings || []).filter((v) => v.kind === "weight").length === 1);
await editProfile(pg, "body", { w: "57.2" }, { wait: 1500 });
check("changing the weight adds a new reading and keeps the earlier one", (await db(pg)).vital_readings.filter((v) => v.kind === "weight").map((v) => +v.value).sort().join() === "57.2,58");
// imperial units convert to the same stored values
await editProfile(pg, "body", { units: "imperial" }, { save: false });
check("switching to imperial converts the shown values (162 cm ≈ 5 ft 4 in, 57.2 kg ≈ 126.1 lb)", (await pg.inputValue("#hpsf-body [name=hft]")) === "5" && (await pg.inputValue("#hpsf-body [name=hin]")) === "4" && (await pg.inputValue("#hpsf-body [name=wlb]")) === "126.1");
await pg.click('[data-hpcancel="body"]'); await W(pg, 150);

// the explicit answers
await openSection(pg, "history");
await pg.click('#hpl-surgery input[data-hpans="surgery"][value="no"] + .mx-opt'); await W(pg, 1500);
check("'No' to surgery is saved as an explicit answer, and the list says 'You said none.'", (await db(pg)).health_profiles[0].history_answers.surgery === "no" && (await pg.textContent("#hpl-surgery")).includes("You said none."));
check("an unanswered section still reads as not added, never as 'none'", (await pg.textContent("#hpl-hospitalization")).includes("No hospital stays added.") && !(await db(pg)).health_profiles[0].history_answers.hosp);

await addRecord(pg, "condition", { title: "Hypothyroidism", onset: "2018", status: "controlled", sev: "mild", clinician: "Dr. Fictional", notes: "On thyroxine" });
await addRecord(pg, "past_illness", { title: "Typhoid", onset: "2015-06", hospitalized: "no", status: "recovered" });
await addRecord(pg, "surgery", { title: "Tonsillectomy", onset: "2004", facility: "Fictional Hospital", status: "recovered" });
await addRecord(pg, "hospitalization", { title: "Typhoid fever", onset: "2015-06-02", discharged: "2015-06-01" }, { wait: 300 });
check("a discharge date before admission is refused", /can’t be before admission/.test(await pg.textContent("#hprf")));
await pg.fill("#hprf [name=discharged]", "2015-06-07"); await pg.click("#hprf button[type=submit]"); await W(pg, 1500);
await addRecord(pg, "allergy", { title: "Sulfa drugs", cat: "medication", cert: "confirmed", reaction: "Rash", sev: "severe", confirmed: "yes" });
await addRecord(pg, "allergy", { title: "Shellfish", cat: "food", cert: "suspected", sev: "moderate" });
await addRecord(pg, "allergy", { title: "Milk", cat: "food", cert: "intolerance" });
await addRecord(pg, "family", { cat: "father", title: "Type 2 diabetes", age: "52", status: "living" });
await addRecord(pg, "family", { cat: "father", title: "Hypertension", age: "55" });
await addRecord(pg, "family", { cat: "mother", title: "Hypothyroidism" });
await addRecord(pg, "device", { title: "Glasses", cat: "wearable" });
// medicines: a regular one through the existing Medicines form, an occasional and a stopped one in the profile
await openSection(pg, "meds"); await pg.click("[data-hpmadd]"); await W(pg, 150);
check("'Add medicine' in the profile opens the existing medicine form (doses and reminders live in one place)", (await pg.evaluate("S.view")) === "medicines" && (await pg.$("#mf")) !== null);
await addMed(pg, { name: "Thyroxine", strength: ["50", "mcg"], unit: "tablet", mode: "once", times: ["07:00"] }); await W(pg, 1200);
await openSection(pg, "meds");
await pg.click('[data-hpmed="med_occ|"]'); await W(pg, 100);
for (const [k, v] of [["name", "Paracetamol"], ["strength", "650 mg"], ["dose", "1 tablet"], ["reason", "Headache"], ["useFreq", "About twice a month"]]) await pg.fill(`#hprf [name=${k}]`, v);
await pg.click("#hprf button[type=submit]"); await W(pg, 1500);
await pg.click('[data-hpmed="med_stop|"]'); await W(pg, 100);
for (const [k, v] of [["name", "Atorvastatin"], ["dose", "10 mg at night"], ["start", "2022-01-01"], ["end", "2023-05-01"], ["stopReason", "Muscle aches"]]) await pg.fill(`#hprf [name=${k}]`, v);
await pg.click('#hprf input[name=stopAdvice][value=yes] + .mx-opt'); await pg.click("#hprf button[type=submit]"); await W(pg, 1500);
const th = await pg.evaluate("S.meds.find(m=>m.name==='Thyroxine').id");
await pg.click(`[data-hpmed="med_more|${th}"]`); await W(pg, 100); await pg.fill("#hprf [name=reason]", "Hypothyroidism"); await pg.click('#hprf input[name=route][value=oral] + .mx-opt'); await pg.fill("#hprf [name=prescriber]", "Dr. Fictional");
await pg.click("#hprf button[type=submit]"); await W(pg, 1500);

t = await db(pg);
const recs = t.health_records || [];
check("every kind of record is saved as its own row", ["condition", "past_illness", "surgery", "hospitalization", "allergy", "family", "device"].every((k) => recs.some((r) => r.kind === k)) && recs.length === 11, recs.length + " rows");
check("details are kept in their fields, with where they came from", recs.some((r) => r.kind === "condition" && r.status === "controlled" && r.onset === "2018" && r.details.clinician === "Dr. Fictional" && r.source === "user")
  && recs.some((r) => r.kind === "hospitalization" && r.onset === "2015-06-02" && r.details.discharged === "2015-06-07"));
check("confirmed allergy, suspected allergy and intolerance are kept apart", ["confirmed", "suspected", "intolerance"].every((c) => recs.some((r) => r.kind === "allergy" && r.certainty === c)));
check("two conditions for the same relative are two entries", recs.filter((r) => r.kind === "family" && r.category === "father").length === 2);
const meds = t.medicines || [];
check("regular, occasional and stopped medicines are saved with their details", meds.some((m) => m.name === "Thyroxine" && m.category === "regular" && m.reason === "Hypothyroidism" && m.route === "oral" && m.prescriber === "Dr. Fictional")
  && meds.some((m) => m.name === "Paracetamol" && m.category === "occasional" && m.use_frequency === "About twice a month" && m.start_date == null)
  && meds.some((m) => m.name === "Atorvastatin" && m.status === "completed" && m.stop_reason === "Muscle aches" && m.stopped_on_advice === "yes" && m.end_date === "2023-05-01"));
check("the occasional medicine gets no reminder times (only when needed)", (t.medication_schedules || []).some((s) => s.frequency === "as_needed" && s.times.length === 0 && meds.find((m) => m.id === s.medicine_id)?.name === "Paracetamol"));
check("the severe allergy is shown prominently at the top", (await pg.textContent(".hp-alert")).includes("Sulfa drugs") && (await pg.textContent(".hp-alert")).includes("Rash"));
check("the overview summarises the saved records", /Hypothyroidism/.test(await pg.textContent(".hp-ovw")) && /Thyroxine/.test(await pg.textContent(".hp-ovw")) && /Sulfa drugs/.test(await pg.textContent(".hp-ovw")) && !/Atorvastatin/.test(await pg.textContent(".hp-ovw")));
check("the stopped medicine is listed as stopped, never as current", await pg.evaluate("medEnded(S.meds.find(m=>m.name==='Atorvastatin'))&&!todayDoses().some(d=>d.m&&d.m.name==='Atorvastatin')"));
// duplicates are never merged silently
await addRecord(pg, "condition", { title: "hypothyroidism" }, { wait: 300 });
check("adding the same condition again warns instead of silently merging or saving", /already in this list/.test(await pg.textContent("#hprf")) && (await db(pg)).health_records.filter((r) => r.kind === "condition").length === 1);
await pg.click('[data-hpcancel="rec"]'); await W(pg, 150);
const dbAfter1 = JSON.stringify(await db(pg));
await pg.reload(); await W(pg, 1500);
check("after a reload, every record is still there (adding a surgery turned the earlier 'No' into 'Yes')", await pg.evaluate("S.hist.length===11&&S.meds.length===3&&S.profile.phone==='+91 98765 43210'&&S.profile.life.diet==='eggetarian'&&S.profile.ans.surgery==='yes'&&S.profile.ans.hosp==='yes'"));
await signOut(pg); await signIn(pg, "kavya@example.test");
check("after signing out and back in, every record is still there", await pg.evaluate("S.hist.length===11&&S.meds.length===3&&S.profile.sex==='female'"));

// ===== 3. Editing a medicine's dose =====
await openSection(pg, "meds"); const pid = await pg.evaluate("S.meds.find(m=>m.name==='Paracetamol').id");
await pg.click(`[data-hpmed="med_occ|${pid}"]`); await W(pg, 100); await pg.fill("#hprf [name=dose]", "2 tablets"); await pg.click("#hprf button[type=submit]"); await W(pg, 1500);
await pg.reload(); await W(pg, 1500);
check("an edited dose is saved and survives a reload", (await db(pg)).medicines.find((m) => m.name === "Paracetamol").dose === "2 tablets" && await pg.evaluate("S.meds.find(m=>m.name==='Paracetamol').dose==='2 tablets'"));

// ===== 4. Removing one allergy =====
await openSection(pg, "allergy"); const sid = await pg.evaluate("S.hist.find(r=>r.title==='Shellfish').id");
await pg.click(`[data-hpdel="${sid}"]`); await W(pg, 100);
check("removing asks for confirmation first, and nothing is removed yet", /Remove this allergy\?/.test(await pg.textContent("#hps-allergy")) && (await db(pg)).health_records.some((r) => r.title === "Shellfish"));
await pg.click(`[data-hpdelok="${sid}"]`); await W(pg, 1500);
t = await db(pg);
check("the allergy is removed and every other record stays", !t.health_records.some((r) => r.title === "Shellfish") && t.health_records.length === 10 && t.health_records.some((r) => r.title === "Sulfa drugs") && t.medicines.length === 3);

// ===== "Saved" only after the database confirms; retry =====
await pg.evaluate(() => { window.__failTable = "health_records"; });
await addRecord(pg, "condition", { title: "Migraine" }, { wait: 1500 });
check("when saving fails, the profile says so and offers to try again (no false 'Saved')", /Not saved yet/.test(await pg.textContent("#hps-history")) && (await pg.$('#hps-history [data-hpretry]')) !== null && !/Saved to your account/.test(await pg.textContent("#hps-history")));
await pg.evaluate(() => { window.__failTable = null; }); await pg.click('#hps-history [data-hpretry]'); await W(pg, 1800);
check("…and 'Try again' saves it", (await db(pg)).health_records.some((r) => r.title === "Migraine") && /Saved to your account/.test(await pg.textContent("#hps-history")));
// unsaved changes are flagged and protected
await openSection(pg, "personal"); await pg.fill("#hpsf-personal [name=city]", "Mysuru"); await W(pg, 100);
check("typing shows 'Unsaved changes' and the sign-out warning counts them", /Unsaved changes/.test(await pg.textContent("#hpsf-personal")) && await pg.evaluate("unsavedCount()>0"));
await pg.click('[data-hpcancel="personal"]'); await W(pg, 100);
check("discarding puts the saved value back", (await pg.inputValue("#hpsf-personal [name=city]")) === "Bengaluru");

// unsafe text is shown as text
await addRecord(pg, "condition", { title: "<img src=x onerror=window.__pwned=1>", notes: "<script>window.__pwned=1</script>" });
check("text that looks like code is shown as plain text, never run", !(await pg.evaluate("window.__pwned")) && (await pg.textContent("#hpl-condition")).includes("<img src=x"));

// ===== 7. What Doctine AI would receive (only when the person ticks "use my saved reports and profile") =====
const ctxOf = (q) => pg.evaluate((q) => { S.useRecords = true; S.msgs = [{ r: "u", t: q }]; const c = buildCtx(); S.useRecords = false; S.msgs = []; return c; }, q);
check("nothing from the profile is sent unless the person opts in for that chat", await pg.evaluate("S.useRecords=false,buildCtx()===null"));
let c = (await ctxOf("I have been feeling dizzy recently")).profile;
check("for a symptom, the AI gets allergies (with kind and severity), current conditions and current medicines",
  c.allergies.some((a) => a.substance === "Sulfa drugs" && a.kind === "confirmed allergy" && a.severity === "severe") && c.allergies.some((a) => a.substance === "Milk" && a.kind === "intolerance")
  && c.conditions.some((x) => x.name === "Hypothyroidism" && x.status === "controlled" && x.source === "self-reported") && c.current_medicines.some((m) => m.name === "Thyroxine" && m.taken === "regularly") && c.current_medicines.some((m) => m.name === "Paracetamol" && m.taken === "now and then"));
check("a stopped medicine is never sent as current", !c.current_medicines.some((m) => m.name === "Atorvastatin"));
check("unrelated history and personal contact details are not sent", !c.related_history && !JSON.stringify(c).includes("98765") && !JSON.stringify(c).includes("Bengaluru") && !JSON.stringify(c).includes("Ravi"));
c = (await ctxOf("Could my old atorvastatin explain muscle aches? My father has diabetes")).profile;
check("history that matches the question is sent, labelled: the stopped medicine as stopped, family history as family", c.related_history.some((h) => h.type === "stopped medicine" && /Atorvastatin, stopped/.test(h.text) && h.when === "2023-05-01")
  && c.related_history.some((h) => h.type === "family history" && /Father: Type 2 diabetes, diagnosed around age 52/.test(h.text)));
check("nothing missing is filled in (no invented dose, date or severity)", !("severity" in (c.allergies.find((a) => a.substance === "Milk") || {})) && !("since" in (c.conditions.find((x) => x.name === "Migraine") || { since: 1 })));
check("pregnancy is not sent unless the person allowed it in the women's health section", !("pregnancy" in c));

// ===== 6. Phone =====
const dbJson = JSON.stringify(await pg.evaluate(() => window.__sbdb));
await ctx.close();
({ ctx, pg } = await device(dbJson, { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }));
await signIn(pg, "kavya@example.test"); await pg.evaluate("go('health')"); await W(pg, 200);
check("on a phone, the page doesn't scroll sideways", !(await pg.evaluate("document.documentElement.scrollWidth>innerWidth||document.querySelector('#view').scrollWidth>document.querySelector('#view').clientWidth")));
await pg.tap('[data-hpsec="history"]'); await W(pg, 200);
check("sections open with a tap", (await pg.getAttribute('[data-hpsec="history"]', "aria-expanded")) === "true");
const small = await pg.$$eval('#hps-history button, #hps-history input:not([type=radio]), #hps-history select, #hps-history .mx-opt', (x) => x.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 32).map((e) => e.textContent.trim() || e.name));
check("buttons and fields are comfortable to tap (at least 32 px; the main ones 44 px)", small.length === 0 && (await pg.$eval('[data-hpsec="history"]', (e) => e.getBoundingClientRect().height)) >= 44, small.join(", "));
await pg.tap('[data-hpadd="past_illness"]'); await W(pg, 150);
check("a record form fits the screen on a phone", !(await pg.evaluate("document.querySelector('#hprf').scrollWidth>document.querySelector('#hprf').clientWidth+1")));
await pg.fill("#hprf [name=title]", "Chickenpox"); await pg.fill("#hprf [name=onset]", "2001"); await pg.tap("#hprf button[type=submit]"); await W(pg, 1500);
check("saving works on a phone", (await db(pg)).health_records.some((r) => r.title === "Chickenpox" && r.onset === "2001"));

// ===== 5. A second person sees none of it =====
await signOut(pg); await register(pg, "Imran Shaikh", "imran@example.test");
await pg.evaluate("go('health')"); await W(pg, 150);
check("a different account starts with an empty profile and none of the first person's records", await pg.evaluate("S.hist.length===0&&S.meds.length===0&&!S.profile.phone") && !/Sulfa|Hypothyroidism|Thyroxine/.test(await pg.textContent("#view")));
const forged = await pg.evaluate(async () => { const owner = window.__sbdb.tables.health_records[0].user_id; const r = await CLOUD.sb.from("health_records").upsert({ user_id: owner, client_id: 1, kind: "condition", title: "Planted" }); return r.error && r.error.message; });
check("writing into the first person's history is refused", /row-level security/.test(forged || ""));
const peek = await pg.evaluate(async () => (await CLOUD.sb.from("health_records").select("*")).data.length);
check("reading the history table returns only this person's rows (none)", peek === 0);

// ===== 2. An account from before this update =====
await ctx.close();
const legacyUser = "11111111-2222-4333-8444-555555555555";
const legacy = { files: {}, users: { "old.user@example.test": { user: { id: legacyUser, email: "old.user@example.test", user_metadata: { full_name: "Old User" } }, password: "fictional-pass-1" } }, tables: {
  health_profiles: [{ user_id: legacyUser, full_name: "Old User", date_of_birth: "1970-01-01", blood_group: "b positive", allergies: "Penicillin, dust", height_cm: 170, weight_kg: 70 }],
  medicines: [{ id: "m-old-1", user_id: legacyUser, client_id: 5, name: "Metformin", dose: "1 tablet", status: "active", start_date: "2025-01-01" }],
  medication_schedules: [{ id: "s-old-1", user_id: legacyUser, medicine_id: "m-old-1", frequency: "daily", days_of_week: [], times: ["08:00"] }] } };
({ ctx, pg } = await device(JSON.stringify(legacy)));
await signIn(pg, "old.user@example.test"); await pg.evaluate("go('health')"); await W(pg, 200);
check("an older account loads with its profile and medicine", await pg.evaluate("S.cloud&&S.profile.name==='Old User'&&S.profile.allergies==='Penicillin, dust'&&S.meds.length===1&&S.meds[0].name==='Metformin'"));
await openSection(pg, "allergy");
check("its earlier allergy note is shown, with an offer to add it as a detailed allergy (never converted on its own)", /From your earlier profile/.test(await pg.textContent("#hps-allergy")) && /Penicillin, dust/.test(await pg.textContent("#hps-allergy")));
await openSection(pg, "personal");
check("an older free-text blood group is kept and shown, not replaced", /Saved earlier: b positive/.test(await pg.textContent("#hpsf-personal")));
await addRecord(pg, "condition", { title: "Type 2 diabetes", status: "active" });
t = await db(pg);
check("new history is added beside the existing data, which stays as it was", t.health_records.length === 1 && t.health_profiles[0].allergies === "Penicillin, dust" && t.health_profiles[0].blood_group === "b positive" && t.medicines.length === 1 && t.medicines[0].dose === "1 tablet");
// a database before this update: the rest still works
await signOut(pg); await pg.evaluate(() => { window.__missingTables = ["health_records"]; }); await signIn(pg, "old.user@example.test");
check("without the history table, the account still loads with its profile and medicines", await pg.evaluate("S.cloud&&S.profile.name==='Old User'&&S.meds.length===1&&CLOUD.noHist===true"));
await addRecord(pg, "condition", { title: "Asthma" }, { wait: 1500 });
check("…and adding history says plainly it can't be saved yet, instead of pretending", /can’t be saved to your account yet/.test(await pg.textContent("#hps-history")));
await ctx.close();

// ===== 8. The sample account =====
({ ctx, pg } = await device(null));
await pg.goto(BASE + "/?sample=1"); await W(pg, 1200); await pg.evaluate("go('health')"); await W(pg, 200);
check("the sample account shows a filled-in profile, its severe allergy first", /Penicillin/.test(await pg.textContent(".hp-alert")) && /Prediabetes/.test(await pg.textContent(".hp-ovw")));
await openSection(pg, "history");
check("the sample's condition is linked to the sample prescription it came from", /Linked to “Prescription – Sample Clinic”/.test(await pg.textContent("#hps-history")));
await addRecord(pg, "condition", { title: "Sample-only test" }, { wait: 400 });
check("changes in the sample say they are not saved, and nothing is written anywhere", /not saved/.test(await pg.textContent("#hps-history")) && !(await pg.evaluate("JSON.stringify(window.__sbdb||{}).includes('Sample-only')")) && !(await pg.evaluate("JSON.stringify(localStorage).includes('Sample-only')")));
await pg.evaluate("document.getElementById('out').click()"); await W(pg, 400); await register(pg, "Fresh Person", "fresh@example.test");
check("sample records never appear in a real account", await pg.evaluate("S.hist.length===0&&S.meds.length===0&&!S.sample"));

check("no JavaScript errors on any page", errs.length === 0, errs.join(" | "));
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
await b.close(); process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
