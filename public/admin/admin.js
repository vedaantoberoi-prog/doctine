/* Doctine · internal admin console (app.doctine.com/admin).
 *
 * This page holds no privileges of its own. It signs in with the normal Doctine sign-in (Supabase Auth, publishable key)
 * and sends the person's own token to /api/admin, where the server and the database decide every request. Menus are
 * hidden for permissions a role does not have, but that is only tidiness: the same requests are refused server-side.
 * No health information is ever requested or shown: no record titles, values, prescriptions, messages or files.
 *
 * Value states are kept distinct everywhere: an actual zero, "Not measured", "Not configured", "Insufficient data",
 * "Loading" and "Unavailable" never look alike.
 */
"use strict";
(() => {
/* ───────────────────────── basics ───────────────────────── */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("en-IN");
const n = (v) => (v == null || v === "" || Number.isNaN(+v) ? "—" : nf.format(+v));
const pct = (a, b, d = 1) => (b ? (Math.round((a * 10 ** (d + 2)) / b) / 10 ** d) + "%" : "—");
const bytes = (b) => { if (b == null) return "—"; b = +b || 0; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 2 : b < 100 ? 1 : 0) : b) + " " + u[i]; };
const TZ = "Asia/Kolkata", IST = 330 * 60000, DAY = 864e5;
const fmtDT = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtD = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const dt = (v, time = true) => (v ? (time ? fmtDT : fmtD).format(new Date(v)) : "—");
const ago = (v) => { if (!v) return "—"; const s = (Date.now() - Date.parse(v)) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; if (s < 86400 * 30) return Math.round(s / 86400) + " d ago"; return dt(v, false); };
const dayLabel = (d) => new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(String(d).slice(0, 10) + "T00:00:00Z"));
const hourLabel = (h) => new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric" }).format(new Date(h));
const ls = { get: (k, d) => { try { const v = localStorage.getItem("doctine-admin:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem("doctine-admin:" + k, JSON.stringify(v)); } catch {} } };

const ICON = {
  dashboard: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z", analytics: "M3 3v18h18M7 15l4-4 3 3 6-6", reports: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75", documents: "M4 4h6l2 2h8v14H4zM4 10h16",
  health: "M22 12h-4l-3 9L9 3l-3 9H2", errors: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", incidents: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  alerts: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0", flags: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7", maintenance: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
  announcements: "M3 11l18-8v18L3 13zM7 12v6a2 2 0 0 0 4 0v-4", team: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", audit: "M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9",
  security: "M3 11h18v10H3zM7 11V7a5 5 0 0 1 10 0v4", definitions: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5", settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0", refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6",
  menu: "M3 6h18M3 12h18M3 18h18", collapse: "M11 17l-5-5 5-5M18 17l-5-5 5-5", out: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9", info: "M12 16v-4M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  x: "M18 6 6 18M6 6l12 12", columns: "M12 3v18M3 3h18v18H3z", download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
};
const ic = (k, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[k] || ICON.info}"/></svg>`;

const A = { sb: null, session: null, me: null, cfg: null, route: "dashboard", period: ls.get("period", { key: "30d" }), seq: 0, activity: null };
const can = (p) => !!(A.me && A.me.perms && A.me.perms.includes(p));

/* ───────────────────────── periods (calendar days in IST) ───────────────────────── */
function istMidnight(ms) { const d = new Date(ms + IST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST; }
function periodRange(p = A.period) {
  const now = Date.now(), today = istMidnight(now);
  let from, to = now, label;
  if (p.key === "today") { from = today; label = "Today"; }
  else if (p.key === "7d") { from = today - 6 * DAY; label = "Last 7 days"; }
  else if (p.key === "90d") { from = today - 89 * DAY; label = "Last 90 days"; }
  else if (p.key === "month" || p.key === "lastmonth") {
    const d = new Date(now + IST); let y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (p.key === "lastmonth") { m -= 1; if (m < 0) { m = 11; y -= 1; } }
    from = Date.UTC(y, m, 1) - IST; to = Math.min(Date.UTC(y, m + 1, 1) - IST, now);
    label = new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m, 1)));
  } else if (p.key === "custom" && p.from && p.to) {
    from = Date.parse(p.from + "T00:00:00+05:30"); to = Math.min(Date.parse(p.to + "T00:00:00+05:30") + DAY, now); label = `${dayLabel(p.from)} – ${dayLabel(p.to)}`;
  } else { from = today - 29 * DAY; label = "Last 30 days"; }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), label };
}
const prevRange = (r) => { const len = Date.parse(r.to) - Date.parse(r.from); return { from: new Date(Date.parse(r.from) - len).toISOString(), to: r.from }; };

/* ───────────────────────── server ───────────────────────── */
async function token() { const { data } = await A.sb.auth.getSession(); A.session = data.session; return data.session && data.session.access_token; }
async function api(action, args = {}, { raw = false } = {}) {
  const t = await token();
  if (!t) { renderGate(); throw new Error("signed_out"); }
  const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: JSON.stringify({ action, ...args }) });
  if (raw && r.ok) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || "error"); e.status = r.status; e.code = j.error; e.request_id = j.request_id;
    if (r.status === 401) renderGate("Your session ended. Please sign in again.");
    throw e;
  }
  return j.data;
}
const ERR = { forbidden: "Your role does not allow this.", not_installed: "The admin database update has not been applied to this Supabase project yet.", not_configured: "The server is missing its Supabase settings.",
  mfa_required: "Two-step sign-in is required.", invalid: "Some details were not accepted.", invalid_period: "That date range is not valid (up to 400 days).", not_found: "Not found.", rate_limited: "Too many requests. Please wait a moment.",
  database_error: "The database did not answer. Please try again.", server_error: "The server hit an error. It has been recorded.", invalid_report: "Unknown report." };
const errText = (e) => esc(ERR[e.code] || "Something went wrong (" + (e.code || e.message) + ").") + (e.request_id ? ` <span class="mono">ref ${esc(e.request_id.slice(0, 8))}</span>` : "");
function toast(msg, bad = false) { const t = document.createElement("div"); t.className = "toast" + (bad ? " bad" : ""); t.setAttribute("role", "status"); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3800); }
async function download(action, args, fallback) {
  const r = await api(action, args, { raw: true });
  const blob = await r.blob(); const m = (r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/);
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = m ? m[1] : fallback; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ───────────────────────── value states ───────────────────────── */
const STATE = {
  zero: ["0", ""], not_measured: ["Not measured", "The app has not sent this measurement yet."], not_configured: ["Not configured", "The service behind this is not set up."],
  insufficient: ["Insufficient data", "Not enough history to compare or chart."], unavailable: ["Unavailable", "This could not be loaded."],
};
const stateBox = (kind, extra = "", title) => `<div class="state${kind === "unavailable" ? " err" : ""}" data-state="${kind}"><b>${esc(title || STATE[kind][0])}</b><span>${extra || esc(STATE[kind][1])}</span></div>`;
const none = (text, title = "None") => stateBox("zero", text, title);
const skel = (h = 220) => `<div class="skel" style="height:${h}px"></div>`;

/* ───────────────────────── boot & sign-in ───────────────────────── */
async function boot() {
  try { A.cfg = await (await fetch("/api/config", { cache: "no-store" })).json(); } catch { A.cfg = null; }
  if (!A.cfg || !A.cfg.supabaseUrl || !window.supabase) {
    $("#root").innerHTML = `<main class="gate"><div class="card"><div class="mark">D</div><h1>Admin console unavailable</h1><p>This site is not connected to its account service, so there is nothing to administer here.</p></div></main>`;
    return;
  }
  A.sb = window.supabase.createClient(A.cfg.supabaseUrl, A.cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  A.sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") renderGate(); });
  await enter();
}
async function enter() {
  if (!(await token())) return renderGate();
  try {
    const t = await token();
    const r = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: '{"action":"me"}' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error); e.code = j.error; e.status = r.status; e.request_id = j.request_id; throw e; }
    A.me = j;
  } catch (e) {
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
    ${msg ? `<div class="callout" style="margin-bottom:10px">${esc(msg)}</div>` : ""}
    <label class="f" for="em">Email</label><input id="em" type="email" autocomplete="username" required>
    <label class="f" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
    <p class="err" id="gerr" role="alert">${htmlErr || ""}</p>
    <button class="btn primary" style="width:100%;margin-top:14px;min-height:38px" type="submit">Sign in</button>
    <p class="hint" style="margin-top:12px">Signed in to Doctine with Google? Open <a href="/">app.doctine.com</a> first, then come back here.</p>
  </form></main>`;
  $("#signin").addEventListener("submit", async (ev) => {
    ev.preventDefault(); const b = $("#signin button[type=submit]"); b.disabled = true; $("#gerr").textContent = "";
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
  const shell = (inner) => { $("#root").innerHTML = `<main class="gate"><form class="card" id="mfa"><div class="mark" aria-hidden="true">D</div>${inner}</form></main>`; };
  if (totp) {
    shell(`<h1>Two-step sign-in</h1><p>Enter the 6-digit code from your authenticator app.</p>
      <label class="f" for="code">Code</label><input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
      <p class="err" id="merr" role="alert"></p><button class="btn primary" style="width:100%;margin-top:14px">Continue</button>
      <button class="btn ghost" type="button" id="so" style="width:100%;margin-top:6px">Sign out</button>`);
    $("#so").onclick = async () => { await A.sb.auth.signOut({ scope: "local" }); renderGate(); };
    $("#mfa").onsubmit = async (ev) => {
      ev.preventDefault();
      const { error } = await A.sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code: $("#code").value.trim() });
      if (error) { $("#merr").textContent = "That code did not work. Try the newest code."; return; }
      await A.sb.auth.refreshSession(); enter();
    };
    return;
  }
  const { data: en, error } = await A.sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Doctine admin " + new Date().toISOString().slice(0, 10) });
  if (error) { shell(`<h1>Two-step sign-in needed</h1><p>It could not be set up here (${esc(error.message)}). Ask the owner to check that TOTP is enabled in Supabase Auth.</p>`); return; }
  shell(`<h1>Set up two-step sign-in</h1><p>Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the code it shows.</p>
    <img alt="QR code for your authenticator app" src="${esc(en.totp.qr_code)}" width="180" height="180" style="display:block;margin:0 auto 8px;background:#fff">
    <p class="hint">Can't scan? Enter this key: <span class="mono">${esc(en.totp.secret)}</span></p>
    <label class="f" for="code">Code</label><input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
    <p class="err" id="merr" role="alert"></p><button class="btn primary" style="width:100%;margin-top:14px">Turn on two-step sign-in</button>`);
  $("#mfa").onsubmit = async (ev) => {
    ev.preventDefault();
    const { error: e2 } = await A.sb.auth.mfa.challengeAndVerify({ factorId: en.id, code: $("#code").value.trim() });
    if (e2) { $("#merr").textContent = "That code did not work. Try the newest code."; return; }
    await A.sb.auth.refreshSession(); toast("Two-step sign-in is on."); enter();
  };
}

/* ───────────────────────── shell, navigation, top bar ───────────────────────── */
const NAV = [
  ["Overview", [["dashboard", "Dashboard", "dashboard.view"], ["analytics", "Analytics", "analytics.view"], ["reports", "Reports", "reports.export"]]],
  ["Operations", [["users", "Users", "users.view"], ["documents", "Documents", "documents.view"], ["health", "Platform health", "health.view"], ["errors", "Errors", "health.view"], ["incidents", "Incidents", "health.view"], ["alerts", "Alerts", "health.view"]]],
  ["Control", [["flags", "Feature switches", "flags.view"], ["maintenance", "Maintenance", "flags.view"], ["announcements", "Announcements", "dashboard.view"]]],
  ["Security", [["team", "Admin team", "team.view"], ["audit", "Audit log", "audit.view"], ["security", "Security events", "security.view"]]],
  ["Settings", [["definitions", "Metric definitions", "dashboard.view"], ["settings", "Admin settings", "dashboard.view"]]],
];
const PAGES = Object.fromEntries(NAV.flatMap(([g, items]) => items.map(([k, t, p]) => [k, { title: t, group: g, perm: p }])));
const PERIOD_VIEWS = new Set(["dashboard", "analytics", "documents", "reports", "audit"]);

function renderShell() {
  const env = (A.cfg.environment || "unset").toLowerCase();
  $("#root").innerHTML = `<div class="shell${ls.get("mini", false) ? " mini" : ""}" id="shell">
    <aside class="side" id="side" aria-label="Admin sections">
      <div class="brand"><div class="mark" aria-hidden="true">D</div><div><b>Doctine</b><small>Admin console</small></div></div>
      <nav class="nav">${NAV.map(([g, items]) => { const vis = items.filter(([, , p]) => can(p)); return vis.length ? `<h2>${g}</h2>` + vis.map(([k, t]) => `<a href="#/${k}" data-k="${k}" title="${t}">${ic(k)}<span>${t}</span>${k === "alerts" ? `<b class="count" id="nav-alerts" hidden></b>` : ""}</a>`).join("") : ""; }).join("")}</nav>
      <div class="side-foot"><button class="collapse" id="collapse" title="Collapse the sidebar">${ic("collapse")}<span>Collapse</span></button></div>
    </aside>
    <div class="main">
      <header class="top">
        <div class="top-row">
          <button class="iconbtn menu-btn" id="menu" aria-controls="side" aria-expanded="false" aria-label="Open navigation">${ic("menu")}</button>
          <div class="crumbs"><small id="crumb">Overview</small><h1 id="title">Dashboard</h1></div>
          <div class="search" id="search"><label class="sr" for="q">Search</label>${ic("search")}<input id="q" type="search" placeholder="Search people, errors, pages…" autocomplete="off"><span class="kbd">/</span></div>
          <button class="iconbtn" id="refresh" title="Refresh this page" aria-label="Refresh">${ic("refresh")}</button>
          <div style="position:relative"><button class="iconbtn" id="bell" aria-label="Notifications" aria-expanded="false">${ic("bell")}<b class="dot" id="bell-n" hidden></b></button></div>
          <span class="env ${esc(env)}" title="Which site this console is connected to">${esc(env === "production" ? "Production" : env === "unset" ? "Environment not set" : env)}</span>
          <div style="position:relative"><button class="who" id="who" aria-expanded="false" aria-label="Your account"><span class="avatar">${esc((A.me.email || "?").slice(0, 1))}</span><span class="meta"><b>${esc(A.me.email || "")}</b><small>${esc(A.me.role)}</small></span></button></div>
        </div>
        <div class="sub-row" id="filters"></div>
      </header>
      <main class="content" id="view" tabindex="-1"></main>
    </div></div>`;
  $("#menu").onclick = () => { const o = $("#side").classList.toggle("open"); $("#menu").setAttribute("aria-expanded", o); };
  $("#side").addEventListener("click", (e) => { if (e.target.closest("a")) { $("#side").classList.remove("open"); $("#menu").setAttribute("aria-expanded", "false"); } });
  $("#collapse").onclick = () => { const m = $("#shell").classList.toggle("mini"); ls.set("mini", m); };
  $("#refresh").onclick = async () => { const b = $("#refresh"); b.classList.add("spin"); await route(); b.classList.remove("spin"); toast("Refreshed."); refreshBadges(); };
  $("#who").onclick = (e) => popover(e.currentTarget, `<div style="padding:8px 8px 10px"><b>${esc(A.me.email)}</b><div class="muted" style="text-transform:capitalize">${esc(A.me.role)} · ${A.me.aal === "aal2" ? "two-step sign-in used" : "password only"}</div></div>
    <a href="#/settings">${ic("settings")} Admin settings</a><button class="item" id="pop-out">${ic("out")} Sign out</button>`, (p) => { $("#pop-out", p).onclick = signOut; });
  $("#bell").onclick = (e) => openNotifications(e.currentTarget);
  setupSearch();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !document.querySelector("dialog[open]")) { closePop(); closeDrawer(); return; } if (e.key === "/"&& !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); const q = $("#q"); if (q && q.offsetParent) q.focus(); } });
  window.onhashchange = () => route();
  route();
  refreshBadges();
  setInterval(refreshBadges, 120000);
}
async function signOut() { await A.sb.auth.signOut({ scope: "local" }); renderGate("You have signed out."); }

let popEl = null;
function closePop() { if (popEl) { popEl.remove(); popEl = null; $$("[aria-expanded=true].iconbtn,[aria-expanded=true].who,[aria-expanded=true].btn").forEach((b) => b.setAttribute("aria-expanded", "false")); } }
function popover(anchor, html, init) {
  const was = popEl && popEl.parentElement === anchor.parentElement; closePop(); if (was) return;
  popEl = document.createElement("div"); popEl.className = "pop"; popEl.innerHTML = html; anchor.parentElement.appendChild(popEl); anchor.setAttribute("aria-expanded", "true");
  if (init) init(popEl);
  const mine = popEl;
  setTimeout(() => document.addEventListener("click", function off(e) { if (popEl !== mine) return document.removeEventListener("click", off); if (!mine.contains(e.target) && !anchor.contains(e.target)) { closePop(); document.removeEventListener("click", off); } }), 0);
}
async function refreshBadges() {
  if (!can("health.view")) return;
  try {
    const a = await api("activity"); A.activity = a;
    const k = (a.alerts || []).filter((x) => x.status === "open").length, i = (a.incidents || []).length;
    const bn = $("#bell-n"); if (bn) { bn.hidden = !(k + i); bn.textContent = k + i; }
    const na = $("#nav-alerts"); if (na) { na.hidden = !k; na.textContent = k; }
  } catch {}
}
async function openNotifications(anchor) {
  if (!can("health.view")) return popover(anchor, `<div style="padding:10px" class="muted">Your role does not receive platform notifications.</div>`);
  popover(anchor, `<div style="padding:10px" class="muted">Loading…</div>`);
  try { A.activity = await api("activity"); } catch {}
  if (!popEl) return;
  const a = A.activity || {}, al = a.alerts || [], inc = a.incidents || [];
  popEl.innerHTML = `<h4>Alerts needing attention</h4>${al.length ? al.map((x) => `<a href="#/alerts"><span class="sev ${esc(x.severity)}">${esc(x.severity)}</span><span style="flex:1">${esc(x.message)}<div class="muted">${esc(SERVICE[x.service] || x.service || "")} · ${ago(x.opened_at)} · ${esc(x.status)}</div></span></a>`).join("") : `<div class="muted" style="padding:6px 8px">No open alerts.</div>`}
    <h4>Open incidents</h4>${inc.length ? inc.map((x) => `<a href="#/incidents"><span class="sev ${esc(x.severity)}">${esc(x.severity)}</span><span style="flex:1">${esc(x.title)}<div class="muted">${esc(x.status)} · since ${ago(x.started_at)}</div></span></a>`).join("") : `<div class="muted" style="padding:6px 8px">No open incidents.</div>`}
    <div style="border-top:1px solid var(--line-2);margin-top:6px;padding:8px 8px 2px" class="muted">Choose whether alerts are emailed to you in <a href="#/settings">Admin settings</a>.</div>`;
  $$("a", popEl).forEach((x) => x.addEventListener("click", closePop));
}
function setupSearch() {
  const input = $("#q"); let timer = null, active = 0;
  const pages = () => NAV.flatMap(([, items]) => items).filter(([, , p]) => can(p));
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 220); });
  input.addEventListener("keydown", (e) => {
    if (!popEl) return; const items = $$("a,button.item", popEl);
    if (e.key === "ArrowDown") active = Math.min(active + 1, items.length - 1);
    else if (e.key === "ArrowUp") active = Math.max(active - 1, 0);
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); items[active].click(); closePop(); input.blur(); return; }
    else if (e.key === "Escape") { closePop(); return; } else return;
    e.preventDefault(); items.forEach((x, i) => x.classList.toggle("active", i === active));
  });
  async function run() {
    const q = input.value.trim(); active = 0;
    if (!q) return closePop();
    const pm = pages().filter(([, t]) => t.toLowerCase().includes(q.toLowerCase())).slice(0, 5);
    let r = { users: [], errors: [], incidents: [] };
    if (q.length >= 2) { try { r = await api("search", { q }); } catch {} }
    if (input.value.trim() !== q) return;
    const html = `${pm.length ? `<h4>Pages</h4>${pm.map(([k, t]) => `<a href="#/${k}">${ic(k)}${esc(t)}</a>`).join("")}` : ""}
      ${r.users.length ? `<h4>People</h4>${r.users.map((u) => `<button class="item" data-user="${esc(u.id)}">${ic("users")}<span>${esc(u.email)}<div class="muted mono">${esc(u.id.slice(0, 8))}</div></span></button>`).join("")}` : ""}
      ${r.errors.length ? `<h4>Errors</h4>${r.errors.map((x) => `<button class="item" data-err="${esc(x.fingerprint)}">${ic("errors")}<span>${esc(x.kind)}<div class="muted">${esc(x.message)}</div></span></button>`).join("")}` : ""}
      ${r.incidents.length ? `<h4>Incidents</h4>${r.incidents.map((x) => `<a href="#/incidents">${ic("incidents")}<span>${esc(x.title)}<div class="muted">${esc(x.status)}</div></span></a>`).join("")}` : ""}
      ${!pm.length && !r.users.length && !r.errors.length && !r.incidents.length ? `<div class="muted" style="padding:8px">No matches for “${esc(q)}”.</div>` : ""}`;
    closePop(); popEl = document.createElement("div"); popEl.className = "pop"; popEl.innerHTML = html; $("#search").appendChild(popEl);
    $$("[data-user]", popEl).forEach((b) => b.onclick = () => { closePop(); input.value = ""; openUser(b.dataset.user); });
    $$("[data-err]", popEl).forEach((b) => b.onclick = () => { closePop(); input.value = ""; openError(b.dataset.err); });
    $$("a", popEl).forEach((a) => a.addEventListener("click", () => { closePop(); input.value = ""; }));
    const mine = popEl;
    setTimeout(() => document.addEventListener("click", function off(e) { if (popEl !== mine) return document.removeEventListener("click", off); if (!mine.contains(e.target) && e.target !== input) { closePop(); document.removeEventListener("click", off); } }), 0);
  }
}

function renderFilters() {
  const f = $("#filters"); if (!f) return;
  if (!PERIOD_VIEWS.has(A.route)) { f.innerHTML = ""; f.style.display = "none"; return; }
  f.style.display = "";
  const keys = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["month", "This month"], ["lastmonth", "Last month"], ["custom", "Custom"]];
  const r = periodRange(), days = Math.max(1, Math.round((Date.parse(r.to) - Date.parse(r.from)) / DAY));
  f.innerHTML = `<div class="seg" role="group" aria-label="Date range">${keys.map(([k, t]) => `<button data-p="${k}" aria-pressed="${A.period.key === k}">${t}</button>`).join("")}</div>
    ${A.period.key === "custom" ? `<label class="sr" for="pf">From</label><input type="date" id="pf" value="${esc(A.period.from || "")}"><span class="muted">to</span><label class="sr" for="pt">To</label><input type="date" id="pt" value="${esc(A.period.to || "")}"><button class="btn sm" id="papply">Apply</button>` : ""}
    <span class="muted" style="font-size:12px" id="prange">${esc(r.label)} · ${dt(r.from)} → ${dt(r.to)} IST · compared with the previous ${days} day${days === 1 ? "" : "s"}</span>`;
  $$("[data-p]", f).forEach((b) => b.onclick = () => { A.period = { ...A.period, key: b.dataset.p }; if (b.dataset.p !== "custom") { ls.set("period", A.period); renderFilters(); route(); } else renderFilters(); });
  const ap = $("#papply"); if (ap) ap.onclick = () => { const from = $("#pf").value, to = $("#pt").value; if (!from || !to || from > to) return toast("Choose a start date on or before the end date.", true); if ((Date.parse(to) - Date.parse(from)) / DAY > 399) return toast("Choose up to 400 days.", true); A.period = { key: "custom", from, to }; ls.set("period", A.period); renderFilters(); route(); };
}
async function route() {
  closeDrawer(); closePop();
  const k = location.hash.replace(/^#\/?/, "").split("?")[0] || "dashboard";
  const ok = PAGES[k] && can(PAGES[k].perm);
  A.route = ok ? k : NAV.flatMap(([, i]) => i).find(([, , p]) => can(p))[0];
  $$(".nav a").forEach((a) => (a.dataset.k === A.route ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const pg = PAGES[A.route];
  $("#title").textContent = pg.title; $("#crumb").textContent = pg.group; document.title = "Doctine · " + pg.title;
  renderFilters();
  const v = $("#view"), seq = ++A.seq;
  v.innerHTML = `<div class="grid kpis">${Array.from({ length: 4 }, () => `<div class="card" style="padding:16px">${skel(64)}</div>`).join("")}</div><div class="card" style="margin-top:12px;padding:16px">${skel(220)}</div>`;
  try { await VIEWS[A.route](v, seq); }
  catch (e) { if (e.message !== "signed_out" && seq === A.seq) { v.innerHTML = `<div class="state err" data-state="unavailable"><b>Unavailable</b><span>${errText(e)}</span><button class="btn sm" id="retry" style="margin-top:8px">Try again</button></div>`; const rb = $("#retry"); if (rb) rb.onclick = () => route(); } }
}
const stale = (seq) => seq !== A.seq;

/* ───────────────────────── charts (plain SVG) ───────────────────────── */
let chartN = 0;
const fmtShort = (v) => { v = +v || 0; const a = Math.abs(v); return a >= 1e7 ? (v / 1e7).toFixed(1) + " Cr" : a >= 1e5 ? (v / 1e5).toFixed(1) + " L" : a >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(Math.round(v * 100) / 100); };
function niceMax(max) { if (max <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(max))), m = max / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; }
/* series: [{ key | values, label, color, type: "line"|"bar"|"area", dash }]. One y-axis only: every series shares a unit. */
function chart(rows, series, opts = {}) {
  const { height = 220, yFmt = fmtShort, xFmt = dayLabel, tipFmt = (v) => n(v), ytitle = "", xkey = "day" } = opts;
  const val = (s, r, i) => (s.values ? (s.values[i] === undefined ? null : s.values[i]) : r[s.key]);
  const nums = rows.flatMap((r, i) => series.map((s) => val(s, r, i))).filter((v) => v != null && !Number.isNaN(+v));
  if (!rows.length || !nums.length) return stateBox("insufficient", opts.empty || "There is no data for this period yet.");
  if (!opts.allowZero && series.filter((s) => !s.dash).every((s) => rows.every((r, i) => !+val(s, r, i)))) return none(opts.zeroText || "The value was zero on every day of this period.", "Zero in this period");
  const id = "c" + (++chartN), W = window.innerWidth < 640 ? 400 : 720, H = height, L = 46, R = 12, T = opts.ytitle ? 24 : 14, B = 26;
  const vmax = Math.max(...nums.map(Number)), whole = !opts.ymax && nums.every((v) => Number.isInteger(+v));
  let ymax = opts.ymax || niceMax(vmax), ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
  if (whole) { // counts get whole-number gridlines (no "0.25 people")
    let st = 1; for (const m of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 1e4, 2e4, 5e4, 1e5, 1e6]) { st = m; if (Math.ceil(Math.max(vmax, 1) / m) <= 5) break; }
    ymax = st * Math.max(1, Math.ceil(vmax / st)); ticks = Array.from({ length: Math.round(ymax / st) + 1 }, (_, i) => i * st);
  }
  const bars = series.filter((s) => s.type === "bar"), nb = bars.length;
  const slot = (W - L - R) / rows.length;
  const x = (i) => (nb ? L + slot * (i + 0.5) : L + (rows.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (rows.length - 1)));
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, +v) / ymax);
  const step = Math.max(1, Math.ceil(rows.length / (W < 500 ? 4 : 8)));
  let svg = ticks.map((t) => `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${L - 8}" y="${y(t) + 3.5}" text-anchor="end">${esc(yFmt(t))}</text>`).join("");
  svg += rows.map((r, i) => (i % step === 0 && (rows.length - 1 - i >= step * 0.85 || i === 0)) || i === rows.length - 1 ? `<text class="ax" x="${x(i)}" y="${H - 7}" text-anchor="${i === rows.length - 1 && rows.length > 1 ? "end" : i === 0 && !nb ? "start" : "middle"}">${esc(xFmt(r[xkey]))}</text>` : "").join("");
  if (ytitle) svg += `<text class="at" x="${L - 40}" y="${T - 12}">${esc(ytitle)}</text>`;
  if (nb) {
    const bw = Math.max(2, Math.min(26, (slot * 0.72) / nb));
    bars.forEach((s, j) => {
      svg += rows.map((r, i) => { const v = +val(s, r, i) || 0; if (!v) return ""; const h = Math.max(1.5, (H - T - B) * (v / ymax)); const bx = x(i) - (bw * nb) / 2 + j * bw + 0.5, w = bw - 1, rr = Math.min(3, h, w / 2);
        return `<path d="M${bx},${y(0)}v${-(h - rr)}q0,${-rr} ${rr},${-rr}h${w - 2 * rr}q${rr},0 ${rr},${rr}v${h - rr}z" fill="${s.color}"/>`; }).join("");
    });
  }
  for (const s of series.filter((q) => q.type !== "bar")) {
    const pts = rows.map((r, i) => [x(i), val(s, r, i)]).filter(([, v]) => v != null);
    if (!pts.length) continue;
    const d = pts.map(([px, v], i) => `${i ? "L" : "M"}${px.toFixed(1)},${y(v).toFixed(1)}`).join("");
    if (s.type === "area") svg += `<path d="${d}L${pts[pts.length - 1][0].toFixed(1)},${y(0)}L${pts[0][0].toFixed(1)},${y(0)}Z" fill="${s.fill || "rgba(42,98,184,.12)"}"/>`;
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.dash ? 1.5 : 2}" ${s.dash ? 'stroke-dasharray="4 4"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    if (pts.length <= 2) svg += pts.map(([px, v]) => `<circle cx="${px}" cy="${y(v)}" r="3.5" fill="${s.color}"/>`).join("");
  }
  svg += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#98a2b3" stroke-dasharray="3 3" style="display:none"/><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span style="color:${s.color}"><i class="${s.dash ? "dash" : ""}" style="background:${s.color}"></i><span style="color:var(--ink-2)">${esc(s.label)}</span></span>`).join("")}</div>` : "";
  const table = `<details class="tv"><summary>Show as table</summary><div class="tbl-wrap" style="max-height:260px;margin-top:6px;border:1px solid var(--line);border-radius:6px"><table><thead><tr><th>${esc(opts.xlabel || "Day")}</th>${series.map((s) => `<th class="num">${esc(s.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((r, i) => `<tr><td>${esc(xFmt(r[xkey]))}</td>${series.map((s) => `<td class="num">${esc(tipFmt(val(s, r, i)))}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
  queueMicrotask(() => {
    const host = document.getElementById(id); if (!host) return;
    const sv = host.querySelector("svg"), tip = host.querySelector(".tip"), cross = sv.querySelector(".cross");
    const move = (ev) => {
      const b = sv.getBoundingClientRect(), px = ((ev.clientX - b.left) / b.width) * W;
      const i = nb ? Math.min(rows.length - 1, Math.max(0, Math.floor((px - L) / slot))) : Math.min(rows.length - 1, Math.max(0, Math.round(((px - L) / (W - L - R)) * (rows.length - 1))));
      const cx = x(i), r = rows[i];
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.style.display = "";
      tip.innerHTML = `<b>${esc(opts.tipTitle ? opts.tipTitle(r) : xFmt(r[xkey]))}</b><br>` + series.map((s) => `<i style="background:${s.color}"></i>${esc(s.label)}: <b>${esc(tipFmt(val(s, r, i)))}</b>`).join("<br>");
      tip.style.display = "block"; tip.style.left = Math.max(90, Math.min(b.width - 90, (cx / W) * b.width)) + "px"; tip.style.top = (T / H) * b.height + 12 + "px";
    };
    sv.addEventListener("pointermove", move); sv.addEventListener("pointerdown", move);
    sv.addEventListener("pointerleave", () => { tip.style.display = "none"; cross.style.display = "none"; });
  });
  return `${legend}<div class="chart" id="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.label).join(", "))}">${svg}</svg><div class="tip"></div></div>${table}`;
}
function spark(values) {
  const v = values.map((x) => +x || 0); if (v.length < 3 || v.every((x) => x === v[0])) return "";
  const W = 96, H = 32, max = Math.max(...v), min = Math.min(...v), sx = (i) => (i * W) / (v.length - 1), sy = (x) => H - 3 - ((x - min) / (max - min || 1)) * (H - 6);
  const d = v.map((x, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)},${sy(x).toFixed(1)}`).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="${d}L${W},${H}L0,${H}Z" fill="rgba(42,98,184,.12)"/><path d="${d}" fill="none" stroke="#2a62b8" stroke-width="1.5"/></svg>`;
}
function hbars(items, { total, fmt = n, color } = {}) {
  if (!items.length) return none("Nothing in this period.");
  const max = Math.max(1, total || 0, ...items.map((i) => +i.value || 0));
  return `<div class="hbar">${items.map((i) => i.unmeasured ? `<div>${esc(i.label)}</div><div class="track"></div><div class="v"><span class="st none">Not measured</span></div>` : `<div>${esc(i.label)}</div><div class="track"><div class="bar" style="width:${((+i.value || 0) / max) * 100}%;${color || i.color ? "background:" + (i.color || color) : ""}"></div></div><div class="v">${fmt(i.value)}${total ? ` <small>${pct(+i.value || 0, total)}</small>` : ""}</div>`).join("")}</div>`;
}
const S1 = "#2a62b8", S2 = "#b8781c", S3 = "#16927a", SG = "#98a2b3", RED = "#b42318";
const SERVICE = { app: "Main application", database: "Database / Data API", auth: "Authentication", storage: "File storage", ai: "AI provider (Anthropic)", monitoring: "Scheduled monitoring" };

/* KPI card. A change is shown only with real comparison data; "invert" marks metrics where up is bad. */
function delta(cur, prev, { invert = false } = {}) {
  if (cur == null || prev == null) return `<span class="muted">No comparison</span>`;
  if (+prev === 0 && +cur === 0) return `<span class="delta flat">No change</span> <span class="muted">0 before</span>`;
  if (+prev === 0) return `<span class="delta ${invert ? "up bad-up" : "up"}">New</span> <span class="muted">none in the previous period</span>`;
  const d = ((cur - prev) / prev) * 100, r = Math.abs(d) < 10 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d));
  const cls = d > 0 ? "up" + (invert ? " bad-up" : "") : d < 0 ? "down" + (invert ? " good-down" : "") : "flat";
  return `<span class="delta ${cls}">${d > 0 ? "▲" : d < 0 ? "▼" : "■"} ${r}%</span> <span class="muted">vs ${n(prev)}</span>`;
}
function kpi({ label, value, display, meta = "", tip = "", href, sparkline = "", state, id }) {
  const tag = href ? "a" : "div";
  const v = state ? `<div class="k-value word" data-state="${state}">${esc(STATE[state][0])}</div>` : `<div class="k-value">${display != null ? display : n(value)}</div>`;
  return `<${tag} class="card kpi" ${href ? `href="${href}"` : ""} ${id ? `data-kpi="${id}"` : ""}><div class="k-label">${esc(label)}${tip ? `<span class="tip" title="${esc(tip)}" aria-label="${esc(tip)}">${ic("info")}</span>` : ""}</div>
    <div class="k-row">${v}${state ? "" : sparkline}</div><div class="k-meta">${state && !meta ? esc(STATE[state][1]) : meta}</div></${tag}>`;
}
const card = (title, sub, body, { right = "", foot = "", style = "" } = {}) => `<section class="card" ${style ? `style="${style}"` : ""}><div class="card-h"><div style="flex:1;min-width:0"><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}</div>${right}</div><div class="card-b">${body}</div>${foot ? `<div class="card-f">${foot}</div>` : ""}</section>`;
const section = (title, sub = "") => `<div class="section"><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ""}</div>`;
const tabs = (id, options, current) => `<div class="tabs" role="tablist" data-tabs="${id}">${options.map(([k, t]) => `<button role="tab" data-tab="${k}" aria-selected="${k === current}">${t}</button>`).join("")}</div>`;
function bindTabs(root, id, render) { $$(`[data-tabs="${id}"] [data-tab]`, root).forEach((b) => b.onclick = () => { $$(`[data-tabs="${id}"] [data-tab]`, root).forEach((x) => x.setAttribute("aria-selected", x === b)); render(b.dataset.tab); }); }
const alignPrev = (prev, key) => (prev ? prev.map((r) => r[key]) : null);

/* ───────────────────────── views ───────────────────────── */
const VIEWS = {};

/* Dashboard */
VIEWS.dashboard = async (v, seq) => {
  const p = periodRange(), pp = prevRange(p), wantSeries = can("analytics.view");
  const [o, s, sp, act] = await Promise.all([api("overview", p), wantSeries ? api("series", p).catch(() => null) : null, wantSeries ? api("series", pp).catch(() => null) : null, api("activity").catch(() => null)]);
  if (stale(seq)) return;
  if (act) A.activity = act;
  const sl = (k) => (s ? spark(s.map((d) => d[k])) : "");
  const av = o.availability, avp = o.availability_prev, storagePct = o.storage_limit ? (o.storage_bytes / o.storage_limit) * 100 : null;
  v.innerHTML = `<p class="lead">How Doctine is doing in <b>${esc(p.label.toLowerCase())}</b>. Updated ${dt(o.generated_at)} IST. Click any card for detail.</p>
  <div class="grid kpis">
    ${kpi({ id: "accounts", label: "Registered accounts", value: o.users_total, meta: delta(o.users_total, o.users_total_prev), tip: "All accounts at the end of the period, excluding deleted and anonymous ones.", href: can("users.view") ? "#/users" : null, sparkline: sl("users_total") })}
    ${kpi({ id: "new", label: "New accounts", value: o.users_new, meta: delta(o.users_new, o.users_new_prev), tip: "Accounts created in the selected period.", href: can("analytics.view") ? "#/analytics" : null, sparkline: sl("users_new") })}
    ${kpi({ id: "dau", label: "Daily active (DAU)", value: o.dau, meta: delta(o.dau, o.dau_prev) + ` <span class="muted">today vs yesterday</span>`, tip: "Distinct people with meaningful activity today (IST). Signing in alone does not count.", href: can("analytics.view") ? "#/analytics" : null, sparkline: sl("dau") })}
    ${kpi({ id: "wau", label: "Weekly active (WAU)", value: o.wau, meta: delta(o.wau, o.wau_prev) + ` <span class="muted">vs the 7 days before</span>`, tip: "Distinct people with meaningful activity in the last 7 days.", href: can("analytics.view") ? "#/analytics" : null, sparkline: sl("wau") })}
    ${kpi({ id: "mau", label: "Monthly active (MAU)", value: o.mau, meta: delta(o.mau, o.mau_prev) + ` <span class="muted">vs the 30 days before</span>`, tip: "Distinct people with meaningful activity in the last 30 days.", href: can("analytics.view") ? "#/analytics" : null, sparkline: sl("mau") })}
    ${kpi({ id: "returning", label: "Returning people", value: o.returning, meta: delta(o.returning, o.returning_prev) + ` <span class="muted">${pct(o.returning, o.active)} of ${n(o.active)} active</span>`, tip: "Active in the period and also active before it started.", href: can("analytics.view") ? "#/analytics" : null, sparkline: sl("returning") })}
    ${kpi({ id: "records", label: "Health records created", value: o.documents_new, meta: delta(o.documents_new, o.documents_new_prev) + ` <span class="muted">${n(o.documents_total)} in total</span>`, tip: "Records saved in the period, from any source (scan, upload or typed).", href: can("documents.view") ? "#/documents" : null, sparkline: sl("documents") })}
    ${kpi({ id: "files", label: "Documents uploaded", value: o.files_new, meta: delta(o.files_new, o.files_new_prev), tip: "Document files stored in the period (originals and cleaned page images).", href: can("documents.view") ? "#/documents" : null, sparkline: sl("files") })}
    ${kpi({ id: "storage", label: "Storage consumed", display: bytes(o.storage_bytes), meta: storagePct != null ? `<span class="muted">${o.storage_bytes && storagePct < 0.1 ? "under 0.1" : storagePct.toFixed(1)}% of ${bytes(o.storage_limit)} · ${n(o.storage_files)} files</span>` : "", tip: "All files in the private document bucket, from Supabase Storage.", href: can("documents.view") ? "#/documents" : null, sparkline: sl("storage_total") })}
    ${kpi({ id: "errors", label: "Application errors", value: o.app_errors, meta: o.errors_since ? delta(o.app_errors, o.app_errors_prev, { invert: true }) : `<span class="muted">Tracking is on · nothing ever reported, an actual zero</span>`, tip: "Errors reported by the app and the server in the period.", href: can("health.view") ? "#/errors" : null, sparkline: sl("app_errors") })}
    ${o.events_since ? kpi({ id: "failed", label: "Failed uploads", value: o.uploads_failed, meta: delta(o.uploads_failed, o.uploads_failed_prev, { invert: true }), tip: "Uploads the app reported as failed (opt-in measurement).", href: can("documents.view") ? "#/documents" : null, sparkline: sl("uploads_failed") })
      : kpi({ id: "failed", label: "Failed uploads", state: "not_measured", meta: "Sent only by people who switched on Help improve Doctine; none received yet.", href: can("documents.view") ? "#/documents" : null })}
    ${av && av.checks ? kpi({ id: "availability", label: "Platform availability", display: av.pct + "%", meta: `<span class="muted">${n(av.ok)} of ${n(av.checks)} checks passed${avp && avp.checks ? ` · previous ${avp.pct}%` : " · no checks in the previous period"}</span>`, tip: "Share of scheduled health checks of the app that passed in the period.", href: can("health.view") ? "#/health" : null })
      : kpi({ id: "availability", label: "Platform availability", state: "insufficient", meta: o.checks_since ? "No checks were recorded in this period." : "No health checks have been recorded yet.", href: can("health.view") ? "#/health" : null })}
  </div>
  ${s ? `${section("Trends", `${esc(p.label)}, day by day (IST). The dashed line is the previous period.`)}<div class="grid cols-2" id="charts"></div>`
      : `<div class="callout" style="margin-top:16px">${ic("info")}<span>Trend charts need the analytics permission. Your role sees the headline figures.</span></div>`}
  ${act ? `${section("Activity", "The most recent events")}<div class="grid cols-3" id="activity"></div>` : ""}`;
  if (s) renderDashCharts($("#charts"), s, sp);
  if (act) renderActivity($("#activity"), act);
};
function renderDashCharts(host, s, sp) {
  const measured = s.some((d) => d.uploads_completed || d.uploads_failed || d.processing_completed || d.processing_failed);
  const prev = (key) => (sp ? [{ label: "Previous period", color: SG, dash: true, values: alignPrev(sp, key) }] : []);
  const B = {
    growth: { t: "A · User growth", d: "Daily registrations and cumulative registered accounts", tabs: [["daily", "Daily"], ["total", "Cumulative"]],
      r: (t) => (t === "total" ? chart(s, [{ key: "users_total", label: "Registered accounts", color: S1, type: "area" }, ...(sp ? [{ label: "Previous period", color: SG, dash: true, values: alignPrev(sp, "users_total") }] : [])], { ytitle: "Accounts" })
        : chart(s, [{ key: "users_new", label: "New accounts", color: S1, type: "bar" }, ...prev("users_new")], { ytitle: "Accounts", zeroText: "No accounts were created in this period." })) },
    active: { t: "B · Active users", d: "DAU, WAU and MAU over time (meaningful activity only)", r: () => chart(s, [{ key: "dau", label: "DAU", color: S1 }, { key: "wau", label: "WAU", color: S2 }, { key: "mau", label: "MAU", color: S3 }], { ytitle: "People", zeroText: "Nobody had meaningful activity in this period." }) },
    activity: { t: "C · User activity", d: "New registrations, returning people and meaningful actions", tabs: [["people", "People"], ["actions", "Actions"]],
      r: (t) => (t === "actions" ? chart(s, [{ key: "actions", label: "Meaningful actions", color: S1, type: "bar" }, ...prev("actions")], { ytitle: "Actions", zeroText: "No meaningful actions in this period." })
        : chart(s, [{ key: "users_new", label: "New registrations", color: S1, type: "bar" }, { key: "returning", label: "Returning people", color: S2, type: "bar" }], { ytitle: "People" })) },
    records: { t: "D · Health record growth", d: "Records created per day and cumulative", tabs: [["daily", "Daily"], ["total", "Cumulative"]],
      r: (t) => (t === "total" ? chart(s, [{ key: "documents_total", label: "Records in total", color: S1, type: "area" }], { ytitle: "Records", zeroText: "No records exist yet." })
        : chart(s, [{ key: "documents", label: "Records created", color: S1, type: "bar" }, ...prev("documents")], { ytitle: "Records", zeroText: "No records were created in this period." })) },
    docs: { t: "E · Document activity", d: "Files uploaded, upload and PDF-reading outcomes, storage over time", tabs: [["files", "Uploads"], ["outcomes", "Outcomes"], ["storage", "Storage"]],
      r: (t) => (t === "storage" ? chart(s, [{ key: "storage_total", label: "Stored file size", color: S1, type: "area" }], { yFmt: bytes, tipFmt: bytes, ytitle: "Size", zeroText: "No files are stored yet." })
        : t === "outcomes" ? (measured ? chart(s, [{ key: "uploads_completed", label: "Uploads completed", color: S3, type: "bar" }, { key: "uploads_failed", label: "Uploads failed", color: RED, type: "bar" }, { key: "processing_completed", label: "Readings done", color: S1 }, { key: "processing_failed", label: "Readings failed", color: S2 }], { allowZero: true, ytitle: "Events" })
          : stateBox("not_measured", "Upload and reading outcomes are sent by the app only for people who switched on Help improve Doctine. None have been received in this period."))
        : chart(s, [{ key: "files", label: "Files uploaded", color: S1, type: "bar" }, ...prev("files")], { ytitle: "Files", zeroText: "No files were uploaded in this period." })) },
    reliability: { t: "F · Platform reliability", d: "Availability, response time, errors and failed checks", tabs: [["avail", "Availability"], ["ms", "Response time"], ["errors", "Errors"]],
      r: (t) => { const rows = s.map((d) => ({ ...d, avail: d.checks ? Math.round((d.checks_ok / d.checks) * 1000) / 10 : null, failed: d.checks - d.checks_ok }));
        if (t === "errors") return chart(rows, [{ key: "app_errors", label: "Errors reported", color: RED, type: "bar" }, { key: "failed", label: "Failed checks", color: S2, type: "bar" }], { ytitle: "Count", zeroText: "No errors and no failed checks in this period." });
        if (!rows.some((d) => d.checks)) return stateBox("insufficient", "No scheduled health checks were recorded in this period.");
        return t === "ms" ? chart(rows, [{ key: "ms_avg", label: "App response (ms)", color: S1 }], { ytitle: "ms", tipFmt: (x) => (x == null ? "no checks" : n(x) + " ms"), allowZero: true })
          : chart(rows, [{ key: "avail", label: "Availability", color: S3, type: "area", fill: "rgba(22,146,122,.12)" }], { ymax: 100, yFmt: (x) => x + "%", tipFmt: (x) => (x == null ? "no checks" : x + "%"), ytitle: "%", allowZero: true }); } },
  };
  host.innerHTML = Object.entries(B).map(([k, b]) => card(b.t, b.d, `<div id="ch-${k}"></div>`, { right: b.tabs ? tabs("t-" + k, b.tabs, b.tabs[0][0]) : "" })).join("");
  for (const [k, b] of Object.entries(B)) { $("#ch-" + k).innerHTML = b.r(b.tabs ? b.tabs[0][0] : null); if (b.tabs) bindTabs(host, "t-" + k, (t) => { $("#ch-" + k).innerHTML = b.r(t); }); }
}
function renderActivity(host, a) {
  const panel = (title, href, items, empty) => `<section class="card"><div class="card-h"><h3 style="flex:1">${title}</h3>${href ? `<a href="${href}" style="font-size:12px">View all</a>` : ""}</div><div class="list" style="margin-top:8px">${items.length ? items.join("") : `<div class="li muted">${empty}</div>`}</div></section>`;
  const parts = [];
  if (a.registrations) parts.push(panel("Recent registrations", "#/users", a.registrations.map((u) => `<button class="li" data-user="${esc(u.id)}"><span class="t"><div>${esc(u.email || "(no email)")}</div><div class="muted">${u.confirmed ? "Email confirmed" : "Email not confirmed"}</div></span><span class="r">${ago(u.at)}</span></button>`), "No accounts yet."));
  else parts.push(panel("Recent registrations", null, [`<div class="li"><span class="t"><div><b>${n(a.registrations_7d)}</b> in the last 7 days</div><div class="muted">Your role does not see account details.</div></span></div>`], ""));
  if (a.errors) parts.push(panel("Recent platform errors", "#/errors", a.errors.map((e) => `<button class="li" data-err="${esc(e.fingerprint)}"><span class="t"><div><b>${esc(e.kind)}</b> ${esc(e.message)}</div><div class="muted">${esc(e.source === "server" ? "Server" : "App")} · ${n(e.count)} times</div></span><span class="r">${ago(e.last_seen)}</span></button>`), "No open errors."));
  if (a.checks) parts.push(panel("Latest system checks", "#/health", a.checks.map((c) => `<div class="li"><span class="t"><div>${esc(SERVICE[c.target] || c.target)}</div><div class="muted">${c.ms != null ? n(c.ms) + " ms" : ""}${c.status ? " · HTTP " + esc(c.status) : ""}</div></span><span class="r">${c.ok ? `<span class="st good">Passed</span>` : `<span class="st bad">Failed</span>`} ${ago(c.at)}</span></div>`), "No checks recorded yet."));
  if (a.admin_actions) parts.push(panel("Recent admin actions", "#/audit", a.admin_actions.map((x) => `<a class="li" href="#/audit"><span class="t"><div class="mono">${esc(x.action)}</div><div class="muted">${esc(x.by || "unknown")} · ${esc(x.outcome)}</div></span><span class="r">${ago(x.at)}</span></a>`), "No admin actions yet."));
  if (a.incidents) parts.push(panel("Open incidents", "#/incidents", a.incidents.map((x) => `<a class="li" href="#/incidents"><span class="t"><div>${esc(x.title)}</div><div class="muted"><span class="sev ${esc(x.severity)}">${esc(x.severity)}</span> · ${esc(x.status)}</div></span><span class="r">${ago(x.started_at)}</span></a>`), "No open incidents."));
  if (a.alerts) parts.push(panel("Alerts requiring attention", "#/alerts", a.alerts.map((x) => `<a class="li" href="#/alerts"><span class="t"><div>${esc(x.message)}</div><div class="muted"><span class="sev ${esc(x.severity)}">${esc(x.severity)}</span> · ${esc(SERVICE[x.service] || x.service || "")} · ${esc(x.status)}</div></span><span class="r">${ago(x.opened_at)}</span></a>`), "Nothing needs attention."));
  host.innerHTML = parts.join("");
  $$("[data-user]", host).forEach((b) => b.onclick = () => openUser(b.dataset.user));
  $$("[data-err]", host).forEach((b) => b.onclick = () => openError(b.dataset.err));
}

/* Analytics */
VIEWS.analytics = async (v, seq) => {
  const p = periodRange(), pp = prevRange(p);
  const [o, s, sp, f, fp, e, ep, ad, tr, ret] = await Promise.all([api("overview", p), api("series", p), api("series", pp).catch(() => null), api("funnel", p), api("funnel", pp), api("engagement", p), api("engagement", pp), api("adoption", p), api("adoption_trend", { weeks: 12 }), api("retention", { weeks: 8 })]);
  if (stale(seq)) return;
  const steps = [["Account created", "account_created"], ["Email confirmed", "email_verified"], ["Signed in", "signed_in"], ["Profile completed", "profile_completed"], ["First record created", "first_record"], ["First document uploaded", "first_file"]];
  const funnelHtml = f.account_created ? `<div class="funnel">${steps.map(([l, k], i) => { const val = f[k], pv = i ? f[steps[i - 1][1]] : null;
      return `<div class="step"><div><b>${l}</b><div class="muted">${i ? `${pct(val, pv)} of the previous step` : "Start"}${i && pv - val > 0 ? ` · <span class="drop">${n(pv - val)} dropped off</span>` : ""}</div></div><div class="fb"><div style="width:${(val / f.account_created) * 100}%"></div></div><div style="text-align:right"><b>${n(val)}</b> <span class="muted">${pct(val, f.account_created)}</span><div class="muted" style="font-size:11.5px">previous period: ${n(fp[k])}</div></div></div>`; }).join("")}</div>`
    : none("No accounts were created in this period, so there is no funnel to show.", "No sign-ups in this period");
  const kinds = { record: "Record added or changed", file: "File uploaded", dose: "Dose recorded", medicine: "Medicine added or changed", profile: "Profile edited", assistant: "Assistant message", search_performed: "Search", record_exported: "Export" };
  v.innerHTML = `${section("Acquisition", "Who is signing up")}
  <div class="grid kpis">
    ${kpi({ label: "Sign-ups", value: o.users_new, meta: delta(o.users_new, o.users_new_prev) })}
    ${kpi({ label: "Registered accounts", value: o.users_total, meta: delta(o.users_total, o.users_total_prev) })}
    ${f.account_created ? kpi({ label: "Email confirmation rate", display: pct(f.email_verified, f.account_created), meta: `<span class="muted">${n(f.email_verified)} of ${n(f.account_created)} new accounts · previous ${pct(fp.email_verified, fp.account_created)}</span>`, tip: "Of accounts created in the period, the share that confirmed their email." }) : kpi({ label: "Email confirmation rate", state: "insufficient", meta: "No sign-ups in this period." })}
    ${f.account_created ? kpi({ label: "Registration completion", display: pct(f.first_activity, f.account_created), meta: `<span class="muted">reached meaningful activity · previous ${pct(fp.first_activity, fp.account_created)}</span>`, tip: "Of accounts created in the period, the share that did something meaningful." }) : kpi({ label: "Registration completion", state: "insufficient", meta: "No sign-ups in this period." })}
  </div>
  <div class="grid cols-2" style="margin-top:12px">
    ${card("Sign-ups by day", "The dashed line is the previous period", chart(s, [{ key: "users_new", label: "Sign-ups", color: S1, type: "bar" }, ...(sp ? [{ label: "Previous period", color: SG, dash: true, values: alignPrev(sp, "users_new") }] : [])], { ytitle: "Accounts", zeroText: "No sign-ups in this period." }))}
    ${card("Registration growth", "Registered accounts at the end of each day", chart(s, [{ key: "users_total", label: "Registered accounts", color: S1, type: "area" }], { ytitle: "Accounts" }))}
  </div>
  ${section("Activation", "From account to first meaningful use, for accounts created in this period. Signing in alone is not activation.")}
  ${card("Activation funnel", "Account created → email confirmed → signed in → profile completed → first record → first document", funnelHtml, { foot: `Failed sign-up attempts: ${o.events_since ? n(f.signup_failed) : "not measured (the app does not send them)"}` })}
  ${section("Engagement", "Meaningful activity only")}
  <div class="grid kpis">
    ${kpi({ label: "Active people", value: e.active, meta: delta(e.active, ep.active) })}
    ${e.active ? kpi({ label: "Returning rate", display: pct(e.returning, e.active), meta: `<span class="muted">${n(e.returning)} of ${n(e.active)} were active before · previous ${pct(ep.returning, ep.active)}</span>` }) : kpi({ label: "Returning rate", state: "insufficient", meta: "Nobody was active in this period." })}
    ${e.active ? kpi({ label: "Actions per active person", display: (e.actions / e.active).toFixed(1), meta: `<span class="muted">${n(e.actions)} actions · previous ${ep.active ? (ep.actions / ep.active).toFixed(1) : "—"}</span>` }) : kpi({ label: "Actions per active person", state: "insufficient", meta: "Nobody was active in this period." })}
    ${e.active ? kpi({ label: "Active days per person", display: String(e.active_days_avg), meta: `<span class="muted">average days with activity in the period</span>` }) : kpi({ label: "Active days per person", state: "insufficient", meta: "Nobody was active in this period." })}
  </div>
  <div class="grid cols-2" style="margin-top:12px">
    ${card("User activity trends", "DAU, WAU and MAU", chart(s, [{ key: "dau", label: "DAU", color: S1 }, { key: "wau", label: "WAU", color: S2 }, { key: "mau", label: "MAU", color: S3 }], { ytitle: "People", zeroText: "Nobody was active in this period." }))}
    ${card("Meaningful actions by kind", "What people did in the period", hbars(Object.entries(e.by_kind).sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ label: kinds[k] || k, value: c }))), { foot: "Sessions and page views are not instrumented: Doctine does not record visits." })}
  </div>
  ${section("Feature adoption", `Of ${n(ad.accounts)} accounts (all are eligible). App-measured features say “Not measured” until measurements arrive.`)}
  <div class="grid cols-2">
    ${card("Adoption by feature", "People who have ever used each feature", hbars(ad.features.map((x) => ({ label: x.label, value: x.ever, unmeasured: !x.measured })), { total: ad.accounts }))}
    ${card("Historical adoption", "Cumulative people using each database-backed feature, by week", chart(tr, [{ key: "record", label: "Health records", color: S1 }, { key: "file", label: "Document upload", color: S2 }, { key: "profile", label: "Health profile", color: S3 }, { key: "dose", label: "Dose tracking", color: "#7a5af8" }], { xkey: "week", xlabel: "Week of", tipTitle: (r) => "Week of " + dayLabel(r.week), ytitle: "People", zeroText: "No feature has been used yet." }))}
  </div>
  <div class="card" style="margin-top:12px"><div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>Feature</th><th class="num">People, ever</th><th class="num">Share of eligible</th><th class="num">Used in period</th><th>Source</th></tr></thead><tbody>
    ${ad.features.map((x) => `<tr><td>${esc(x.label)}</td>${x.measured ? `<td class="num">${n(x.ever)}</td><td class="num">${pct(x.ever, ad.accounts)}</td><td class="num">${n(x.period)}</td>` : `<td class="num" colspan="3"><span class="st none">Not measured</span></td>`}<td class="muted">${x.source === "event" ? "App measurement (opt-in)" : "Database"}</td></tr>`).join("")}</tbody></table></div></div>
  ${section("Retention", "Weekly sign-up cohorts (IST weeks starting Monday)")}
  ${card("Cohort retention", "Share of each week's new accounts with meaningful activity between day N and day N+7 after sign-up. Cells stay empty until the cohort is old enough.",
    ret.length ? `<div class="tbl-wrap" style="border:1px solid var(--line);border-radius:6px"><table class="heat"><thead><tr><th>Week of</th><th class="num">People</th><th>Day 1</th><th>Day 7</th><th>Day 30</th></tr></thead><tbody>${ret.map((r) => `<tr><td>${esc(dayLabel(r.week))}</td><td class="num">${n(r.size)}</td>${["d1", "d7", "d30"].map((k) => { const el = r[k + "_eligible"], c = r[k]; if (!el) return `<td class="muted">not old enough</td>`; return `<td style="background:rgba(42,98,184,${(0.06 + (c / el) * 0.5).toFixed(2)})"><b>${pct(c, el)}</b><div class="muted" style="font-size:11px">${n(c)} of ${n(el)}</div></td>`; }).join("")}</tr>`).join("")}</tbody></table></div>`
      : stateBox("insufficient", "No sign-ups in the last 8 weeks."))}`;
};

/* Reports */
VIEWS.reports = async (v, seq) => {
  const p = periodRange();
  const [st, hist] = await Promise.all([api("settings_status"), api("exports").catch(() => [])]);
  if (stale(seq)) return;
  const need = { growth: "analytics.view", engagement: "analytics.view", funnel: "analytics.view", adoption: "analytics.view", documents: "documents.view", storage: "dashboard.view", availability: "health.view", errors: "health.view", admin_activity: "audit.view", users: "users.view" };
  const list = st.reports.filter((r) => can(need[r.key] || "reports.export"));
  v.innerHTML = `<p class="lead">Reports cover <b>${esc(p.label.toLowerCase())}</b> (change it above) and compare with the previous period of the same length. They are built on the server, contain no health information, and every download is recorded in the audit log.</p>
  <div class="grid cols-3">${list.map((r) => `<section class="card" style="display:flex;flex-direction:column"><div class="card-h"><div><h3>${esc(r.title)}</h3><p>${esc(r.description)}</p></div></div>
    <div class="card-b" style="margin-top:auto"><div class="row"><button class="btn sm" data-r="${r.key}" data-f="csv">${ic("download")} CSV</button><button class="btn sm primary" data-r="${r.key}" data-f="pdf">${ic("download")} PDF</button></div></div></section>`).join("")}</div>
  ${section("Export history", "The latest 50 exports by anyone on the team")}
  <div class="card">${hist.length ? `<div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>When</th><th>Report</th><th>Format</th><th>Period</th><th>By</th><th>Outcome</th></tr></thead><tbody>${hist.map((h) => `<tr><td>${dt(h.at)}</td><td>${esc((st.reports.find((r) => r.key === h.report) || {}).title || h.report)}</td><td class="mono">${esc(h.format)}</td><td class="muted">${h.from ? dt(h.from, false) + " – " + dt(h.to, false) : "—"}</td><td>${esc(h.by || "")}</td><td>${h.outcome === "ok" ? `<span class="st good">Delivered</span>` : `<span class="st bad">Failed</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<div class="card-b">${none("No reports have been exported yet.", "No exports yet")}</div>`}</div>`;
  $$("[data-r]", v).forEach((b) => b.onclick = async () => {
    b.disabled = true; const t = b.innerHTML; b.textContent = "Preparing…";
    try { await download("report", { report: b.dataset.r, format: b.dataset.f, ...p }, `doctine-${b.dataset.r}.${b.dataset.f}`); toast("Downloaded. The export was recorded."); if (A.route === "reports") VIEWS.reports(v, A.seq); }
    catch (e) { toast(ERR[e.code] || "The report could not be made.", true); } finally { b.disabled = false; b.innerHTML = t; }
  });
};

/* Users */
const COLS = [["id", "Account ID"], ["email", "Email"], ["created_at", "Registered"], ["verified", "Email verification"], ["last_sign_in_at", "Last sign-in"], ["last_activity", "Last meaningful activity"], ["records", "Records"], ["files", "Files"], ["status", "Status"], ["role", "Role"]];
const UQ = { q: "", status: "", sort: "created_desc", page: 1, size: ls.get("usize", 25), reg_from: "", reg_to: "", cols: ls.get("ucols", ["id", "email", "created_at", "verified", "last_sign_in_at", "last_activity", "records", "files", "status"]) };
VIEWS.users = async (v, seq) => {
  const args = { q: UQ.q, status: UQ.status, sort: UQ.sort, page: UQ.page, size: UQ.size, reg_from: UQ.reg_from ? new Date(UQ.reg_from + "T00:00:00+05:30").toISOString() : null, reg_to: UQ.reg_to ? new Date(Date.parse(UQ.reg_to + "T00:00:00+05:30") + DAY).toISOString() : null };
  const d = await api("users", args);
  if (stale(seq)) return;
  const pages = Math.max(1, Math.ceil(d.total / d.size)), on = (c) => UQ.cols.includes(c);
  const sortBtn = (label, asc, desc) => `<button data-sort="${UQ.sort === desc ? asc : desc}" aria-label="Sort by ${label}">${label}${UQ.sort === desc ? " ▼" : UQ.sort === asc ? " ▲" : ""}</button>`;
  const cell = { id: (u) => `<td class="mono" title="${esc(u.id)}">${esc(u.id.slice(0, 8))}</td>`, email: (u) => `<td>${esc(u.email || "(no email)")}</td>`, created_at: (u) => `<td>${dt(u.created_at, false)}</td>`,
    verified: (u) => `<td>${u.email_confirmed_at ? `<span class="st good">Verified</span>` : `<span class="st warn">Not verified</span>`}</td>`, last_sign_in_at: (u) => `<td>${u.last_sign_in_at ? ago(u.last_sign_in_at) : `<span class="muted">Never</span>`}</td>`,
    last_activity: (u) => `<td>${u.last_activity ? ago(u.last_activity) : `<span class="muted">None yet</span>`}</td>`, records: (u) => `<td class="num">${n(u.records)}</td>`, files: (u) => `<td class="num">${n(u.files)}</td>`,
    status: (u) => `<td>${u.suspended ? `<span class="st bad">Suspended</span>` : `<span class="st good">Active</span>`}</td>`, role: (u) => `<td>${u.admin_role ? `<span class="tag role">${esc(u.admin_role)}</span>` : `<span class="muted">Member</span>`}</td>` };
  const head = { id: "<th>Account ID</th>", email: `<th>${sortBtn("Email", "email", "email")}</th>`, created_at: `<th>${sortBtn("Registered", "created_asc", "created_desc")}</th>`, verified: "<th>Email verification</th>", last_sign_in_at: "<th>Last sign-in</th>",
    last_activity: `<th>${sortBtn("Last activity", "activity_asc", "activity_desc")}</th>`, records: `<th class="num">${sortBtn("Records", "records_desc", "records_desc")}</th>`, files: '<th class="num">Files</th>', status: "<th>Status</th>", role: "<th>Role</th>" };
  const filtered = UQ.q || UQ.status || UQ.reg_from || UQ.reg_to;
  v.innerHTML = `<div class="card">
    <form class="toolbar" id="uf" role="search">
      <label class="sr" for="uq">Search by email or account ID</label><input id="uq" type="search" placeholder="Search email or account ID" value="${esc(UQ.q)}" style="min-width:min(240px,100%)">
      <label class="sr" for="us">Status</label><select id="us">${[["", "All accounts"], ["active", "Active"], ["suspended", "Suspended"], ["verified", "Email verified"], ["unverified", "Email not verified"], ["admins", "Admin team"]].map(([k, t]) => `<option value="${k}" ${UQ.status === k ? "selected" : ""}>${t}</option>`).join("")}</select>
      <span class="muted" style="font-size:12px">Registered</span><label class="sr" for="urf">Registered from</label><input type="date" id="urf" value="${esc(UQ.reg_from)}"><label class="sr" for="urt">Registered to</label><input type="date" id="urt" value="${esc(UQ.reg_to)}">
      <button class="btn primary sm">Apply</button>${filtered ? `<button class="btn ghost sm" type="button" id="uclear">Clear</button>` : ""}
      <span class="spacer"></span>
      <div style="position:relative"><button class="btn sm" type="button" id="ucols" aria-expanded="false">${ic("columns")} Columns</button></div>
      ${can("reports.export") ? `<button class="btn sm" type="button" id="ucsv">${ic("download")} CSV</button>` : ""}
    </form>
    <div class="tbl-wrap"><table><thead><tr>${COLS.filter(([k]) => on(k)).map(([k]) => head[k]).join("")}</tr></thead><tbody>
      ${d.rows.length ? d.rows.map((u) => `<tr class="click" data-id="${esc(u.id)}" tabindex="0">${COLS.filter(([k]) => on(k)).map(([k]) => cell[k](u)).join("")}</tr>`).join("") : `<tr><td colspan="${UQ.cols.length}">${none(filtered ? "No accounts match these filters." : "There are no accounts yet.", "No matches")}</td></tr>`}
    </tbody></table></div>
    <div class="pager"><span>${n(d.total)} account${d.total === 1 ? "" : "s"}</span><span class="spacer"></span><label for="usz">Rows per page</label><select id="usz">${[10, 25, 50, 100].map((k) => `<option ${UQ.size == k ? "selected" : ""}>${k}</option>`).join("")}</select>
      <button class="btn sm" id="pp" ${UQ.page <= 1 ? "disabled" : ""}>Previous</button><span>Page ${UQ.page} of ${pages}</span><button class="btn sm" id="pn" ${UQ.page >= pages ? "disabled" : ""}>Next</button></div>
  </div>
  <p class="hint" style="margin-top:10px">Account management only. Health records, files and messages are never shown in the console.</p>`;
  const again = () => VIEWS.users(v, A.seq);
  $("#uf").onsubmit = (e) => { e.preventDefault(); Object.assign(UQ, { q: $("#uq").value.trim(), status: $("#us").value, reg_from: $("#urf").value, reg_to: $("#urt").value, page: 1 }); again(); };
  const cl = $("#uclear"); if (cl) cl.onclick = () => { Object.assign(UQ, { q: "", status: "", reg_from: "", reg_to: "", page: 1 }); again(); };
  $$("[data-sort]", v).forEach((b) => b.onclick = () => { UQ.sort = b.dataset.sort; UQ.page = 1; again(); });
  $("#usz").onchange = (e) => { UQ.size = +e.target.value; ls.set("usize", UQ.size); UQ.page = 1; again(); };
  $("#pp").onclick = () => { UQ.page--; again(); }; $("#pn").onclick = () => { UQ.page++; again(); };
  $$("tr.click", v).forEach((tr) => { tr.onclick = () => openUser(tr.dataset.id); tr.onkeydown = (e) => { if (e.key === "Enter") openUser(tr.dataset.id); }; });
  $("#ucols").onclick = (e) => popover(e.currentTarget, `<h4>Show columns</h4>${COLS.map(([k, t]) => `<label style="display:flex;gap:8px;padding:6px 8px;cursor:pointer"><input type="checkbox" data-col="${k}" ${on(k) ? "checked" : ""}> ${t}</label>`).join("")}`, (pop) => {
    $$("[data-col]", pop).forEach((c) => c.onchange = () => { UQ.cols = $$("[data-col]", pop).filter((x) => x.checked).map((x) => x.dataset.col); if (!UQ.cols.length) UQ.cols = ["email"]; ls.set("ucols", UQ.cols); closePop(); again(); });
  });
  const csvB = $("#ucsv"); if (csvB) csvB.onclick = async () => {
    const r = args.reg_from && args.reg_to ? { from: args.reg_from, to: args.reg_to } : { from: new Date(Date.now() - 399 * DAY).toISOString(), to: new Date().toISOString() };
    try { await download("report", { report: "users", format: "csv", ...r }, "doctine-users.csv"); toast(`Account list downloaded (${args.reg_from ? "registration dates as filtered" : "registered in the last 400 days"}). The export was recorded.`); } catch (e) { toast(ERR[e.code] || "Export failed.", true); }
  };
};
function closeDrawer() { $$(".drawer,.scrim").forEach((e) => e.remove()); }
function drawer(title, sub = "") {
  closeDrawer();
  const sc = document.createElement("div"); sc.className = "scrim"; sc.onclick = closeDrawer;
  const dr = document.createElement("aside"); dr.className = "drawer"; dr.setAttribute("role", "dialog"); dr.setAttribute("aria-modal", "true"); dr.setAttribute("aria-label", title);
  dr.innerHTML = `<div class="drawer-h"><div style="flex:1;min-width:0"><h3>${esc(title)}</h3>${sub ? `<div class="muted">${sub}</div>` : ""}</div><button class="iconbtn" id="dx" aria-label="Close">${ic("x")}</button></div><div class="drawer-b">${skel(160)}</div>`;
  document.body.append(sc, dr);
  dr.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  $("#dx", dr).onclick = closeDrawer; $("#dx", dr).focus();
  return { el: dr, body: $(".drawer-b", dr), head: $(".drawer-h h3", dr) };
}
async function openUser(id) {
  const D = drawer("Account");
  let u; try { u = await api("user", { id }); } catch (e) { D.body.innerHTML = `<div class="callout bad">${errText(e)}</div>`; return; }
  if (!u) { D.body.innerHTML = stateBox("unavailable", "Account not found."); return; }
  D.head.textContent = u.email || "(no email)";
  const g = u.usage, ad = u.adoption || {};
  const chip = (ok, label) => `<span class="chip ${ok ? "yes" : "no"}">${ok ? "✓" : "–"} ${label}</span>`;
  D.body.innerHTML = `<div class="row" style="margin-bottom:12px">${u.suspended ? `<span class="st bad">Suspended</span>` : `<span class="st good">Active</span>`}${u.admin_role ? `<span class="tag role">${esc(u.admin_role)}</span>` : ""}<span class="mono muted">${esc(u.id)}</span></div>
    <h4>Account</h4><dl class="dl"><dt>Registered</dt><dd>${dt(u.created_at)}</dd><dt>Email confirmed</dt><dd>${u.email_confirmed_at ? dt(u.email_confirmed_at) : "Not yet"}</dd><dt>First meaningful activity</dt><dd>${dt(u.first_activity)}</dd><dt>Last sign-in</dt><dd>${dt(u.last_sign_in_at)}</dd><dt>Last meaningful activity</dt><dd>${dt(g.last_activity)}</dd><dt>Sign-in methods</dt><dd>${(u.sign_in_methods || []).map((m) => `<span class="tag">${esc(m)}</span>`).join(" ") || "—"}</dd><dt>Two-step sign-in</dt><dd>${u.mfa ? "On" : "Off"}</dd></dl>
    <h4>Usage summary (counts only)</h4><dl class="dl"><dt>Records</dt><dd>${n(g.records)} ${Object.keys(g.records_by_source || {}).length ? `<span class="muted">(${Object.entries(g.records_by_source).map(([k, c]) => esc(k) + " " + n(c)).join(", ")})</span>` : ""}</dd><dt>Files stored</dt><dd>${n(g.files)} · ${bytes(g.file_bytes)}</dd><dt>Medicines</dt><dd>${n(g.medicines)}</dd><dt>Doses recorded</dt><dd>${n(g.doses_recorded)}</dd><dt>Active days (30 days)</dt><dd>${n(g.active_days_30)}</dd><dt>Failed uploads (30 days)</dt><dd>${n(u.uploads.failed_30d)}</dd></dl>
    <h4>Feature adoption</h4><div class="chips">${chip(ad.profile, "Profile")}${chip(ad.record, "Records")}${chip(ad.file, "Documents")}${chip(ad.schedule, "Medicine schedules")}${chip(ad.dose, "Dose tracking")}${chip(ad.search, "Search")}${chip(ad.export, "Export")}</div><p class="hint">Search and export show only if the person switched on measurements.</p>
    <h4>Actions</h4><div class="row">
      ${can("users.reset_password") ? `<button class="btn sm" data-act="reset">Send password reset</button>` : ""}
      ${can("users.suspend") ? `<button class="btn sm" data-act="revoke">Sign out everywhere</button>${u.suspended ? `<button class="btn sm" data-act="restore">Restore account</button>` : `<button class="btn sm danger" data-act="suspend">Suspend account</button>`}` : ""}
      ${!can("users.reset_password") && !can("users.suspend") ? `<span class="muted">Your role can view this account but not act on it.</span>` : ""}</div>
    ${u.notes ? `<h4>Support notes</h4><form id="nf"><label class="sr" for="nt">New note</label><textarea id="nt" maxlength="1000" placeholder="A note for the team. Never write health details here."></textarea><div class="row" style="margin-top:6px"><button class="btn sm">Add note</button></div></form>
      ${u.notes.length ? u.notes.map((x) => `<div class="card" style="margin-top:8px;padding:10px 12px;box-shadow:none"><div class="muted">${dt(x.at)} · ${esc(x.author || "")}</div><div>${esc(x.body)}</div></div>`).join("") : `<p class="hint">No notes yet.</p>`}` : ""}
    <h4>Security-related account events</h4>${u.admin_actions.length ? `<ul class="timeline">${u.admin_actions.map((x) => `<li><b class="mono">${esc(x.action)}</b> · ${esc(x.outcome)}<div class="muted">${dt(x.at)} · by ${esc(x.by || "unknown")}${x.reason ? " · “" + esc(x.reason) + "”" : ""}</div></li>`).join("")}</ul>` : `<p class="hint">No administrative actions on this account.</p>`}
    <p class="hint" style="margin-top:16px">Health records, files, values and messages are never shown here. Helping someone with their own records needs a separate, consent-based support process.</p>`;
  const acts = {
    reset: { t: "Send a password reset email?", d: `Supabase will email ${esc(u.email)} a link to choose a new password. You never see or set the password.`, a: "user_reset_password", ok: "Reset email sent.", reason: false },
    revoke: { t: "Sign this person out everywhere?", d: "Every session on every device ends. They can sign in again.", a: "user_revoke_sessions", ok: "Sessions ended.", reason: true },
    suspend: { t: "Suspend this account?", d: "They are signed out everywhere and cannot sign in until restored. Their records are kept. A current sign-in token can keep working for up to an hour for their own data, but cannot be renewed.", a: "user_suspend", ok: "Account suspended.", reason: true, danger: true },
    restore: { t: "Restore this account?", d: "They will be able to sign in again.", a: "user_restore", ok: "Account restored.", reason: true },
  };
  $$("[data-act]", D.body).forEach((b) => b.onclick = async () => {
    const c = acts[b.dataset.act]; const r = await confirmBox(c.t, c.d, { reason: c.reason, danger: c.danger, button: b.textContent });
    if (r === null) return;
    try {
      const out = await api(c.a, { id: u.id, reason: r });
      if (out && out.ok === false) toast(out.error === "admin_target_needs_owner" ? "Only the owner can act on another admin." : out.error === "not_on_yourself" ? "You cannot do this to your own account." : out.error === "email_rate_limited" ? "The email provider is limiting emails right now. Try again later." : "That did not complete (" + out.error + ").", true);
      else toast(c.ok);
      openUser(u.id);
    } catch (e) { toast(ERR[e.code] || "That did not work. Please try again.", true); }
  });
  const nfm = $("#nf", D.body);
  if (nfm) nfm.onsubmit = async (e) => { e.preventDefault(); const t = $("#nt", D.body).value.trim(); if (!t) return; try { await api("user_note", { id: u.id, note: t }); toast("Note added."); openUser(u.id); } catch { toast("The note was not saved.", true); } };
}
function confirmBox(title, desc, { reason = false, danger = false, button = "Confirm", extra = "" } = {}) {
  return new Promise((res) => {
    const d = document.createElement("dialog");
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p style="color:var(--ink-2);margin:0 0 6px">${desc}</p>${extra}
      ${reason ? `<label class="f" for="cr">Reason (recorded in the audit log)</label><textarea id="cr" maxlength="500" placeholder="Why, in a few words. No health details."></textarea>` : ""}
      <p class="err" id="cerr" role="alert"></p>
      <p class="hint">Acting as ${esc(A.me.email)} (${esc(A.me.role)}).</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" value="cancel" type="button" id="cc">Cancel</button><button class="btn ${danger ? "danger solid" : "primary"}" value="ok" id="co">${esc(button)}</button></div></form>`;
    document.body.appendChild(d); d.showModal();
    const done = (val) => { d.close(); d.remove(); res(val); };
    $("#cc", d).onclick = () => done(null);
    d.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    $("form", d).onsubmit = (e) => { e.preventDefault(); const r = reason ? $("#cr", d).value.trim() : ""; if (reason && !r) { $("#cerr", d).textContent = "Please give a reason."; return; } done(reason ? r : ""); };
  });
}

/* Documents */
let DPAGE = 1;
VIEWS.documents = async (v, seq) => {
  const p = periodRange();
  const [d, s] = await Promise.all([api("documents", { ...p, page: DPAGE, size: 25 }), can("analytics.view") ? api("series", p).catch(() => null) : null]);
  if (stale(seq)) return;
  const x = d.summary, ev = !!x.events_since, used = x.storage_limit ? (x.storage_bytes / x.storage_limit) * 100 : 0;
  const pages = Math.max(1, Math.ceil(d.total / 25));
  const kv = (o, unit) => { const e = Object.entries(o || {}); return e.length ? hbars(e.sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ label: k, value: c }))) : none(`No ${unit} in this period.`); };
  const rate = (ok, bad) => (ok + bad ? pct(ok, ok + bad) : null);
  const nm = (label) => kpi({ label, state: "not_measured", meta: "Opt-in app measurement; none received yet." });
  v.innerHTML = `<div class="callout" style="margin-bottom:14px">${ic("info")}<span>Technical metadata only. Titles, providers, values, extracted text and files are never shown. Accounts appear as pseudonymous codes.</span></div>
  <div class="grid kpis">
    ${kpi({ label: "Records created", value: x.records, meta: `<span class="muted">${n(x.records_total)} in total</span>` })}
    ${kpi({ label: "Files stored", value: x.files, meta: `<span class="muted">${n(x.files_total)} in total · ${bytes(x.bytes)} this period</span>` })}
    ${kpi({ label: "Storage used", display: bytes(x.storage_bytes), meta: `<span class="muted">${used.toFixed(used < 1 ? 2 : 1)}% of ${bytes(x.storage_limit)}</span>` })}
    ${kpi({ label: "Storage remaining", display: bytes(Math.max(0, x.storage_limit - x.storage_bytes)), meta: `<span class="muted">Supabase Free plan limit</span>` })}
    ${ev ? kpi({ label: "Successful uploads", value: x.upload_completed, meta: rate(x.upload_completed, x.upload_failed) ? `<span class="muted">${rate(x.upload_completed, x.upload_failed)} success rate</span>` : "" }) : nm("Successful uploads")}
    ${ev ? kpi({ label: "Failed uploads", value: x.upload_failed }) : nm("Failed uploads")}
    ${ev ? kpi({ label: "Successful PDF readings", value: x.pdf_completed, meta: x.processing_ms_avg ? `<span class="muted">average ${n(x.processing_ms_avg)} ms</span>` : "" }) : nm("Successful PDF readings")}
    ${ev ? kpi({ label: "Failed readings", value: x.processing_failed, meta: rate(x.processing_completed, x.processing_failed) ? `<span class="muted">${rate(x.processing_completed, x.processing_failed)} success rate</span>` : "" }) : nm("Failed readings")}
  </div>
  ${card("Storage capacity", `${bytes(x.storage_bytes)} of ${bytes(x.storage_limit)} used`, `<div class="meter ${used >= 95 ? "bad" : used >= 80 ? "warn" : ""}" role="meter" aria-valuenow="${used.toFixed(2)}" aria-valuemin="0" aria-valuemax="100" aria-label="Storage used"><div style="width:${Math.max(used, 0.4)}%"></div></div><p class="hint">Alerts open at 80% (warning) and 95% (critical).${used >= 80 ? " <b>Storage is getting full.</b>" : ""}</p>`, { style: "margin-top:12px" })}
  <div class="grid cols-2" style="margin-top:12px">
    ${s ? card("Uploads over time", "Files stored per day", chart(s, [{ key: "files", label: "Files stored", color: S1, type: "bar" }], { ytitle: "Files", zeroText: "No files were stored in this period." })) : ""}
    ${s ? card("Storage growth", "Total stored file size at the end of each day", chart(s, [{ key: "storage_total", label: "Stored", color: S1, type: "area" }], { yFmt: bytes, tipFmt: bytes, ytitle: "Size", zeroText: "No files are stored yet." })) : ""}
    ${card("File types", "Stored file formats in this period", kv(x.by_type, "files"))}
    ${card("Record categories", "The category chosen for each record in this period", kv(x.by_category, "records"))}
    ${card("Upload success and failure", "With failure codes", ev ? hbars([{ label: "Completed", value: x.upload_completed, color: S3 }, { label: "Failed", value: x.upload_failed, color: RED }, ...Object.entries(x.failure_reasons).map(([k, c]) => ({ label: "↳ " + k, value: c, color: S2 }))]) : stateBox("not_measured", "Upload outcomes come from in-app measurements, which start when people switch on Help improve Doctine."))}
    ${card("PDF reading success and failure", "With failure codes", ev ? hbars([{ label: "PDF read", value: x.pdf_completed, color: S3 }, { label: "Any reading failed", value: x.processing_failed, color: RED }, ...Object.entries(x.processing_reasons).map(([k, c]) => ({ label: "↳ " + k, value: c, color: S2 }))]) : stateBox("not_measured", "Reading outcomes come from in-app measurements, which start when people switch on Help improve Doctine."))}
  </div>
  ${section("Document operations", "Stored files and reported upload and reading events in the period, newest first")}
  <div class="card">${d.rows.length ? `<div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>When</th><th>Account</th><th>File type</th><th class="num">Size</th><th>Upload</th><th>Processing</th><th>Error code</th><th class="num">Duration</th></tr></thead><tbody>${d.rows.map((r) => `<tr><td>${dt(r.at)}</td><td class="mono">${esc(r.account)}</td><td>${esc(r.file_type || "—")}</td><td class="num">${r.bytes != null ? bytes(r.bytes) : "—"}</td><td>${r.upload_status ? `<span class="st ${r.upload_status === "failed" ? "bad" : "good"}">${esc(r.upload_status)}</span>` : "—"}</td><td>${r.processing_status ? `<span class="st ${r.processing_status === "failed" ? "bad" : "good"}">${esc(r.processing_status)}</span>` : `<span class="muted">—</span>`}</td><td class="mono">${esc(r.error_code || "—")}</td><td class="num">${r.ms != null ? n(r.ms) + " ms" : "—"}</td></tr>`).join("")}</tbody></table></div>
    <div class="pager"><span>${n(d.total)} rows</span><span class="spacer"></span><button class="btn sm" id="dp" ${DPAGE <= 1 ? "disabled" : ""}>Previous</button><span>Page ${DPAGE} of ${pages}</span><button class="btn sm" id="dn" ${DPAGE >= pages ? "disabled" : ""}>Next</button></div>` : `<div class="card-b">${none("No files were stored and no upload events were reported in this period.", "Nothing in this period")}</div>`}</div>`;
  const a = $("#dp"), b = $("#dn"); if (a) a.onclick = () => { DPAGE--; VIEWS.documents(v, A.seq); }; if (b) b.onclick = () => { DPAGE++; VIEWS.documents(v, A.seq); };
};

/* Platform health */
const AI_STATE = { not_configured: ["Not configured", "none", "No AI provider key is set on the server."], disabled_responding: ["Disabled by switch", "none", "Configured and responding, but the AI switch is off."], disabled_failing: ["Disabled · check failing", "warn", "The AI switch is off, and the provider check is failing."], responding: ["Operational", "good", "Configured, switched on and responding."], failing: ["Configured but failing", "bad", "Configured and switched on, but the provider check failed."] };
function serviceState(c, t) {
  if (!c) return ["Unknown", "none"];
  if (c.ok && c.ms > 3000) return ["Degraded", "warn"];
  if (!c.ok) return ["Down", "bad"];
  if (t && t.checks_24h && t.ok_24h < t.checks_24h) return ["Degraded", "warn"];
  return ["Operational", "good"];
}
VIEWS.health = async (v, seq) => {
  v.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="lead" style="margin:0">Each check runs from the server when you open this page or press Re-check, and is added to the history. Nothing is shown as operational unless it was just checked.</p><span class="spacer"></span><button class="btn" id="rc">${ic("refresh")} Re-check now</button></div><div id="hc">${skel(160)}</div><div id="uh"></div>`;
  $("#rc").onclick = () => VIEWS.health(v, A.seq);
  const [h, u] = await Promise.all([api("health"), api("uptime", { days: 7 })]);
  if (stale(seq)) return;
  const T = Object.fromEntries(u.targets.map((t) => [t.target, t]));
  const dl = (rows) => `<dl class="dl" style="grid-template-columns:1fr auto;gap:5px 8px">${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>`;
  const svc = ["app", "database", "auth", "storage"].map((k) => { const c = h.checks.find((x) => x.target === k), t = T[k] || {}; const [label, cls] = serviceState(c, t);
    return `<section class="card" data-service="${k}"><div class="card-h"><div style="flex:1"><h3>${esc(SERVICE[k])}</h3><p>Checked ${c ? ago(c.checked_at) : "—"}</p></div><span class="st ${cls}">${label}</span></div>
      <div class="card-b">${dl([["Response time", c ? n(c.ms) + " ms" : "—"], ["Last successful check", t.last_ok ? ago(t.last_ok) : "—"], ["Failures (7 days)", n(t.failures)], ["Uptime (7 days)", t.checks ? pct(t.ok, t.checks, 2) : "No checks"], ["Latest error", t.last_failure ? `<span class="mono">${esc(((t.last_failure.status || "") + " " + (t.last_failure.error || "")).trim() || "failed")}</span>` : "—"]])}</div></section>`; });
  const ai = AI_STATE[h.ai_state] || AI_STATE.not_configured, aiC = h.checks.find((x) => x.target === "ai"), aiT = T.ai || {};
  svc.push(`<section class="card" data-service="ai"><div class="card-h"><div style="flex:1"><h3>${esc(SERVICE.ai)}</h3><p>${esc(ai[2])}</p></div><span class="st ${ai[1]}">${esc(ai[0])}</span></div><div class="card-b">${dl([["Response time", aiC ? n(aiC.ms) + " ms" : "—"], ["Failures (7 days)", aiT.checks ? n(aiT.failures) : "—"], ["Latest error", aiC && !aiC.ok ? `<span class="mono">${esc(aiC.error || aiC.status || "failed")}</span>` : "—"]])}<p class="hint">The check lists models only. It never sends health data or an AI request, and the key is never shown.</p></div></section>`);
  const last = u.last_round, behind = last && Date.now() - Date.parse(last) > 45 * 60000;
  svc.push(`<section class="card" data-service="monitoring"><div class="card-h"><div style="flex:1"><h3>${esc(SERVICE.monitoring)}</h3><p>The 15-minute health round (/api/monitor)</p></div>${!last ? `<span class="st none">Unknown</span>` : behind ? `<span class="st warn">Behind schedule</span>` : `<span class="st good">Running</span>`}</div><div class="card-b">${dl([["Last round", last ? ago(last) : "Never"], ["Rounds in 24 hours", `${n(u.rounds_24h)} <span class="muted">of 96 expected</span>`], ["Error tracking", "On"], ["Alert email", h.config.email_provider ? `<span class="st good">Configured</span>` : `<span class="st none">Not configured</span>`]])}</div></section>`);
  $("#hc").innerHTML = `<div class="grid cols-3">${svc.join("")}</div>`;
  const strip = (t) => (t.buckets.length ? `<div class="strip" role="img" aria-label="${esc(SERVICE[t.target])} check results">${t.buckets.map((b) => { const r = b.checks ? b.ok / b.checks : null; return `<i title="${esc(dt(b.at))}: ${b.ok} of ${b.checks} passed${b.ms ? ", " + n(b.ms) + " ms" : ""}" style="background:${r == null ? "#e4e7ec" : r === 1 ? "#16927a" : r >= 0.5 ? "#dc8a12" : "#b42318"}"></i>`; }).join("")}</div>` : `<span class="muted">No checks yet</span>`);
  const msRows = (() => { const all = new Map(); for (const t of u.targets) for (const b of t.buckets) { if (!all.has(b.at)) all.set(b.at, { day: b.at }); all.get(b.at)[t.target] = b.ms; } return [...all.values()].sort((a, b) => a.day.localeCompare(b.day)); })();
  const errRows = (() => { const m = new Map(); for (const t of u.targets) for (const b of t.buckets) { if (!m.has(b.at)) m.set(b.at, { day: b.at, failed: 0 }); m.get(b.at).failed += b.checks - b.ok; } return [...m.values()].sort((a, b) => a.day.localeCompare(b.day)); })();
  $("#uh").innerHTML = `${section("Uptime history", `Last ${u.days} days · each block is ${u.bucket_hours} hour${u.bucket_hours === 1 ? "" : "s"} · ${u.since ? "recorded since " + dt(u.since) : "nothing recorded yet"}`)}
    <div class="card"><div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>Service</th><th style="width:52%">History</th><th class="num">Uptime</th><th class="num">Typical</th><th class="num">Slowest 5%</th></tr></thead><tbody>${u.targets.map((t) => `<tr><td>${esc(SERVICE[t.target])}</td><td>${strip(t)}</td><td class="num">${t.checks ? pct(t.ok, t.checks, 2) : "—"}</td><td class="num">${t.checks && t.ms_p50 ? n(Math.round(t.ms_p50)) + " ms" : "—"}</td><td class="num">${t.checks && t.ms_p95 ? n(Math.round(t.ms_p95)) + " ms" : "—"}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="grid cols-2" style="margin-top:12px">
      ${card("Response time", "Average of passing checks per block", msRows.length > 1 ? chart(msRows, [{ key: "app", label: "App", color: S1 }, { key: "database", label: "Database", color: S2 }, { key: "auth", label: "Auth", color: S3 }, { key: "storage", label: "Storage", color: "#7a5af8" }], { xFmt: hourLabel, tipTitle: (r) => dt(r.day), ytitle: "ms", tipFmt: (x) => (x == null ? "—" : n(x) + " ms"), allowZero: true, xlabel: "Time" }) : stateBox("insufficient", "Needs at least two rounds of checks."))}
      ${card("Failed service checks", "Failed checks across all services per block", errRows.length > 1 ? chart(errRows, [{ key: "failed", label: "Failed checks", color: RED, type: "bar" }], { xFmt: hourLabel, tipTitle: (r) => dt(r.day), ytitle: "Checks", zeroText: "No check failed in the last 7 days.", xlabel: "Time" }) : stateBox("insufficient", "Needs at least two rounds of checks."))}
    </div>
    ${card("Recent health checks", "The latest rounds, newest first", u.recent.length ? `<div class="tbl-wrap" style="max-height:320px;border:1px solid var(--line);border-radius:6px"><table><thead><tr><th>When</th><th>Service</th><th>Result</th><th class="num">Response</th></tr></thead><tbody>${u.recent.map((c) => `<tr><td>${dt(c.at)}</td><td>${esc(SERVICE[c.target] || c.target)}</td><td>${c.ok ? `<span class="st good">Passed</span>` : `<span class="st bad">Failed ${esc(c.status || "")} ${esc(c.error || "")}</span>`}</td><td class="num">${n(c.ms)} ms</td></tr>`).join("")}</tbody></table></div>` : stateBox("insufficient", "No checks recorded yet."), { style: "margin-top:12px" })}
    <p class="hint" style="margin-top:10px">Not measured here: database load, Supabase quota use and Cloudflare traffic (see those dashboards). The 15-minute schedule depends on GitHub Actions, which can delay or skip runs; the monitoring card shows whether rounds are arriving.</p>`;
};

/* Errors */
const EF = { status: "open", cat: "", period: "7d" };
VIEWS.errors = async (v, seq) => {
  const e = await api("errors", { status: EF.status });
  if (stale(seq)) return;
  const cutoff = { "24h": 1, "7d": 7, "30d": 30, all: 3650 }[EF.period] * DAY;
  const groups = e.groups.filter((g) => (!EF.cat || g.category === EF.cat) && Date.now() - Date.parse(g.last_seen) <= cutoff);
  v.innerHTML = `<div class="grid kpis">${kpi({ label: "Errors, last 24 hours", value: e.last_24h, meta: e.since ? `<span class="muted">tracking since ${dt(e.since, false)}</span>` : `<span class="muted">Tracking is on; none reported yet</span>` })}${kpi({ label: "Errors, last 7 days", value: e.last_7d })}${kpi({ label: "Errors, last 30 days", value: e.last_30d })}${kpi({ label: "Open error groups", value: e.open, meta: `<span class="muted">repeats of one error form one group</span>` })}</div>
  <div class="grid cols-2" style="margin-top:12px">
    ${card("Error frequency", "Occurrences per day, last 30 days", chart(e.daily, [{ key: "n", label: "Errors", color: RED, type: "bar" }], { ytitle: "Errors", zeroText: "No errors in the last 30 days." }))}
    ${card("Error categories", "All occurrences by category", hbars(Object.entries(e.by_category).sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ label: k, value: c, color: S2 }))))}
  </div>
  <div class="card" style="margin-top:12px">
    <div class="toolbar"><div class="seg" role="group" aria-label="Status">${[["open", "Open"], ["resolved", "Resolved"], ["ignored", "Ignored"], ["", "All"]].map(([k, t]) => `<button data-es="${k}" aria-pressed="${EF.status === k}">${t}</button>`).join("")}</div>
      <label class="sr" for="ecat">Category</label><select id="ecat"><option value="">All categories</option>${Object.keys(e.by_category).map((c) => `<option ${EF.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <label class="sr" for="eper">Time period</label><select id="eper">${[["24h", "Seen in 24 hours"], ["7d", "Seen in 7 days"], ["30d", "Seen in 30 days"], ["all", "Any time"]].map(([k, t]) => `<option value="${k}" ${EF.period === k ? "selected" : ""}>${t}</option>`).join("")}</select>
      <span class="spacer"></span><span class="muted" style="font-size:12px">Stored without numbers, quoted text or email addresses.</span></div>
    ${groups.length ? `<div class="tbl-wrap"><table><thead><tr><th>Error</th><th>Category</th><th class="num">24 h</th><th class="num">Total</th><th>First seen</th><th>Last seen</th><th>Status</th></tr></thead><tbody>${groups.map((g) => `<tr class="click" data-fp="${esc(g.fingerprint)}" tabindex="0"><td><b>${esc(g.kind)}</b> <span class="trunc" style="display:inline-block;vertical-align:bottom">${esc(g.message)}</span><div class="muted">${esc(g.source === "server" ? "Server" : "App")} · <span class="mono">${esc(g.location || "—")}</span></div></td><td><span class="tag">${esc(g.category || "other")}</span></td><td class="num">${n(g.last_24h)}</td><td class="num">${n(g.count)}</td><td>${dt(g.first_seen)}</td><td>${ago(g.last_seen)}</td><td><span class="st ${g.status === "open" ? "bad" : g.status === "resolved" ? "good" : "none"}">${esc(g.status)}</span></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card-b">${none("No errors match these filters.", "No matching errors")}</div>`}
  </div>`;
  $$("[data-es]", v).forEach((b) => b.onclick = () => { EF.status = b.dataset.es; VIEWS.errors(v, A.seq); });
  $("#ecat").onchange = (x) => { EF.cat = x.target.value; VIEWS.errors(v, A.seq); };
  $("#eper").onchange = (x) => { EF.period = x.target.value; VIEWS.errors(v, A.seq); };
  $$("tr.click", v).forEach((tr) => { tr.onclick = () => openError(tr.dataset.fp); tr.onkeydown = (k) => { if (k.key === "Enter") openError(tr.dataset.fp); }; });
};
async function openError(fp) {
  const D = drawer("Error");
  let g; try { g = await api("error", { id: fp }); } catch (e) { D.body.innerHTML = `<div class="callout bad">${errText(e)}</div>`; return; }
  if (!g) { D.body.innerHTML = stateBox("unavailable", "Error not found."); return; }
  D.head.textContent = `${g.kind}: ${g.message}`;
  D.body.innerHTML = `<div class="row" style="margin-bottom:10px"><span class="st ${g.status === "open" ? "bad" : g.status === "resolved" ? "good" : "none"}">${esc(g.status)}</span><span class="tag">${esc(g.category || "other")}</span><span class="tag">${esc(g.source === "server" ? "Server" : "App")}</span></div>
    ${can("alerts.manage") ? `<div class="row">${g.status !== "resolved" ? `<button class="btn sm" data-s="resolved">Resolve</button>` : ""}${g.status !== "ignored" ? `<button class="btn sm ghost" data-s="ignored">Ignore</button>` : ""}${g.status !== "open" ? `<button class="btn sm" data-s="open">Reopen</button>` : ""}</div>` : ""}
    <h4>Details</h4><dl class="dl"><dt>Where</dt><dd class="mono">${esc(g.location || "—")}</dd><dt>Route</dt><dd class="mono">${esc(g.route || "—")}</dd><dt>Environment</dt><dd>${esc(g.environment || "—")}</dd><dt>Release</dt><dd class="mono">${esc(g.release ? g.release.slice(0, 12) : "—")}</dd><dt>Latest correlation ID</dt><dd class="mono">${esc(g.last_request_id || "—")}</dd><dt>First seen</dt><dd>${dt(g.first_seen)}</dd><dt>Last seen</dt><dd>${dt(g.last_seen)}</dd><dt>Total occurrences</dt><dd>${n(g.count)}</dd>${g.updated_by_email ? `<dt>Status changed by</dt><dd>${esc(g.updated_by_email)}</dd>` : ""}</dl>
    <h4>Last 7 days</h4>${g.hourly.length ? chart(g.hourly.map((x) => ({ day: x.hour, n: x.n })), [{ key: "n", label: "Occurrences", color: RED, type: "bar" }], { xFmt: hourLabel, tipTitle: (r) => dt(r.day), height: 150, xlabel: "Hour" }) : `<p class="hint">No occurrences in the last 7 days.</p>`}
    <h4>Stack sample (cleaned)</h4>${g.sample_stack ? `<pre class="stack">${esc(g.sample_stack)}</pre>` : `<p class="hint">No stack was captured for this error.</p>`}
    <p class="hint">Before storage, numbers, quoted text, email addresses, query strings and host names are removed. No account, IP address or page content is kept.</p>
    ${g.history.length ? `<h4>History</h4><ul class="timeline">${g.history.map((x) => `<li><b class="mono">${esc(x.action)}</b><div class="muted">${dt(x.at)} · ${esc(x.by || "")}</div></li>`).join("")}</ul>` : ""}`;
  $$("[data-s]", D.body).forEach((b) => b.onclick = async () => { try { await api("error_update", { id: fp, status: b.dataset.s }); toast("Updated."); openError(fp); if (A.route === "errors") VIEWS.errors($("#view"), A.seq); } catch (e) { toast(ERR[e.code] || "Not updated.", true); } });
}

/* Incidents */
VIEWS.incidents = async (v, seq) => {
  const [list, team] = await Promise.all([api("incidents"), can("team.view") ? api("team").catch(() => []) : []]);
  if (stale(seq)) return;
  const ST = { investigating: "bad", degraded: "warn", operational: "info", resolved: "good" };
  const open = list.filter((i) => i.status !== "resolved"), done = list.filter((i) => i.status === "resolved");
  const table = (l, empty) => (l.length ? `<div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>Incident</th><th>Severity</th><th>Status</th><th>Assigned</th><th>Created</th><th>Resolved / updated</th></tr></thead><tbody>${l.map((i) => `<tr class="click" data-id="${esc(i.id)}" tabindex="0"><td><b>${esc(i.title)}</b><div class="muted trunc">${esc(i.impact || "")}</div></td><td><span class="sev ${esc(i.severity)}">${esc(i.severity)}</span></td><td><span class="st ${ST[i.status]}">${esc(i.status)}</span></td><td>${esc(i.assigned_email || "Unassigned")}</td><td>${dt(i.started_at)}</td><td>${i.resolved_at ? dt(i.resolved_at) : ago(i.updated_at)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="card-b">${none(empty)}</div>`);
  v.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="lead" style="margin:0">Incidents are an internal record of what went wrong and how it was handled. They are not shown to users.</p><span class="spacer"></span>${can("incidents.manage") ? `<button class="btn primary" id="ni">Open an incident</button>` : ""}</div>
    ${section("Open", `${open.length} open`)}<div class="card">${table(open, "No open incidents.")}</div>
    ${section("Resolved")}<div class="card">${table(done, "No resolved incidents yet.")}</div>`;
  const edit = (i = {}) => {
    const d = document.createElement("dialog"); d.style.width = "min(580px,calc(100% - 32px))";
    const admins = team.filter((m) => m.status === "active");
    d.innerHTML = `<form><h3>${i.id ? "Update incident" : "Open an incident"}</h3>
      <label class="f" for="it">Title</label><input id="it" type="text" maxlength="160" style="width:100%" value="${esc(i.title || "")}" required>
      <div class="row"><div><label class="f" for="isev">Severity</label><select id="isev">${["critical", "major", "minor"].map((s) => `<option ${(i.severity || "minor") === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div><label class="f" for="is">Status</label><select id="is">${["investigating", "degraded", "operational", "resolved"].map((s) => `<option ${(i.status || "investigating") === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div style="flex:1"><label class="f" for="ia">Assigned administrator</label><select id="ia" style="width:100%"><option value="">Unassigned</option>${admins.map((m) => `<option ${i.assigned_email === m.email ? "selected" : ""}>${esc(m.email)}</option>`).join("")}</select></div></div>
      <label class="f" for="ii">Description and impact on people</label><textarea id="ii" maxlength="600">${esc(i.impact || "")}</textarea>
      <label class="f" for="in">Resolution notes (internal, no health details)</label><textarea id="in" maxlength="2000">${esc(i.notes || "")}</textarea>
      <label class="f" for="iu">What changed (added to the timeline)</label><input id="iu" type="text" maxlength="300" style="width:100%" placeholder="${i.id ? "e.g. Rolled back the last deploy" : "e.g. Uploads failing for some people"}">
      <p class="err" id="ierr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" type="button" id="ic">Cancel</button><button class="btn primary">Save</button></div></form>`;
    document.body.appendChild(d); d.showModal(); $("#ic", d).onclick = () => { d.close(); d.remove(); };
    $("form", d).onsubmit = async (e) => { e.preventDefault();
      try { await api("incident_save", { data: { id: i.id, title: $("#it", d).value, severity: $("#isev", d).value, status: $("#is", d).value, assigned_email: $("#ia", d).value, impact: $("#ii", d).value, notes: $("#in", d).value, update_note: $("#iu", d).value } }); d.close(); d.remove(); toast("Incident saved."); VIEWS.incidents(v, A.seq); refreshBadges(); }
      catch (er) { $("#ierr", d).innerHTML = errText(er); } };
  };
  const ni = $("#ni"); if (ni) ni.onclick = () => edit();
  $$("tr.click", v).forEach((tr) => tr.onclick = () => {
    const i = list.find((x) => x.id === tr.dataset.id); const D = drawer(i.title);
    D.body.innerHTML = `<div class="row" style="margin-bottom:10px"><span class="sev ${esc(i.severity)}">${esc(i.severity)}</span><span class="st ${ST[i.status]}">${esc(i.status)}</span>${can("incidents.manage") ? `<span class="spacer"></span><button class="btn sm" id="ied">Update</button>` : ""}</div>
      <dl class="dl"><dt>Assigned</dt><dd>${esc(i.assigned_email || "Unassigned")}</dd><dt>Opened</dt><dd>${dt(i.started_at)} by ${esc(i.created_by_email || "—")}</dd><dt>Resolved</dt><dd>${dt(i.resolved_at)}</dd></dl>
      <h4>Description</h4><p>${esc(i.impact || "—")}</p><h4>Resolution notes</h4><p style="white-space:pre-wrap">${esc(i.notes || "—")}</p>
      <h4>Timeline</h4><ul class="timeline">${i.timeline.map((x) => `<li><b>${esc(x.status || "")}</b> · <span class="sev ${esc(x.severity || "")}">${esc(x.severity || "")}</span><div>${esc(x.note || "")}</div><div class="muted">${dt(x.at)} · ${esc(x.by || "")}</div></li>`).join("") || "<li class='muted'>No changes recorded.</li>"}</ul>`;
    const b = $("#ied", D.body); if (b) b.onclick = () => { closeDrawer(); edit(i); };
  });
};

/* Alerts */
const ALERT_HELP = { upload_failure_rate: "Check File storage on Platform health, then recent storage errors. Consider pausing file storage if failures continue.", login_failures: "Look for one source repeating failed sign-ins; check the Supabase Auth logs.", signup_failures: "Check the sign-up flow and Supabase Auth health; confirm email limits are not exceeded.",
  storage_near_limit: "Plan a storage upgrade or clean-up before uploads start failing (Supabase → Storage).", error_spike: "Open Errors, look at the last 24 hours, and check whether one release introduced them.", down_app: "Open the site; check the Cloudflare deployment and recent deploys. Open an incident if people are affected.",
  down_database: "Check Supabase status and the project's health; open an incident.", down_auth: "Check Supabase Auth status; sign-in may be failing for everyone.", down_storage: "Check Supabase Storage status; uploads and file viewing may fail.", down_ai: "Check the AI provider status and key; keep the assistant switched off until fixed.",
  monitor_stale: "The scheduled health round has stopped. Check the scheduler (GitHub Actions uptime workflow); meanwhile re-check Platform health by hand." };
VIEWS.alerts = async (v, seq) => {
  const [list, st] = await Promise.all([api("alerts", { evaluate: true }), api("settings_status")]);
  if (stale(seq)) return;
  const SEV = { info: "none", warning: "warn", critical: "bad" }, S = { open: "bad", acknowledged: "warn", muted: "none", resolved: "good" };
  const live = list.filter((a) => a.status !== "resolved"), old = list.filter((a) => a.status === "resolved");
  const row = (a) => `<tr><td><span class="st ${SEV[a.severity]}">${esc(a.severity)}</span></td><td>${dt(a.opened_at)}<div class="muted">updated ${ago(a.updated_at)}</div></td><td>${esc(SERVICE[a.service] || a.service || "—")}</td><td style="max-width:440px;white-space:normal"><b>${esc(a.message)}</b><div class="muted">${esc(ALERT_HELP[a.rule] || "")}</div>${a.notified_at ? `<div class="muted">Emailed ${dt(a.notified_at)}</div>` : ""}</td><td><span class="st ${S[a.status]}">${esc(a.status)}${a.status === "muted" && a.muted_until ? " until " + esc(dt(a.muted_until)) : ""}</span></td>
    <td>${can("alerts.manage") && a.status !== "resolved" ? `<div class="row">${a.status === "open" ? `<button class="btn sm" data-a="acknowledged" data-id="${esc(a.id)}">Acknowledge</button>` : ""}${a.status !== "muted" ? `<button class="btn sm ghost" data-a="muted" data-id="${esc(a.id)}">Mute 24 h</button>` : ""}<button class="btn sm" data-a="resolved" data-id="${esc(a.id)}">Resolve</button></div>` : ""}</td></tr>`;
  const head = `<thead><tr><th>Severity</th><th>Time</th><th>Affected service</th><th>Description and recommended action</th><th>Status</th><th></th></tr></thead>`;
  v.innerHTML = `<div class="callout ${st.config.email_provider ? "good" : "warn"}" style="margin-bottom:12px">${ic("info")}<span>${st.config.email_provider ? `Email alerts are configured. Admins who switch them on in <a href="#/settings">Admin settings</a> receive each new alert once.` : `Email delivery is <b>not configured</b> on the server, so the console sends no alert emails. Until it is, the GitHub uptime workflow fails on new alerts, which makes GitHub email the repository owner.`}</span></div>
  <p class="lead">Rules are checked by every scheduled health round and each time this page opens. An alert opens only when there are enough measurements to judge.</p>
  <div class="card">${live.length ? `<div class="tbl-wrap" style="border-top:0"><table>${head}<tbody>${live.map(row).join("")}</tbody></table></div>` : `<div class="card-b">${none("No open, acknowledged or muted alerts. All rules were checked just now.", "Nothing needs attention")}</div>`}</div>
  ${old.length ? `${section("Resolved")}<div class="card"><div class="tbl-wrap" style="border-top:0"><table>${head}<tbody>${old.slice(0, 30).map(row).join("")}</tbody></table></div></div>` : ""}
  ${section("Alert rules", "What opens an alert")}
  <div class="card"><div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>Category</th><th>Opens when</th><th>Severity</th><th>Measured by</th></tr></thead><tbody>
    <tr><td>Service outage</td><td>The app, database, sign-in or storage failed its last two scheduled checks</td><td><span class="sev critical">critical</span></td><td>Uptime history</td></tr>
    <tr><td>AI provider failure</td><td>The AI provider failed its last two checks (only when a key is configured)</td><td><span class="sev warning">warning</span></td><td>Uptime history</td></tr>
    <tr><td>Monitoring job failure</td><td>No scheduled health round for 45 minutes</td><td><span class="sev warning">warning</span></td><td>Uptime history</td></tr>
    <tr><td>Increased application errors</td><td>25 or more errors within about an hour</td><td><span class="sev warning">warning</span></td><td>Error tracking</td></tr>
    <tr><td>Upload failure spike</td><td>20% or more of at least 5 uploads failed in 24 hours</td><td><span class="sev warning">warning</span></td><td>App measurements (opt-in)</td></tr>
    <tr><td>Storage nearing limit</td><td>80% (warning) or 95% (critical) of the storage limit</td><td><span class="sev warning">warning</span> / <span class="sev critical">critical</span></td><td>Supabase Storage</td></tr>
    <tr><td>Sign-in failure spike</td><td>30 or more failed sign-ins in an hour</td><td><span class="sev warning">warning</span></td><td><span class="st none">Not measured</span> (the app does not send these)</td></tr>
    <tr><td>Sign-up failure spike</td><td>10 or more failed sign-ups in 24 hours</td><td><span class="sev warning">warning</span></td><td><span class="st none">Not measured</span> (the app does not send these)</td></tr>
  </tbody></table></div></div>`;
  $$("[data-a]", v).forEach((b) => b.onclick = async () => { try { await api("alert_update", { id: b.dataset.id, status: b.dataset.a }); toast(b.dataset.a === "muted" ? "Muted for 24 hours." : "Updated."); VIEWS.alerts(v, A.seq); refreshBadges(); } catch (e) { toast(ERR[e.code] || "Not updated.", true); } });
};

/* Feature switches */
const FLAG_INFO = {
  ai_assistant: { label: "AI assistant and AI document reading", on: "People who give consent can chat with the assistant and send photos for AI reading through the server.", off: "The server refuses all AI requests. Emergency guidance still works. Nothing is sent to the AI provider.", deps: "An AI provider key on the server, user consent, legal review and the provider agreement.", layer: "Backend (server refuses) and app (hides the assistant)", sensitive: true },
  document_upload: { label: "Storing document files", on: "Original documents and page images are stored in private storage.", off: "No new files are stored. Records still save; their files stay on the person's device and are stored when this is back on.", deps: "Supabase Storage. Maintenance mode also pauses this.", layer: "Backend (database storage policy) and app", sensitive: false },
  pdf_reading: { label: "Reading PDFs into records", on: "The app reads text out of uploaded PDFs to suggest record details.", off: "PDFs can still be attached; people type the details themselves.", deps: "Runs in the person's browser; no server dependency.", layer: "App only", sensitive: false },
  registrations: { label: "New account sign-ups", on: "Anyone can create a Doctine account.", off: "New accounts are refused. Existing accounts can always sign in.", deps: "The Supabase Auth hook “Before User Created” must point to public.hook_before_user_created. Until it does, this switch is not enforced.", layer: "Backend (Supabase Auth hook)", sensitive: false },
  sample_data: { label: "Sample records for new people", on: "The sign-in screen offers to explore Doctine with fictional records.", off: "The sample option is not offered.", deps: "None.", layer: "App only", sensitive: false },
};
async function waitForPropagation(key, enabled, el) {
  el.innerHTML = `<span class="st info">Checking the live app…</span>`;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, i ? 5000 : 1500));
    try { const c = await (await fetch("/api/config", { cache: "no-store" })).json(); if (c.features && c.features[key] === enabled) { el.innerHTML = `<span class="st good">Live in the app</span>`; return; } } catch {}
  }
  el.innerHTML = `<span class="st warn">Not confirmed yet</span> <span class="muted">Server caches can take up to a minute; reload to check.</span>`;
}
VIEWS.flags = async (v, seq) => {
  const flags = (await api("flags")).filter((f) => f.key !== "maintenance");
  if (stale(seq)) return;
  v.innerHTML = `<p class="lead">Each switch changes what Doctine actually does, at the layer shown. Every change needs a reason, is recorded in the audit log, and is confirmed against the live app.</p>
  <div class="grid cols-2">${flags.map((f) => { const i = FLAG_INFO[f.key] || { label: f.key, on: "", off: "", deps: "", layer: "" };
    return `<section class="card flag" data-flag="${esc(f.key)}"><div><h3>${esc(i.label)} ${i.sensitive ? `<span class="st warn">Sensitive</span>` : ""}</h3><div class="row" style="margin-top:4px">${f.enabled ? `<span class="st good">On</span>` : `<span class="st none">Off</span>`}<span class="muted" style="font-size:12px">${f.updated_by ? `changed by ${esc(f.updated_by)} ` : ""}${f.updated_at ? ago(f.updated_at) : "never changed"}</span></div><div id="prop-${esc(f.key)}" style="margin-top:6px"></div></div>
      <button class="switch" role="switch" aria-checked="${f.enabled}" aria-label="${esc(i.label)}" data-k="${esc(f.key)}" ${can("flags.manage") ? "" : "disabled"}></button>
      <div class="grid2"><div><b>When on</b>${esc(i.on)}</div><div><b>When off</b>${esc(i.off)}</div><div><b>Depends on</b>${esc(i.deps)}</div><div><b>Enforced by</b>${esc(i.layer)}</div></div></section>`; }).join("")}</div>
  ${can("flags.manage") ? "" : `<p class="hint" style="margin-top:10px">Your role can see switches but not change them.</p>`}`;
  $$(".switch[data-k]", v).forEach((b) => b.onclick = async () => {
    const k = b.dataset.k, on = b.getAttribute("aria-checked") !== "true", i = FLAG_INFO[k] || { label: k };
    const warn = k === "ai_assistant" && on ? `<div class="callout bad" style="margin:8px 0">${ic("info")}<span>Turn this on only when the provider agreement, consent wording, legal review and safety review are all in place. Health information will be sent to the AI provider for people who consent.</span></div>` : "";
    const r = await confirmBox(`Turn ${on ? "on" : "off"}: ${i.label}?`, esc(on ? i.on : i.off), { reason: true, danger: !on || i.sensitive, button: on ? "Turn on" : "Turn off", extra: warn });
    if (r === null) return;
    try { await api("set_flag", { key: k, enabled: on, reason: r }); toast("Switch changed. Checking the live app…"); await VIEWS.flags(v, A.seq); const el = $("#prop-" + k); if (el) waitForPropagation(k, on, el); } catch (e) { toast(ERR[e.code] || "Not changed.", true); }
  });
};

/* Maintenance */
VIEWS.maintenance = async (v, seq) => {
  const all = await api("flags"); if (stale(seq)) return;
  const m = all.find((f) => f.key === "maintenance") || { enabled: false, value: {} }, reg = all.find((f) => f.key === "registrations");
  const val = m.value || {}, win = val.starts_at && val.ends_at, onNow = m.on_now, manage = can("maintenance.manage");
  const toLocal = (s) => (s ? new Date(Date.parse(s) + IST).toISOString().slice(0, 16) : ""), fromLocal = (s) => (s ? new Date(s + ":00+05:30").toISOString() : null);
  v.innerHTML = `<div class="grid cols-2">
    ${card("Maintenance mode", "", `<div class="row" style="margin-bottom:10px">${onNow ? `<span class="st warn">On now</span>` : `<span class="st good">Off</span>`}${m.enabled ? `<span class="tag">switched on by hand</span>` : ""}${win ? `<span class="tag">window ${esc(dt(val.starts_at))} → ${esc(dt(val.ends_at))}</span>` : ""}</div>
      <p class="muted" style="margin-top:0">While on: the app shows your message to everyone; new document files are refused by the database (records still save); the AI assistant is refused by the server; new sign-ups are refused once the Auth hook is enabled. People can still sign in, read and edit their records.</p>
      <label class="f" for="mm">Message shown in the app</label><textarea id="mm" maxlength="300" ${manage ? "" : "disabled"} placeholder="For example: Doctine is being updated. File uploads pause until 10:00 IST.">${esc(val.message || "")}</textarea>
      <div class="callout warn" style="margin-top:8px"><span><b>Preview:</b> <span id="mprev">${esc(val.message || "Doctine is being updated.")}</span> Your records are safe and you can keep using Doctine; new file uploads and the assistant are paused for now.</span></div>
      ${manage ? `<div class="row" style="margin-top:12px">${m.enabled ? `<button class="btn" id="msave">Update message</button><button class="btn primary" id="moff">Turn off now</button>` : `<button class="btn danger solid" id="mon">Turn on now</button>`}</div>` : `<p class="hint">Only the owner and admins can change maintenance mode.</p>`}`, { foot: `Last changed ${m.updated_by ? "by " + esc(m.updated_by) + " " : ""}${m.updated_at ? ago(m.updated_at) : "never"}` })}
    ${card("Schedule a maintenance window", "Turns on and off by itself between these times. It is checked each time the app loads, so no background job is needed.", `
      <div class="row"><div><label class="f" for="ms">Starts (IST)</label><input id="ms" type="datetime-local" value="${toLocal(val.starts_at)}" ${manage ? "" : "disabled"}></div><div><label class="f" for="me">Ends (IST)</label><input id="me" type="datetime-local" value="${toLocal(val.ends_at)}" ${manage ? "" : "disabled"}></div></div>
      ${manage ? `<div class="row" style="margin-top:12px"><button class="btn primary" id="mwin">Save window</button>${win ? `<button class="btn ghost" id="mclr">Clear window</button>` : ""}</div>` : ""}
      <div class="section" style="margin:20px 0 6px"><h2 style="font-size:13px">Related controls</h2></div>
      <div class="li" style="padding:6px 0"><span class="t"><div>New account sign-ups</div><div class="muted">${reg && reg.enabled ? "On" : "Off"} · needs the Supabase Auth hook to be enforced</div></span><a class="btn sm" href="#/flags">Feature switches</a></div>
      <div class="li" style="padding:6px 0"><span class="t"><div>Tell people in advance</div><div class="muted">Publish an announcement</div></span><a class="btn sm" href="#/announcements">Announcements</a></div>`)}
  </div>`;
  const mm = $("#mm"); mm.oninput = () => { $("#mprev").textContent = mm.value || "Doctine is being updated."; };
  const go = async (enabled, label, starts = val.starts_at || null, ends = val.ends_at || null) => {
    const r = await confirmBox(label + "?", enabled ? "Everyone using Doctine will see the message; uploads, the assistant and (with the hook) sign-ups pause." : "Doctine returns to normal unless a scheduled window is active.", { reason: true, danger: enabled, button: label });
    if (r === null) return;
    try { const out = await api("set_maintenance", { enabled, message: mm.value, starts_at: starts, ends_at: ends, reason: r }); toast(out.on_now ? "Maintenance is on." : "Maintenance is off."); VIEWS.maintenance(v, A.seq); } catch (e) { toast(ERR[e.code] || "Not changed.", true); }
  };
  const a = $("#mon"), b = $("#moff"), c = $("#msave"), w = $("#mwin"), x = $("#mclr");
  if (a) a.onclick = () => go(true, "Turn maintenance on"); if (b) b.onclick = () => go(false, "Turn maintenance off"); if (c) c.onclick = () => go(true, "Update the message");
  if (w) w.onclick = () => { const s = fromLocal($("#ms").value), e = fromLocal($("#me").value); if (!s || !e || e <= s) return toast("Choose a start and an end after it.", true); go(m.enabled, "Save the maintenance window", s, e); };
  if (x) x.onclick = () => go(m.enabled, "Clear the maintenance window", null, null);
};

/* Announcements */
VIEWS.announcements = async (v, seq) => {
  const list = await api("announcements"); if (stale(seq)) return;
  const stl = (a) => (a.live ? `<span class="st good">Showing now</span>` : a.status === "published" ? (a.ends_at && Date.parse(a.ends_at) < Date.now() ? `<span class="st none">Expired</span>` : `<span class="st info">Scheduled</span>`) : a.status === "archived" ? `<span class="st none">Unpublished</span>` : `<span class="st none">Draft</span>`);
  v.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="lead" style="margin:0">Published announcements show as a banner in the app between their dates (checked each time the app loads). People can dismiss them.</p><span class="spacer"></span>${can("announcements.manage") ? `<button class="btn primary" id="na">New announcement</button>` : ""}</div>
    <div class="card">${list.length ? `<div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>Title</th><th>Type</th><th>Audience</th><th>Status</th><th>Shows</th><th>Updated</th><th></th></tr></thead><tbody>${list.map((a) => `<tr><td><b>${esc(a.title)}</b><div class="muted trunc">${esc(a.body)}</div></td><td>${esc(a.kind)}</td><td>${a.audience === "all" ? "Everyone" : "Signed-in people"}</td><td>${stl(a)}</td><td class="muted">${a.starts_at ? dt(a.starts_at) : "Now"} → ${a.ends_at ? dt(a.ends_at) : "until unpublished"}</td><td>${ago(a.updated_at)}</td><td>${can("announcements.manage") ? `<button class="btn sm" data-id="${esc(a.id)}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="card-b">${none("No announcements yet.", "None yet")}</div>`}</div>`;
  const toLocal = (s) => (s ? new Date(Date.parse(s) + IST).toISOString().slice(0, 16) : ""), fromLocal = (s) => (s ? new Date(s + ":00+05:30").toISOString() : "");
  const edit = (a = { kind: "product", status: "draft", audience: "signed_in" }) => {
    const d = document.createElement("dialog"); d.style.width = "min(600px,calc(100% - 32px))";
    d.innerHTML = `<form><h3>${a.id ? "Edit announcement" : "New announcement"}</h3>
      <div class="row"><div><label class="f" for="ak">Type</label><select id="ak">${[["service", "Service notice"], ["maintenance", "Maintenance"], ["product", "Product update"]].map(([k, t]) => `<option value="${k}" ${a.kind === k ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div><label class="f" for="aa">Audience</label><select id="aa"><option value="signed_in" ${a.audience !== "all" ? "selected" : ""}>Signed-in people</option><option value="all" ${a.audience === "all" ? "selected" : ""}>Everyone (also the sign-in screen)</option></select></div></div>
      <label class="f" for="at">Title</label><input id="at" type="text" maxlength="120" style="width:100%" value="${esc(a.title || "")}" required>
      <label class="f" for="ab">Message</label><textarea id="ab" maxlength="600">${esc(a.body || "")}</textarea>
      <div class="row"><div><label class="f" for="as">Show from (IST, optional)</label><input id="as" type="datetime-local" value="${toLocal(a.starts_at)}"></div><div><label class="f" for="ae">Until (IST, optional)</label><input id="ae" type="datetime-local" value="${toLocal(a.ends_at)}"></div></div>
      <label class="f">Preview</label><div id="apv"></div>
      <p class="err" id="aerr" role="alert"></p>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" type="button" id="ac">Cancel</button>${a.id && a.status === "published" ? `<button class="btn" type="button" data-s="archived">Unpublish</button>` : ""}<button class="btn" type="button" data-s="draft">Save draft</button><button class="btn primary" type="button" data-s="published">Publish</button></div></form>`;
    document.body.appendChild(d); d.showModal();
    const pv = () => { $("#apv", d).innerHTML = `<div class="callout ${$("#ak", d).value === "maintenance" ? "warn" : ""}"><span><b>${esc($("#at", d).value || "Title")}</b>${$("#ab", d).value ? " " + esc($("#ab", d).value) : ""}</span></div>`; };
    pv(); d.addEventListener("input", pv); d.addEventListener("change", pv);
    $("#ac", d).onclick = () => { d.close(); d.remove(); };
    $$("[data-s]", d).forEach((b) => b.onclick = async () => {
      if (!$("#at", d).value.trim()) { $("#aerr", d).textContent = "Add a title."; return; }
      if ($("#as", d).value && $("#ae", d).value && $("#ae", d).value <= $("#as", d).value) { $("#aerr", d).textContent = "The end must be after the start."; return; }
      try { await api("announcement_save", { data: { id: a.id, kind: $("#ak", d).value, audience: $("#aa", d).value, title: $("#at", d).value, body: $("#ab", d).value, status: b.dataset.s, starts_at: fromLocal($("#as", d).value), ends_at: fromLocal($("#ae", d).value) } }); d.close(); d.remove(); toast(b.dataset.s === "published" ? "Published." : b.dataset.s === "archived" ? "Unpublished." : "Draft saved."); VIEWS.announcements(v, A.seq); }
      catch (e) { $("#aerr", d).innerHTML = errText(e); }
    });
  };
  const na = $("#na"); if (na) na.onclick = () => edit();
  $$("[data-id]", v).forEach((b) => b.onclick = () => edit(list.find((x) => x.id === b.dataset.id)));
};

/* Admin team */
const ROLE_INFO = { owner: "Full administrative authority, including appointing and removing admins.", admin: "Approved operational controls: accounts, switches, maintenance, incidents, alerts, announcements; reads the audit log.", analyst: "Read-only analytics, reports, document operations and platform health. No account details.", support: "Limited account metadata, password resets and support notes.", auditor: "Read-only audit log, security events and the team list." };
VIEWS.team = async (v, seq) => {
  const t = await api("team"); if (stale(seq)) return;
  const meId = A.session && A.session.user.id;
  v.innerHTML = `<div class="row" style="margin-bottom:12px"><p class="lead" style="margin:0">${can("team.manage") ? "Admins are existing Doctine accounts. No account is created here and nobody can sign up as an admin." : "Only the owner can add, change or remove admins."}</p><span class="spacer"></span>${can("team.manage") ? `<button class="btn primary" id="tinv">Add team member</button>` : ""}</div>
  <div class="card"><div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>Member</th><th>Role</th><th>Access</th><th>Two-step sign-in</th><th>Last sign-in</th><th>Last admin action</th><th>Added</th>${can("team.manage") ? "<th></th>" : ""}</tr></thead><tbody>
    ${t.map((m) => `<tr><td>${esc(m.email)}${m.user_id === meId ? ` <span class="muted">(you)</span>` : ""}</td><td><span class="tag role">${esc(m.role)}</span></td><td>${m.status === "active" ? `<span class="st good">Active</span>` : `<span class="st bad">Suspended</span>`}</td><td>${m.mfa ? `<span class="st good">On</span>` : `<span class="st warn">Off</span>`}</td><td>${ago(m.last_sign_in_at)}</td><td>${ago(m.last_admin_action)}</td><td>${dt(m.added_at, false)}${m.added_by ? `<div class="muted">by ${esc(m.added_by)}</div>` : ""}</td>${can("team.manage") ? `<td>${m.user_id === meId ? "" : `<button class="btn sm" data-e="${esc(m.email)}" data-r="${esc(m.role)}" data-s="${esc(m.status)}">Manage</button>`}</td>` : ""}</tr>`).join("")}
  </tbody></table></div></div>
  ${section("Roles", "Least privilege. Checked by the database on every request.")}
  <div class="card"><div class="tbl-wrap" style="border-top:0"><table><thead><tr><th>Role</th><th>What it can do</th></tr></thead><tbody>${Object.entries(ROLE_INFO).map(([r, d]) => `<tr><td><span class="tag role">${r}</span></td><td>${esc(d)}</td></tr>`).join("")}</tbody></table></div></div>
  ${can("audit.view") ? `<p class="hint" style="margin-top:10px">Permission changes are recorded in the <a href="#/audit">audit log</a> (filter by “Team and permissions”). Refused requests are under <a href="#/security">Security events</a>.</p>` : ""}`;
  const set = async (email, role, status, title, danger) => {
    const r = await confirmBox(title, `${esc(email)}${role && status !== "removed" ? " → " + esc(role) : ""}`, { reason: true, danger, button: "Confirm" });
    if (r === null) return;
    try { const out = await api("team_set", { email, role, status, reason: r }); if (out && out.ok === false) toast(out.error === "no_account" ? "There is no Doctine account with that email. They need to sign up in the app first." : out.error === "not_on_yourself" ? "You cannot change your own membership." : "Not changed.", true); else { toast("Team updated."); VIEWS.team(v, A.seq); } }
    catch (e) { toast(e.code === "forbidden" ? "Only the owner can do this, and there must always be an active owner." : ERR[e.code] || "Not changed.", true); }
  };
  const inv = $("#tinv"); if (inv) inv.onclick = () => {
    const d = document.createElement("dialog");
    d.innerHTML = `<form><h3>Add team member</h3><p class="muted" style="margin-top:0">They must already have a Doctine account (they sign up in the app first).</p>
      <label class="f" for="te">Their Doctine account email</label><input id="te" type="email" style="width:100%" required>
      <label class="f" for="tr">Role</label><select id="tr" style="width:100%">${Object.keys(ROLE_INFO).map((r) => `<option value="${r}" ${r === "analyst" ? "selected" : ""}>${r}</option>`).join("")}</select><p class="hint" id="trd">${esc(ROLE_INFO.analyst)}</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" type="button" id="x2">Cancel</button><button class="btn primary">Continue</button></div></form>`;
    document.body.appendChild(d); d.showModal(); $("#x2", d).onclick = () => { d.close(); d.remove(); };
    $("#tr", d).onchange = (e) => { $("#trd", d).textContent = ROLE_INFO[e.target.value]; };
    $("form", d).onsubmit = (e) => { e.preventDefault(); const em = $("#te", d).value.trim(), r = $("#tr", d).value; d.close(); d.remove(); set(em, r, "active", `Give ${r} access to ${em}?`, r === "owner" || r === "admin"); };
  };
  $$("[data-e]", v).forEach((b) => b.onclick = () => {
    const d = document.createElement("dialog");
    d.innerHTML = `<form><h3>Manage ${esc(b.dataset.e)}</h3><label class="f" for="cr2">Role</label><select id="cr2" style="width:100%">${Object.keys(ROLE_INFO).map((r) => `<option value="${r}" ${r === b.dataset.r ? "selected" : ""}>${r}</option>`).join("")}</select>
      <label class="f" for="cs2">Access</label><select id="cs2" style="width:100%"><option value="active" ${b.dataset.s === "active" ? "selected" : ""}>Active</option><option value="suspended" ${b.dataset.s === "suspended" ? "selected" : ""}>Suspend access (kept on the list, no access)</option><option value="removed">Revoke access (remove from the team)</option></select>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" type="button" id="x2">Cancel</button><button class="btn primary">Continue</button></div></form>`;
    document.body.appendChild(d); d.showModal(); $("#x2", d).onclick = () => { d.close(); d.remove(); };
    $("form", d).onsubmit = (e) => { e.preventDefault(); const r = $("#cr2", d).value, s = $("#cs2", d).value; d.close(); d.remove(); set(b.dataset.e, r, s, s === "removed" ? "Revoke this person's admin access?" : s === "suspended" ? "Suspend this person's admin access?" : "Change this person's role?", s !== "active" || r === "owner"); };
  });
};

/* Audit log */
const AQ = { admin: "", filter_action: "", target: "", page: 1 };
VIEWS.audit = async (v, seq) => {
  const p = periodRange();
  const d = await api("audit", { ...AQ, from: p.from, to: p.to, size: 50 }); if (stale(seq)) return;
  const pages = Math.max(1, Math.ceil(d.total / 50));
  v.innerHTML = `<div class="card"><form class="toolbar" id="af"><label class="sr" for="aa">Administrator</label><input id="aa" type="search" placeholder="Administrator email" value="${esc(AQ.admin)}">
    <label class="sr" for="ac2">Action</label><select id="ac2">${[["", "All actions"], ["user.", "Accounts"], ["flag.", "Switches"], ["maintenance.", "Maintenance"], ["team.", "Team and permissions"], ["announcement.", "Announcements"], ["incident.", "Incidents"], ["alert.", "Alerts"], ["error.", "Errors"], ["report.", "Exports"], ["prefs.", "Preferences"], ["denied:", "Refused requests"]].map(([k, t]) => `<option value="${k}" ${AQ.filter_action === k ? "selected" : ""}>${t}</option>`).join("")}</select>
    <label class="sr" for="at2">Resource</label><input id="at2" type="search" placeholder="Resource id" value="${esc(AQ.target)}"><button class="btn sm primary">Filter</button>
    <span class="spacer"></span><span class="muted" style="font-size:12px">${n(d.total)} entries in ${esc(p.label.toLowerCase())} · append-only, cannot be edited or deleted</span>
    ${can("reports.export") ? `<button class="btn sm" type="button" id="aexp">${ic("download")} Export</button>` : ""}</form>
  ${d.rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>When (IST)</th><th>Administrator</th><th>Action</th><th>Resource</th><th>Reason</th><th>Outcome</th><th>Previous → new</th><th>Correlation</th></tr></thead><tbody>${d.rows.map((r) => `<tr><td>${dt(r.at)}</td><td>${esc(r.actor_email || "—")}<div class="muted">${esc(r.actor_role || "")}</div></td><td class="mono">${esc(r.action)}</td><td>${esc(r.target_type || "")}<div class="mono muted">${esc((r.target_id || "").slice(0, 36))}</div></td><td>${esc(r.reason || "")}</td><td><span class="st ${r.outcome === "ok" ? "good" : r.outcome === "denied" || r.outcome === "failed" ? "bad" : "none"}">${esc(r.outcome)}</span></td><td class="mono" style="max-width:280px;white-space:pre-wrap;word-break:break-word;font-size:11px">${r.before || r.after ? esc(JSON.stringify({ before: r.before || undefined, after: r.after || undefined })) : ""}</td><td class="mono">${esc((r.request_id || "").slice(0, 8))}</td></tr>`).join("")}</tbody></table></div>
    <div class="pager"><button class="btn sm" id="ap" ${AQ.page <= 1 ? "disabled" : ""}>Previous</button><span>Page ${AQ.page} of ${pages}</span><button class="btn sm" id="an" ${AQ.page >= pages ? "disabled" : ""}>Next</button></div>` : `<div class="card-b">${none("No entries match these filters in this period.", "No entries")}</div>`}</div>`;
  $("#af").onsubmit = (e) => { e.preventDefault(); Object.assign(AQ, { admin: $("#aa").value.trim(), filter_action: $("#ac2").value, target: $("#at2").value.trim(), page: 1 }); VIEWS.audit(v, A.seq); };
  const a = $("#ap"), b = $("#an"); if (a) a.onclick = () => { AQ.page--; VIEWS.audit(v, A.seq); }; if (b) b.onclick = () => { AQ.page++; VIEWS.audit(v, A.seq); };
  const ex = $("#aexp"); if (ex) ex.onclick = async () => { try { await download("report", { report: "admin_activity", format: "csv", ...p }, "doctine-admin-activity.csv"); toast("Downloaded. The export was recorded."); } catch (e) { toast(ERR[e.code] || "Export failed.", true); } };
};

/* Security events */
VIEWS.security = async (v, seq) => {
  const s = await api("security"); if (stale(seq)) return;
  v.innerHTML = `<div class="grid kpis">
    ${kpi({ label: "Refused admin requests (24 h)", value: s.denied_24h, meta: `<span class="muted">accounts without the permission</span>` })}
    ${kpi({ label: "Sign-in failures (24 h)", state: "not_measured", meta: "The app does not report sign-in failures (they happen before consent). See Supabase → Logs → Auth." })}
    ${kpi({ label: "Suspended accounts", value: s.suspended_accounts })}
    ${kpi({ label: "Admins without two-step sign-in", value: s.admins_without_mfa, meta: s.admins_without_mfa ? `<span class="delta down">Ask them to set it up</span>` : `<span class="muted">All set</span>` })}
  </div>
  <div class="grid cols-2" style="margin-top:12px">
    ${card("Recent refused requests", "Who tried to use the console without permission", s.denied_recent.length ? `<div class="tbl-wrap" style="border:1px solid var(--line);border-radius:6px"><table><tbody>${s.denied_recent.map((x) => `<tr><td>${dt(x.at)}</td><td>${esc(x.who || "unknown account")}</td><td class="mono">${esc(x.action)}</td></tr>`).join("")}</tbody></table></div>` : none("No refused requests."))}
    ${card("How the console is protected", "", `<ul style="margin:0;padding-left:18px;line-height:1.8"><li>Admin access is checked by the database on every request; the browser holds no privileges.</li><li>Every admin action and refusal is in the append-only audit log.</li><li>Suspension blocks sign-in and ends sessions; a current token can keep working for up to an hour for the person's own data.</li><li>Password resets go through Supabase; admins never see or set passwords.</li></ul>`)}
  </div>`;
};

/* Metric definitions */
VIEWS.definitions = async (v) => {
  const D = [
    ["Account", "A Doctine sign-in (Supabase Auth user). Deleted and anonymous accounts are excluded."],
    ["New account", "An account created within the period. Days are calendar days in India Standard Time (UTC+5:30)."],
    ["Meaningful activity", "Something done with health records: adding or changing a record, uploading a file, recording a dose, adding or changing a medicine, editing the health profile after sign-up, sending an assistant message, searching, or exporting. Signing in, opening pages, refreshing and repeated sign-ins never count. Measured on the server from the database (a browser cannot fake it), except search and export, which come from opt-in app measurements."],
    ["Active user", "An account with meaningful activity in the window."],
    ["DAU", "Distinct accounts with meaningful activity today (IST). Compared with yesterday."],
    ["WAU", "Distinct accounts with meaningful activity in the last 7 × 24 hours, compared with the 7 days before. In charts: the 7 calendar days ending that day."],
    ["MAU", "As WAU, over 30 days."],
    ["Returning user", "Active in the period and also had meaningful activity before the period began. Returning rate = returning ÷ active."],
    ["Email confirmation rate", "Of accounts created in the period, the share with a confirmed email."],
    ["Registration completion", "Of accounts created in the period, the share that reached any meaningful activity."],
    ["Activation funnel", "Accounts created in the period → email confirmed → signed in at least once → profile completed (a detail beyond the name) → first record → first document file."],
    ["Retention (day N)", "Of a week's new accounts, the share with meaningful activity between N and N+7 days after sign-up. Shown only when every account in the cohort is old enough."],
    ["Feature adoption", "Accounts that have ever used a feature. Database-backed features are always measured; app-measured features (PDF reading, search, export) say “Not measured” until the first measurement arrives."],
    ["Health records created", "Rows in documents created in the period, from any source (scan, upload or typed)."],
    ["Documents uploaded", "Document files stored in the period (originals and cleaned page images)."],
    ["Storage consumed", "Total size of files in the private health-documents bucket, from Supabase Storage. The limit is the Supabase Free plan's 1 GB unless changed."],
    ["Upload success", "Uploads the app reported as completed ÷ (completed + failed). Opt-in app measurement."],
    ["PDF reading success", "PDFs read into a record ÷ (read + failed). Opt-in app measurement."],
    ["Application errors", "Occurrences reported to Doctine's own error tracker by the app and the server. Repeats of the same error are grouped."],
    ["Platform availability", "Share of scheduled health checks of the app that passed. Checks run every 15 minutes when the scheduler runs, and whenever an admin opens Platform health."],
    ["Previous period", "The same length of time immediately before the selected period. “New” means there was nothing in the previous period, so no percentage is shown."],
    ["Value states", "0 is an actual zero. “Not measured” means the measurement has not started. “Not configured” means the service behind it is not set up. “Insufficient data” means too little history to chart or compare. “Unavailable” means it could not be loaded."],
  ];
  v.innerHTML = `<div class="card"><div class="tbl-wrap" style="border-top:0"><table><thead><tr><th style="width:220px">Term</th><th>Definition</th></tr></thead><tbody>${D.map(([t, d]) => `<tr><td><b>${esc(t)}</b></td><td>${esc(d)}</td></tr>`).join("")}</tbody></table></div></div>
  <p class="hint" style="margin-top:10px">Never collected: document contents, test values, diagnoses, prescription or medication details, medical history, extracted text, search words, chat contents, passwords or tokens. Measurement properties are limited to short codes by the database.</p>`;
};

/* Admin settings */
VIEWS.settings = async (v, seq) => {
  const st = await api("settings_status"); if (stale(seq)) return;
  const c = st.config, pr = st.prefs;
  const yes = (b, on = "Configured", off = "Not configured") => (b ? `<span class="st good">${on}</span>` : `<span class="st none">${off}</span>`);
  v.innerHTML = `<div class="grid cols-2">
    ${card("Your access", "", `<dl class="dl"><dt>Signed in as</dt><dd>${esc(A.me.email)}</dd><dt>Role</dt><dd><span class="tag role">${esc(A.me.role)}</span></dd><dt>Two-step sign-in</dt><dd>${A.me.aal === "aal2" ? `<span class="st good">Used for this session</span>` : A.me.mfa_enrolled ? `<span class="st info">Set up</span>` : `<span class="st warn">Not set up</span>`}</dd><dt>Required for admins</dt><dd>${c.admin_mfa_required ? `<span class="st good">Yes</span>` : `<span class="st warn">No</span> <span class="muted">set ADMIN_REQUIRE_MFA=true</span>`}</dd></dl>
      <div class="section" style="margin:18px 0 8px"><h2 style="font-size:13px">Your permissions</h2></div><div class="chips">${(A.me.perms || []).map((p) => `<span class="chip">${esc(p)}</span>`).join("")}</div>
      <div class="row" style="margin-top:14px">${A.me.aal !== "aal2" && !A.me.mfa_enrolled ? `<button class="btn primary" id="mf">Set up two-step sign-in</button>` : ""}<button class="btn" id="so2">${ic("out")} Sign out</button></div>`)}
    ${card("Notification preferences", "Email for new platform alerts", !can("health.view") ? `<p class="muted">Your role does not receive platform alerts.</p>` : `
      <div class="row"><button class="switch" role="switch" id="pe" aria-checked="${!!pr.email_alerts}" aria-label="Email me new alerts"></button><span>Email me new alerts</span></div>
      <label class="f" for="psev">Minimum severity</label><select id="psev">${[["info", "All alerts"], ["warning", "Warnings and critical"], ["critical", "Critical only"]].map(([k, t]) => `<option value="${k}" ${pr.min_severity === k ? "selected" : ""}>${t}</option>`).join("")}</select>
      <div class="callout ${c.email_provider ? "good" : "warn"}" style="margin-top:12px">${ic("info")}<span>${c.email_provider ? "Email delivery is configured on the server. New alerts are emailed once." : "<b>Email delivery is not configured</b> on the server, so no alert emails are sent, whatever you choose here. Your choice is saved and takes effect once an email provider is set up."}</span></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="psave">Save preferences</button>${pr.updated_at ? `<span class="muted" style="font-size:12px">saved ${ago(pr.updated_at)}</span>` : ""}</div>`)}
    ${card("Configuration status", "What the server has set up (names only, never values)", `<dl class="dl" style="grid-template-columns:1fr auto"><dt>Environment</dt><dd>${esc(c.environment)}</dd><dt>Release</dt><dd class="mono">${esc(c.release || "—")}</dd><dt>Supabase (database, auth, storage)</dt><dd>${yes(c.supabase)}</dd><dt>AI provider key</dt><dd>${yes(c.ai_key)}</dd><dt>Email provider (alerts)</dt><dd>${yes(c.email_provider)}</dd><dt>Fixed alert recipients</dt><dd>${yes(c.alert_email_to)}</dd><dt>Rate-limit secret</dt><dd>${yes(c.rate_limit_secret)}</dd><dt>Google sign-in</dt><dd>${yes(c.google_sign_in, "On", "Off")}</dd><dt>Two-step sign-in required</dt><dd>${yes(c.admin_mfa_required, "Yes", "No")}</dd></dl>`)}
    ${card("Time and data", "", `<dl class="dl"><dt>Time zone</dt><dd>India Standard Time (Asia/Kolkata) for every date and day boundary</dd><dt>Data retention</dt><dd>Measurements about 13 months · errors 180 days · checks 90 days · audit log kept</dd><dt>Health data</dt><dd>Never shown or exported by the console</dd></dl>`)}
  </div>`;
  const mf = $("#mf"); if (mf) mf.onclick = () => renderMfa();
  $("#so2").onclick = signOut;
  const pe = $("#pe"); if (pe) pe.onclick = () => pe.setAttribute("aria-checked", pe.getAttribute("aria-checked") !== "true");
  const ps = $("#psave"); if (ps) ps.onclick = async () => { try { await api("set_prefs", { email_alerts: pe.getAttribute("aria-checked") === "true", min_severity: $("#psev").value }); toast("Preferences saved."); VIEWS.settings(v, A.seq); } catch (e) { toast(ERR[e.code] || "Not saved.", true); } };
};

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
