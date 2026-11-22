/**
 * Doctine · forgotten password, end to end, in account mode. Supabase is simulated (fake-supabase-strict.js) the way
 * supabase-js 2.45.4 really handles an email link: it saves the recovery session from the address and announces
 * PASSWORD_RECOVERY only a moment later. This test plays Supabase's /verify step: a reset token works once; a used or
 * expired one comes back as Supabase's error redirect. Fictional people and passwords only.
 *
 * Covers: requesting a reset (without revealing whether an account exists), the reset address, opening the link signed
 * out, while signed in to the same account, and while signed in to a different account; links from older emails that
 * return to the home page; mismatched, short and unchanged passwords; saving; being signed out everywhere afterwards;
 * signing in with the new password and not the old one; reused and expired links (signed in and out); errors sent in
 * the query string; Cancel; Show/Hide on both fields; strength feedback; the address bar never keeping the token; no
 * account data loaded during recovery; layout at 320 and 390 px.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fake = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const out = []; const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript(fake);
const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => { if (pg.url() !== "about:blank") errs.push(e.message); }); /* the blank page between links has no storage */ pg.on("dialog", (d) => d.accept());
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase" }) });
  if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
const W = (ms) => pg.waitForTimeout(ms);
const h1 = () => pg.textContent(".au-card h1").catch(() => "");
const appOpen = () => pg.evaluate(() => !document.getElementById("app").classList.contains("hidden") && !!S.email);
const LS = (k) => pg.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), k);
const err = () => pg.textContent("#aerr").catch(() => "");
const fresh = async (url) => { await pg.goto("about:blank"); await pg.goto(url); await W(900); };
// Supabase's /verify step: a token works once; afterwards (or if expired) Supabase redirects with an error instead.
const SUCCESS = (tok) => `${BASE}/?reset=password#access_token=${tok}&expires_at=${Math.floor(Date.now() / 1000) + 3600}&expires_in=3600&refresh_token=r-${tok}&token_type=bearer&type=recovery`;
const EXPIRED = `${BASE}/?reset=password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`;
const openLink = async (tok, { expired = false, url = SUCCESS } = {}) => {
  const R = await LS("__sbrecovery"); const used = !R || !R[tok] || R[tok].used;
  if (!used && !expired) await pg.evaluate((t) => { const R = JSON.parse(localStorage.getItem("__sbrecovery")); R[t].used = true; localStorage.setItem("__sbrecovery", JSON.stringify(R)); }, tok);
  await fresh(used || expired ? EXPIRED : url(tok));
};
const register = async (name, email, pw) => { await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", name); await pg.fill("input[name=email]", email); await pg.fill("input[name=pw]", pw); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(700); };
const signOut = async () => { await pg.evaluate("document.getElementById('out').click()"); await W(400); };
const signIn = async (email, pw) => { if (!(await pg.$("#lf"))) { await pg.click("[data-auth=login]").catch(() => {}); await W(150); } await pg.fill("#lf [name=email]", email); await pg.fill("#lf [name=pw]", pw); await pg.click("#lf button.pri"); await W(900); };
const requestReset = async (email) => { if (!(await pg.$("#ff"))) { await pg.click("[data-auth=forgot]"); await W(150); } await pg.fill("#ff [name=email]", email); await pg.click("#ff button.pri"); await W(400); return pg.evaluate(() => localStorage.getItem("__lastRecovery")); };
const setNew = async (a, c = a) => { await pg.fill("#npf [name=pw]", a); await pg.fill("#npf [name=pw2]", c); await pg.click("#npf button.pri"); await W(600); };

await pg.goto(BASE + "/index.html"); await W(800);
// two fictional accounts, each with a record, so we can tell whose data is on screen
await register("Kavya Rao", "kavya.reset@example.com", "kavya-old-pass-1");
await pg.evaluate(() => { const db = window.__sbdb; (db.tables.documents = db.tables.documents || []).push({ id: crypto.randomUUID(), user_id: CLOUD.uid, client_id: "9001", title: "KAVYA-PRIVATE-RECORD", category: "Lab report", source: "manual", page_count: 0, fields: {}, created_at: new Date().toISOString() }); localStorage.setItem("__sbdb", JSON.stringify(db)); });
await signOut();
await register("Dev Mehta", "dev.reset@example.com", "dev-old-pass-12");
await pg.evaluate(() => { const db = window.__sbdb; (db.tables.documents = db.tables.documents || []).push({ id: crypto.randomUUID(), user_id: CLOUD.uid, client_id: "9002", title: "DEV-PRIVATE-RECORD", category: "Lab report", source: "manual", page_count: 0, fields: {}, created_at: new Date().toISOString() }); localStorage.setItem("__sbdb", JSON.stringify(db)); });
await signOut();

// 1. requesting a reset
await pg.click("[data-auth=forgot]"); await W(150);
await pg.fill("#ff [name=email]", "nobody.reset@example.com"); await pg.click("#ff button.pri"); await W(400);
const unknownMsg = await pg.textContent(".au-note");
let tok = await requestReset("kavya.reset@example.com").catch(() => null);
if (!(await pg.$("#ff"))) { await pg.click("[data-auth=login]"); await W(150); tok = await requestReset("kavya.reset@example.com"); }
const knownMsg = await pg.textContent(".au-note");
const calls = await LS("__resetCalls");
check("a reset email is requested for the address typed", calls.some((c) => c.email === "kavya.reset@example.com"));
check("the link returns to the dedicated reset address (/?reset=password on this site)", calls.every((c) => c.redirectTo === new URL(BASE).origin + "/?reset=password"));
check("the confirmation never reveals whether an account exists", unknownMsg.replace("nobody.reset@example.com", "X") === knownMsg.replace("kavya.reset@example.com", "X"));

// 2. opening the link while signed out
await openLink(tok);
await W(800);
check("signed out: the link opens 'Create a new password', and it stays (the account does not open)", (await h1()) === "Create a new password" && !(await appOpen()));
check("…with the subtitle, the account it is for, and new + confirm fields", (await pg.textContent(".au-sub")).includes("Choose a new password to securely access your Doctine account") && (await pg.textContent(".au-card")).includes("kavya.reset@example.com") && !!(await pg.$("#npf [name=pw]")) && !!(await pg.$("#npf [name=pw2]")));
check("the recovery token is removed from the address bar", !(await pg.evaluate(() => location.href)).includes("access_token") && !(await pg.evaluate(() => location.search)).includes("reset"));
check("no account data is loaded or shown during recovery", !(await pg.evaluate(() => document.body.innerText.includes("KAVYA-PRIVATE-RECORD"))) && (await pg.evaluate(() => S.reports.length)) === 0);
// labels and Show/Hide on both fields
check("both fields have visible labels", !!(await pg.$("label[for=au-pw]")) && !!(await pg.$("label[for=au-pw2]")));
await pg.click("#pwtoggle-pw2");
check("Show/Hide works on each field on its own", (await pg.getAttribute("[name=pw2]", "type")) === "text" && (await pg.getAttribute("[name=pw]", "type")) === "password");
await pg.click("#pwtoggle-pw2");
await pg.fill("#npf [name=pw]", "abc"); const s1 = await pg.textContent("#pwstrl");
await pg.fill("#npf [name=pw]", "Correct-Horse-Battery-9"); const s4 = await pg.textContent("#pwstrl");
check("strength feedback updates while typing", /too short/i.test(s1) && s4 === "Strong", s1 + " → " + s4);
// validation
await setNew("kavya-new-pass-2", "kavya-new-pass-3");
check("mismatched passwords: a clear error, nothing saved", /don’t match/.test(await err()) && (await pg.evaluate(() => window.__sbdb.users["kavya.reset@example.com"].password)) === "kavya-old-pass-1");
await setNew("short", "short");
check("too short: refused before anything is sent", (await err()) === "Use at least 8 characters.");
await setNew("kavya-old-pass-1");
check("the current password again: refused with a plain message", /current password/.test(await err()));
// saving
await setNew("kavya-new-pass-2");
check("matching passwords: 'Your password has been updated successfully.'", (await h1()) === "Password updated" && (await pg.textContent(".au-card")).includes("Your password has been updated successfully."));
check("the new password is saved", (await pg.evaluate(() => window.__sbdb.users["kavya.reset@example.com"].password)) === "kavya-new-pass-2");
check("afterwards every session is signed out (global sign-out), so an old session elsewhere stops working", (await LS("__signOuts")).pop() === "global" && !(await LS("__sbsession")));
check("the form is gone after saving, so it can't be sent twice", !(await pg.$("#npf")));
await pg.click(".au-card [data-auth=login]"); await W(200);
check("'Continue to sign in' opens sign-in with the email filled in", (await h1()) === "Welcome back" && (await pg.inputValue("#lf [name=email]")) === "kavya.reset@example.com");
await signIn("kavya.reset@example.com", "kavya-old-pass-1");
check("the old password no longer works", !(await appOpen()) && /incorrect/.test(await err()));
await signIn("kavya.reset@example.com", "kavya-new-pass-2");
check("the new password signs in, and the account's own records are there (so the checks above are meaningful)", (await appOpen()) && (await pg.evaluate(() => S.reports.some((r) => r.title === "KAVYA-PRIVATE-RECORD"))));

// 3. the same link again
await signOut();
await openLink(tok);
check("reusing a link: 'This link has expired', with a button for a new one", (await h1()) === "This link has expired" && !!(await pg.$(".au-card [data-auth=forgot]")) && !(await appOpen()));

// 4. opening a link while already signed in to the same account (the reported problem)
await signIn("kavya.reset@example.com", "kavya-new-pass-2");
check("(signed in to Kavya's account)", await appOpen());
tok = await pg.evaluate(async () => { await CLOUD.sb.auth.resetPasswordForEmail("kavya.reset@example.com", { redirectTo: location.origin + "/?reset=password" }); return localStorage.getItem("__lastRecovery"); });
await openLink(tok);
await W(1200);
check("already signed in: the link still opens 'Create a new password' and the account does not open", (await h1()) === "Create a new password" && !(await appOpen()));
check("…and none of the account's records are on screen", !(await pg.evaluate(() => document.body.innerText.includes("KAVYA-PRIVATE-RECORD"))));
await setNew("kavya-third-pass-3");
check("…and the new password saves", (await h1()) === "Password updated" && (await pg.evaluate(() => window.__sbdb.users["kavya.reset@example.com"].password)) === "kavya-third-pass-3");

// 5. signed in as Dev, opening Kavya's link on the same browser
await pg.click(".au-card [data-auth=login]"); await W(150);
await signIn("dev.reset@example.com", "dev-old-pass-12");
check("(signed in to Dev's account)", await appOpen());
tok = await pg.evaluate(async () => { await CLOUD.sb.auth.resetPasswordForEmail("kavya.reset@example.com", { redirectTo: location.origin + "/?reset=password" }); return localStorage.getItem("__lastRecovery"); });
await openLink(tok);
check("signed in as someone else: the reset is for the account the link was sent to, and Dev's data is not shown", (await h1()) === "Create a new password" && (await pg.textContent(".au-card")).includes("kavya.reset@example.com") && !(await pg.evaluate(() => document.body.innerText.includes("DEV-PRIVATE-RECORD"))));
await pg.click("#npcancel"); await W(400);
check("Cancel ends the reset session and goes to sign-in, changing nothing", (await h1()) === "Welcome back" && !(await LS("__sbsession")) && (await pg.evaluate(() => window.__sbdb.users["kavya.reset@example.com"].password)) === "kavya-third-pass-3");

// 6. an expired link while signed in: the account is kept and can be continued
await signIn("dev.reset@example.com", "dev-old-pass-12");
await openLink("rec-not-a-real-token", { expired: true });
check("expired link while signed in: 'This link has expired', the session is kept, and the account doesn't open by itself", (await h1()) === "This link has expired" && !!(await LS("__sbsession")) && !(await appOpen()));
await pg.click("#expcont"); await W(900);
check("…'Continue to my account' opens it", await appOpen());

// 7. links from emails sent before this change returned to the home page with the recovery session
await signOut();
tok = await requestReset("dev.reset@example.com");
await pg.evaluate((t) => { const R = JSON.parse(localStorage.getItem("__sbrecovery")); R[t].used = true; localStorage.setItem("__sbrecovery", JSON.stringify(R)); }, tok);
await fresh(`${BASE}/index.html#access_token=${tok}&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery`);
check("an older reset email (returning to the home page) also opens 'Create a new password'", (await h1()) === "Create a new password" && !(await appOpen()));
await pg.click("#npcancel"); await W(300);

// 8. Supabase can also send the error in the query string
await fresh(`${BASE}/?reset=password&error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
check("an expired link reported in the query string: the same expired screen, and the error is cleared from the address", (await h1()) === "This link has expired" && !(await pg.evaluate(() => location.search)).includes("error"));

// 9. layout
for (const w of [320, 390]) {
  await pg.setViewportSize({ width: w, height: 760 });
  tok = await requestReset("dev.reset@example.com").catch(async () => { await pg.click("[data-auth=login]").catch(() => {}); return requestReset("dev.reset@example.com"); });
  await openLink(tok);
  const o = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(`${w} px: the new-password screen fits without sideways scrolling`, (await h1()) === "Create a new password" && o <= 1, "overflow " + o);
  if (w === 390) await pg.screenshot({ path: new URL("./reset-password-390.png", import.meta.url).pathname.replace("/tests/browser/", "/.qa/") }).catch(() => {});
  await pg.click("#npcancel"); await W(300);
}
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} passed, ${failed} FAILED` : `${out.length}/${out.length} passed`);
process.exit(failed ? 1 : 0);
