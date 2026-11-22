/**
 * Doctine · admin reports. Each report is built on the server from the same database functions the console uses
 * (so each one enforces its own permission), with the previous period of the same length for comparison, and is
 * rendered as CSV or PDF. No report contains health information.
 */
import { makePdf } from "./pdf.mjs";

const IST = 330 * 60000;
export const ist = (v) => (v ? new Date(Date.parse(v) + IST).toISOString().slice(0, 16).replace("T", " ") + " IST" : "-");
const fmt = (v) => (v == null || v === "" ? "-" : typeof v === "number" ? v.toLocaleString("en-IN") : String(v));
const mb = (b) => (b == null ? "-" : (b / 1048576).toFixed(2) + " MB");
const pct = (a, b) => (b ? ((a * 100) / b).toFixed(1) + "%" : "-");
const chg = (a, b) => (a == null || b == null ? "-" : b === 0 ? (a === 0 ? "no change" : "new (none before)") : `${a >= b ? "+" : ""}${Math.round(((a - b) / b) * 100)}%`);
const prev = (p) => { const len = Date.parse(p.p_to) - Date.parse(p.p_from); return { p_from: new Date(Date.parse(p.p_from) - len).toISOString(), p_to: p.p_from }; };
const cmp = (label, cur, before, f = fmt) => [label, f(cur), f(before), chg(cur, before)];
const CMP_COLS = { cols: ["Measure", "This period", "Previous period", "Change"], align: ["", "r", "r", "r"] };

export const REPORTS = {
  growth: { title: "User growth", description: "Registrations, total accounts and email confirmation, day by day, with the previous period." },
  engagement: { title: "User engagement", description: "Active people, returning people and meaningful actions by kind." },
  funnel: { title: "Registration and activation funnel", description: "Of the accounts created in the period: confirmed, signed in, profile, first record, first document." },
  adoption: { title: "Feature adoption", description: "People who have used each feature, ever and in the period. Unmeasured features are labelled." },
  documents: { title: "Document operations", description: "Records, files, upload and PDF-reading outcomes. Technical metadata only." },
  storage: { title: "Storage", description: "Document storage in use, its limit and growth by day." },
  availability: { title: "Platform availability", description: "Share of scheduled checks that passed for each service, and response times." },
  errors: { title: "Errors", description: "Error volume by day and category, and the most frequent errors." },
  admin_activity: { title: "Administrative activity", description: "Every administrative action in the period, from the append-only audit log." },
  users: { title: "Account list", description: "Account metadata only: dates, verification, status, record and file counts." },
};

export async function buildReport(kind, uid, p, rpc) {
  const pp = prev(p), A = { p_actor: uid };
  const S = [];
  if (kind === "growth") {
    const [o, s] = await Promise.all([rpc("admin_overview", { ...A, ...p }), rpc("admin_series", { ...A, ...p })]);
    S.push({ h: "Summary", table: { ...CMP_COLS, rows: [cmp("New accounts", o.users_new, o.users_new_prev), cmp("Total accounts at end", o.users_total, o.users_total_prev),
      ["Email confirmed (all accounts)", fmt(o.users_verified), "-", pct(o.users_verified, o.users_total) + " of accounts"]] } });
    S.push({ h: "Day by day", table: { cols: ["Day", "New accounts", "Total accounts"], align: ["", "r", "r"], rows: s.map((d) => [d.day, fmt(d.users_new), fmt(d.users_total)]) } });
  } else if (kind === "engagement") {
    const [o, e, ep, s] = await Promise.all([rpc("admin_overview", { ...A, ...p }), rpc("admin_engagement", { ...A, ...p }), rpc("admin_engagement", { ...A, ...pp }), rpc("admin_series", { ...A, ...p })]);
    S.push({ h: "Summary", table: { ...CMP_COLS, rows: [cmp("Active people", e.active, ep.active), cmp("Returning people", e.returning, ep.returning), cmp("Meaningful actions", e.actions, ep.actions),
      ["Actions per active person", e.active ? (e.actions / e.active).toFixed(1) : "-", ep.active ? (ep.actions / ep.active).toFixed(1) : "-", "-"],
      ["Daily / 7-day / 30-day active (now)", `${fmt(o.dau)} / ${fmt(o.wau)} / ${fmt(o.mau)}`, `${fmt(o.dau_prev)} / ${fmt(o.wau_prev)} / ${fmt(o.mau_prev)}`, "-"]] } });
    S.push({ h: "Actions by kind", table: { cols: ["Kind", "This period", "Previous period"], align: ["", "r", "r"], rows: [...new Set([...Object.keys(e.by_kind), ...Object.keys(ep.by_kind)])].map((k) => [k, fmt(e.by_kind[k] || 0), fmt(ep.by_kind[k] || 0)]) } });
    S.push({ h: "Day by day", table: { cols: ["Day", "Daily active", "7-day active", "30-day active", "Returning", "Actions"], align: ["", "r", "r", "r", "r", "r"], rows: s.map((d) => [d.day, fmt(d.dau), fmt(d.wau), fmt(d.mau), fmt(d.returning), fmt(d.actions)]) } });
  } else if (kind === "funnel") {
    const [f, fp] = await Promise.all([rpc("admin_funnel", { ...A, ...p }), rpc("admin_funnel", { ...A, ...pp })]);
    const steps = [["Account created", "account_created"], ["Email confirmed", "email_verified"], ["Signed in", "signed_in"], ["Profile completed", "profile_completed"], ["First record created", "first_record"], ["First document uploaded", "first_file"]];
    S.push({ h: "Funnel", table: { cols: ["Step", "People", "Of created", "Previous period", "Of created (prev)"], align: ["", "r", "r", "r", "r"],
      rows: steps.map(([l, k]) => [l, fmt(f[k]), pct(f[k], f.account_created), fmt(fp[k]), pct(fp[k], fp.account_created)]) } });
  } else if (kind === "adoption") {
    const a = await rpc("admin_adoption", { ...A, ...p });
    S.push({ h: `Feature adoption (of ${fmt(a.accounts)} accounts)`, table: { cols: ["Feature", "People, ever", "Share", "In period", "Source"], align: ["", "r", "r", "r", ""],
      rows: a.features.map((x) => x.measured ? [x.label, fmt(x.ever), pct(x.ever, a.accounts), fmt(x.period), x.source === "event" ? "app measurement" : "database"] : [x.label, "Not measured", "-", "Not measured", "app measurement (none yet)"]) } });
  } else if (kind === "documents") {
    const [d, dp, s] = await Promise.all([rpc("admin_documents", { ...A, ...p, p_page: 1, p_size: 1 }), rpc("admin_documents", { ...A, ...pp, p_page: 1, p_size: 1 }), rpc("admin_series", { ...A, ...p }).catch(() => null)]);
    const a = d.summary, b = dp.summary;
    S.push({ h: "Summary", table: { ...CMP_COLS, rows: [cmp("Records created", a.records, b.records), cmp("Files stored", a.files, b.files), cmp("Uploads completed (measured)", a.upload_completed, b.upload_completed),
      cmp("Uploads failed (measured)", a.upload_failed, b.upload_failed), cmp("PDF readings completed", a.pdf_completed, b.pdf_completed), cmp("Readings failed", a.processing_failed, b.processing_failed)] } });
    S.push({ h: "Record categories (period)", table: { cols: ["Category", "Records"], align: ["", "r"], rows: Object.entries(a.by_category).map(([k, v]) => [k, fmt(v)]) } });
    S.push({ h: "File types (period)", table: { cols: ["Type", "Files"], align: ["", "r"], rows: Object.entries(a.by_type).map(([k, v]) => [k, fmt(v)]) } });
    if (s) S.push({ h: "Day by day", table: { cols: ["Day", "Records", "Files", "Uploads failed", "Readings failed"], align: ["", "r", "r", "r", "r"], rows: s.map((x) => [x.day, fmt(x.documents), fmt(x.files), fmt(x.uploads_failed), fmt(x.processing_failed)]) } });
    if (!a.events_since) S.push({ p: "Upload and reading outcomes come from in-app measurements, which have not started yet (they are sent only for people who switched on Help improve Doctine)." });
  } else if (kind === "storage") {
    const [o, s] = await Promise.all([rpc("admin_overview", { ...A, ...p }), rpc("admin_series", { ...A, ...p }).catch(() => null)]);
    S.push({ h: "Storage now", table: { cols: ["Measure", "Value"], align: ["", "r"], rows: [["In use", mb(o.storage_bytes)], ["Limit", mb(o.storage_limit)], ["Used", pct(o.storage_bytes, o.storage_limit)], ["Files", fmt(o.storage_files)], ["Files added in period", fmt(o.files_new)]] } });
    if (s) S.push({ h: "Stored file size by day (cumulative, from file records)", table: { cols: ["Day", "Files added", "Total"], align: ["", "r", "r"], rows: s.map((x) => [x.day, fmt(x.files), mb(x.storage_total)]) } });
  } else if (kind === "availability") {
    const days = Math.max(1, Math.min(90, Math.ceil((Date.parse(p.p_to) - Date.parse(p.p_from)) / 864e5)));
    const [o, u] = await Promise.all([rpc("admin_overview", { ...A, ...p }), rpc("admin_uptime", { ...A, p_days: days })]);
    S.push({ h: "This app", table: { ...CMP_COLS, rows: [["Availability", o.availability.pct == null ? "No checks" : o.availability.pct + "%", o.availability_prev.pct == null ? "No checks" : o.availability_prev.pct + "%", "-"],
      ["Checks recorded", fmt(o.availability.checks), fmt(o.availability_prev.checks), "-"], ["Average response (ms)", fmt(o.availability.ms_avg), fmt(o.availability_prev.ms_avg), "-"]] } });
    S.push({ h: `Each service, last ${days} days`, table: { cols: ["Service", "Checks", "Passed", "Availability", "Typical ms", "Slowest 5% ms"], align: ["", "r", "r", "r", "r", "r"],
      rows: u.targets.map((t) => [t.target, fmt(t.checks), fmt(t.ok), t.checks ? pct(t.ok, t.checks) : "No checks", fmt(t.ms_p50 && Math.round(t.ms_p50)), fmt(t.ms_p95 && Math.round(t.ms_p95))]) } });
    if (!o.checks_since) S.push({ p: "No scheduled checks have been recorded yet." });
  } else if (kind === "errors") {
    const [o, e] = await Promise.all([rpc("admin_overview", { ...A, ...p }), rpc("admin_errors", { ...A, p_status: null })]);
    S.push({ h: "Summary", table: { ...CMP_COLS, rows: [cmp("Errors reported", o.app_errors, o.app_errors_prev), ["Open error groups", fmt(e.open), "-", "-"], ["Last 24 h / 7 d / 30 d", `${fmt(e.last_24h)} / ${fmt(e.last_7d)} / ${fmt(e.last_30d)}`, "-", "-"]] } });
    S.push({ h: "By category (all time)", table: { cols: ["Category", "Occurrences"], align: ["", "r"], rows: Object.entries(e.by_category).map(([k, v]) => [k, fmt(v)]) } });
    S.push({ h: "Most recent error groups", table: { cols: ["Error", "Where", "Total", "Last seen", "Status"], align: ["", "", "r", "", ""], rows: e.groups.slice(0, 40).map((g) => [`${g.kind}: ${g.message}`, g.location || "-", fmt(g.count), ist(g.last_seen), g.status]) } });
  } else if (kind === "admin_activity") {
    const r = await rpc("admin_audit", { ...A, p_admin: null, p_action: null, p_target: null, p_from: p.p_from, p_to: p.p_to, p_page: 1, p_size: 200 });
    S.push({ h: `Administrative actions (${fmt(r.total)}${r.total > 200 ? ", latest 200 shown" : ""})`, table: { cols: ["When", "Admin", "Action", "Target", "Outcome", "Reason"], align: ["", "", "", "", "", ""],
      rows: r.rows.map((x) => [ist(x.at), x.actor_email || "-", x.action, `${x.target_type || ""} ${(x.target_id || "").slice(0, 12)}`.trim(), x.outcome, x.reason || ""]) } });
  } else if (kind === "users") {
    const all = [];
    for (let page = 1; page <= 50; page++) { const r = await rpc("admin_users", { ...A, p_q: null, p_status: null, p_sort: "created_asc", p_page: page, p_size: 100, p_from: p.p_from, p_to: p.p_to }); all.push(...r.rows); if (all.length >= r.total || !r.rows.length) break; }
    S.push({ h: `Accounts registered in the period (${all.length})`, table: { cols: ["Account ID", "Email", "Registered", "Email confirmed", "Last sign-in", "Last activity", "Records", "Files", "Status", "Admin role"], align: [],
      rows: all.map((u) => [u.id, u.email, ist(u.created_at), u.email_confirmed_at ? "yes" : "no", ist(u.last_sign_in_at), ist(u.last_activity), fmt(u.records), fmt(u.files), u.suspended ? "suspended" : "active", u.admin_role || ""]) } });
  } else {
    throw Object.assign(new Error("invalid_report"), { status: 400, error: "invalid_report" });
  }
  return { kind, ...REPORTS[kind], sections: S };
}

const csvCell = (v) => { const t = v == null ? "" : String(v); const safe = /^[=+\-@\t\r]/.test(t) ? "'" + t : t; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
export function toCsv(r, p, meta) {
  const out = [`# ${r.title}`, `# ${ist(p.p_from)} to ${ist(p.p_to)} · generated ${ist(new Date().toISOString())} by ${meta.email || "an admin"} (${meta.role}) · contains no health information`];
  for (const s of r.sections) {
    out.push("");
    if (s.h) out.push(`# ${s.h}`);
    if (s.table) { out.push(s.table.cols.map(csvCell).join(",")); for (const row of s.table.rows) out.push(row.map(csvCell).join(",")); }
    if (s.p) out.push(`# ${s.p}`);
  }
  return out.join("\n") + "\n";
}
export function toPdf(r, p, meta) {
  const blocks = [{ p: r.description }];
  for (const s of r.sections) { if (s.h) blocks.push({ h: s.h }); if (s.table) blocks.push({ table: { ...s.table, align: s.table.align && s.table.align.length ? s.table.align : s.table.cols.map(() => "") } }); if (s.p) blocks.push({ p: s.p }); }
  blocks.push({ h: "Definitions" }, { p: "Active means did something with their records (added or changed a record, file, dose, medicine or profile, searched, exported or used the assistant); signing in alone does not count. Days are calendar days in India Standard Time. The previous period is the same length immediately before. This report contains no health information." });
  return makePdf({ title: `Doctine · ${r.title}`, subtitle: `${ist(p.p_from)} to ${ist(p.p_to)} · generated ${ist(new Date().toISOString())} for ${meta.email || "an admin"} (${meta.role})`, blocks });
}
