/**
 * Doctine · sign-in, account creation and recovery, in account mode (Supabase simulated in the browser by
 * fake-supabase-strict.js, plus the switches below). Checks the screens drive the real auth calls and show the right
 * state for each response: validation, wrong password, unconfirmed email and resending, existing account, reset
 * request, expired email link, slow responses, network failure, session persistence and sign-out; and the layout at
 * nine widths. Run through tools/run-browser-tests.mjs.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8888";
const fakeSrc = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
// Switches on top of the fake: email confirmation (window.__confirmRequired), slow replies (__authDelay ms),
// network failure (__netFail), and a log of auth calls in localStorage.__authLog.
const authSwitches = `(() => {
  const make = window.supabase.createClient;
  window.supabase.createClient = (...a) => {
    const c = make(...a), A = c.auth;
    const log = (k, v) => { const L = JSON.parse(localStorage.getItem("__authLog") || "[]"); L.push([k, v]); localStorage.setItem("__authLog", JSON.stringify(L)); };
    const wait = () => new Promise((r) => setTimeout(r, window.__authDelay || 0));
    const unconf = () => JSON.parse(localStorage.getItem("__unconf") || "[]");
    const net = () => { if (window.__netFail) throw new TypeError("fetch failed"); };
    c.auth = { ...A,
      async signUp(p) { await wait(); net(); log("signUp", p.email);
        if (!window.__confirmRequired) return A.signUp(p);
        if (window.__sbdb.users[p.email]) return { data: { user: { id: "00000000-0000-0000-0000-000000000000" }, session: null }, error: null }; // Supabase hides existing accounts
        const r = await A.signUp(p); await A.signOut(); localStorage.setItem("__unconf", JSON.stringify([...unconf(), p.email]));
        return { data: { user: r.data.user, session: null }, error: null }; },
      async signInWithPassword(p) { await wait(); net(); log("signIn", p.email);
        const u = window.__sbdb.users[p.email];
        if (unconf().includes(p.email) && u && u.password === p.password) return { data: {}, error: { message: "Email not confirmed" } };
        return A.signInWithPassword(p); },
      async resend(p) { await wait(); net(); log("resend", p.type + "|" + p.email); return { error: null }; },
      async resetPasswordForEmail(e, o) { await wait(); net(); log("reset", e + "|" + (o && o.redirectTo)); return { error: null }; },
      async updateUser(p) { await wait(); net(); log("updateUser", p.password ? "password" : "other"); return A.updateUser(p); },
    };
    return c;
  };
})();`;

const out = [];
const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch();
const errs = [];
async function open(width = 390, { hash = "", search = "", googleFlag = false, height } = {}) {
  const ctx = await b.newContext({ viewport: { width, height: height || (width < 700 ? 844 : 900) } });
  await ctx.addInitScript({ content: fakeSrc }); await ctx.addInitScript({ content: authSwitches });
  if (googleFlag) await ctx.addInitScript(() => sessionStorage.setItem("doctine:google-consent", "1"));
  const pg = await ctx.newPage(); pg.on("pageerror", (e) => errs.push(e.message)); pg.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await pg.route("**/*", (r) => { const u = r.request().url();
    if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase" }) });
    if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
  await pg.goto(BASE + "/index.html" + search + hash); await pg.waitForSelector("#auth .au-card h1", { timeout: 10000 }); await pg.waitForTimeout(300);
  return { ctx, pg };
}
const W = (pg, ms) => pg.waitForTimeout(ms);
const errText = (pg) => pg.evaluate(() => document.querySelector("#aerr")?.innerText.trim() || "");
const invalid = (pg, name) => pg.evaluate((n) => document.querySelector(`#auth [name=${n}]`)?.getAttribute("aria-invalid") === "true", name);
const authLog = (pg) => pg.evaluate(() => JSON.parse(localStorage.getItem("__authLog") || "[]"));

// ---------- sign-in screen: structure ----------
let { ctx, pg } = await open(390);
check("sign-in opens with 'Welcome back' and the supporting sentence", (await pg.textContent(".au-card h1")) === "Welcome back" && (await pg.textContent(".au-sub")).includes("Sign in to access your personal health records."));
check("every field has a visible label tied to it", await pg.evaluate(() => [...document.querySelectorAll("#auth input.au-inp")].every((i) => document.querySelector(`label[for="${i.id}"]`)?.offsetParent)));
check("autocomplete lets password managers fill the form (username/email, current-password)", (await pg.getAttribute("[name=email]", "autocomplete")).includes("email") && (await pg.getAttribute("[name=pw]", "autocomplete")) === "current-password");
check("pasting is not blocked", await pg.evaluate(() => { const i = document.querySelector("[name=pw]"); return !i.hasAttribute("onpaste") && !i.hasAttribute("readonly"); }));
await pg.click("#pwtoggle");
check("Show turns the password visible, says Hide, and reports pressed", (await pg.getAttribute("[name=pw]", "type")) === "text" && (await pg.textContent("#pwtoggle")) === "Hide" && (await pg.getAttribute("#pwtoggle", "aria-pressed")) === "true");
await pg.click("#pwtoggle");
check("…and Hide turns it back", (await pg.getAttribute("[name=pw]", "type")) === "password" && (await pg.getAttribute("#pwtoggle", "aria-label")) === "Show password");
check("only real sign-in options appear (no Google button unless the site turns it on, no guest chat)", (await pg.$("#google")) === null && (await pg.$("#guest")) === null);
check("on a phone the large picture panel is hidden and the form comes first", await pg.evaluate(() => getComputedStyle(document.querySelector(".au-art")).display === "none" && document.querySelector(".au-card").getBoundingClientRect().top < 160));

// ---------- validation ----------
await pg.click("#lf button.pri"); await W(pg, 150);
check("empty email: asks for it, marks the field and moves focus there", (await errText(pg)) === "Enter your email address." && (await invalid(pg, "email")) && (await pg.evaluate(() => document.activeElement.name)) === "email");
await pg.fill("[name=email]", "kavya.at.example"); await pg.click("#lf button.pri"); await W(pg, 150);
check("badly formed email: explains the expected form", (await errText(pg)).includes("like name@example.com") && (await invalid(pg, "email")));
await pg.fill("[name=email]", "kavya@example.com"); await pg.click("#lf button.pri"); await W(pg, 150);
check("missing password: asks for it on the password field", (await errText(pg)) === "Enter your password." && (await invalid(pg, "pw")) && !(await invalid(pg, "email")));
check("the error is announced (role=alert) and linked to the field", await pg.evaluate(() => !!document.querySelector("#aerr [role=alert]") && document.querySelector("[name=pw]").getAttribute("aria-errormessage") === "au-err"));
check("validation alone calls no sign-in", !(await authLog(pg)).some(([k]) => k === "signIn"));

// ---------- create account: validation, existing account, confirmation required, resend ----------
await pg.click("[data-auth=register]"); await W(pg, 150);
check("create account: heading, name/email/password fields and the 8-character hint", (await pg.textContent(".au-card h1")) === "Create your account" && (await pg.$("#rf [name=name]")) && (await pg.textContent("#au-pw-hint")) === "At least 8 characters." && (await pg.getAttribute("#rf [name=pw]", "autocomplete")) === "new-password");
check("the hint is read with the password field", (await pg.getAttribute("#rf [name=pw]", "aria-describedby")) === "au-pw-hint");
await pg.fill("[name=name]", "Kavya Rao"); await pg.fill("[name=email]", "kavya@example.com"); await pg.fill("[name=pw]", "short"); await pg.click("#rf button.pri"); await W(pg, 150);
check("a short password is refused before anything is sent", (await errText(pg)) === "Use at least 8 characters." && (await invalid(pg, "pw")) && !(await authLog(pg)).some(([k]) => k === "signUp"));
await pg.fill("[name=pw]", "kavya-pass-123"); await pg.click("#rf button.pri"); await W(pg, 150);
check("the agreement must be ticked", (await errText(pg)) === "Please tick the box to continue.");
await pg.evaluate(() => { window.__confirmRequired = true; });
await pg.check("[name=ack]"); await pg.click("#rf button.pri"); await W(pg, 400);
check("with email confirmation on: 'Confirm your email', naming the address", (await pg.textContent(".au-card h1")) === "Confirm your email" && (await pg.textContent(".au-note")).includes("kavya@example.com"));
await pg.click("#resend"); await W(pg, 300);
check("'send it again' resends the signup confirmation and says so", (await authLog(pg)).some(([k, v]) => k === "resend" && v === "signup|kavya@example.com") && (await errText(pg)).startsWith("Sent."));
await pg.click("[data-auth=login]"); await W(pg, 150);
await pg.fill("[name=email]", "kavya@example.com"); await pg.fill("[name=pw]", "kavya-pass-123"); await pg.click("#lf button.pri"); await W(pg, 400);
check("signing in before confirming explains why and offers to resend", (await errText(pg)).includes("Please confirm your email first") && (await pg.$("#aerr #resend")) !== null);
await pg.click("#aerr #resend"); await W(pg, 300);
check("…which resends the confirmation", (await authLog(pg)).filter(([k]) => k === "resend").length === 2);
await ctx.close();

// ---------- wrong password, existing account, slow reply, network failure ----------
({ ctx, pg } = await open(1440));
await pg.click("[data-auth=register]"); await pg.fill("[name=name]", "Meera"); await pg.fill("[name=email]", "meera@example.com"); await pg.fill("[name=pw]", "meera-pass-123"); await pg.check("[name=ack]"); await pg.click("#rf button.pri"); await W(pg, 900);
check("creating an account (no confirmation needed) opens the app", await pg.evaluate(() => !!S.cloud) && (await pg.textContent("#who")).includes("Doctine account"));
await pg.reload(); await pg.waitForTimeout(1200);
check("the session persists across a reload", await pg.evaluate(() => !!S.cloud && document.getElementById("auth").classList.contains("hidden") && !document.getElementById("app").classList.contains("hidden")));
await pg.evaluate(() => document.getElementById("out").click()); await W(pg, 500);
check("signing out returns to the sign-in screen", (await pg.textContent(".au-card h1")) === "Welcome back");
await pg.click("[data-auth=register]"); await pg.fill("[name=name]", "Meera"); await pg.fill("[name=email]", "meera@example.com"); await pg.fill("[name=pw]", "another-pass-1"); await pg.check("[name=ack]"); await pg.click("#rf button.pri"); await W(pg, 300);
check("an existing account is pointed to sign-in", (await errText(pg)).includes("already exists. Try signing in."));
await pg.click("[data-auth=login]"); await pg.fill("[name=email]", "meera@example.com"); await pg.fill("[name=pw]", "not-her-password"); await pg.click("#lf button.pri"); await W(pg, 300);
check("wrong password: one message that doesn't say which part was wrong", (await errText(pg)) === "Email or password is incorrect.");
await pg.evaluate(() => { window.__authDelay = 900; });
await pg.click("#lf button.pri"); await W(pg, 250);
const busy = await pg.evaluate(() => { const x = document.querySelector("#lf button.pri"); return { t: x.textContent, b: x.getAttribute("aria-busy"), d: x.disabled, spin: !!x.querySelector(".au-spin") }; });
check("while waiting, the button says 'Signing in…', is busy and can't be pressed twice", busy.t === "Signing in…" && busy.b === "true" && busy.d && busy.spin, JSON.stringify(busy));
await W(pg, 900);
check("…and comes back as 'Sign in' after the answer", (await pg.textContent("#lf button.pri")) === "Sign in" && !(await pg.getAttribute("#lf button.pri", "aria-busy")));
await pg.evaluate(() => { window.__authDelay = 0; window.__netFail = true; });
await pg.click("#lf button.pri"); await W(pg, 300);
check("network failure is reported as such", (await errText(pg)).startsWith("Network problem."));
await pg.evaluate(() => { window.__netFail = false; });
await pg.fill("[name=pw]", "meera-pass-123"); await pg.keyboard.press("Enter"); await W(pg, 1000);
check("Enter submits, and a correct password signs in", await pg.evaluate(() => !!S.cloud));
await pg.evaluate(() => document.getElementById("out").click()); await W(pg, 500);

// ---------- password recovery ----------
await pg.click("[data-auth=forgot]"); await W(pg, 150);
check("reset screen: heading, email field and a privacy-safe explanation", (await pg.textContent(".au-card h1")) === "Reset your password" && (await pg.textContent(".au-sub")).includes("If it matches an account"));
await pg.fill("#ff [name=email]", "nobody@example.com"); await pg.click("#ff button.pri"); await W(pg, 300);
const rl = (await authLog(pg)).find(([k]) => k === "reset");
check("the reset email is requested from Supabase, returning to this app", !!rl && rl[1].startsWith("nobody@example.com|") && rl[1].endsWith("/index.html"));
check("the confirmation doesn't reveal whether an account exists", (await pg.textContent(".au-card h1")) === "Check your email" && (await pg.textContent(".au-note")).includes("If an account exists for nobody@example.com"));
await pg.evaluate(() => { S.auth = "newpw"; render(); }); await W(pg, 150);
check("arriving from a reset link: 'Choose a new password' with the new-password field", (await pg.textContent(".au-card h1")) === "Choose a new password" && (await pg.getAttribute("#npf [name=pw]", "autocomplete")) === "new-password");
await pg.fill("#npf [name=pw]", "short"); await pg.click("#npf button.pri"); await W(pg, 150);
check("a short new password is refused", (await errText(pg)) === "Use at least 8 characters." && !(await authLog(pg)).some(([k]) => k === "updateUser"));
await ctx.close();

// ---------- links from emails that have expired, and Google errors ----------
({ ctx, pg } = await open(390, { hash: "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired" }));
check("an expired email link opens 'This link has expired' (not a Google error)", (await pg.textContent(".au-card h1")) === "This link has expired" && !(await pg.evaluate(() => S.oauthErr)));
check("…the error is removed from the address bar", (await pg.evaluate(() => location.hash)) === "");
await pg.click(".au-card [data-auth=forgot]"); await W(pg, 150);
check("…and leads straight to requesting a new link", (await pg.textContent(".au-card h1")) === "Reset your password");
await ctx.close();
({ ctx, pg } = await open(390, { hash: "#error=access_denied&error_code=flow_state_not_found&error_description=Email+link+could+not+be+used" }));
check("an email link that fails for another reason says the link didn't work (not a Google error) and offers the way forward", (await pg.textContent(".au-card h1")) === "That link didn’t work" && (await pg.textContent(".au-note")).includes("Request a new one") && !(await pg.evaluate(() => S.oauthErr)));
await ctx.close();
({ ctx, pg } = await open(390, { search: "?error=access_denied&error_description=The+user+denied", googleFlag: true }));
check("cancelling Google sign-in is still reported as a Google cancellation", (await pg.evaluate(() => S.oauthErr)) === "Google sign-in was cancelled." && (await pg.textContent(".au-card h1")) === "Welcome back");
await ctx.close();

// ---------- layout at nine widths, light and dark ----------
const rows = [];
for (const w of [360, 375, 390, 430, 768, 1024, 1366, 1440, 1920]) {
  for (const scheme of ["light", "dark"]) {
    const c2 = await b.newContext({ viewport: { width: w, height: w < 700 ? 760 : w < 1100 ? 900 : 900 }, colorScheme: scheme });
    await c2.addInitScript({ content: fakeSrc }); await c2.addInitScript({ content: authSwitches });
    const p = await c2.newPage(); p.on("pageerror", (e) => errs.push(e.message));
    await p.route("**/*", (r) => { const u = r.request().url(); if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: '{"supabaseUrl":"https://x.supabase.co","supabaseAnonKey":"anon","accounts":"supabase"}' }); if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
    await p.goto(BASE + "/index.html"); await p.waitForSelector("#auth .au-card h1"); await p.waitForTimeout(250);
    for (const screen of ["login", "register", "forgot"]) {
      if (screen !== "login") { await p.evaluate((s) => { S.auth = s; render(); }, screen); await p.waitForTimeout(120); }
      const m = await p.evaluate(() => {
        const vw = innerWidth, art = document.querySelector(".au-art"), card = document.querySelector(".au-card"), btn = document.querySelector(".au-card button.pri");
        const small = [...document.querySelectorAll("#auth button, #auth a, #auth input")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && e.type !== "checkbox" && (r.height < 24 || r.width < 24); }).map((e) => (e.id || e.textContent.trim()).slice(0, 20));
        const inp = document.querySelector(".au-card .au-inp").getBoundingClientRect();
        return { over: document.documentElement.scrollWidth - vw, art: getComputedStyle(art).display !== "none", artW: Math.round(art.getBoundingClientRect().width / vw * 100), cardW: Math.round(card.getBoundingClientRect().width), btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0, inpH: Math.round(inp.height), small, cardTop: Math.round(card.getBoundingClientRect().top) };
      });
      rows.push({ w, scheme, screen, ...m });
      if (scheme === "light" && screen === "login") await p.screenshot({ path: (process.env.SHOTS || "/tmp") + `/auth-${w}.png` }).catch(() => {});
      if (scheme === "dark" && screen === "login" && (w === 390 || w === 1440)) await p.screenshot({ path: (process.env.SHOTS || "/tmp") + `/auth-dark-${w}.png` }).catch(() => {});
    }
    await c2.close();
  }
}
const bad = rows.filter((r) => r.over > 0 || r.small.length || r.btnH < 44 || r.inpH < 44 || (r.w >= 960) !== r.art);
check("at 360–1920px (light and dark; sign-in, create account, reset): no sideways scroll, 44px+ fields and buttons, no tiny targets, picture panel only from 960px", !bad.length, bad.slice(0, 3).map((r) => `${r.w} ${r.scheme} ${r.screen} over=${r.over} btn=${r.btnH} inp=${r.inpH} art=${r.art} small=${r.small}`).join("; "));
const desk = rows.filter((r) => r.w >= 1024 && r.screen === "login" && r.scheme === "light");
check("on desktop the picture takes about 42% (a little less on very wide, short screens, so it is never cropped) and the form stays readable (380–420px)", desk.every((r) => r.artW >= 34 && r.artW <= 43 && r.cardW >= 380 && r.cardW <= 420), desk.map((r) => `${r.w}:${r.artW}%/${r.cardW}px`).join(" "));
check("no script errors on any sign-in screen", !errs.length, errs.slice(0, 3).join(" | "));

await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`${out.length - failed}/${out.length} passed`);
process.exit(failed ? 1 : 0);
