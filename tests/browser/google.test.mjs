/**
 * Doctine · signing in with Google. Supabase is simulated (fake-supabase-strict.js, with row-level ownership), including
 * the round trip through Google: the page leaves and comes back signed in. Checks that the button appears only when
 * the site has Google switched on, that the same agreement as an email sign-up is required and recorded once, that a
 * choice made later is never overwritten, that records are saved to the account, and that failures are explained.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const results = [], errs = [];
const check = (name, ok, detail = "") => { const line = (ok ? "PASS " : "FAIL ") + name + (detail ? "  — " + detail : ""); results.push(line); console.log(line); };
const b = await chromium.launch();

async function device(google, aiAvailable) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript({ content: fakeSrc });
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message));
  await pg.route("**/*", async (r) => { const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase", environment: "test", googleSignIn: google, ...(aiAvailable === undefined ? {} : { aiAvailable }) }) });
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(700);
  return { ctx, pg };
}
const oauthCalls = (pg) => pg.evaluate("JSON.parse(localStorage.getItem('__oauthCalls')||'[]')");
const consents = (pg) => pg.evaluate("(()=>{const u=window.__sbdb.users['priya.google@example.com'];return u?window.__sbdb.tables.consents?.filter(c=>c.user_id===u.user.id).map(c=>c.kind+'='+c.granted).sort():null})()");

// Google not switched on for this site: no button, so nobody is sent to an error page
let { ctx, pg } = await device(false);
check("no Google button when the site hasn't switched Google on", (await pg.$("#google")) === null);
check("with real accounts, the sign-in screen offers no guest chat (the assistant answers signed-in accounts only)", (await pg.$("#guest")) === null && (await pg.$("#samp")) !== null);
check("the sign-in screen has visible field labels, a Show/Hide password control and the brand panel copy", (await pg.$("label[for=au-email]")) !== null && (await pg.$("label[for=au-pw]")) !== null && (await pg.$("#pwtoggle[aria-pressed=false]")) !== null && (await pg.textContent(".au-art")).includes("Your health has a history."));
await ctx.close();

({ ctx, pg } = await device(true));
check("'Continue with Google' is on the sign-in screen", (await pg.$("#google")) !== null && (await pg.$("#gack")) !== null);
await pg.click("[data-auth=register]"); await pg.waitForTimeout(100);
check("…and on the create-account screen", (await pg.$("#google")) !== null);

await pg.click("#google"); await pg.waitForTimeout(200);
check("both sign-up agreements ask the person to confirm they are 18 or older, as the terms require", (await pg.textContent("label:has(#gack)")).includes("18 or older") && (await pg.textContent("label:has(input[name=ack])")).includes("18 or older"));
check("Google needs the same agreement as an email sign-up", (await pg.textContent("#gerr")).includes("Please tick the box") && (await oauthCalls(pg)).length === 0);

await pg.check("#gack"); await Promise.all([pg.waitForNavigation({ timeout: 10000 }), pg.click("#google")]); await pg.waitForTimeout(900);
const calls = await oauthCalls(pg);
check("it asks Supabase for Google, returning to this page", calls.length === 1 && calls[0].provider === "google" && calls[0].redirectTo === BASE + "/index.html", JSON.stringify(calls));
check("back from Google, the person is in their Doctine account", await pg.evaluate("S.cloud===true&&CLOUD.email==='priya.google@example.com'") && (await pg.textContent("#who")).includes("Doctine account"));
check("the agreement is recorded once, as for an email sign-up", JSON.stringify(await consents(pg)) === JSON.stringify(["cloud_storage=true"]), JSON.stringify(await consents(pg)));
check("signing up doesn't switch on the AI assistant: that's a separate choice, off by default", await pg.evaluate("S.consent.ai===false") && !/AI provider/.test(await pg.evaluate("document.body.innerText")));

// records go into the account and survive a reload
await pg.evaluate("go('health')"); for (const [k, v] of [["blood", "O+"], ["allergies", "Penicillin"]]) { await pg.fill(`[data-p=${k}]`, v); await pg.dispatchEvent(`[data-p=${k}]`, "change"); }
await pg.waitForTimeout(2500);
const saved = await pg.evaluate("window.__sbdb.tables.health_profiles?.find(p=>p.user_id===CLOUD.uid)");
check("health details are saved to the database under this account", saved && saved.blood_group === "O+" && saved.allergies === "Penicillin");
await pg.reload(); await pg.waitForTimeout(1200);
check("still signed in after a reload, with the details still there", await pg.evaluate("S.cloud&&S.profile.blood==='O+'&&S.profile.allergies==='Penicillin'"));

// a later choice is never overwritten by signing in again
await pg.evaluate("(()=>{const c=window.__sbdb.tables.consents.find(c=>c.user_id===CLOUD.uid&&c.kind==='cloud_storage');c.granted=false;localStorage.setItem('__sbdb',JSON.stringify(window.__sbdb))})()");
await pg.evaluate("document.querySelector('#out').click()"); await pg.waitForTimeout(500);
await pg.check("#gack"); await Promise.all([pg.waitForNavigation({ timeout: 10000 }), pg.click("#google")]); await pg.waitForTimeout(900);
check("signing in with Google again keeps a choice the person changed later", JSON.stringify(await consents(pg)) === JSON.stringify(["cloud_storage=false"]), JSON.stringify(await consents(pg)));
// an AI permission recorded under the old, bundled sign-up agreement (before it became its own choice) doesn't count
await pg.evaluate("(()=>{window.__sbdb.tables.consents.push({user_id:CLOUD.uid,kind:'ai_chat',granted:true,updated_at:'2026-11-05T10:00:00Z'});localStorage.setItem('__sbdb',JSON.stringify(window.__sbdb))})()");
await pg.evaluate("document.querySelector('#out').click()"); await pg.waitForTimeout(500);
await pg.check("#gack"); await Promise.all([pg.waitForNavigation({ timeout: 10000 }), pg.click("#google")]); await pg.waitForTimeout(900);
check("an AI permission from the old bundled sign-up agreement isn't treated as permission", await pg.evaluate("S.consent.ai===false"));
check("signing in again opens the same account, not a new one", await pg.evaluate("Object.keys(window.__sbdb.users).length===1&&S.profile.blood==='O+'"));

// failures are explained
await pg.evaluate("document.querySelector('#out').click()"); await pg.waitForTimeout(500);
await pg.evaluate("window.__oauthFail=true"); await pg.check("#gack"); await pg.click("#google"); await pg.waitForTimeout(300);
check("if Google sign-in isn't available, the person is told and can use email", (await pg.textContent("#gerr")).includes("isn’t available right now") && !(await pg.isDisabled("#google")));
await pg.goto(BASE + "/index.html?error=server_error&error_code=unexpected_failure&error_description=Unable+to+exchange+external+code"); await pg.waitForTimeout(900);
check("a Google error sent back in the query string is explained and removed from the address", (await pg.textContent("#gerr")).includes("didn’t work") && (await pg.evaluate("location.search")) === "", await pg.evaluate("location.search"));
// a full page load, as when Google sends the person back
await pg.goto(BASE + "/index.html?from=google#error=access_denied&error_description=The+user+denied"); await pg.waitForTimeout(900);
check("cancelling at Google shows a message and cleans the address", (await pg.textContent("#gerr")).includes("cancelled") && !(await pg.evaluate("location.hash")) && (await pg.$("#gack")) !== null);

await ctx.close();

// before the AI model is switched on, a signed-in person is told up front instead of finding out after asking
const signIn = async (pg) => { await pg.check("#gack"); await Promise.all([pg.waitForNavigation({ timeout: 10000 }), pg.click("#google")]); await pg.waitForTimeout(900); };
({ ctx, pg } = await device(true, false)); await signIn(pg);
await pg.evaluate("go('chat')"); await pg.waitForTimeout(150);
check("with the AI not switched on yet, chat says so before anyone asks, and still mentions 112", (await pg.$("#aioff")) !== null && /switching on soon/.test(await pg.textContent("#aioff")) && /112/.test(await pg.textContent("#aioff")) && (await pg.$("[data-q]")) === null);
await pg.evaluate("go('reports')"); await pg.waitForTimeout(100);
check("…and scanning says pages are saved as photos for now", (await pg.textContent("#view")).includes("Saved as a photo. Automatic reading switches on soon."));
await pg.evaluate("go('health')"); await pg.waitForTimeout(100);
check("the health profile says it saves to the account, not this browser", (await pg.textContent("#view")).includes("Saved to your account when you leave a field") && !(await pg.textContent("#view")).includes("Saved in this browser"));
await pg.evaluate("go('settings')"); await pg.waitForTimeout(100);
check("no 'demo' wording left in a real account's settings or reminders", !/this demo/i.test(await pg.textContent("#view")) && await pg.evaluate("go('reminders'),!/this demo|Simulate/i.test(document.querySelector('#view').textContent)"));
await ctx.close();
({ ctx, pg } = await device(true, true)); await signIn(pg); await pg.evaluate("go('chat')"); await pg.waitForTimeout(150);
check("with the AI switched on, there's no notice and the example questions are back", (await pg.$("#aioff")) === null && (await pg.$("[data-q]")) !== null);
await ctx.close();

check("no JavaScript errors", errs.length === 0, errs.join(" | "));
await b.close();
console.log(results.filter((r) => r.startsWith("PASS")).length + "/" + results.length + " passed");
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
