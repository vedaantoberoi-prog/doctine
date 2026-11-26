#!/usr/bin/env node
/**
 * Doctine Model Lab · baseline B0: the lab-report reader that ships in the app today (parseText in public/index.html,
 * run on the device for PDF text layers and on-device OCR text). It is loaded from the app file itself at run time,
 * never copied, so the benchmark always measures the code users actually get.
 *
 * stdin: JSON lines {id, text}   stdout: JSON lines {id, prediction: {date, facility, lab_results:[{test,value,unit,range,flag}]}, unreadable: n}
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const start = html.indexOf("const NUM="), end = html.indexOf("/* Libraries from public CDNs");
if (start < 0 || end < start) { console.error("app_parser: parseText not found in public/index.html"); process.exit(2); }
const parseText = new Function(html.slice(start, end) + "\nreturn parseText;")();

// The app shows each row as {k: test, v: "13.5 g/dL (ref 13–17) · marked high on the report"}: turn it back into fields.
export function fieldsOf(row) {
  const m = row.v.match(/^(\S+)(?: (.+?))? \(ref (.+?)\)(?: · marked (high|low|abnormal) on the report)?$/);
  if (!m) return { test: row.k, value: row.v, unit: "", range: "", flag: "" };
  return { test: row.k, value: m[1], unit: m[2] || "", range: m[3].replace("–", " - "), flag: m[4] === "high" ? "H" : m[4] === "low" ? "L" : m[4] ? "*" : "" };
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const { id, text } = JSON.parse(line);
  const pages = text.split(/^--- page \d+ ---$/m);
  const r = parseText(pages);
  const unreadable = (r.warns.find((w) => /looked like/.test(w)) || "").match(/^(\d+)/);
  process.stdout.write(JSON.stringify({ id, prediction: { date: r.date, facility: r.lab, lab_results: r.rows.map(fieldsOf) }, unreadable: unreadable ? +unreadable[1] : 0 }) + "\n");
}
