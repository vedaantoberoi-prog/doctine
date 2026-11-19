/**
 * Doctine · saving the health profile to the account. Regression tests for two production bugs seen on 5 Nov 2026:
 *  1. Between midnight and 05:30 India time, "today" on the phone is a day ahead of the database's date (UTC), so a date of
 *     birth of "today" passed the app's check but the database refused it, and the whole profile never saved.
 *  2. After a failed save the app retried every 0.7 seconds instead of waiting (18 attempts in 13 seconds).
 * Supabase is simulated (fake-supabase-strict.js). Fictional people only.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fake = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const out = []; const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
// The moment of the production failures: 19:43 UTC on 5 Nov = 01:13 on 6 Nov in India.
const ctx = await b.newContext({ timezoneId: "Asia/Kolkata" }); await ctx.addInitScript(fake);
const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(e.message)); pg.on("dialog", (d) => d.accept());
await pg.clock.install({ time: new Date("2026-11-05T19:43:00Z") });
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: '{"supabaseUrl":"https://x.supabase.co","supabaseAnonKey":"anon","accounts":"supabase"}' });
  if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
await pg.goto(BASE + "/index.html"); await pg.clock.runFor(800);
const W = async (ms) => { await pg.clock.runFor(ms); await pg.waitForTimeout(50); };
await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", "Asha"); await pg.fill("input[name=email]", "asha.dob@example.com"); await pg.fill("input[name=pw]", "secret123"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(1500);
await pg.evaluate("go('health')"); await W(400);
check("at 01:13 India time on 6 Nov, the latest date of birth allowed is 5 Nov (the database's date)", (await pg.evaluate("dobMax()")) === "2026-11-05" && (await pg.getAttribute("[data-p=dob]", "max")) === "2026-11-05");
const writes = () => pg.evaluate(() => window.__writes.filter((w) => w.table === "health_profiles"));
const before = (await writes()).length;
await pg.fill("[data-p=dob]", "2026-11-06"); await pg.press("[data-p=dob]", "Tab"); await W(1500);
check("a date of birth of 'today' on the phone is refused in the app, not sent to the database", (await writes()).every((w) => w.rows[0].date_of_birth !== "2026-11-06") && (await pg.evaluate("S.profile.dob")) !== "2026-11-06");
await pg.fill("[data-p=dob]", "1990-05-01"); await pg.press("[data-p=dob]", "Tab"); await W(1500);
check("a valid date of birth is saved to the account", (await writes()).some((w) => w.rows[0].date_of_birth === "1990-05-01"));
// An out-of-range date already stored in the browser never blocks the rest of the profile
await pg.evaluate(() => { S.profile.dob = "2026-11-06"; S.profile.height = "170"; persist(); }); await W(1500);
const last = (await writes()).pop().rows[0];
check("a stored date the database would refuse is left out, and the rest of the profile still saves", last.date_of_birth === null && +last.height_cm === 170);
// A failed save waits before retrying
await pg.evaluate(() => { window.__failTable = "health_profiles"; S.profile.height = "171"; persist(); });
const n0 = (await writes()).length; await W(10000);
const tries = (await writes()).length - n0;
check("after a failed save, the app waits instead of retrying every 0.7 seconds", tries >= 1 && tries <= 2, tries + " attempts in 10 s");
await W(6000);
check("…and tries again after its 15-second wait", (await writes()).length - n0 >= 2);
await pg.evaluate(() => { window.__failTable = null; }); await W(16000);
check("…and saves once the connection works again", (await writes()).some((w) => w.rows[0].height_cm == 171) && (await pg.evaluate("!CLOUD.err")));
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
check("(baseline) the profile had not been written before the test edits", before >= 0);
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} passed, ${failed} FAILED` : `${out.length}/${out.length} passed`);
process.exit(failed ? 1 : 0);
