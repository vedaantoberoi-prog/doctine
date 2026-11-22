/* Doctine · browser-test helper: add a medicine through the real form (open it, fill each step, Review, Save). Fictional data only. */
export async function addMed(pg, o) {
  const W = (ms) => pg.waitForTimeout(ms);
  if (!(await pg.$("#mf"))) { await pg.click("[data-medadd]"); await W(100); }
  await pg.fill("#mf [name=name]", o.name);
  if (o.form) { await pg.selectOption("#mf [name=form]", o.form); await W(80); }
  if (o.strength) { await pg.fill("#mf [name=sv]", o.strength[0]); await pg.selectOption("#mf [name=su]", o.strength[1]); }
  await pg.fill("#mf [name=amount]", o.amount || "1");
  if (o.unit !== false) { await pg.selectOption("#mf [name=unit]", o.unit || "tablet"); await W(80); }
  await pg.click(`#mf input[name=mode][value=${o.mode || "once"}] + .mx-opt`); await W(100);
  for (const d of o.days || []) await pg.click(`#mf input[name=day][value='${d}'] + .mx-opt`);
  if (o.mode === "interval") { await pg.selectOption("#mf [name=interval]", String(o.interval)); await W(80); await pg.fill("#mf [name=first]", o.first); await pg.press("#mf [name=first]", "Tab"); await W(80); }
  else if (o.mode !== "prn") {
    const ts = o.times || ["09:00"];
    for (let i = 0; i < ts.length; i++) { if (!(await pg.$(`#mf [data-mt='${i}']`))) { await pg.click("#mtadd"); await W(80); } await pg.fill(`#mf [data-mt='${i}']`, ts[i]); }
  }
  if (o.note) await pg.fill("#mf [name=note]", o.note);
  await pg.click("#mf button.pri"); await W(150);
  if (o.review) await o.review();
  if (await pg.$("#mf[data-step=review]")) { await pg.click("#mf button.pri"); }
  await W(o.wait || 150);
}

/* Health profile: open a section, set fields through the real form, press Save and wait for the result.
   Values: text and dates are typed, <select>s are chosen, radio groups (segmented buttons) are clicked. */
async function setField(pg, form, k, v) {
  const el = await pg.$(`${form} [name="${k}"]`); if (!el) throw new Error(`no field ${k} in ${form}`);
  const tag = await el.evaluate((x) => x.tagName + ":" + (x.type || ""));
  if (tag.startsWith("SELECT")) { await pg.selectOption(`${form} [name="${k}"]`, String(v)); await pg.waitForTimeout(60); }
  else if (tag === "INPUT:radio") { await pg.click(`${form} input[name="${k}"][value="${v}"] + .mx-opt`); await pg.waitForTimeout(60); }
  else await pg.fill(`${form} [name="${k}"]`, String(v));
}
export async function openSection(pg, sec) {
  if ((await pg.evaluate("S.view")) !== "health") { await pg.evaluate("go('health')"); await pg.waitForTimeout(100); }
  if ((await pg.getAttribute(`[data-hpsec="${sec}"]`, "aria-expanded")) !== "true") { await pg.click(`[data-hpsec="${sec}"]`); await pg.waitForTimeout(100); }
}
export async function editProfile(pg, sec, fields, { save = true, wait = 1200 } = {}) {
  await openSection(pg, sec);
  for (const [k, v] of Object.entries(fields)) await setField(pg, `#hpsf-${sec}`, k, v);
  if (save) { await pg.click(`#hpsf-${sec} button[type=submit]`); await pg.waitForTimeout(wait); }
}
export async function addRecord(pg, kind, fields, { wait = 1200, sec } = {}) {
  await openSection(pg, sec || { condition: "history", past_illness: "history", surgery: "history", hospitalization: "history", other_history: "history", allergy: "allergy", device: "allergy", family: "family" }[kind]);
  await pg.click(`[data-hpadd="${kind}"]`); await pg.waitForTimeout(100);
  for (const [k, v] of Object.entries(fields)) await setField(pg, "#hprf", k, v);
  await pg.click("#hprf button[type=submit]"); await pg.waitForTimeout(wait);
}
