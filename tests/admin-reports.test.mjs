import { readFileSync } from "node:fs";
/**
 * Doctine · every admin report (CSV and PDF) built from data shaped like the real database output
 * (tests/browser/fixtures/admin-shapes.json), empty and busy. Fails on a throw, "undefined", "NaN", "Invalid Date",
 * "[object Object]", "null%" or "Infinity" in the output, or a PDF that isn't one. Fictional values only.
 */
import { REPORTS, buildReport, toCsv, toPdf } from "../netlify/lib/reports.mjs";
const src = readFileSync(new URL("./browser/admin-shapes.test.mjs", import.meta.url), "utf8");
// reuse the sweep's data builder
const m = await import("data:text/javascript," + encodeURIComponent(src.slice(src.indexOf("const SH ="), src.indexOf("const errs =")).replace(/readFileSync\(new URL\("\.\.\/\.\.\/supabase\/migrations\/([^"]+)", import\.meta\.url\), "utf8"\)/, (m, f) => JSON.stringify(readFileSync(new URL("../supabase/migrations/" + f, import.meta.url), "utf8"))).replace('JSON.parse(readFileSync(new URL("./fixtures/admin-shapes.json", import.meta.url), "utf8"))', JSON.stringify(JSON.parse(readFileSync(new URL("./browser/fixtures/admin-shapes.json", import.meta.url), "utf8")))) + "\nexport { make };"));
const MAP = { admin_overview: "overview", admin_series: "series", admin_engagement: "engagement", admin_funnel: "funnel", admin_adoption: "adoption", admin_documents: "documents", admin_uptime: "uptime", admin_errors: "errors", admin_audit: "audit", admin_users: "users" };
let problems = 0;
for (const mode of ["empty", "busy"]) {
  const D = m.make(mode);
  const rpc = async (fn) => { const k = MAP[fn]; if (!k) throw new Error("unmapped " + fn); return structuredClone(D[k]); };
  const p = { p_from: new Date(Date.now() - 30 * 864e5).toISOString(), p_to: new Date().toISOString() };
  for (const kind of Object.keys(REPORTS)) {
    try {
      const r = await buildReport(kind, "x", p, rpc);
      const csv = toCsv(r, p, { email: "owner@example.test", role: "owner" });
      const pdf = toPdf(r, p, { email: "owner@example.test", role: "owner" });
      const txt = csv + "\n" + Buffer.from(pdf).toString("latin1");
      for (const w of ["undefined", "NaN", "Invalid Date", "[object Object]", "null%", "Infinity"]) if (txt.includes(w)) { problems++; console.log(`${mode} ${kind}: "${w}" … ${txt.slice(Math.max(0, txt.indexOf(w) - 80), txt.indexOf(w) + 20).replace(/\n/g, " / ")}`); }
      if (!Buffer.from(pdf).toString("latin1").startsWith("%PDF")) { problems++; console.log(`${mode} ${kind}: not a PDF`); }
    } catch (e) { problems++; console.log(`${mode} ${kind}: THREW ${e.message}`); }
  }
}
console.log(problems ? problems + " report problems" : "all 20 report builds clean (10 reports × empty/busy, CSV + PDF)");
process.exit(problems ? 1 : 0);
