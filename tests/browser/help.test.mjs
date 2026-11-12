/**
 * Doctine · the app's Settings → Help and feedback, and What's new. Supabase is simulated (fake-supabase-strict.js) with
 * the same ownership rule as the real database functions: each person reaches only their own support requests.
 * Checks: sending a request and feedback, seeing a staff reply but never an internal note, replying, the health-details
 * warning, that one person's requests never show for the next person on the same browser, and published release notes.
 * Fictional people and text only.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = process.env.DOCTINE_BASE || "http://localhost:8766";
const fake = readFileSync(new URL("./fake-supabase-strict.js", import.meta.url), "utf8");
const out = []; const check = (n, ok, d = "") => { out.push((ok ? "PASS " : "FAIL ") + n + (d ? "  — " + d : "")); console.log(out[out.length - 1]); };
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 } }); await ctx.addInitScript(fake);
const pg = await ctx.newPage(); const errs = []; pg.on("pageerror", (e) => errs.push(e.message)); pg.on("dialog", (d) => d.accept());
await pg.route("**/*", async (r) => { const u = r.request().url();
  if (u.endsWith("/api/config")) return r.fulfill({ contentType: "application/json", body: JSON.stringify({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", accounts: "supabase",
    whatsNew: [{ id: "n1", title: "Faster record search", body: "Search now finds records by provider.", published_at: "2026-11-12T06:00:00Z" }] }) });
  if (u.startsWith(BASE)) return r.continue(); return r.abort(); });
await pg.goto(BASE + "/index.html"); await pg.waitForTimeout(700);
const W = (ms) => pg.waitForTimeout(ms);
const register = async (name, email) => { await pg.click("[data-auth=register]"); await pg.fill("input[name=name]", name); await pg.fill("input[name=email]", email); await pg.fill("input[name=pw]", "secret123"); await pg.check("input[name=ack]"); await pg.click("#rf button.pri"); await W(600); };
const signOut = async () => { await pg.evaluate("document.getElementById('out').click()"); await W(400); };
const settings = async () => { await pg.evaluate("go('settings')"); await W(500); };
const view = () => pg.textContent("#view");

await register("Asha", "asha.help@example.com"); await settings();
check("Settings has Help and feedback for a signed-in account, with a warning not to include health details", (await view()).includes("Help and feedback") && (await view()).includes("don’t include test results, prescriptions or other health details"));
check("What's new shows published release notes", (await view()).includes("What’s new") && (await view()).includes("Faster record search"));
await pg.click("#help summary >> nth=0");
await pg.click("#supsend"); await W(200);
check("an empty request is not sent", !(await pg.evaluate(() => window.__writes.some((w) => w.table === "rpc:support_submit"))));
await pg.selectOption("#supcat", "sign_in"); await pg.fill("#supsub", "Cannot sign in on my phone"); await pg.fill("#supbody", "The code never arrives on my phone."); await pg.click("#supsend"); await W(700);
check("sending a request gives a reference and lists it", /Your reference is S-\d+/.test(await view()) && (await view()).includes("Cannot sign in on my phone"));
const sent = await pg.evaluate(() => window.__writes.find((w) => w.table === "rpc:support_submit").rows[0]);
check("the request goes through the support function with topic, subject and message only", JSON.stringify(Object.keys(sent).sort()) === JSON.stringify(["p_body", "p_category", "p_subject"]) && sent.p_category === "sign_in");
// staff reply and an internal note, added the way the database would hold them
await pg.evaluate(() => { const db = window.__sbdb, r = db.tables.support_requests[0], t = new Date().toISOString(); db.tables.support_messages.push({ request_id: r.id, at: t, from_staff: true, internal: false, body: "Please try the email link instead." }, { request_id: r.id, at: t, from_staff: true, internal: true, body: "INTERNAL-NOTE-SECRET" }); r.status = "waiting"; localStorage.setItem("__sbdb", JSON.stringify(db)); });
await pg.evaluate("go('home')"); await W(200); await pg.evaluate("S.help=null"); await settings(); await W(400);
check("the person sees the support reply and its status", (await view()).includes("Doctine replied") && (await pg.evaluate(() => document.querySelector("#help").innerHTML.includes("Please try the email link instead."))));
check("…but never an internal staff note", !(await pg.evaluate(() => document.body.innerHTML.includes("INTERNAL-NOTE-SECRET"))));
await pg.evaluate(() => document.querySelectorAll("#help details").forEach((d) => { d.open = true; }));
const rid = await pg.evaluate(() => document.querySelector("[data-supreply]").dataset.supreply);
await pg.fill(`[id="suprep-${rid}"]`, "Thanks, that worked."); await pg.click(`[data-supreply="${rid}"]`); await W(600);
check("the person can reply to their request", (await view()).includes("Reply sent") && (await pg.evaluate(() => window.__sbdb.tables.support_messages.some((m) => m.body === "Thanks, that worked."))));
await pg.evaluate(() => document.querySelectorAll("#help details").forEach((d) => { d.open = true; }));
await pg.selectOption("#fbkind", "idea"); await pg.selectOption("#fbarea", "medicines"); await pg.fill("#fbbody", "A weekly view of doses would help."); await pg.click("#fbsend"); await W(500);
check("feedback is sent with its kind and area", (await view()).includes("Your feedback went to the Doctine team") && (await pg.evaluate(() => window.__sbdb.tables.feedback.some((f) => f.kind === "idea" && f.area === "medicines"))));

// the next person on the same browser never sees the first person's requests
await signOut(); await register("Bharat", "bharat.help@example.com"); await settings(); await W(500);
check("after signing out, the next person sees none of the previous person's requests", !(await view()).includes("Cannot sign in on my phone") && !(await view()).includes("Your requests"));
const leaked = await pg.evaluate(() => window.__writes.filter((w) => w.table === "rpc:support_mine").map((w) => w.session));
check("each person's request list was fetched under their own sign-in", new Set(leaked).size === 2);

// rate limit message
await pg.evaluate(() => { const db = window.__sbdb, u = db.users["bharat.help@example.com"].user.id; for (let i = 0; i < 5; i++) db.tables.support_requests.push({ id: "x" + i, ref: "S-x", user_id: u, subject: "s", status: "open" }); localStorage.setItem("__sbdb", JSON.stringify(db)); });
await pg.evaluate(() => document.querySelectorAll("#help details").forEach((d) => { d.open = true; }));
await pg.fill("#supsub", "Another one"); await pg.fill("#supbody", "Fictional request beyond the limit."); await pg.click("#supsend"); await W(500);
check("the daily limit is explained plainly", (await view()).includes("You’ve sent a lot today"));
const o = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
check("390 px: no sideways scrolling", o <= 1, "overflow " + o);
check("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
await b.close();
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(failed ? `${out.length - failed} passed, ${failed} FAILED` : `${out.length}/${out.length} passed`);
process.exit(failed ? 1 : 0);
