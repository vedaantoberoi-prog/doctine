/**
 * Doctine · deterministic emergency check, run on every message BEFORE the AI.
 * It does not depend on the model, so urgent guidance still appears if the AI is down.
 * It errs towards flagging: a false alarm costs a sentence, a miss can cost a life.
 */

const RULES = [
  { id: "chest", re: /\b(chest|seene|seena|chhati|chhaati)\b[^.?!]{0,40}\b(pain|pressure|tight|tightness|heavy|heaviness|squeez|crush|dard|bhaari|bhari)/i },
  { id: "chest", re: /\b(cold sweat|sweating|sweaty|paseena|pasina)\b[^.?!]{0,60}\b(chest|jaw|left arm|seene|seena)\b|\b(chest|jaw|left arm|seene|seena)\b[^.?!]{0,60}\b(cold sweat|sweating|sweaty|paseena|pasina)\b/i },
  { id: "chest", re: /\b(heart attack|cardiac arrest)\b/i },
  { id: "chest", re: /\b(pain|dard)\b[^.?!]{0,30}\b(chest|chhati|chhaati|seene|seena)\b|\bdil\b[^.?!]{0,15}\b(dard|pain)\b/i },
  { id: "breathing", re: /\b(can'?t|cannot|can not|unable to|hard to|difficult(y)? (to )?|struggling to|trouble)\s*(breathe|breathing|catch (my|his|her) breath)|\bsaans\b[^.?!]{0,25}\b(nahi|nahin|phool|takleef|dikkat)|\b(gasping|choking|turning blue|lips (are )?blue)\b/i },
  { id: "stroke", re: /\b(face (is )?(drooping|droop)|slurred speech|sudden(ly)? (numb|weak)|one side (of (my|his|her) body )?(is )?(numb|weak|paraly)|can'?t (move|feel) (my|his|her) (arm|leg)|stroke)\b/i },
  { id: "stroke", re: /\b(can'?t|cannot|unable to) (speak|talk) (properly|clearly)\b|\bsudden(ly)?\b[^.?!]{0,30}\b(can'?t|cannot|unable to) (speak|talk|see)\b|\b(mooh|muh|munh)\b[^.?!]{0,10}\b(tedha|tirchha|latak)|\b(haath|hath|pair)\b[^.?!]{0,15}\b(sunn|sun|kamzor|nahi hil)/i },
  { id: "unconscious", re: /\b(unconscious|passed out|fainted|not waking|won'?t wake|unresponsive|behosh)\b/i },
  { id: "seizure", re: /\b(seizure|convuls|fits?\b|mirgi)/i },
  { id: "bleeding", re: /\b(bleeding (heavily|a lot|won'?t stop|wont stop|non ?stop)|heavy bleeding|blood (won'?t|wont) stop|vomiting blood|coughing (up )?blood|blood in vomit|khoon (ki )?ulti)\b/i },
  { id: "allergy", re: /\b(anaphyla|throat (is )?(closing|swelling|swollen)|tongue (is )?swell|face (is )?swell(ing)? (up|after))/i },
  { id: "poison", re: /\b(overdose|took (too many|a lot of|\d{2,}) ([a-z]+ ){0,2}(pills|tablets|capsules)|swallowed (some |a few |many |all )?(of )?(my |his |her |the )?([a-z]+ ){0,2}(pills|tablets|medicine)|swallowed (poison|bleach|acid|pesticide)|poison(ed|ing)?|zeher|keetnashak)\b/i },
  { id: "poison", re: /\b(drank|drunk|swallowed|ate|pi liya|pee liya|kha liya|nigal liya)\b[^.?!]{0,30}\b(kerosene|phenyl|bleach|acid|pesticide|insecticide|harpic|toilet cleaner|mitti ka tel|chuha ?maar)|\b(kerosene|phenyl|bleach|pesticide|insecticide|harpic|toilet cleaner|mitti ka tel|chuha ?maar)\b[^.?!]{0,25}\b(pi liya|pee liya|kha liya|nigal liya|drank|drunk|swallowed)/i },
  { id: "self_harm", re: /\b(kill (my ?self|myself)|suicid|end (my|it all|my life)|want to die|don'?t want to (live|be alive)|self[- ]?harm|hurt(ing)? myself|cut(ting)? myself|mar jaana|marna chahta|marna chahti|jeena nahi|khudkushi|aatmahatya|atmahatya|(no|any|the) point (in )?(living|being alive|going on)|better off without me|can'?t go on (living|anymore)|nahi jeena)/i },
  { id: "child", re: /\b(baby|infant|newborn|toddler|child|kid|son|daughter|bacch?a|bacch?e|beta|beti|\d+\s*(year|yr|month)s?[- ]old)\b[^.?!]{0,80}\b(not breathing|turning blue|limp|won'?t (feed|wake)|hard to wake|very sleepy|drowsy|unresponsive|seizure|fits|stiff neck|not feeding|swallowed)/i },
  { id: "infant", re: /\b(baby|infant|newborn|month[- ]old)\b[^.?!]{0,60}\b(not breathing|blue|limp|won'?t (feed|wake)|fever|seizure|fits)\b/i },
  { id: "head", re: /\b(worst headache (of my life|ever)|thunderclap headache|head injury[^.?!]{0,40}(vomit|confus|sleepy|unconscious))\b/i },
  { id: "pregnancy", re: /\b(pregnan\w*)\b[^.?!]{0,60}\b(bleeding|severe pain|severe headache|blurr(y|ed) vision|fits|seizure|baby not moving|water broke|face (is )?swollen)\b/i },
  { id: "pregnancy", re: /\b(pregnan\w*|garbh\w*)\b[^.?!]{0,60}\b(khoon|bahut dard|tez dard|fits|baccha hil nahi)/i },
];

/** The patterns, for tools/sync-safety-rules.mjs (which copies them into the web page). */
export const RULE_LIST = RULES;

/** Returns the ids of matched emergency patterns in the latest message (empty array when none). */
export function emergencyCheck(text) {
  const t = String(text || "");
  const ids = [];
  for (const r of RULES) if (r.re.test(t) && !ids.includes(r.id)) ids.push(r.id);
  return ids;
}

/** Fixed guidance used when the rules fire. Safety text only: no medical claims about the person. */
export function emergencyGuidance(ids) {
  const selfHarm = ids.includes("self_harm");
  const reply = selfHarm
    ? "I’m really glad you told me. What you’re feeling matters, and you don’t have to handle it alone. If you might act on these thoughts or are in danger right now, call 112 or go to the nearest emergency department. You can also call Tele-MANAS, India’s free mental health helpline, on 14416 (or 1-800-891-4416) any time, day or night, to talk to a trained counsellor. If you can, reach out to someone you trust and let them know how you’re feeling."
    : "What you’ve described can be a sign of a medical emergency. Please call 112 now, or have someone take you to the nearest emergency department straight away. Don’t wait to see if it gets better, and don’t drive yourself if you feel unwell. If someone is with you, tell them what is happening.";
  return {
    reply,
    sections: [],
    urgency: "emergency",
    uncertainty: "",
    safety_note: selfHarm ? "" : "If the person is unconscious and not breathing normally, call 112 and follow the call handler’s instructions.",
    question: "",
    options: [],
    record_claims: [],
    safety: "rule",
  };
}
