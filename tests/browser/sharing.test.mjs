/**
 * Doctine · "Share with a doctor" in the app, driven against the REAL /api/share handler in this test process, with the
 * database's sharing functions simulated in memory (one verified doctor with a code; the same rules: confirmation,
 * one active share per doctor, stop at any time). The rules themselves are tested on PostgreSQL in tests/sharing.test.sql.
 * Supabase sign-in is simulated in the browser. Fictional people only.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import shareFn, { _resetShareCache } from "../../netlify/functions/share.mjs";
import { _resetSettingsCache } from "../../netlify/lib/settings.mjs";
import { _resetTokenCache } from "../../netlify/lib/ratelimit.mjs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const out = [], errs = [];
const check = (name, ok, detail = "") => { const line = (ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""); out.push(line); console.log(line); };
const b = await chromium.launch();
const UID = "f7000000-0000-4000-8000-0000000000aa";
const CODE = "ABCDEFGHJK";
const DOCTOR = { name: "Dr Meera Fictional", registration_number: "DMC/12345", registration_council: "Delhi Medical Council", qualifications: ["MBBS", "MD"], specialties: ["General physician"], verified: true, verified_at: "2026-11-20T10:00:00Z" };

function database() {
  const st = { shares: [], access: [], calls: [] };
  const ok = (v) => new Response(JSON.stringify(v)); const err = (code, status, message = "") => new Response(JSON.stringify({ code, message }), { status });
  const list = () => ({ shares: st.shares.map((s) => ({ ...s, active: !s.revoked_at && Date.parse(s.expires_at) > Date.now(), opened: st.access.filter((a) => a.share === s.id).length })), access: st.access.map((a) => ({ doctor: DOCTOR.name, scope: a.scope, at: a.at })) });
  const fetchImpl = async (url, init = {}) => {
    url = String(url); const body = init.body ? JSON.parse(init.body) : null;
    if (url.endsWith("/auth/v1/user")) return /^Bearer .+/.test(init.headers.authorization || "") ? ok({ id: UID }) : new Response("{}", { status: 401 });
    if (url.endsWith("/rpc/public_settings")) return ok({ flags: { record_sharing: true }, maintenance: { on: false }, announcements: [] });
    if (url.endsWith("/rpc/rate_limit_hit")) return ok([{ allowed: true, hits: 1, reset_at: new Date(Date.now() + 6e5).toISOString() }]);
    st.calls.push({ fn: url.split("/rpc/")[1], body });
    if (url.endsWith("/rpc/share_list")) return ok(list());
    if (url.endsWith("/rpc/share_lookup")) return body.p_code === CODE ? ok(DOCTOR) : err("P0002", 404);
    if (url.endsWith("/rpc/share_create")) {
      if (st.shares.some((s) => !s.revoked_at)) return err("22023", 400, "you are already sharing with this doctor; stop that share first to change it");
      const id = "f7000000-0000-4000-8000-00000000000" + st.shares.length;
      st.shares.unshift({ id, doctor: DOCTOR, scopes: body.p.scopes, purpose: body.p.purpose, note: body.p.note || null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + body.p.days * 864e5).toISOString(), revoked_at: null });
      st.access.push({ share: id, scope: body.p.scopes[0], at: new Date().toISOString() });   // as if the doctor opened one part
      return ok({ ok: true, id });
    }
    if (url.endsWith("/rpc/share_revoke")) { const s = st.shares.find((x) => x.id === body.p_id && !x.revoked_at); if (!s) return err("P0002", 404); s.revoked_at = new Date().toISOString(); return ok({ ok: true }); }
    return new Response("{}", { status: 404 });
  };
  return { st, fetchImpl };
}

async function device(features, { width = 390 } = {}) {
  const ctx = await b.newContext({ viewport: { width, height: 844 } });
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message));
  const db = database();
  const env = { SUPABASE_URL: "https://fictional.supabase.test", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service-fictional", RATE_LIMIT_SECRET: "r".repeat(40) };
  await ctx.route("**/*", async (r) => { const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", features }) });
    if (u.includes("/api/share")) {
      _resetShareCache(); _resetSettingsCache(); _resetTokenCache();
      const rq = r.request(), body = rq.postData();
      const res = await shareFn(new Request(u, { method: rq.method(), headers: rq.headers(), body: rq.method() === "POST" ? body : undefined }), {}, { env, fetchImpl: db.fetchImpl, log: () => {} });
      return r.fulfill({ status: res.status, contentType: "application/json", body: await res.text() });
    }
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(700);
  await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Asha"); await pg.fill("input[name=email]", `asha${Math.random().toString(16).slice(2, 8)}@example.com`); await pg.fill("input[name=pw]", "secret123"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await pg.waitForTimeout(700);
  pg.on("dialog", (d) => d.accept());
  return { ctx, pg, db };
}
const text = (pg) => pg.evaluate(() => document.body.innerText);
const W = (pg, ms) => pg.waitForTimeout(ms);

{
  const { ctx, pg } = await device({});
  check("with the record_sharing switch off, there is no “Share with a doctor” in the menu", !(await pg.$("#nav [data-nav=sharing]")));
  await pg.evaluate(() => go("sharing")); await W(pg, 300);
  check("…and opening it directly says it isn't available", (await text(pg)).includes("Sharing with a doctor isn’t available yet"));
  await ctx.close();
}
{
  const { ctx, pg, db } = await device({ record_sharing: true });
  check("with the switch on, it's in the menu", !!(await pg.$("#nav [data-nav=sharing]")));
  await pg.evaluate(() => go("sharing")); await W(pg, 800);
  check("the screen explains: chosen parts, for a set time, stop any time, see every opening", /you choose what, for how long, and can stop at any time/i.test(await text(pg)) && (await text(pg)).includes("You’re not sharing your record with anyone"));
  await pg.fill("#shcode", "zzzzz-zzzzz"); await pg.click("#shlookup"); await W(pg, 600);
  check("an unknown code says no verified doctor has it", (await text(pg)).includes("No verified doctor has that code"));
  await pg.fill("#shcode", "abcde-fghjk"); await pg.press("#shcode", "Enter"); await W(pg, 700);
  const t = await text(pg);
  check("a real code shows the doctor's name, qualifications, registration number and council, and that it's not a rating", t.includes("Dr Meera Fictional") && t.includes("MBBS, MD") && t.includes("DMC/12345") && t.includes("Delhi Medical Council") && t.includes("isn’t a rating"));
  check("basic details, allergies and medicines are pre-ticked; history, tests and documents are not", await pg.isChecked("input[name=scope][value=medicines]") && !(await pg.isChecked("input[name=scope][value=labs]")) && !(await pg.isChecked("input[name=scope][value=history]")));
  await pg.click("#shf button.pri"); await W(pg, 300);
  check("sharing without ticking the confirmation is refused in the app (nothing sent)", (await text(pg)).includes("Please tick the box to confirm") && !db.st.calls.some((c) => c.fn === "share_create"));
  await pg.check("input[name=scope][value=labs]"); await pg.selectOption("select[name=days]", "1"); await pg.selectOption("select[name=purpose]", "second_opinion"); await pg.fill("input[name=note]", "Fictional cough for two weeks");
  await pg.check("input[name=confirm]"); await pg.click("#shf button.pri"); await W(pg, 900);
  const c = db.st.calls.find((x) => x.fn === "share_create");
  check("Share sends exactly what was chosen, for the person in the sign-in token", !!c && c.body.p_patient === UID && c.body.p_code === CODE && c.body.p.days === 1 && c.body.p.purpose === "second_opinion" && c.body.p.scopes.sort().join() === "allergies,labs,medicines,profile" && c.body.p.confirm === true);
  const t2 = await text(pg);
  check("“Sharing now” lists the doctor, the parts, until when, and how many times it was opened", t2.includes("Sharing now") && t2.includes("Test results") && /opened 1 time/.test(t2) && t2.includes("A second opinion"));
  check("“Who opened what” shows the doctor's opening", t2.includes("Who opened what") && /Dr Meera Fictional opened/.test(t2));
  await pg.click("[data-shrev]"); await W(pg, 800);
  check("Stop sharing ends it at once and moves it to “Ended”", db.st.calls.some((x) => x.fn === "share_revoke" && x.body.p_patient === UID) && (await text(pg)).includes("Ended") && (await text(pg)).includes("You’re not sharing your record with anyone"));
  const o = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("390px: no sideways scrolling", o <= 1, "overflow " + o);
  if (process.env.SHOTS) await pg.screenshot({ path: `${process.env.SHOTS}/sharing-390.png`, fullPage: true });
  await ctx.close();
}
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} sharing checks passed, ${failed} FAILED` : `all ${out.length} sharing checks passed`);
process.exitCode = failed ? 1 : 0;
