/**
 * Doctine · request classification, deterministic (no model): what kind of request this is, how risky, whether it needs
 * the person's records, and which rules apply. A model never decides this, so a crafted message can't talk its way
 * into a different category.
 */
import { emergencyCheck } from "../safety.mjs";
import { understand } from "../evidence/query.mjs";
import { INSTRUCTION_LIKE } from "../evidence/investigate.mjs";

// asking for somebody else's records, or naming a person or account by id
const OTHER_PERSON = /\b(my|his|her|their)\s+(wife|husband|son|daughter|mother|mom|mum|father|dad|brother|sister|friend|patient|child|kid|parent|partner|grand(mother|father|ma|pa))'?s?\b.{0,40}\b(report|reports|record|records|result|results|cholesterol|sugar|values?|labs?|data|medicines?)\b|\b(patient|user|account|person)\s*(id|number|#)\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(someone|somebody|another (person|patient|user))('s)?\s+(report|records?|results?)\b/i;
// things only a write tool could do; none are enabled
const ACTION = /\b(remind me|set (a |an )?(reminder|alarm)|book (an?|my) (appointment|test|consultation|slot|visit)|schedule (an?|my) |cancel (my |the )?(appointment|booking)|(delete|remove|erase) (my|this|that|the|all)\b|share (my|this|these|it)|send (my|this|these|it)|email (my|this|it)|change my (dose|medicines?|medication)|place (an )?order|order (more|new|my|a)|buy |refill)/i;
// a reminder for a medicine already listed: the one action the assistant may PROPOSE (switch ai_actions)
const REMIND = /\b(remind me|set (a |an )?(reminder|alarm)|add (a |an )?(reminder|alarm)|reminder (for|to))\b/i;
const PRESET = [[/\b(morning|breakfast)\b/i, "08:00"], [/\b(afternoon|lunch)\b/i, "14:00"], [/\b(evening|dinner)\b/i, "20:00"], [/\b(bed ?time|night)\b/i, "22:00"]];
/** "9 pm", "9:30pm", "21:00", "at bedtime" → "HH:MM", or null. */
export function parseTime(text) {
  const t = String(text || "");
  let m = /\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i.exec(t);
  if (m) { let h = +m[1] % 12; if (/^p/i.test(m[3])) h += 12; return `${String(h).padStart(2, "0")}:${m[2] || "00"}`; }
  m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(t);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  for (const [re, hhmm] of PRESET) if (re.test(t)) return hhmm;
  return null;
}
const RECORD_HINT = /\b(my|mine|i had|i've had|have i)\b/i;

export const CATEGORIES = ["emergency", "other_person", "injection", "action_request", "record_question", "general_health", "unclear"];

export function classify(message, { today } = {}) {
  const text = String(message || "").slice(0, 2000);
  const flags = emergencyCheck(text);
  if (flags.length) return { category: "emergency", risk: 3, needs_records: false, emergency_flags: flags, reason: "emergency wording" };
  if (OTHER_PERSON.test(text)) return { category: "other_person", risk: 3, needs_records: false, reason: "asks for another person's records or names an id" };
  if (INSTRUCTION_LIKE.test(text)) return { category: "injection", risk: 3, needs_records: false, reason: "tries to change the assistant's rules" };
  if (REMIND.test(text) && !/\b(delete|remove|cancel|stop)\b/i.test(text)) return { category: "action_request", action: "add_reminder", risk: 2, needs_records: true, time: parseTime(text), reason: "asks for a medicine reminder (an action the assistant may only propose)" };
  if (ACTION.test(text)) return { category: "action_request", risk: 2, needs_records: false, reason: "asks for an action that changes or sends something" };
  const plan = understand(text, { today });
  if (plan.strategy === "general_knowledge") return { category: "general_health", risk: 1, needs_records: false, plan: summary(plan), reason: "what something means" };
  if (plan.concepts.length || plan.tests.length || RECORD_HINT.test(text)) return { category: "record_question", risk: 1, needs_records: true, plan: summary(plan), reason: `intent ${plan.intent}` };
  return { category: "unclear", risk: 1, needs_records: false, plan: summary(plan), reason: "no records or health topic recognised" };
}

const summary = (p) => ({ intent: p.intent, strategy: p.strategy, concepts: p.concepts.map((c) => c.key), tests: p.tests, dates: p.dates });
