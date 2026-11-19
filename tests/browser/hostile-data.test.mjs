/**
 * Doctine · script-injection check for the screens that show what people type or what is read from their documents:
 * My Health, Medicines (list, form, review, prescription list), Vitals, Medical records and the page viewer.
 * Every text field gets markup that would run script if it were inserted unescaped. Fictional data; demo account.
 */
import { chromium } from "playwright";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const out = [];
const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
const pg = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = []; pg.on("pageerror", (e) => errs.push(e.message));
const W = (ms) => pg.waitForTimeout(ms);
await pg.goto(BASE + "/"); await W(300);
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Hostile Test"); await pg.fill("input[name=email]", "hostile@example.com"); await pg.fill("input[name=pw]", "fictional-pass-1"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(400);
await pg.evaluate(() => {
  const X = (k) => `"><img src=x onerror="window.__pwn='${k}'"><svg onload="window.__pwn='${k}'"></svg>`;
  window.__pwn = null; const d = today();
  S.profile.name = X("name"); S.profile.allergies = X("allergies"); S.profile.blood = X("blood");
  S.meds.push({ id: 1, name: X("medname"), brand: X("brand"), strength: X("strength"), form: X("form"), amount: X("amount"), unit: X("unit"), dose: X("dose"), instructions: X("instr"), status: "active", start: d, end: "", freq: "daily", days: [], times: ["00:01", "23:59"], src: { doc: 9, raw: X("raw"), conf: "low" } });
  S.meds.push({ id: 2, name: X("legacy"), dose: X("legacydose"), status: "completed", start: "2026-01-01", end: "2026-01-02", freq: "weekly", days: [1], times: ["09:00"] });
  S.vitals = [{ id: 3, kind: "blood_pressure", v: 120, v2: 80, unit: X("unit"), ctx: X("ctx"), note: X("note"), at: new Date().toISOString() }, { id: 4, kind: "glucose", v: 99, v2: null, unit: "mg/dL", ctx: "fasting", note: X("note2"), at: new Date().toISOString() }];
  S.reports.unshift({ id: 9, title: X("title"), cat: X("cat"), date: d, lab: X("lab"), fields: { [X("fkey")]: X("fval") }, imgs: 0,
    scan: { medicines: [{ raw: X("sraw"), name: X("sname"), form: X("sform"), strength: X("sstr"), frequency: X("sfreq"), timing: X("stime"), duration: X("sdur"), confidence: X("conf"), alternatives: [X("alt")] }], unreadable: [X("unread")], transcription: X("tx") }, checked: false });
  S.doses[`1@00:01@${d}`] = X("dose-status");
});
for (const v of ["home", "medicines", "vitals", "reports", "health", "reminders", "chat", "settings"]) { await pg.evaluate((x) => go(x), v); await W(150); }
await pg.evaluate(() => { const r = S.reports[0]; S.medScan = { rid: r.id, title: r.title, meds: r.scan.medicines, added: {} }; go("medicines"); }); await W(150);
await pg.click("[data-msadd='0']"); await W(150);
await pg.evaluate(() => { S.medDraft.amount = "1"; S.medDraft.unit = "tablet"; S.medDraft.mode = "once"; S.medDraft.times = ["08:00"]; render(); }); await W(80);
await pg.click("#mf button.pri"); await W(150);   // review step
await pg.evaluate(() => { S.medDraft = null; go("medicines"); }); await W(80);
await pg.click(".mx-item [data-edit='1']"); await W(150);
await pg.evaluate(() => { S.medDraft = null; S.vDraft = { kind: "heart_rate", v: '"><img src=x onerror="window.__pwn=1">', v2: "", ctx: "", note: '"><img src=x onerror="window.__pwn=2">', date: today(), time: "08:00" }; go("vitals"); }); await W(150);
await pg.click("#vf button.pri"); await W(150);
await pg.evaluate(() => { S.reports[0].imgs = 1; IMG.urls["scan:9:0"] = "data:image/gif;base64,R0lGODlhAQABAAAAACw="; go("reports"); }); await W(150);
await pg.click("[data-vs='9|0']"); await W(200);
await W(500);
const pwn = await pg.evaluate("window.__pwn");
check("no injected markup ran on any screen", pwn === null, String(pwn));
check("no injected element exists in the page", await pg.evaluate("!document.querySelector('img[src=\"x\"],svg[onload],[onerror]')"));
check("the hostile text is shown as text", (await pg.textContent("body")).includes("onerror="));
check("no JavaScript errors", errs.length === 0, errs.join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
