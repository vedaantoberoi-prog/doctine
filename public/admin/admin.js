/* Doctine · internal admin console (app.doctine.com/admin).
 *
 * This page holds no privileges of its own. It signs in with the normal Doctine sign-in (Supabase Auth, publishable key)
 * and sends the person's own token to /api/admin, where the server and the database decide every request. Menus are
 * hidden for permissions a role does not have, but that is only tidiness: the same requests are refused server-side.
 * No health information is ever requested or shown: no record titles, values, prescriptions, messages or files.
 */
"use strict";
(() => {
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en-IN");
const n = (v) => (v == null || v === "" || Number.isNaN(+v) ? "—" : nf.format(+v));
const pct = (a, b) => (b ? Math.round((a * 1000) / b) / 10 + "%" : "—");
const bytes = (b) => { b = +b || 0; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + " " + u[i]; };
const TZ = "Asia/Kolkata";
const dt = (v, withTime = true) => (v ? new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(new Date(v)) : "—");
const dayLabel = (d) => new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(d + "T00:00:00Z"));
const IST = 330 * 60000;

const A = { sb: null, session: null, me: null, cfg: null, route: "dashboard", period: { key: "7d" }, cache: {} };
const can = (p) => !!(A.me && A.me.perms && A.me.perms.includes(p));

/* ───────── periods (calendar days in India Standard Time) ───────── */
function istMidnight(ms) { const d = new Date(ms + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST; }
function periodRange(p = A.period) {
  const now = Date.now(), today = istMidnight(now), day = 86400000;
  let from, to = now, label;
  if (p.key === "today") { from = today; label = "Today"; }
  else if (p.key === "7d") { from = today - 6 * day; label = "Last 7 days"; }
  else if (p.key === "30d") { from = today - 29 * day; label = "Last 30 days"; }
  else if (p.key === "90d") { from = today - 89 * day; label = "Last 90 days"; }
  else if (p.key === "month" || p.key === "lastmonth") {
    const d = new Date(now + IST); let y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (p.key === "lastmonth") { m -= 1; if (m < 0) { m = 11; y -= 1; } }
    from = Date.UTC(y, m, 1) - IST; const end = Date.UTC(y, m + 1, 1) - IST; to = Math.min(end, now);
    label = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m, 1)));
  } else if (p.key === "custom" && p.from && p.to) {
    from = Date.parse(p.from + "T00:00:00+05:30"); to = Math.min(Date.parse(p.to + "T00:00:00+05:30") + day, now); label = p.from + " to " + p.to;
  } else { from = today - 6 * day; label = "Last 7 days"; }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), label };
}

/* ───────── server calls ───────── */
async function token() {
  const { data } = await A.sb.auth.getSession();
  A.session = data.session; return data.session && data.session.access_token;
}
async function api(action, args = {}, { raw = false } = {}) {
  const t = await token();
  if (!t) { renderGate(); throw new Error("signed_out"); }
  const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: JSON.stringify({ action, ...args }) });
  if (raw && r.ok) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || "error"); e.status = r.status; e.code = j.error; e.request_id = j.request_id;
    if (r.status === 401) { renderGate("Your session ended. Please sign in again."); }
    throw e;
  }
  return j.data;
}
const ERR = { forbidden: "Your role does not allow this.", not_installed: "The admin database update has not been applied to this Supabase project yet (see docs/ADMIN_CONSOLE.md).", not_configured: "The server is missing its Supabase settings.", mfa_required: "Two-step sign-in is required.", invalid: "Some details were not accepted.", invalid_period: "That date range is not valid (up to 400 days).", not_found: "Not found.", rate_limited: "Too many requests. Please wait a moment.", database_error: "The database did not answer. Please try again." };
const errText = (e) => (ERR[e.code] || "Something went wrong (" + esc(e.code || e.message) + ").") + (e.request_id ? ` <span class="mono">ref ${esc(e.request_id.slice(0, 8))}</span>` : "");
function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3500); }

/* ───────── boot & sign-in ───────── */
async function boot() {
  try {
    A.cfg = await (await fetch("/api/config", { cache: "no-store" })).json();
  } catch { A.cfg = null; }
  if (!A.cfg || !A.cfg.supabaseUrl || !window.supabase) {
    $("#root").innerHTML = `<div class="gate"><div class="card"><div class="mark">D</div><h1>Admin console unavailable</h1><p>This site is not connected to its account service, so there is nothing to administer here.</p></div></div>`;
    return;
  }
  A.sb = window.supabase.createClient(A.cfg.supabaseUrl, A.cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  A.sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") renderGate(); });
  await enter();
}
async function enter() {
  if (!(await token())) return renderGate();
  try { A.me = await (async () => { const t = await token(); const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: '{"action":"me"}' }); const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error); e.code = j.error; e.status = r.status; e.request_id = j.request_id; throw e; } return j; })(); }
  catch (e) {
    if (e.status === 401) return renderGate("Please sign in again.");
    if (e.code === "forbidden") return renderNoAccess();
    return renderGate(null, errText(e));
  }
  if (A.me.mfa_required) return renderMfa();
  renderShell();
}
function renderGate(msg, htmlErr) {
  $("#root").innerHTML = `<main class="gate"><form class="card" id="signin" novalidate>
    <div class="mark" aria-hidden="true">D</div>
    <h1>Doctine admin</h1>
    <p>For the Doctine team only. Sign in with your Doctine account. Access is given by the owner; there is no sign-up here.</p>
    ${msg ? `<p class="callout">${esc(msg)}</p>` : ""}
    <label class="f" for="em">Email</label><input id="em" type="email" autocomplete="username" required>
    <label class="f" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
    <p class="err" id="gerr" role="alert">${htmlErr || ""}</p>
    <button class="btn primary" style="width:100%;margin-top:12px" type="submit">Sign in</button>
  </form></main>`;
  $("#signin").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const b = ev.submitter || $("#signin button"); b.disabled = true; $("#gerr").textContent = "";
    const { error } = await A.sb.auth.signInWithPassword({ email: $("#em").value.trim(), password: $("#pw").value });
    b.disabled = false;
    if (error) { $("#gerr").textContent = /confirm/i.test(error.message) ? "Please confirm your email address first." : "That email and password did not match."; return; }
    enter();
  });
}
function renderNoAccess() {
  const email = A.session && A.session.user && A.session.user.email;
  $("#root").innerHTML = `<main class="gate"><div class="card"><div class="mark" aria-hidden="true">D</div><h1>No admin access</h1>
    <p>${email ? `You are signed in as <b>${esc(email)}</b>, which` : "This account"} is not on the Doctine admin team. The attempt has been recorded.</p>
    <div class="row"><a class="btn" href="/">Go to Doctine</a><button class="btn ghost" id="so">Sign out</button></div></div></main>`;
  $("#so").onclick = async () => { await A.sb.auth.signOut({ scope: "local" }); renderGate(); };
}
async function renderMfa() {
  const { data } = await A.sb.auth.mfa.listFactors();
  const totp = (data && data.totp || []).find((f) => f.status === "verified");
  if (totp) {
    $("#root").innerHTML = `<main class="gate"><form class="card" id="mfa"><div class="mark" aria-hidden="true">D</div><h1>Two-step sign-in</h1>
      <p>Enter the 6-digit code from your authenticator app.</p>
      <label class="f" for="code">Code</label><input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
      <p class="err" id="merr" role="alert"></p><button class="btn primary" style="width:100%;margin-top:12px">Continue</button>
      <button class="btn ghost" type="button" id="so" style="width:100%;margin-top:6px">Sign out</button></form></main>`;
    $("#mfa").onsubmit = async (ev) => {
      ev.preventDefault();
      const { error } = await A.sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code: $("#code").value.trim() });
      if (error) { $("#merr").textContent = "That code did not work. Try the newest code."; return; }
      await A.sb.auth.refreshSession(); enter();
    };
  } else {
    const { data: en, error } = await A.sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Doctine admin " + new Date().toISOString().slice(0, 10) });
    if (error) { $("#root").innerHTML = `<main class="gate"><div class="card"><h1>Two-step sign-in needed</h1><p>Two-step sign-in is required for the admin console, but it could not be set up here (${esc(error.message)}). Ask the owner to check that TOTP is enabled in Supabase Auth.</p></div></main>`; return; }
    $("#root").innerHTML = `<main class="gate"><form class="card" id="mfa"><div class="mark" aria-hidden="true">D</div><h1>Set up two-step sign-in</h1>
      <p>The admin console requires it. Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the code it shows.</p>
      <img alt="QR code for your authenticator app" src="${esc(en.totp.qr_code)}" width="180" height="180" style="display:block;margin:0 auto 8px;background:#fff">
      <p class="note">Can't scan? Enter this key: <span class="mono">${esc(en.totp.secret)}</span></p>
      <label class="f" for="code">Code</label><input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
      <p class="err" id="merr" role="alert"></p><button class="btn primary" style="width:100%;margin-top:12px">Turn on two-step sign-in</button></form></main>`;
    $("#mfa").onsubmit = async (ev) => {
      ev.preventDefault();
      const { error: e2 } = await A.sb.auth.mfa.challengeAndVerify({ factorId: en.id, code: $("#code").value.trim() });
      if (e2) { $("#merr").textContent = "That code did not work. Try the newest code."; return; }
      await A.sb.auth.refreshSession(); enter();
    };
  }
}

/* ───────── shell & navigation ───────── */
const NAV = [
  ["Overview", [["dashboard", "Dashboard", "dashboard.view"], ["analytics", "Analytics", "analytics.view"], ["reports", "Reports", "reports.export"]]],
  ["Operations", [["users", "Users", "users.view"], ["documents", "Documents", "documents.view"], ["health", "Platform health", "health.view"], ["incidents", "Incidents", "health.view"], ["alerts", "Alerts", "health.view"]]],
  ["Control", [["flags", "Feature switches", "flags.view"], ["maintenance", "Maintenance", "flags.view"], ["announcements", "Announcements", "dashboard.view"]]],
  ["Security", [["team", "Admin team", "team.view"], ["audit", "Audit log", "audit.view"], ["security", "Security events", "security.view"]]],
  ["Settings", [["definitions", "Metric definitions", "dashboard.view"], ["access", "Your access", "dashboard.view"]]],
];
const TITLES = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([k, t]) => [k, t])));
const PERIOD_VIEWS = new Set(["dashboard", "analytics", "documents", "reports"]);

function renderShell() {
  const env = A.cfg.environment || "unset";
  $("#root").innerHTML = `<div class="shell">
    <aside class="side" id="side" aria-label="Admin sections">
      <div class="brand"><div class="mark" aria-hidden="true">D</div><div>Doctine<small>Admin console</small></div></div>
      <nav class="nav">${NAV.map(([g, items]) => { const vis = items.filter(([, , p]) => can(p)); return vis.length ? `<h2>${g}</h2>` + vis.map(([k, t]) => `<a href="#/${k}" data-k="${k}">${t}</a>`).join("") : ""; }).join("")}</nav>
    </aside>
    <div class="main">
      <header class="top">
        <button class="btn menu-btn" id="menu" aria-controls="side" aria-expanded="false">Menu</button>
        <h1 id="title">Dashboard</h1>
        <div class="filters" id="filters"></div>
        <div class="who"><span class="env ${esc(env)}" title="Which site this console is connected to">${esc(env)}</span><span class="email">${esc(A.me.email || "")}</span><span class="role">${esc((A.me.role || "").replace("_", " "))}</span><button class="btn ghost" id="signout">Sign out</button></div>
      </header>
      <main class="content" id="view" tabindex="-1"></main>
    </div></div>`;
  $("#signout").onclick = async () => { await A.sb.auth.signOut({ scope: "local" }); renderGate("You have signed out."); };
  $("#menu").onclick = () => { const s = $("#side"); const o = s.classList.toggle("open"); $("#menu").setAttribute("aria-expanded", o); };
  $("#side").addEventListener("click", (e) => { if (e.target.closest("a")) { $("#side").classList.remove("open"); $("#menu").setAttribute("aria-expanded", "false"); } });
  window.onhashchange = route; route();
}
function renderFilters() {
  const f = $("#filters"); if (!f) return;
  if (!PERIOD_VIEWS.has(A.route)) { f.innerHTML = ""; return; }
  const keys = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["month", "This month"], ["lastmonth", "Last month"], ["custom", "Custom"]];
  f.innerHTML = `<div class="seg" role="group" aria-label="Period">${keys.map(([k, t]) => `<button data-p="${k}" aria-pressed="${A.period.key === k}">${t}</button>`).join("")}</div>
    ${A.period.key === "custom" ? `<label class="sr" for="pf">From</label><input type="date" id="pf" value="${esc(A.period.from || "")}"><label class="sr" for="pt">To</label><input type="date" id="pt" value="${esc(A.period.to || "")}"><button class="btn" id="papply">Apply</button>` : ""}
    <span class="tz">Times in India Standard Time (IST)</span>`;
  f.querySelectorAll("[data-p]").forEach((b) => b.onclick = () => { A.period = { ...A.period, key: b.dataset.p }; if (b.dataset.p !== "custom") { renderFilters(); route(); } else renderFilters(); });
  const ap = $("#papply"); if (ap) ap.onclick = () => { A.period = { key: "custom", from: $("#pf").value, to: $("#pt").value }; if (!A.period.from || !A.period.to || A.period.from > A.period.to) return toast("Choose a start date on or before the end date."); renderFilters(); route(); };
}
async function route() {
  const k = (location.hash.replace(/^#\/?/, "").split("?")[0]) || "dashboard";
  const allowed = NAV.flatMap(([, items]) => items).find(([key, , p]) => key === k && can(p));
  A.route = allowed ? k : NAV.flatMap(([, i]) => i).find(([, , p]) => can(p))[0];
  document.querySelectorAll(".nav a").forEach((a) => (a.dataset.k === A.route ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  $("#title").textContent = TITLES[A.route]; document.title = "Doctine · " + TITLES[A.route];
  renderFilters();
  const v = $("#view"); v.innerHTML = `<p class="note">Loading…</p>`;
  try { await VIEWS[A.route](v); } catch (e) { if (e.message !== "signed_out") v.innerHTML = `<div class="callout bad">${errText(e)}</div>`; }
}

/* ───────── charts (plain SVG; hover for values; table view) ───────── */
let chartN = 0;
function lineChart(rows, series, { height = 220, bars = false, fmt = n } = {}) {
  if (!rows.length) return `<div class="empty">No data in this period.</div>`;
  const id = "c" + (++chartN), W = 640, H = height, L = 44, R = 12, T = 10, B = 26;
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => +r[s.key] || 0)));
  const nice = (() => { const p = Math.pow(10, Math.floor(Math.log10(max))); const m = max / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; })();
  const x = (i) => L + (rows.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (rows.length - 1));
  const bw = Math.max(2, Math.min(28, ((W - L - R) / rows.length) * 0.6));
  const xb = (i) => L + ((i + 0.5) * (W - L - R)) / rows.length;
  const y = (v) => T + (H - T - B) * (1 - v / nice);
  const ticks = (nice % 2 === 0 ? [0, 0.5, 1] : [0, 1]).map((f) => f * nice);
  const step = Math.max(1, Math.ceil(rows.length / 7));
  let svg = `<g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>`;
  svg += `<g class="axis">${ticks.map((t) => `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmt(Math.round(t))}</text>`).join("")}`;
  svg += rows.map((r, i) => (i % step === 0 || i === rows.length - 1) ? `<text x="${bars ? xb(i) : x(i)}" y="${H - 6}" text-anchor="middle">${esc(dayLabel(r.day))}</text>` : "").join("") + `</g>`;
  if (bars) {
    const s = series[0];
    svg += rows.map((r, i) => { const v = +r[s.key] || 0, h = (H - T - B) * (v / nice); return v ? `<path d="M${xb(i) - bw / 2},${y(0)} v${-Math.max(h - 3, 0)} q0,-3 3,-3 h${bw - 6} q3,0 3,3 v${Math.max(h - 3, 0)} z" fill="${s.color}"/>` : ""; }).join("");
  } else {
    for (const s of series) {
      const pts = rows.map((r, i) => `${x(i).toFixed(1)},${y(+r[s.key] || 0).toFixed(1)}`);
      svg += `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}"/>`;
      if (rows.length <= 2) svg += rows.map((r, i) => `<circle cx="${x(i)}" cy="${y(+r[s.key] || 0)}" r="4" fill="${s.color}"/>`).join("");
    }
  }
  svg += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#9aa4b0" stroke-dasharray="3 3" style="display:none"/>`;
  svg += `<rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("")}</div>` : "";
  const table = `<details><summary class="linkish">Show as table</summary><div class="tablewrap" style="margin-top:8px;max-height:260px"><table><thead><tr><th>Day</th>${series.map((s) => `<th class="num">${esc(s.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(dayLabel(r.day))}</td>${series.map((s) => `<td class="num">${fmt(r[s.key])}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
  queueMicrotask(() => {
    const host = document.getElementById(id); if (!host) return;
    const sv = host.querySelector("svg"), tip = host.querySelector(".tip"), cross = sv.querySelector(".cross");
    const move = (ev) => {
      const b = sv.getBoundingClientRect(), px = ((ev.clientX - b.left) / b.width) * W;
      const i = bars ? Math.min(rows.length - 1, Math.max(0, Math.floor(((px - L) / (W - L - R)) * rows.length))) : Math.min(rows.length - 1, Math.max(0, Math.round(((px - L) / (W - L - R)) * (rows.length - 1))));
      const cx = bars ? xb(i) : x(i), r = rows[i];
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.style.display = "";
      tip.innerHTML = `<b>${esc(dayLabel(r.day))}</b><br>` + series.map((s) => `${esc(s.label)}: <b>${fmt(r[s.key])}</b>`).join("<br>");
      tip.style.display = "block"; tip.style.left = (cx / W) * 100 + "%"; tip.style.top = (y(Math.max(...series.map((s) => +r[s.key] || 0))) / H) * b.height + "px";
    };
    sv.addEventListener("pointermove", move); sv.addEventListener("pointerdown", move);
    sv.addEventListener("pointerleave", () => { tip.style.display = "none"; cross.style.display = "none"; });
  });
  return `${legend}<div class="chart" id="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.label).join(", "))} by day">${svg}</svg><div class="tip"></div></div>${table}`;
}
function hbars(items, { total, fmt = n } = {}) {
  if (!items.length) return `<div class="empty">No data yet.</div>`;
  const max = Math.max(1, total || 0, ...items.map((i) => +i.value || 0));
  return `<div class="hbar">${items.map((i) => `<div>${esc(i.label)}</div><div class="track"><div class="bar" style="width:${((+i.value || 0) / max) * 100}%;${i.color ? "background:" + i.color : ""}"></div></div><div class="v">${fmt(i.value)}${total ? ` <span class="note">(${pct(+i.value || 0, total)})</span>` : ""}</div>`).join("")}</div>`;
}
const S1 = "var(--s1)", S2 = "var(--s2)", S3 = "var(--s3)";

function delta(cur, prev) {
  if (prev == null || cur == null) return "";
  if (+prev === 0) return +cur === 0 ? `<span class="delta flat">no change</span>` : `<span class="delta up">new</span>`;
  const d = Math.round(((cur - prev) / prev) * 100);
  return `<span class="delta ${d > 0 ? "up" : d < 0 ? "down" : "flat"}">${d > 0 ? "▲" : d < 0 ? "▼" : "■"} ${Math.abs(d)}%</span>`;
}
const kpi = (label, value, meta = "", title = "") => `<div class="panel kpi"><div class="label"><span>${label}</span>${title ? `<span title="${esc(title)}" aria-label="${esc(title)}">ⓘ</span>` : ""}</div><div class="value${/[a-z]{3}/i.test(String(value).replace(/<[^>]+>/g, "").replace(/\b(KB|MB|GB|TB)\b/, "")) ? " word" : ""}">${value}</div><div class="meta">${meta}</div></div>`;
const since = (s) => (s ? `Recorded since ${dt(s, false)}` : "Not recorded yet: the app has not sent any measurements");

/* ───────── views ───────── */
const VIEWS = {};

VIEWS.dashboard = async (v) => {
  const p = periodRange();
  const [o, series] = await Promise.all([api("overview", p), can("analytics.view") ? api("series", p) : Promise.resolve(null)]);
  const prevNote = `vs previous ${esc(p.label.toLowerCase().startsWith("last") ? "period" : "period")}`;
  v.innerHTML = `
  <p class="note" style="margin:0 0 12px">${esc(p.label)} · ${dt(p.from)} to ${dt(p.to)} IST · updated ${dt(o.generated_at)}</p>
  <div class="grid kpis">
    ${kpi("Total accounts", n(o.users_total), `${n(o.users_verified)} with email confirmed`, "Accounts created up to the end of the period, excluding deleted and anonymous ones.")}
    ${kpi("New accounts", n(o.users_new), `${delta(o.users_new, o.users_new_prev)} ${prevNote} (${n(o.users_new_prev)})`)}
    ${kpi("New today · 7d · 30d", `${n(o.new_today)} · ${n(o.new_7d)} · ${n(o.new_30d)}`, "Rolling, independent of the period filter")}
    ${kpi("Active people (DAU · WAU · MAU)", `${n(o.dau)} · ${n(o.wau)} · ${n(o.mau)}`, "Did something with their records; signing in alone does not count", "Today in IST, last 7 days, last 30 days. See Metric definitions.")}
    ${kpi("Active in period", n(o.active), `${delta(o.active, o.active_prev)} ${prevNote} · ${n(o.returning)} returning`)}
    ${kpi("Signed in during period", n(o.signed_in), "Last sign-in falls in the period")}
    ${kpi("Records added", n(o.documents_new), `${delta(o.documents_new, o.documents_new_prev)} ${prevNote} · ${n(o.documents_total)} in total`)}
    ${kpi("Document storage", bytes(o.storage_bytes), `${n(o.storage_files)} files · Supabase Free includes 1 GB`)}
    ${kpi("Failed uploads", n(o.uploads_failed), since(o.events_since))}
    ${kpi("Sign-in failures", n(o.login_failures), since(o.events_since))}
    ${kpi("App errors", n(o.app_errors), since(o.events_since))}
    ${kpi("Availability", "Not measured here", `The uptime check runs in GitHub Actions; see <a href="#/health">Platform health</a>`)}
  </div>
  ${series ? `
  <div class="section-title">Trends</div>
  <div class="grid two">
    <div class="panel"><h3>Account growth</h3><p class="sub">Total accounts at the end of each day</p>${lineChart(series, [{ key: "users_total", label: "Total accounts", color: S1 }])}</div>
    <div class="panel"><h3>New accounts per day</h3><p class="sub">Sign-ups by calendar day (IST)</p>${lineChart(series, [{ key: "users_new", label: "New accounts", color: S1 }], { bars: true })}</div>
    <div class="panel"><h3>Active people</h3><p class="sub">Daily, 7-day and 30-day active, by qualifying activity</p>${lineChart(series, [{ key: "dau", label: "Daily", color: S1 }, { key: "wau", label: "7-day", color: S2 }, { key: "mau", label: "30-day", color: S3 }])}</div>
    <div class="panel"><h3>Records added per day</h3><p class="sub">New health records saved (any source)</p>${lineChart(series, [{ key: "documents", label: "Records added", color: S1 }], { bars: true })}</div>
  </div>` : ""}`;
};

VIEWS.analytics = async (v) => {
  const p = periodRange();
  const [series, funnel, ret, adopt] = await Promise.all([api("series", p), api("funnel", p), api("retention", { weeks: 8 }), api("adoption", p)]);
  const f = funnel;
  v.innerHTML = `
  <div class="grid two">
    <div class="panel"><h3>Sign-up funnel</h3><p class="sub">People who created an account in this period, and how far they got. Only steps Doctine records.</p>
      ${f.account_created ? hbars([{ label: "Account created", value: f.account_created }, { label: "Email confirmed", value: f.email_verified }, { label: "Signed in", value: f.signed_in }, { label: "First qualifying activity", value: f.first_activity }], { total: f.account_created }) : `<div class="empty">No new accounts in this period.</div>`}
      <p class="note">Failed sign-up attempts recorded: ${n(f.signup_failed)}</p></div>
    <div class="panel"><h3>Feature adoption</h3><p class="sub">People who have ever used each feature (bar), and in this period. Of ${n(adopt.accounts)} accounts.</p>
      ${hbars(adopt.features.map((x) => ({ label: x.label, value: x.ever })), { total: adopt.accounts })}
      <div class="tablewrap" style="margin-top:12px"><table><thead><tr><th>Feature</th><th class="num">Ever</th><th class="num">In period</th></tr></thead><tbody>${adopt.features.map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${n(x.ever)}</td><td class="num">${n(x.period)}</td></tr>`).join("")}</tbody></table></div>
      <p class="note">PDF reading, search and export come from in-app measurements: ${since(adopt.events_since).toLowerCase()}.</p></div>
  </div>
  <div class="section-title">Retention</div>
  <div class="panel"><h3>Weekly sign-up cohorts</h3><p class="sub">Of the people who joined each week (IST, weeks start Monday), the share with qualifying activity 1, 7 and 30 days later. Cells stay blank until the cohort is old enough to measure.</p>
    ${ret.length ? `<div class="tablewrap"><table class="heat"><thead><tr><th style="text-align:left">Week of</th><th>People</th><th>Day 1</th><th>Day 7</th><th>Day 30</th></tr></thead><tbody>${ret.map((r) => `<tr><td style="text-align:left">${esc(dayLabel(r.week))}</td><td>${n(r.size)}</td>${["d1", "d7", "d30"].map((k) => { const e = r[k + "_eligible"], c = r[k]; if (!e) return `<td class="note">—</td>`; const sh = c / e; return `<td style="background:rgba(42,98,184,${(0.08 + sh * 0.5).toFixed(2)})">${pct(c, e)}<br><span class="note">${n(c)} of ${n(e)}</span></td>`; }).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="empty">No sign-ups in the last 8 weeks.</div>`}</div>
  <div class="section-title">Technical</div>
  <div class="grid two">
    <div class="panel"><h3>Upload and reading failures</h3><p class="sub">Per day, as reported by the app</p>${lineChart(series, [{ key: "uploads_failed", label: "Failed uploads", color: S1 }, { key: "processing_failed", label: "Failed readings", color: S2 }])}</div>
    <div class="panel"><h3>Sign-in failures and app errors</h3><p class="sub">Per day, as reported by the app</p>${lineChart(series, [{ key: "login_failures", label: "Sign-in failures", color: S1 }, { key: "app_errors", label: "App errors", color: S2 }])}</div>
  </div>`;
};

/* Users */
const UQ = { q: "", status: "", sort: "created_desc", page: 1 };
VIEWS.users = async (v) => {
  const d = await api("users", { ...UQ, size: 25 });
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  v.innerHTML = `<form class="row" id="uf" role="search" style="margin-bottom:12px">
      <label class="sr" for="uq">Search by email or account id</label><input id="uq" type="search" placeholder="Search email or account id" value="${esc(UQ.q)}" style="min-width:min(320px,100%)">
      <label class="sr" for="us">Status</label><select id="us">${[["", "Everyone"], ["verified", "Email confirmed"], ["unverified", "Email not confirmed"], ["suspended", "Suspended"], ["admins", "Admin team"]].map(([k, t]) => `<option value="${k}" ${UQ.status === k ? "selected" : ""}>${t}</option>`).join("")}</select>
      <label class="sr" for="uso">Sort</label><select id="uso">${[["created_desc", "Newest first"], ["created_asc", "Oldest first"], ["activity_desc", "Recently active"], ["email", "Email A–Z"]].map(([k, t]) => `<option value="${k}" ${UQ.sort === k ? "selected" : ""}>${t}</option>`).join("")}</select>
      <button class="btn primary">Search</button><span class="spacer"></span><span class="note">${n(d.total)} accounts</span></form>
    ${d.rows.length ? `<div class="tablewrap"><table><thead><tr><th>Email</th><th>Joined</th><th>Email confirmed</th><th>Last sign-in</th><th>Last activity</th><th class="num">Records</th><th class="num">Files</th><th>Status</th></tr></thead><tbody>
      ${d.rows.map((u) => `<tr class="click" data-id="${esc(u.id)}" tabindex="0"><td>${esc(u.email || "(no email)")}${u.admin_role ? ` <span class="role">${esc(u.admin_role.replace("_", " "))}</span>` : ""}</td><td>${dt(u.created_at, false)}</td><td>${u.email_confirmed_at ? "Yes" : "No"}</td><td>${dt(u.last_sign_in_at)}</td><td>${dt(u.last_activity)}</td><td class="num">${n(u.records)}</td><td class="num">${n(u.files)}</td><td>${u.suspended ? `<span class="st bad">Suspended</span>` : `<span class="st good">Active</span>`}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="pager"><button class="btn" id="pp" ${UQ.page <= 1 ? "disabled" : ""}>Previous</button><span>Page ${UQ.page} of ${pages}</span><button class="btn" id="pn" ${UQ.page >= pages ? "disabled" : ""}>Next</button></div>` : `<div class="empty">No accounts match.</div>`}
    <p class="note">Account details only. Health records, files and messages are never shown in the console.</p>`;
  $("#uf").onsubmit = (e) => { e.preventDefault(); Object.assign(UQ, { q: $("#uq").value.trim(), status: $("#us").value, sort: $("#uso").value, page: 1 }); VIEWS.users(v); };
  const pp = $("#pp"), pn = $("#pn"); if (pp) pp.onclick = () => { UQ.page--; VIEWS.users(v); }; if (pn) pn.onclick = () => { UQ.page++; VIEWS.users(v); };
  v.querySelectorAll("tr.click").forEach((tr) => { tr.onclick = () => openUser(tr.dataset.id); tr.onkeydown = (e) => { if (e.key === "Enter") openUser(tr.dataset.id); }; });
};
function closeDrawer() { document.querySelectorAll(".drawer,.scrim").forEach((e) => e.remove()); }
async function openUser(id) {
  closeDrawer();
  const sc = document.createElement("div"); sc.className = "scrim"; sc.onclick = closeDrawer;
  const dr = document.createElement("aside"); dr.className = "drawer"; dr.setAttribute("role", "dialog"); dr.setAttribute("aria-modal", "true"); dr.setAttribute("aria-label", "Account");
  dr.innerHTML = `<p class="note">Loading…</p>`; document.body.append(sc, dr);
  dr.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  let u; try { u = await api("user", { id }); } catch (e) { dr.innerHTML = `<div class="callout bad">${errText(e)}</div>`; return; }
  if (!u) { dr.innerHTML = `<div class="callout">Account not found.</div>`; return; }
  const g = u.usage;
  dr.innerHTML = `<div class="row"><h3 style="margin:0;font:600 19px var(--serif)">${esc(u.email || "(no email)")}</h3><span class="spacer"></span><button class="btn ghost" id="dx" aria-label="Close">Close</button></div>
    <p class="note mono">${esc(u.id)}</p>
    <div class="row" style="margin:12px 0">${u.suspended ? `<span class="st bad">Suspended</span>` : `<span class="st good">Active</span>`}${u.admin_role ? `<span class="role">${esc(u.admin_role.replace("_", " "))}</span>` : ""}</div>
    <dl class="dl"><dt>Joined</dt><dd>${dt(u.created_at)}</dd><dt>Email confirmed</dt><dd>${u.email_confirmed_at ? dt(u.email_confirmed_at) : "Not yet"}</dd><dt>Last sign-in</dt><dd>${dt(u.last_sign_in_at)}</dd><dt>Last activity</dt><dd>${dt(g.last_activity)}</dd><dt>Active days (30 days)</dt><dd>${n(g.active_days_30)}</dd></dl>
    <div class="section-title">Usage (counts only)</div>
    <dl class="dl"><dt>Records</dt><dd>${n(g.records)} ${Object.keys(g.records_by_source || {}).length ? `<span class="note">(${Object.entries(g.records_by_source).map(([k, c]) => esc(k) + " " + n(c)).join(", ")})</span>` : ""}</dd><dt>Files stored</dt><dd>${n(g.files)} · ${bytes(g.file_bytes)}</dd><dt>Medicines</dt><dd>${n(g.medicines)}</dd><dt>Doses recorded</dt><dd>${n(g.doses_recorded)}</dd><dt>Profile saved</dt><dd>${g.profile_saved ? "Yes" : "No"}</dd><dt>Failed uploads (30 days)</dt><dd>${n(u.uploads.failed_30d)}</dd><dt>Failed readings (30 days)</dt><dd>${n(u.uploads.processing_failed_30d)}</dd></dl>
    <div class="section-title">Actions</div>
    <div class="row">
      ${can("users.reset_password") ? `<button class="btn" data-act="reset">Send password reset email</button>` : ""}
      ${can("users.suspend") ? `<button class="btn" data-act="revoke">Sign out everywhere</button>${u.suspended ? `<button class="btn" data-act="restore">Restore account</button>` : `<button class="btn danger" data-act="suspend">Suspend account</button>`}` : ""}
    </div>
    ${!can("users.reset_password") && !can("users.suspend") ? `<p class="note">Your role can view this account but not act on it.</p>` : ""}
    ${u.notes ? `<div class="section-title">Support notes</div>
      <form id="nf"><label class="sr" for="nt">New note</label><textarea id="nt" maxlength="1000" placeholder="Add a note for the team. Never write health details here."></textarea><div class="row" style="margin-top:6px"><button class="btn">Add note</button></div></form>
      ${u.notes.length ? u.notes.map((x) => `<div class="panel" style="margin-top:8px;padding:10px 12px"><div class="note">${dt(x.at)} · ${esc(x.author || "")}</div><div>${esc(x.body)}</div></div>`).join("") : `<p class="note">No notes.</p>`}` : ""}
    <div class="section-title">Admin actions on this account</div>
    ${u.admin_actions.length ? `<div class="tablewrap"><table><tbody>${u.admin_actions.map((x) => `<tr><td>${dt(x.at)}</td><td>${esc(x.action)}</td><td>${esc(x.outcome)}</td><td>${esc(x.by || "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note">None.</p>`}`;
  $("#dx", dr).onclick = closeDrawer; $("#dx", dr).focus();
  const acts = {
    reset: { t: "Send a password reset email?", d: `Supabase will email ${esc(u.email)} a link to choose a new password. You never see or set the password.`, a: "user_reset_password", ok: "Reset email sent.", reason: false },
    revoke: { t: "Sign this person out everywhere?", d: "Every session on every device ends. They can sign in again.", a: "user_revoke_sessions", ok: "Sessions ended.", reason: true },
    suspend: { t: "Suspend this account?", d: "They are signed out everywhere and cannot sign in until restored. Their records are kept.", a: "user_suspend", ok: "Account suspended.", reason: true, danger: true },
    restore: { t: "Restore this account?", d: "They will be able to sign in again.", a: "user_restore", ok: "Account restored.", reason: true },
  };
  dr.querySelectorAll("[data-act]").forEach((b) => b.onclick = async () => {
    const c = acts[b.dataset.act]; const r = await confirmBox(c.t, c.d, { reason: c.reason, danger: c.danger, button: b.textContent });
    if (r === null) return;
    try {
      const out = await api(c.a, { id: u.id, reason: r });
      if (out && out.ok === false) { toast(out.error === "admin_target_needs_owner" ? "Only the owner can act on another admin." : out.error === "not_on_yourself" ? "You cannot do this to your own account." : out.error === "email_rate_limited" ? "Supabase is limiting emails right now. Try again later." : "That did not complete (" + out.error + ")."); }
      else toast(c.ok);
      openUser(u.id);
    } catch (e) { toast(e.code === "forbidden" ? "Your role does not allow this." : "That did not work. Please try again."); }
  });
  const nfm = $("#nf", dr);
  if (nfm) nfm.onsubmit = async (e) => { e.preventDefault(); const t = $("#nt", dr).value.trim(); if (!t) return; try { await api("user_note", { id: u.id, note: t }); toast("Note added."); openUser(u.id); } catch (er) { toast("The note was not saved."); } };
}
function confirmBox(title, desc, { reason = false, danger = false, button = "Confirm", extra = "" } = {}) {
  return new Promise((res) => {
    const d = document.createElement("dialog");
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p style="color:var(--ink-2);margin:0 0 10px">${desc}</p>${extra}
      ${reason ? `<label class="f" for="cr">Reason (recorded in the audit log)</label><textarea id="cr" maxlength="500" placeholder="Why, in a few words. No health details."></textarea>` : ""}
      <p class="err" id="cerr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" value="cancel" type="button" id="cc">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" value="ok" id="co">${esc(button)}</button></div></form>`;
    document.body.appendChild(d); d.showModal();
    const done = (v) => { d.close(); d.remove(); res(v); };
    $("#cc", d).onclick = () => done(null);
    d.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    $("form", d).onsubmit = (e) => { e.preventDefault(); const r = reason ? $("#cr", d).value.trim() : ""; if (reason && !r) { $("#cerr", d).textContent = "Please give a reason."; return; } done(reason ? r : ""); };
  });
}

/* Documents (metadata only) */
let DPAGE = 1;
VIEWS.documents = async (v) => {
  const p = periodRange(); const d = await api("documents", { ...p, page: DPAGE, size: 25 }); const s = d.summary;
  const kv = (o) => { const e = Object.entries(o || {}); return e.length ? hbars(e.sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ label: k, value: c }))) : `<div class="empty">None in this period.</div>`; };
  const pages = Math.max(1, Math.ceil(d.total / 25));
  v.innerHTML = `<div class="callout" style="margin-bottom:14px">Technical information only. Titles, providers, values, extracted text and files are never shown here, by design.</div>
  <div class="grid kpis">
    ${kpi("Records added", n(s.records), `${n(s.records_total)} in total`)}
    ${kpi("Files stored", n(s.files), `${bytes(s.bytes)} this period`)}
    ${kpi("Storage in use", bytes(s.storage_bytes), "All document files, Supabase Storage")}
    ${kpi("Uploads completed · failed", `${n(s.upload_completed)} · ${n(s.upload_failed)}`, since(s.events_since))}
    ${kpi("Readings completed · failed", `${n(s.processing_completed)} · ${n(s.processing_failed)}`, s.processing_ms_avg ? `Average ${n(s.processing_ms_avg)} ms` : since(s.events_since))}
  </div>
  <div class="grid two" style="margin-top:14px">
    <div class="panel"><h3>How records were added</h3><p class="sub">scan = photographed, upload = file, manual = typed</p>${kv(s.by_source)}</div>
    <div class="panel"><h3>Record type</h3><p class="sub">The category chosen for each record</p>${kv(s.by_category)}</div>
    <div class="panel"><h3>File types</h3><p class="sub">Stored file formats</p>${kv(s.by_type)}</div>
    <div class="panel"><h3>Upload failure reasons</h3><p class="sub">Short codes reported by the app</p>${kv(s.failure_reasons)}</div>
  </div>
  <div class="section-title">Records in this period</div>
  ${d.rows.length ? `<div class="tablewrap"><table><thead><tr><th>Added</th><th>Record id</th><th>Account</th><th>Source</th><th class="num">Pages</th><th class="num">Files</th><th class="num">Size</th><th>File types</th></tr></thead><tbody>${d.rows.map((r) => `<tr><td>${dt(r.created_at)}</td><td class="mono">${esc(String(r.id).slice(0, 8))}</td><td class="mono">${esc(String(r.account).slice(0, 8))}</td><td>${esc(r.source)}</td><td class="num">${n(r.pages)}</td><td class="num">${n(r.files)}</td><td class="num">${bytes(r.bytes)}</td><td>${esc((r.types || []).join(", "))}</td></tr>`).join("")}</tbody></table></div>
  <div class="pager"><button class="btn" id="dp" ${DPAGE <= 1 ? "disabled" : ""}>Previous</button><span>Page ${DPAGE} of ${pages}</span><button class="btn" id="dn" ${DPAGE >= pages ? "disabled" : ""}>Next</button></div>` : `<div class="empty">No records were added in this period.</div>`}`;
  const a = $("#dp"), b = $("#dn"); if (a) a.onclick = () => { DPAGE--; VIEWS.documents(v); }; if (b) b.onclick = () => { DPAGE++; VIEWS.documents(v); };
};

/* Platform health */
VIEWS.health = async (v) => {
  v.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="note" style="margin:0">Each check runs now, from the server, when you open this page or press Re-check. Nothing is shown as working unless it was just checked.</p><span class="spacer"></span><button class="btn" id="rc">Re-check</button></div><div id="hc"><p class="note">Checking…</p></div>`;
  $("#rc").onclick = () => VIEWS.health(v);
  const h = await api("health");
  const st = (c) => c.ok ? `<span class="st good">Responding</span>` : `<span class="st bad">${c.error === "timeout" ? "Timed out" : "Not responding"}</span>`;
  $("#hc").innerHTML = `<div class="tablewrap"><table><thead><tr><th>Service</th><th>Status</th><th class="num">Response time</th><th>HTTP</th><th>Checked</th></tr></thead><tbody>
    <tr><td>This app's server</td><td><span class="st good">Responding</span></td><td class="num">—</td><td>200</td><td>${dt(new Date())}</td></tr>
    ${h.checks.map((c) => `<tr><td>${esc(c.name)}</td><td>${st(c)}</td><td class="num">${n(c.ms)} ms</td><td>${esc(c.status == null ? "—" : c.status)}</td><td>${dt(c.checked_at)}</td></tr>`).join("")}
    <tr><td>AI provider (Anthropic)</td><td>${h.configured.ai_provider ? `<span class="st none">Key set · not called by this check</span>` : `<span class="st none">Not configured</span>`}</td><td class="num">—</td><td>—</td><td>—</td></tr>
  </tbody></table></div>
  <div class="grid two" style="margin-top:14px">
    <div class="panel"><h3>Monitoring</h3><dl class="dl"><dt>Uptime history</dt><dd>${esc(h.configured.external_uptime_monitor)}</dd><dt>Error tracking</dt><dd><span class="st none">Monitoring not configured</span></dd><dt>Shared rate limits</dt><dd>${h.configured.shared_rate_limits ? "On (Supabase)" : "Local only"}</dd><dt>Environment</dt><dd>${esc(h.environment)}</dd></dl></div>
    <div class="panel"><h3>What this does not measure</h3><p class="sub">Doctine does not yet record server response times over time, database load or Supabase quota use. Check those in the Supabase dashboard (Reports) and Cloudflare (Analytics). App errors and failed uploads reported by the app are on the dashboard.</p></div>
  </div>`;
};

/* Incidents */
VIEWS.incidents = async (v) => {
  const list = await api("incidents");
  const ST = { investigating: "bad", degraded: "warn", operational: "good", resolved: "none" };
  v.innerHTML = `${can("incidents.manage") ? `<div class="row" style="margin-bottom:12px"><span class="spacer"></span><button class="btn primary" id="ni">Open an incident</button></div>` : ""}
  ${list.length ? list.map((i) => `<div class="panel" style="margin-bottom:10px"><div class="row"><h3 style="margin:0">${esc(i.title)}</h3><span class="st ${ST[i.status]}">${esc(i.status)}</span><span class="spacer"></span>${can("incidents.manage") ? `<button class="btn" data-id="${esc(i.id)}">Update</button>` : ""}</div>
    <p class="note">Started ${dt(i.started_at)}${i.resolved_at ? ` · resolved ${dt(i.resolved_at)}` : ""} · updated ${dt(i.updated_at)}</p>${i.impact ? `<p><b>Impact:</b> ${esc(i.impact)}</p>` : ""}${i.notes ? `<p style="white-space:pre-wrap">${esc(i.notes)}</p>` : ""}</div>`).join("") : `<div class="empty">No incidents recorded.</div>`}`;
  const edit = async (i = {}) => {
    const d = document.createElement("dialog");
    d.innerHTML = `<form><h3>${i.id ? "Update incident" : "Open an incident"}</h3>
      <label class="f" for="it">Title</label><input id="it" type="text" maxlength="160" style="width:100%" value="${esc(i.title || "")}" required>
      <label class="f" for="is">Status</label><select id="is">${["investigating", "degraded", "operational", "resolved"].map((s) => `<option ${i.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
      <label class="f" for="ii">Impact on people</label><textarea id="ii" maxlength="600">${esc(i.impact || "")}</textarea>
      <label class="f" for="in">Internal notes (no health details)</label><textarea id="in" maxlength="2000">${esc(i.notes || "")}</textarea>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" type="button" id="ic">Cancel</button><button class="btn primary">Save</button></div></form>`;
    document.body.appendChild(d); d.showModal(); $("#ic", d).onclick = () => { d.close(); d.remove(); };
    $("form", d).onsubmit = async (e) => { e.preventDefault(); try { await api("incident_save", { data: { id: i.id, title: $("#it", d).value, status: $("#is", d).value, impact: $("#ii", d).value, notes: $("#in", d).value } }); d.close(); d.remove(); toast("Saved."); VIEWS.incidents(v); } catch (er) { toast("Not saved: " + (ERR[er.code] || er.code)); } };
  };
  const ni = $("#ni"); if (ni) ni.onclick = () => edit();
  v.querySelectorAll("[data-id]").forEach((b) => b.onclick = () => edit(list.find((x) => x.id === b.dataset.id)));
};

/* Alerts */
VIEWS.alerts = async (v) => {
  const list = await api("alerts", { evaluate: true });
  const SEV = { info: "none", warning: "warn", critical: "bad" };
  v.innerHTML = `<p class="note" style="margin:0 0 12px">Rules are checked each time this page opens (there is no background scheduler). An alert opens only when there are enough measurements to judge.</p>
  ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Opened</th><th>Severity</th><th>Alert</th><th>Status</th><th></th></tr></thead><tbody>${list.map((a) => `<tr><td>${dt(a.opened_at)}</td><td><span class="st ${SEV[a.severity]}">${esc(a.severity)}</span></td><td>${esc(a.message)}<div class="note">Updated ${dt(a.updated_at)}</div></td><td>${esc(a.status)}</td><td>${can("alerts.manage") && a.status !== "resolved" ? `${a.status === "open" ? `<button class="btn" data-a="acknowledged" data-id="${esc(a.id)}">Acknowledge</button>` : ""} <button class="btn" data-a="resolved" data-id="${esc(a.id)}">Resolve</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No alerts. All rules were checked just now.</div>`}
  <div class="section-title">Rules</div>
  <div class="panel"><div class="tablewrap"><table><thead><tr><th>Rule</th><th>Opens when</th><th>Needs</th></tr></thead><tbody>
    <tr><td>Upload failure rate</td><td>20% or more of uploads failed in the last 24 hours</td><td>At least 5 uploads reported</td></tr>
    <tr><td>Sign-in failures</td><td>30 or more failed sign-ins in the last hour</td><td>Sign-in measurements from the app</td></tr>
    <tr><td>Sign-up failures</td><td>10 or more failed account creations in 24 hours</td><td>Sign-up measurements from the app</td></tr>
    <tr><td>Storage near limit</td><td>Document storage at 80% (warning) or 95% (critical) of 1 GB</td><td>Supabase Storage sizes</td></tr>
  </tbody></table></div><p class="note">Not alerted yet (not measured): server errors, response times, AI provider failures and costs, database load.</p></div>`;
  v.querySelectorAll("[data-a]").forEach((b) => b.onclick = async () => { try { await api("alert_update", { id: b.dataset.id, status: b.dataset.a }); toast("Updated."); VIEWS.alerts(v); } catch (e) { toast(ERR[e.code] || "Not updated."); } });
};

/* Feature switches */
const FLAG_INFO = {
  registrations: { label: "New account sign-ups", what: "When off, nobody can create a new account. Existing accounts are unaffected.", enforced: "Database: Supabase Auth hook (once enabled in Supabase → Authentication → Hooks). Until then, not enforced.", sensitive: false },
  document_upload: { label: "Storing document files", what: "When off, no new document files are stored. Records still save; their files stay on the person's device and are stored when this is back on.", enforced: "Database: the storage policy refuses new files. The app also stops sending them and says so.", sensitive: false },
  pdf_reading: { label: "Reading PDFs into records", what: "When off, PDFs can still be attached but the app does not read text out of them.", enforced: "App: the reading happens in the person's browser, so this is applied by the app.", sensitive: false },
  sample_data: { label: "Sample records for new people", what: "When off, the 'try with sample records' option is not offered.", enforced: "App: applied by the app.", sensitive: false },
  ai_assistant: { label: "AI assistant and AI document reading", what: "Sends people's messages and documents to the AI provider. Off by default; turn on only with consent, legal review and the provider agreement in place.", enforced: "Server: /api/chat and /api/scan refuse requests while off (emergency guidance still works).", sensitive: true },
};
VIEWS.flags = async (v) => {
  const flags = (await api("flags")).filter((f) => f.key !== "maintenance");
  v.innerHTML = `<p class="note" style="margin:0 0 12px">Each switch changes what Doctine actually does. Changes take effect within about 20 seconds and are recorded in the audit log with your reason.</p>
  ${flags.map((f) => { const i = FLAG_INFO[f.key] || { label: f.key, what: "", enforced: "" }; return `<div class="panel" style="margin-bottom:10px"><div class="row"><div style="flex:1;min-width:220px"><h3>${esc(i.label)} ${i.sensitive ? `<span class="st warn">Sensitive</span>` : ""}</h3><p class="sub" style="margin:4px 0">${esc(i.what)}</p><p class="note" style="margin:0"><b>Enforced by:</b> ${esc(i.enforced)}</p><p class="note">Last changed ${f.updated_by ? `by ${esc(f.updated_by)} ` : ""}${dt(f.updated_at)}</p></div>
    <button class="switch" role="switch" aria-checked="${f.enabled}" aria-label="${esc(i.label)}" data-k="${esc(f.key)}" ${can("flags.manage") ? "" : "disabled"}></button><span style="min-width:28px;font-weight:700">${f.enabled ? "On" : "Off"}</span></div></div>`; }).join("")}
  ${can("flags.manage") ? "" : `<p class="note">Your role can see switches but not change them.</p>`}`;
  v.querySelectorAll(".switch[data-k]").forEach((b) => b.onclick = async () => {
    const k = b.dataset.k, on = b.getAttribute("aria-checked") !== "true", i = FLAG_INFO[k] || { label: k };
    const r = await confirmBox(`Turn ${on ? "on" : "off"}: ${i.label}?`, esc(i.what), { reason: true, danger: !on || i.sensitive, button: on ? "Turn on" : "Turn off" });
    if (r === null) return;
    try { await api("set_flag", { key: k, enabled: on, reason: r }); toast("Switch updated."); VIEWS.flags(v); } catch (e) { toast(ERR[e.code] || "Not changed."); }
  });
};
VIEWS.maintenance = async (v) => {
  const m = (await api("flags")).find((f) => f.key === "maintenance") || { enabled: false, value: {} };
  v.innerHTML = `<div class="panel"><div class="row"><h3 style="margin:0">Maintenance mode</h3>${m.enabled ? `<span class="st warn">On</span>` : `<span class="st none">Off</span>`}</div>
    <p class="sub" style="margin-top:6px">While on: the app shows your message to everyone; new document files are refused by the database (records still save, and their files stay on the person's device until uploads resume); the AI assistant and AI reading are refused by the server; new sign-ups are refused once the Auth hook is enabled. People can still sign in, read and edit their records.</p>
    <label class="f" for="mm">Message shown in the app</label><textarea id="mm" maxlength="300" placeholder="For example: Doctine is being updated. Saving is paused until 10:00 IST.">${esc(m.value && m.value.message || "")}</textarea>
    <p class="note">Last changed ${m.updated_by ? `by ${esc(m.updated_by)} ` : ""}${dt(m.updated_at)}</p>
    ${can("maintenance.manage") ? `<div class="row" style="margin-top:10px">${m.enabled ? `<button class="btn" id="msave">Update message</button><button class="btn primary" id="moff">Turn maintenance off</button>` : `<button class="btn danger" id="mon">Turn maintenance on</button>`}</div>` : `<p class="note">Only the owner and super admins can change maintenance mode.</p>`}</div>`;
  const go = async (on, label) => { const r = await confirmBox(label + "?", on ? "Everyone using Doctine will see the message and saving will pause." : "Doctine returns to normal.", { reason: true, danger: on, button: label }); if (r === null) return; try { await api("set_flag", { key: "maintenance", enabled: on, message: $("#mm").value, reason: r }); toast("Maintenance updated."); VIEWS.maintenance(v); } catch (e) { toast(ERR[e.code] || "Not changed."); } };
  const a = $("#mon"), b = $("#moff"), c = $("#msave");
  if (a) a.onclick = () => go(true, "Turn maintenance on"); if (b) b.onclick = () => go(false, "Turn maintenance off"); if (c) c.onclick = () => go(true, "Update message");
};

/* Announcements */
VIEWS.announcements = async (v) => {
  const list = await api("announcements");
  const stl = (a) => a.live ? `<span class="st good">Showing now</span>` : a.status === "published" ? (a.ends_at && Date.parse(a.ends_at) < Date.now() ? `<span class="st none">Expired</span>` : `<span class="st warn">Scheduled</span>`) : `<span class="st none">${esc(a.status)}</span>`;
  v.innerHTML = `${can("announcements.manage") ? `<div class="row" style="margin-bottom:12px"><span class="spacer"></span><button class="btn primary" id="na">New announcement</button></div>` : ""}
    ${list.length ? `<div class="tablewrap"><table><thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Shows</th><th>Updated</th><th></th></tr></thead><tbody>${list.map((a) => `<tr><td>${esc(a.title)}</td><td>${esc(a.kind)}</td><td>${stl(a)}</td><td>${a.starts_at ? dt(a.starts_at) : "Now"} → ${a.ends_at ? dt(a.ends_at) : "until archived"}</td><td>${dt(a.updated_at)}</td><td>${can("announcements.manage") ? `<button class="btn" data-id="${esc(a.id)}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">No announcements yet.</div>`}
    <p class="note">Published announcements appear as a banner at the top of the app during their dates, for people signed in to a Doctine account (they can dismiss them). At most five show at once; changes reach the app within about 20 seconds of the next page load.</p>`;
  const toLocal = (s) => (s ? new Date(Date.parse(s) + IST).toISOString().slice(0, 16) : "");
  const fromLocal = (s) => (s ? new Date(s + ":00+05:30").toISOString() : "");
  const edit = (a = { kind: "product", status: "draft" }) => {
    const d = document.createElement("dialog"); d.style.width = "min(560px,calc(100% - 32px))";
    d.innerHTML = `<form><h3>${a.id ? "Edit announcement" : "New announcement"}</h3>
      <label class="f" for="ak">Type</label><select id="ak">${[["service", "Service notice"], ["maintenance", "Maintenance"], ["product", "Product update"]].map(([k, t]) => `<option value="${k}" ${a.kind === k ? "selected" : ""}>${t}</option>`).join("")}</select>
      <label class="f" for="at">Title</label><input id="at" type="text" maxlength="120" style="width:100%" value="${esc(a.title || "")}" required>
      <label class="f" for="ab">Message</label><textarea id="ab" maxlength="600">${esc(a.body || "")}</textarea>
      <div class="row"><div><label class="f" for="as">Show from (IST, optional)</label><input id="as" type="datetime-local" value="${toLocal(a.starts_at)}"></div><div><label class="f" for="ae">Until (IST, optional)</label><input id="ae" type="datetime-local" value="${toLocal(a.ends_at)}"></div></div>
      <div class="section-title">Preview</div><div id="apv"></div>
      <p class="err" id="aerr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" type="button" id="ac">Cancel</button>${a.id && a.status !== "archived" ? `<button class="btn" type="button" data-s="archived">Archive</button>` : ""}<button class="btn" type="button" data-s="draft">Save as draft</button><button class="btn primary" type="button" data-s="published">Publish</button></div></form>`;
    document.body.appendChild(d); d.showModal();
    const pv = () => { $("#apv", d).innerHTML = `<div class="callout ${$("#ak", d).value === "maintenance" ? "warn" : ""}"><b>${esc($("#at", d).value || "Title")}</b>${$("#ab", d).value ? " " + esc($("#ab", d).value) : ""}</div>`; };
    pv(); d.addEventListener("input", pv);
    $("#ac", d).onclick = () => { d.close(); d.remove(); };
    d.querySelectorAll("[data-s]").forEach((b) => b.onclick = async () => {
      if (!$("#at", d).value.trim()) { $("#aerr", d).textContent = "Add a title."; return; }
      if ($("#as", d).value && $("#ae", d).value && $("#ae", d).value <= $("#as", d).value) { $("#aerr", d).textContent = "The end must be after the start."; return; }
      try { await api("announcement_save", { data: { id: a.id, kind: $("#ak", d).value, title: $("#at", d).value, body: $("#ab", d).value, status: b.dataset.s, starts_at: fromLocal($("#as", d).value), ends_at: fromLocal($("#ae", d).value) } }); d.close(); d.remove(); toast(b.dataset.s === "published" ? "Published." : "Saved."); VIEWS.announcements(v); }
      catch (e) { $("#aerr", d).innerHTML = errText(e); }
    });
  };
  const na = $("#na"); if (na) na.onclick = () => edit();
  v.querySelectorAll("[data-id]").forEach((b) => b.onclick = () => edit(list.find((x) => x.id === b.dataset.id)));
};

/* Team */
const ROLE_INFO = { owner: "Everything, including appointing and removing admins", super_admin: "Everything except managing the admin team", operations: "Users (suspend, reset), documents, incidents, alerts, announcements", analyst: "Dashboards, analytics and exports; no account details", support: "Look up accounts, send password resets, write notes", developer: "Platform health, incidents, alerts, switches (view), security events" };
VIEWS.team = async (v) => {
  const t = await api("team");
  v.innerHTML = `<div class="tablewrap"><table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Two-step sign-in</th><th>Last sign-in</th><th>Added</th>${can("team.manage") ? "<th></th>" : ""}</tr></thead><tbody>
    ${t.map((m) => `<tr><td>${esc(m.email)}</td><td><span class="role">${esc(m.role.replace("_", " "))}</span></td><td>${m.status === "active" ? `<span class="st good">Active</span>` : `<span class="st bad">Suspended</span>`}</td><td>${m.mfa ? "On" : `<span class="st warn">Off</span>`}</td><td>${dt(m.last_sign_in_at)}</td><td>${dt(m.added_at, false)}</td>${can("team.manage") ? `<td>${m.user_id === (A.session && A.session.user.id) ? `<span class="note">You</span>` : `<button class="btn" data-e="${esc(m.email)}" data-r="${esc(m.role)}" data-s="${esc(m.status)}">Change</button>`}</td>` : ""}</tr>`).join("")}
  </tbody></table></div>
  ${can("team.manage") ? `<div class="panel" style="margin-top:14px"><h3>Add someone to the team</h3><p class="sub">They must already have a Doctine account (they sign up in the app first). No account is created here, and nobody can sign up as an admin.</p>
    <form id="tf" class="row"><label class="sr" for="te">Email</label><input id="te" type="email" placeholder="their Doctine account email" required style="min-width:min(280px,100%)"><label class="sr" for="tr">Role</label><select id="tr">${Object.keys(ROLE_INFO).map((r) => `<option value="${r}" ${r === "analyst" ? "selected" : ""}>${r.replace("_", " ")}</option>`).join("")}</select><button class="btn primary">Add</button></form></div>` : `<p class="note">Only the owner can add, change or remove admins.</p>`}
  <div class="section-title">Roles</div><div class="panel"><dl class="dl">${Object.entries(ROLE_INFO).map(([r, d]) => `<dt>${esc(r.replace("_", " "))}</dt><dd>${esc(d)}</dd>`).join("")}</dl></div>`;
  const set = async (email, role, status, title, danger) => {
    const r = await confirmBox(title, `${esc(email)}${role ? " → " + esc(role.replace("_", " ")) : ""}`, { reason: true, danger, button: "Confirm" });
    if (r === null) return;
    try { const out = await api("team_set", { email, role, status, reason: r }); if (out && out.ok === false) toast(out.error === "no_account" ? "There is no Doctine account with that email. They need to sign up in the app first." : out.error === "not_on_yourself" ? "You cannot change your own membership." : "Not changed."); else { toast("Team updated."); VIEWS.team(v); } }
    catch (e) { toast(e.code === "forbidden" ? "Only the owner can do this, and there must always be an active owner." : ERR[e.code] || "Not changed."); }
  };
  const tf = $("#tf"); if (tf) tf.onsubmit = (e) => { e.preventDefault(); const r = $("#tr").value; set($("#te").value.trim(), r, "active", `Give ${r.replace("_", " ")} access?`, r === "owner" || r === "super_admin"); };
  v.querySelectorAll("[data-e]").forEach((b) => b.onclick = () => {
    const d = document.createElement("dialog");
    d.innerHTML = `<form><h3>Change ${esc(b.dataset.e)}</h3><label class="f" for="cr2">Role</label><select id="cr2">${Object.keys(ROLE_INFO).map((r) => `<option value="${r}" ${r === b.dataset.r ? "selected" : ""}>${r.replace("_", " ")}</option>`).join("")}</select>
      <label class="f" for="cs2">Status</label><select id="cs2"><option value="active" ${b.dataset.s === "active" ? "selected" : ""}>Active</option><option value="suspended" ${b.dataset.s === "suspended" ? "selected" : ""}>Suspended (keeps the record, no access)</option><option value="removed">Remove from team</option></select>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" type="button" id="x2">Cancel</button><button class="btn primary">Continue</button></div></form>`;
    document.body.appendChild(d); d.showModal(); $("#x2", d).onclick = () => { d.close(); d.remove(); };
    $("form", d).onsubmit = (e) => { e.preventDefault(); const r = $("#cr2", d).value, s = $("#cs2", d).value; d.close(); d.remove(); set(b.dataset.e, r, s, s === "removed" ? "Remove from the admin team?" : "Change this admin?", s !== "active" || r === "owner"); };
  });
};

/* Audit log */
const AQ = { admin: "", filter_action: "", target: "", page: 1 };
VIEWS.audit = async (v) => {
  const d = await api("audit", { ...AQ, size: 50 });
  const pages = Math.max(1, Math.ceil(d.total / 50));
  v.innerHTML = `<form class="row" id="af" style="margin-bottom:12px"><label class="sr" for="aa">Admin</label><input id="aa" type="search" placeholder="Admin email" value="${esc(AQ.admin)}"><label class="sr" for="ac2">Action</label><select id="ac2">${["", "user.", "flag.", "maintenance.", "team.", "announcement.", "incident.", "alert.", "report.", "denied:"].map((k) => `<option value="${k}" ${AQ.filter_action === k ? "selected" : ""}>${k ? k.replace(/[.:]$/, "") : "All actions"}</option>`).join("")}</select><label class="sr" for="at2">Target id</label><input id="at2" type="search" placeholder="Target id" value="${esc(AQ.target)}"><button class="btn primary">Filter</button><span class="spacer"></span><span class="note">${n(d.total)} entries · cannot be edited or deleted</span></form>
  ${d.rows.length ? `<div class="tablewrap"><table><thead><tr><th>When (IST)</th><th>Admin</th><th>Action</th><th>Target</th><th>Reason</th><th>Outcome</th><th>Change</th><th>Ref</th></tr></thead><tbody>${d.rows.map((r) => `<tr><td>${dt(r.at)}</td><td>${esc(r.actor_email || "—")}<div class="note">${esc(r.actor_role || "")}</div></td><td>${esc(r.action)}</td><td>${esc(r.target_type || "")}<div class="mono">${esc((r.target_id || "").slice(0, 36))}</div></td><td>${esc(r.reason || "")}</td><td><span class="st ${r.outcome === "ok" ? "good" : r.outcome === "denied" || r.outcome === "failed" ? "bad" : "none"}">${esc(r.outcome)}</span></td><td class="mono" style="max-width:260px;white-space:pre-wrap;word-break:break-word">${r.before || r.after ? esc(JSON.stringify({ before: r.before || undefined, after: r.after || undefined })) : ""}</td><td class="mono">${esc((r.request_id || "").slice(0, 8))}</td></tr>`).join("")}</tbody></table></div>
  <div class="pager"><button class="btn" id="ap" ${AQ.page <= 1 ? "disabled" : ""}>Previous</button><span>Page ${AQ.page} of ${pages}</span><button class="btn" id="an" ${AQ.page >= pages ? "disabled" : ""}>Next</button></div>` : `<div class="empty">No entries match.</div>`}`;
  $("#af").onsubmit = (e) => { e.preventDefault(); Object.assign(AQ, { admin: $("#aa").value.trim(), filter_action: $("#ac2").value, target: $("#at2").value.trim(), page: 1 }); VIEWS.audit(v); };
  const a = $("#ap"), b = $("#an"); if (a) a.onclick = () => { AQ.page--; VIEWS.audit(v); }; if (b) b.onclick = () => { AQ.page++; VIEWS.audit(v); };
};

/* Security */
VIEWS.security = async (v) => {
  const s = await api("security");
  v.innerHTML = `<div class="grid kpis">
    ${kpi("Refused admin requests (24h)", n(s.denied_24h), "Requests to the console from accounts without the permission")}
    ${kpi("Sign-in failures (24h)", n(s.login_failures_24h), "Reported by the app")}
    ${kpi("Suspended accounts", n(s.suspended_accounts), "")}
    ${kpi("Admins without two-step sign-in", n(s.admins_without_mfa), s.admins_without_mfa ? `<span class="delta down">Ask them to set it up</span>` : "All set")}
  </div>
  <div class="grid two" style="margin-top:14px">
    <div class="panel"><h3>Recent refused requests</h3>${s.denied_recent.length ? `<div class="tablewrap"><table><tbody>${s.denied_recent.map((x) => `<tr><td>${dt(x.at)}</td><td>${esc(x.who || "unknown account")}</td><td class="mono">${esc(x.action)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">None.</div>`}</div>
    <div class="panel"><h3>Sign-in failures by reason (7 days)</h3>${hbars(Object.entries(s.login_failures_by_reason).map(([k, c]) => ({ label: k, value: c })))}<p class="note">Supabase also keeps its own Auth logs (Supabase dashboard → Logs).</p></div>
  </div>`;
};

/* Reports */
VIEWS.reports = async (v) => {
  const p = periodRange();
  const items = [["summary", "Summary measures", "Every number on the dashboard for the period", "reports.export"], ["daily", "Daily measures", "One row per day: accounts, active people, records, failures", "reports.export"], ["users", "Account list", "Email, dates, status, record and file counts. No health information.", "users.view"], ["audit", "Audit log", "Admin actions in the period (up to 200 rows)", "audit.view"]];
  v.innerHTML = `<p class="note" style="margin:0 0 12px">Period: ${esc(p.label)} (${dt(p.from)} to ${dt(p.to)} IST). Every export is recorded in the audit log. No export contains health information.</p>
  <div class="grid two">${items.filter(([, , , perm]) => can(perm)).map(([k, t, d]) => `<div class="panel"><h3>${t}</h3><p class="sub">${d}</p><button class="btn primary" data-r="${k}">Download CSV</button></div>`).join("")}
  <div class="panel"><h3>PDF</h3><p class="sub">Open the Dashboard or Analytics page and use your browser's Print → Save as PDF. The navigation is left out of the printout.</p><a class="btn" href="#/dashboard">Open dashboard</a></div></div>`;
  v.querySelectorAll("[data-r]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { const r = await api("export", { report: b.dataset.r, ...p }, { raw: true }); const blob = await r.blob(); const name = (r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name ? name[1] : "doctine-report.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast("Downloaded. The export was recorded."); }
    catch (e) { toast(ERR[e.code] || "Export failed."); } finally { b.disabled = false; }
  });
};

/* Definitions */
VIEWS.definitions = async (v) => {
  const D = [
    ["Account", "A Doctine sign-in (Supabase Auth user). Deleted and anonymous accounts are excluded."],
    ["New account", "An account created within the period. Days are calendar days in India Standard Time (UTC+5:30)."],
    ["Qualifying activity", "Something done with health records: adding or changing a record, uploading a file, recording a dose, adding or changing a medicine, saving the health profile, sending an assistant message, searching, or exporting. Signing in, opening pages and refreshing do not count."],
    ["Daily active (DAU)", "Distinct accounts with qualifying activity today (IST)."],
    ["7-day active (WAU)", "Distinct accounts with qualifying activity in the last 7 × 24 hours. In charts: the 7 calendar days ending that day."],
    ["30-day active (MAU)", "As WAU, over 30 days."],
    ["Returning", "Active in the period, and also had qualifying activity before the period began."],
    ["Retention (day N)", "Of a week's new accounts, the share with qualifying activity between N and N+7 days after sign-up. Measured only once every account in the cohort is old enough."],
    ["Funnel", "For accounts created in the period: email confirmed, signed in at least once, any qualifying activity. Profile completion is not measured as a step."],
    ["Records added", "Rows in documents created in the period, any source (scan, upload, typed)."],
    ["Storage", "Total size of files in the private health-documents bucket, from Supabase Storage."],
    ["Failed uploads, failed readings, sign-in failures, app errors", "Counted from measurements the app sends to /api/events. Retries with the same key count once. Before the app sent its first measurement these read zero; the dashboard shows the date recording began."],
    ["Availability", "Not measured inside the console. The GitHub uptime workflow checks the site every 15 minutes; Platform health runs live checks on demand."],
    ["Previous period", "The same length of time immediately before the selected period."],
  ];
  v.innerHTML = `<div class="panel"><dl class="dl" style="grid-template-columns:220px 1fr;gap:12px 16px">${D.map(([t, d]) => `<dt><b>${esc(t)}</b></dt><dd>${esc(d)}</dd>`).join("")}</dl></div>
  <p class="note">What is never collected: document contents, test values, diagnoses, prescription details, medical history, extracted text, search terms, chat contents, passwords or tokens. Measurement properties are restricted to short codes by the database.</p>`;
};

/* Your access */
VIEWS.access = async (v) => {
  v.innerHTML = `<div class="panel"><dl class="dl"><dt>Signed in as</dt><dd>${esc(A.me.email || "")}</dd><dt>Role</dt><dd>${esc(A.me.role)}</dd><dt>Two-step sign-in</dt><dd>${A.me.aal === "aal2" ? "Used for this session" : A.me.mfa_enrolled ? "Set up" : "Not set up"}</dd><dt>Connected site</dt><dd>${esc(A.cfg.environment)}</dd></dl>
  <div class="section-title">Your permissions</div><p>${(A.me.perms || []).map((p) => `<span class="role" style="display:inline-block;margin:0 6px 6px 0">${esc(p)}</span>`).join("")}</p>
  <p class="note">Permissions are checked by the database on every request. Ask the owner to change your role.</p>
  ${A.me.aal !== "aal2" && !A.me.mfa_enrolled ? `<button class="btn" id="mf">Set up two-step sign-in</button>` : ""}</div>`;
  const mf = $("#mf"); if (mf) mf.onclick = () => renderMfa();
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
