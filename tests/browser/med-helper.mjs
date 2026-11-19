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
