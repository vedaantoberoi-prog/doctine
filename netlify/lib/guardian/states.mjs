/**
 * Doctine Guardian · the incident state machine (deterministic, auditable).
 *
 * An incident moves only along the transitions listed here, each named by a trigger. Nothing else (and never an AI
 * model) can move it. The same list is enforced a second time in the database (migration 20261125000000_guardian,
 * private.guardian_allowed_transition); tests/guardian.test.mjs checks the two lists are identical.
 *
 * NORMAL is "no open incident": it is only ever the `from` of the transition that opens one.
 * Terminal states: RESOLVED (help happened or the person is safe after contacts were told) and CANCELLED (a false
 * alarm stopped before anyone was told, or an event too old to act on).
 */
export const STATES = Object.freeze([
  "NORMAL", "SUSPECTED_EVENT", "CHECKING_IN", "POSSIBLE_EMERGENCY", "USER_CONFIRMED", "HIGH_CONFIDENCE_EVENT",
  "ESCALATING", "CONTACT_ACKNOWLEDGED", "RESOLVED", "CANCELLED", "FAILED_TO_DELIVER",
]);
export const TERMINAL = Object.freeze(["RESOLVED", "CANCELLED"]);

/** from → { trigger: to } */
export const TRANSITIONS = Object.freeze({
  NORMAL: { open_suspected: "SUSPECTED_EVENT", open_high: "HIGH_CONFIDENCE_EVENT", open_confirmed: "USER_CONFIRMED", open_expired: "CANCELLED" },
  SUSPECTED_EVENT: { checkin_start: "CHECKING_IN", corroborated: "HIGH_CONFIDENCE_EVENT", user_ok: "CANCELLED", user_help: "USER_CONFIRMED" },
  HIGH_CONFIDENCE_EVENT: { checkin_start: "CHECKING_IN", platform_unresponsive: "ESCALATING", user_ok: "CANCELLED", user_help: "USER_CONFIRMED" },
  CHECKING_IN: { checkin_timeout: "POSSIBLE_EMERGENCY", user_ok: "CANCELLED", user_help: "USER_CONFIRMED" },
  POSSIBLE_EMERGENCY: { policy_escalate: "ESCALATING", user_ok: "CANCELLED", user_help: "USER_CONFIRMED", resolve: "RESOLVED" },
  USER_CONFIRMED: { escalate: "ESCALATING", user_ok: "CANCELLED" },
  ESCALATING: { contact_ack: "CONTACT_ACKNOWLEDGED", delivery_failed: "FAILED_TO_DELIVER", user_ok: "RESOLVED", resolve: "RESOLVED" },
  FAILED_TO_DELIVER: { retry: "ESCALATING", contact_ack: "CONTACT_ACKNOWLEDGED", user_ok: "RESOLVED", resolve: "RESOLVED" },
  CONTACT_ACKNOWLEDGED: { user_ok: "RESOLVED", resolve: "RESOLVED" },
  RESOLVED: {},
  CANCELLED: {},
});
export const TRIGGERS = Object.freeze([...new Set(Object.values(TRANSITIONS).flatMap((t) => Object.keys(t)))]);

/** Flat list of [from, trigger, to], the form the database stores. */
export const TRANSITION_LIST = Object.freeze(Object.entries(TRANSITIONS).flatMap(([from, t]) => Object.entries(t).map(([trigger, to]) => [from, trigger, to])));

export const isTerminal = (s) => TERMINAL.includes(s);

/** The state `trigger` leads to from `from`, or null when that transition does not exist. */
export function nextState(from, trigger) {
  const t = TRANSITIONS[from];
  return t && Object.prototype.hasOwnProperty.call(t, trigger) ? t[trigger] : null;
}

/** States in which the person is still being asked or helped (shown as "open" in the app). */
export const OPEN_STATES = Object.freeze(STATES.filter((s) => s !== "NORMAL" && !TERMINAL.includes(s)));
