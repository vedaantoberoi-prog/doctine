/**
 * Doctine · the Guardian screen in the app, driven against the REAL /api/guardian handler and incident engine running
 * in this test process (an in-memory store stands in for the database; Supabase sign-in is simulated in the browser).
 * FICTIONAL people, numbers and places only; nothing is sent anywhere.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import guardianFn, { _resetGuardianCache } from "../../netlify/functions/guardian.mjs";
import { createMemoryStore } from "../../netlify/lib/guardian/store-memory.mjs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const out = [], errs = [];
const check = (name, ok, detail = "") => { const line = (ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""); out.push(line); console.log(line); };
const b = await chromium.launch();
const UID = "a1110000-0000-4000-8000-0000000000aa";

async function device(features, { width = 390 } = {}) {
  _resetGuardianCache();
  const ctx = await b.newContext({ viewport: { width, height: 844 }, permissions: [] });
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message));
  const st = { store: createMemoryStore(), skew: 0, offline: false, calls: [] };
  const env = { SUPABASE_URL: "https://fictional.supabase.test", SUPABASE_ANON_KEY: "anon", GUARDIAN_LINK_SECRET: "fictional-test-secret-".padEnd(48, "x") };
  const fetchImpl = async (u, init = {}) => String(u).endsWith("/auth/v1/user") && /^Bearer .+/.test(init.headers.authorization || "") ? new Response(JSON.stringify({ id: UID })) : new Response("{}", { status: 401 });
  await ctx.route("**/*", async (r) => { const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", aiAvailable: true, features }) });
    if (u.includes("/api/guardian")) {
      if (st.offline) return r.abort("internetdisconnected");
      const rq = r.request(), body = rq.postData();
      st.calls.push(body ? (() => { try { return JSON.parse(body).action; } catch { return "form"; } })() : "status");
      const req = new Request(u, { method: rq.method(), headers: rq.headers(), body: rq.method() === "POST" ? body : undefined });
      const res = await guardianFn(req, {}, { env, fetchImpl, store: st.store, now: () => Date.now() + st.skew, log: () => {} });
      return r.fulfill({ status: res.status, contentType: res.headers.get("content-type") || "application/json", body: await res.text() });
    }
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(700);
  await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Asha"); await pg.fill("input[name=email]", `asha${Math.random().toString(16).slice(2, 8)}@example.com`); await pg.fill("input[name=pw]", "secret123"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await pg.waitForTimeout(700);
  return { ctx, pg, st };
}
const text = (pg) => pg.evaluate(() => document.body.innerText);
const W = (pg, ms) => pg.waitForTimeout(ms);

{
  const { ctx, pg } = await device({});
  check("with the guardian switch off, there is no Guardian in the menu", !(await pg.$("[data-nav=guardian]")));
  await pg.evaluate(() => go("guardian")); await W(pg, 300);
  check("…and opening it directly says it isn't available, with 112", (await text(pg)).includes("Guardian isn’t available yet") && (await text(pg)).includes("112"));
  await ctx.close();
}
{
  const { ctx, pg, st } = await device({ guardian: true });
  check("with the switch on, Guardian is in the menu", !!(await pg.$("#nav [data-nav=guardian]")));
  await pg.evaluate(() => go("guardian")); await W(pg, 900);
  let t = await text(pg);
  check("the screen says what Guardian does and doesn't do, and that it isn't an emergency service", t.includes("doesn’t do yet: detect falls or crashes") && t.includes("It is not an emergency service"));
  check("status is honest: Off before it's switched on, and never 'Protected'", t.includes("Guardian status: Off") && !/protected/i.test(t));
  check("unbuilt capabilities are named as such (journey, fall detection, wearable, background, alerts to contacts)", ["Not built yet", "Device unsupported", "Not connected"].every((s) => t.includes(s)) && t.includes("Doctine can’t send messages yet"));
  check("no SOS button until Guardian is switched on", !(await pg.$("#gsos")));
  await pg.check("[data-gset=enabled]"); await W(pg, 900);
  t = await text(pg);
  check("switching it on saves the setting and shows the SOS button; status becomes Limited", !!(await pg.$("#gsos")) && t.includes("Guardian status: Limited") && (await st.store.getSettings(UID)).enabled === true);

  await pg.click("#gadd"); await pg.fill("#gcf input[name=name]", "Fictional Sister"); await pg.fill("#gcf input[name=phone]", "+91 90000 00001"); await pg.fill("#gcf input[name=relationship]", "Sister");
  await pg.click("#gcf button[type=submit]"); await W(pg, 900);
  t = await text(pg);
  check("a trusted contact is added and shown as not verified", t.includes("Fictional Sister") && t.includes("Not confirmed yet") && (await st.store.listContacts(UID)).length === 1);

  await pg.click("[data-ginvite]"); await W(pg, 1200);
  const inv = await pg.$eval("#ginvmsg", (e) => e.value).catch(() => "");
  const link = (inv.match(/https?:\/\/\S+/) || [""])[0];
  check("'Ask to confirm' prepares a message with the contact's own link", /^Asha would like you to be a trusted contact on Doctine/.test(inv) && link.includes("/api/guardian?consent="), inv.slice(0, 60));
  const pc = await ctx.newPage(); await pc.goto(link); await W(pc, 300);
  const ct = await pc.evaluate(() => document.body.innerText);
  check("the contact's page explains what agreeing means and shows nothing about the person", ct.includes("Fictional Sister, someone has added you as a trusted contact") && ct.includes("I agree") && !ct.includes("Asha") && !ct.includes("90000"));
  await pc.click("button[value=agree]"); await W(pc, 300);
  check("agreeing thanks them", (await pc.evaluate(() => document.body.innerText)).includes("You're now a trusted contact"));
  await pc.close();
  await pg.evaluate(() => gLoad(true)); await W(pg, 800);
  check("…and the person now sees the contact as agreed, with no 'Ask to confirm' button", (await text(pg)).includes("Agreed to be your contact") && !(await pg.$("[data-ginvite]")));

  await pg.click("#gsos"); await W(pg, 300);
  check("SOS gives a 5-second countdown with Cancel", (await text(pg)).includes("Raising an alert in") && !!(await pg.$("#gsoscancel")));
  await pg.click("#gsoscancel"); await W(pg, 5500);
  check("cancelling raises nothing", !st.calls.includes("report") && (await st.store.recentIncidents(UID)).length === 0);

  await pg.click("#gsos"); await W(pg, 200); await pg.click("#gsosnow"); await W(pg, 1500);
  t = await text(pg);
  const incs = await st.store.recentIncidents(UID);
  check("'Send now' raises one SOS incident", incs.length === 1 && incs[0].event_type === "sos");
  check("the screen says plainly that contacts could NOT be alerted automatically", t.includes("Doctine could not alert your contacts automatically") && t.includes("Not sent: automatic messages aren’t set up yet"));
  check("Call 112 and a Call button for the contact are offered", !!(await pg.$('a[href="tel:112"]')) && !!(await pg.$('a[href="tel:+919000000001"]')));

  await pg.click("[data-gshare]"); await W(pg, 1200);
  t = await text(pg);
  const msg = await pg.$eval("#gmsg", (e) => e.value).catch(() => "");
  check("'Message' prepares the text to send yourself, ending with 112", /^Doctine alert: Asha pressed SOS at .* IST\..*call 112\.$/.test(msg), msg.slice(0, 80));
  check("…and records it honestly as opened by you, not as delivered", t.includes("You opened a message to them (Doctine can’t see whether it was sent)"));

  await pg.click("[data-gresolve]"); await W(pg, 1200);
  t = await text(pg);
  check("closing the alert moves it to Past alerts as Resolved", t.includes("Past alerts") && t.includes("Resolved") && !(await pg.$("[data-gresolve]")));

  await pg.click("#gtest"); await W(pg, 1500);
  t = await text(pg);
  check("a test alert runs the flow, is marked Test, and says no one was contacted", t.includes("Test") && t.includes("This is a test, so no one was contacted"));
  const tid = (await st.store.openIncidents(UID))[0].id;
  check("…and its delivery is recorded as a test, not sent", (await st.store.listDeliveries(UID, tid)).every((d) => d.error === "test_incident"));
  await pg.click(`[data-gresolve="${tid}"]`); await W(pg, 1000);

  // a check-in from another source (as a watch would send it): the banner asks on any screen
  await pg.evaluate(() => gApi({ action: "report", event: { event_id: gId(), event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good", observed_at: new Date().toISOString() } }));
  await pg.evaluate(() => { go("home"); return gLoad(true); }); await W(pg, 900);
  t = await text(pg);
  check("an open check-in shows 'Guardian: are you OK?' with a countdown on other screens", t.includes("Guardian: are you OK?") && /\d+ s left to answer/.test(t));
  await pg.click("#banner [data-gans=ok]"); await W(pg, 1200);
  check("'I'm OK' cancels it and the banner goes", !(await text(pg)).includes("Guardian: are you OK?") && (await st.store.recentIncidents(UID))[0].state === "CANCELLED");

  // no answer: the device's countdown reaches zero and tells the server
  await pg.evaluate(() => gApi({ action: "report", event: { event_id: gId(), event_type: "fall", source: "apple_fall_detection", confidence: 0.9, signal_quality: "good", observed_at: new Date().toISOString() } }));
  st.skew = 58_000; await pg.evaluate(() => { go("guardian"); return gLoad(true); }); await W(pg, 4500);
  const last = (await st.store.recentIncidents(UID))[0];
  check("when the check-in countdown ends unanswered, the incident escalates (and says it couldn't deliver)", last.state === "FAILED_TO_DELIVER" && st.calls.includes("respond"), last.state);
  await pg.evaluate((id) => gApi({ action: "resolve", incident_id: id }), last.id); st.skew = 0;

  // offline: the SOS is kept on the device and sent when back online, exactly once
  st.offline = true; await pg.evaluate(() => gLoad(true)); await W(pg, 500);
  await pg.click("#gsos"); await W(pg, 200); await pg.click("#gsosnow"); await W(pg, 1200);
  t = await text(pg);
  const queued = await pg.evaluate(() => gQ.get().length);
  check("offline: the SOS is saved on the device and the screen says so (with 112)", queued === 1 && t.includes("saved on this device") && t.includes("call 112"));
  st.offline = false; await pg.evaluate(() => dispatchEvent(new Event("online"))); await W(pg, 1500);
  const all = await st.store.recentIncidents(UID);
  check("back online: the saved SOS is sent once and the queue is empty", all.filter((i) => i.event_type === "sos" && !i.test).length === 2 && (await pg.evaluate(() => gQ.get().length)) === 0);
  await pg.evaluate(() => { dispatchEvent(new Event("online")); }); await W(pg, 800);
  check("sending the queue again creates no duplicate", (await st.store.recentIncidents(UID)).filter((i) => i.event_type === "sos" && !i.test).length === 2);
  await ctx.close();
}
{
  const { ctx, pg } = await device({ guardian: true }, { width: 320 });
  await pg.evaluate(() => go("guardian")); await W(pg, 900);
  await pg.check("[data-gset=enabled]"); await W(pg, 800);
  const over = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("320 px: the Guardian screen fits without sideways scrolling", over <= 0, "overflow " + over);
  await ctx.close();
}
check("no script errors on the page", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
console.log(`\nguardian (browser): ${out.filter((l) => l.startsWith("PASS")).length} passed, ${out.filter((l) => l.startsWith("FAIL")).length} failed`);
if (out.some((l) => l.startsWith("FAIL"))) process.exit(1);
