/**
 * Doctine · test the gateway against the STAGING database without anyone's password.
 *
 *   node tools/staging-replay.mjs sql <uid>          → SQL that runs every read the gateway's test plans make, AS that
 *                                                      person (role authenticated + their id), so the real row security,
 *                                                      real columns and real trigger-built rows are what answers.
 *   node tools/staging-replay.mjs check <a.json> <b.json>  → replays the plans on those real rows and checks the results.
 * Only for the FICTIONAL staging accounts made by tools/staging-seed.mjs.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { userDb } from "../netlify/lib/gateway/db.mjs";
import { CAPABILITIES } from "../netlify/lib/gateway/registry.mjs";
import { executeWorkflow } from "../netlify/lib/gateway/executor.mjs";
import { FICTIONAL } from "./staging-seed.mjs";

export const PLANS = [
  ...CAPABILITIES.map((c) => ({ name: c.name, plan: { steps: [{ id: "s", call: c.name, args: c.examples[0].args }] } })),
  ...["ldl", "hba1c", "cholesterol", "c-reactive protein", "triglycerides", ""].map((t) => ({ name: "compare " + (t || "all"), plan: { steps: [{ id: "c", call: "compare_lab_results", args: t ? { test: t } : {} }] } })),
  { name: "medicines current", plan: { steps: [{ id: "m", call: "get_medications", args: { status: "current" } }] } },
  { name: "prescriptions all", plan: { steps: [{ id: "p", call: "get_prescriptions", args: {} }] } },
  { name: "documents all", plan: { steps: [{ id: "d", call: "search_documents", args: { limit: 50 } }] } },
];
const keyOf = (url) => { const u = new URL(url); const p = [...u.searchParams].sort().map(([k, v]) => `${k}=${v}`).join("&"); return createHash("sha256").update(u.pathname + "?" + p).digest("hex").slice(0, 12); };

async function recordUrls() {
  const urls = new Map();
  const fetchImpl = async (url) => { urls.set(keyOf(url), url); return new Response("[]", { status: 200 }); };
  const db = () => userDb({ base: "https://staging.invalid", anon: "anon", token: "t", fetchImpl });
  for (const p of PLANS) await executeWorkflow(p.plan, { db: db() }).catch(() => {});
  return urls;
}
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
function toSql(url) {
  const u = new URL(url), table = u.pathname.replace("/rest/v1/", "");
  if (!/^[a-z_]+$/.test(table)) throw new Error("bad table");
  const sel = u.searchParams.get("select");
  const cols = []; let embed = null;
  for (const part of sel.match(/[a-z_]+\([^)]*\)|[a-z0-9_*]+/g)) {
    if (part.includes("(")) embed = part; else cols.push(part);
  }
  let colSql = cols.join(", ");
  if (embed) {
    const [, et, ec] = embed.match(/^([a-z_]+)\(([^)]*)\)$/);
    if (table !== "prescriptions" || et !== "prescription_items") throw new Error("unsupported embed");
    colSql += `, (select coalesce(json_agg(json_build_object(${ec.split(",").map((c) => `'${c}', i.${c}`).join(", ")}) order by i.position), '[]'::json) from public.prescription_items i where i.prescription_id = x.id) as prescription_items`;
  }
  const where = [];
  for (const [k, v] of u.searchParams) {
    if (["select", "order", "limit"].includes(k)) continue;
    const [op, ...rest] = v.split("."); const val = rest.join(".");
    if (op === "eq") where.push(`${k} = ${lit(val)}`);
    else if (op === "gte") where.push(`${k} >= ${lit(val)}`);
    else if (op === "lte") where.push(`${k} <= ${lit(val)}`);
    else if (op === "in") where.push(`${k} in (${val.replace(/^\(|\)$/g, "").split(",").map((s) => lit(s.replace(/^"|"$/g, ""))).join(", ")})`);
    else throw new Error("unsupported filter " + op);
  }
  const ord = u.searchParams.get("order");
  const ordSql = ord ? " order by " + ord.split(",").map((o) => { const [c, d, n] = o.split("."); return `${c} ${d === "desc" ? "desc" : "asc"}${n === "nullslast" ? " nulls last" : n === "nullsfirst" ? " nulls first" : ""}`; }).join(", ") : "";
  return `(select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select ${colSql} from public.${table} x${where.length ? " where " + where.join(" and ") : ""}${ordSql} limit ${+u.searchParams.get("limit") || 1000}) t)`;
}

const mode = process.argv[2];
if (mode === "sql") {
  const uid = process.argv[3];
  if (!FICTIONAL.some((f) => f.uid === uid)) { console.error("only the fictional staging accounts"); process.exit(1); }
  const urls = await recordUrls();
  const parts = [...urls].map(([k, url]) => `'${k}', ${toSql(url)}`);
  console.log(`begin; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true); select json_build_object(${parts.join(",\n ")})::text r;`);
} else if (mode === "check") {
  const [a, b] = [process.argv[3], process.argv[4]].map((f) => JSON.parse(readFileSync(f, "utf8")));
  const run = async (rows, name) => {
    const fetchImpl = async (url) => { const k = keyOf(url); if (!(k in rows)) throw new Error("no recorded rows for " + url); return new Response(JSON.stringify(rows[k]), { status: 200 }); };
    const db = () => userDb({ base: "https://staging.invalid", anon: "anon", token: "t", fetchImpl });
    const out = {};
    for (const p of PLANS) out[p.name] = await executeWorkflow(p.plan, { db: db() }).then((r) => r.results[0].value).catch((e) => ({ error: e.code, message: e.message }));
    return out;
  };
  const A = await run(a, "A"), B = await run(b, "B");
  const checks = [];
  const ok = (cond, what) => checks.push([!!cond, what]);
  const errs = Object.entries(A).filter(([, v]) => v && v.error);
  ok(!errs.length, `every plan ran on the real staging schema (${PLANS.length} plans)${errs.length ? ": " + errs.map(([k, v]) => k + " " + v.message).join("; ") : ""}`);
  const docsA = A["documents all"].documents, docsB = B["documents all"].documents;
  ok(docsA.length === 11 && docsB.length === 5, `row security: A sees ${docsA.length} documents, B sees ${docsB.length} (expected 11 and 5)`);
  ok(!docsA.some((d) => docsB.some((x) => x.id === d.id)), "no document is visible to both people");
  const ldl = A["compare ldl"].series[0];
  ok(ldl && ldl.groups.length === 1 && ldl.groups[0].unit === "mg/dL", "LDL: one comparable group in mg/dL");
  ok(ldl.groups[0].points.length === 7, `LDL: 7 dated values compared (got ${ldl.groups[0].points.length}); the undated report kept apart (${ldl.undated.length})`);
  ok(ldl.lab_reports_without_this_test.length === 2, `LDL: 2 lab reports without LDL listed as missing (got ${ldl.lab_reports_without_this_test.length})`);
  ok(ldl.names_seen.includes("LDL-C") && ldl.cautions.some((c) => /Grouped under one name/.test(c)), "LDL: 'LDL-C' grouped with 'LDL Cholesterol', and the grouping is stated");
  ok(ldl.groups[0].points.some((p) => p.verification === "ai_extracted_unconfirmed") && ldl.groups[0].points.some((p) => p.verification === "confirmed_by_person"), "LDL: AI readings built by the real trigger are labelled unconfirmed; typed values confirmed");
  const hb = A["compare hba1c"].series[0];
  ok(hb.groups.map((g) => g.unit).sort().join() === "%,mmol/mol", "HbA1c: % and mmol/mol kept apart, never converted");
  const crp = A["compare c-reactive protein"].series[0];
  ok(crp.not_compared.some((p) => p.value_text === "< 0.5 mg/L"), "CRP: '< 0.5' shown but not compared");
  const tg = A["compare triglycerides"].series[0];
  ok(tg.not_compared.some((p) => p.value_text === "1,6"), "Triglycerides: comma value shown but not compared");
  const chol = A["compare cholesterol"].series.map((s) => s.test).sort().join();
  ok(chol === "hdl cholesterol,ldl cholesterol", `'cholesterol' returns HDL and LDL as separate series (${chol})`);
  ok(A.get_allergies.entries.length === 2 && A.get_allergies.entries.some((e) => e.certainty === "suspected"), "allergies: confirmed and suspected kept distinct");
  ok(A["prescriptions all"].prescriptions[0].items[0].verification === "prescription_line_unconfirmed", "prescription line from the real trigger is unconfirmed");
  ok(A["medicines current"].entries.map((m) => m.name).join() === "Levothyroxine", "current medicines: only the active one");
  ok(!/\+91|fictional@example|Fictional Contact|1980-06-15/.test(JSON.stringify(A)), "no contact details or date of birth in any result");
  ok(docsA.some((d) => /IGNORE ALL PREVIOUS/.test(d.title)), "the injection title comes back as plain data");
  let bad = 0;
  for (const [pass, what] of checks) { console.log(`${pass ? "PASS" : "FAIL"} ${what}`); if (!pass) bad++; }
  console.log(`\nstaging replay: ${checks.length - bad} passed, ${bad} failed`);
  if (bad) process.exit(1);
}
