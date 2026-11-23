/**
 * Doctine · actions the records assistant may PROPOSE (docs/ASSISTANT_ACTIONS_DESIGN.md). Switch: ai_actions (off).
 *
 * First and only action: add a reminder time to a medicine the person already has, with a schedule. The server never
 * writes it: the proposal carries a signed, single-use, 5-minute confirmation (tools.mjs, level 2 "request"); when the
 * person confirms, the server re-checks everything and approves; the APP then opens its own medicine editor with the
 * new time added, the person presses Save, and the app saves and syncs as usual (one writer). Afterwards the server
 * reads the schedule back (as the person) to verify.
 */
import { LEVEL } from "./tools.mjs";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const words = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3);
const STOP = new Set(["tab", "tablet", "tablets", "cap", "capsule", "syrup", "the", "and", "for", "take", "remind", "reminder", "alarm", "set", "add", "medicine", "medication", "dose", "daily"]);
export const label12 = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`; };

/** The person's active medicines with their schedules, read as the person (row security). */
export async function medicinesWithSchedules(db) {
  const [meds, sched] = await Promise.all([
    db.select("medicines", { columns: "id,client_id,name,dose,status" }),
    db.select("medication_schedules", { columns: "medicine_id,frequency,times" }).catch(() => []),
  ]);
  const by = new Map(sched.map((x) => [x.medicine_id, x]));
  return meds.filter((m) => m.status === "active").map((m) => ({ ...m, schedule: by.get(m.id) || null }));
}

/** Which listed medicine the message names: unique match on name words, or null with a reason. */
export function matchMedicine(meds, message) {
  const said = new Set(words(message).filter((w) => !STOP.has(w)));
  const hits = meds.filter((m) => words(m.name).filter((w) => !STOP.has(w)).some((w) => said.has(w) || [...said].some((s) => s.length >= 5 && (w.startsWith(s) || s.startsWith(w)))));
  if (hits.length === 1) return { medicine: hits[0] };
  return { medicine: null, reason: hits.length ? "several" : "none", names: (hits.length ? hits : meds).slice(0, 8).map((m) => m.name) };
}

/** Checks a proposal against the person's current records. Returns { ok, medicine } or { ok:false, code, message }. */
export function checkReminder(meds, clientId, time) {
  if (!HHMM.test(String(time || ""))) return { ok: false, code: "no_time", message: "What time should the reminder be? For example: 9 pm, 21:30 or at bedtime." };
  const m = meds.find((x) => String(x.client_id) === String(clientId));
  if (!m) return { ok: false, code: "medicine_not_found", message: "That medicine isn't in your list of current medicines any more." };
  if (!m.schedule) return { ok: false, code: "as_needed", message: `${m.name} is set as "when needed", so it has no reminder times. You can change that in Medicines.` };
  const times = m.schedule.times || [];
  if (times.includes(time)) return { ok: false, code: "already_set", message: `${m.name} already has a ${label12(time)} reminder.` };
  if (times.length >= 12) return { ok: false, code: "too_many", message: `${m.name} already has the most reminder times allowed.` };
  return { ok: true, medicine: m };
}

/** The level-2 tool registered with the execution gateway when ai_actions is on. Its "run" only APPROVES. */
export function reminderTool() {
  return {
    name: "add_reminder", level: LEVEL.REQUEST,
    validate(a) {
      const out = { medicine_client_id: String(a.medicine_client_id || ""), time: String(a.time || "") };
      if (!/^\d{1,15}$/.test(out.medicine_client_id) || !HHMM.test(out.time) || Object.keys(a).some((k) => !(k in out))) throw Object.assign(new Error("Invalid reminder."), { code: "bad_args" });
      return out;
    },
    summary: (a) => `Add a ${label12(a.time)} reminder`,
    async run({ db }, a) {
      const c = checkReminder(await medicinesWithSchedules(db), a.medicine_client_id, a.time);
      if (!c.ok) throw Object.assign(new Error(c.message), { code: c.code });
      return { approved: true, action: "add_reminder", medicine_client_id: a.medicine_client_id, medicine_name: c.medicine.name, time: a.time };
    },
  };
}

/** After the app saved: does the schedule now include the time? (read as the person) */
export async function verifyReminder(db, clientId, time) {
  const m = (await medicinesWithSchedules(db)).find((x) => String(x.client_id) === String(clientId));
  return !!(m && m.schedule && (m.schedule.times || []).includes(time));
}
