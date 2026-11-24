/**
 * Doctine Guardian · normalized events and the per-event response policy.
 *
 * Every detector (a phone sensor pipeline, a watch fall event, the SOS button, a voice distress phrase, a missed
 * check-in) sends the same shape. The server validates it, clamps anything implausible, and decides the incident's
 * first state from this file's policy table — deterministically, never by asking an AI model.
 *
 * Detectors that do not exist yet (crash, phone fall, wearable alerts) are accepted here so their pipeline is ready,
 * but today only `sos`, `voice_distress` (from an open voice session) and `missed_checkin` are produced by the app.
 */
export const EVENT_TYPES = Object.freeze(["road_incident", "fall", "wearable_alert", "voice_distress", "sos", "missed_checkin", "inactivity", "device_failure"]);
export const SOURCES = Object.freeze(["app_button", "app_voice", "app_checkin", "phone_sensors", "apple_safetykit", "apple_fall_detection", "wear_os_health_services", "healthkit", "health_connect", "samsung_health", "test"]);
export const QUALITY = Object.freeze(["good", "fair", "poor", "unknown"]);

/**
 * How Doctine responds to each kind of event. Timeouts are proposed starting values (seconds), to be tuned with
 * recorded data before any automatic escalation is switched on for real people; the person can change them.
 *   open:               "confirmed" = the person asked for help (bypasses thresholds); "by_confidence" = high only when
 *                       confidence ≥ high_at with good signal quality, otherwise suspected; "suspected" always.
 *   checkin_s:          how long the check-in waits before treating silence as "no answer".
 *   escalate_on_timeout: whether silence alone tells contacts. False for signals that must never escalate alone
 *                       (a heart-rate alert, inactivity without an earlier event).
 *   max_age_s:          an event delivered later than this (e.g. queued offline) is recorded but not acted on, except an
 *                       SOS, which then asks the person first instead of escalating.
 */
export const POLICY = Object.freeze({
  sos:            { open: "confirmed",     checkin_s: 30,  escalate_on_timeout: true,  max_age_s: 1800 },
  voice_distress: { open: "confirmed",     checkin_s: 30,  escalate_on_timeout: true,  max_age_s: 600 },
  road_incident:  { open: "by_confidence", checkin_s: 30,  escalate_on_timeout: true,  max_age_s: 600, high_at: 0.8 },
  fall:           { open: "by_confidence", checkin_s: 60,  escalate_on_timeout: true,  max_age_s: 600, high_at: 0.8 },
  missed_checkin: { open: "suspected",     checkin_s: 300, escalate_on_timeout: true,  max_age_s: 3600 },
  wearable_alert: { open: "suspected",     checkin_s: 120, escalate_on_timeout: false, max_age_s: 1800 },
  inactivity:     { open: "suspected",     checkin_s: 120, escalate_on_timeout: false, max_age_s: 600 },
});
export const CORRELATE_WINDOW_S = 600;           // events this close to an open incident join it instead of opening a new one
export const CORROBORATED_AT = 0.8;              // fused confidence at which a suspected event becomes high-confidence
const RELATED = { fall: ["inactivity", "wearable_alert", "fall"], road_incident: ["inactivity", "road_incident", "fall"], wearable_alert: ["inactivity", "fall", "wearable_alert"], inactivity: ["fall", "road_incident", "wearable_alert", "inactivity"] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class EventError extends Error { constructor(code, message) { super(message || code); this.code = code; } }

const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const pickStr = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/**
 * Validates one event from a device. Returns the normalized event; throws EventError with a code for anything invalid.
 * `now` is the server's clock: the device's `observed_at` is kept, but clamped when the device clock is far off.
 */
export function normalizeEvent(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EventError("bad_event", "An event object is required.");
  const event_id = pickStr(raw.event_id, 40);
  if (!UUID.test(event_id)) throw new EventError("bad_event_id", "event_id must be a UUID made on the device.");
  const event_type = raw.event_type;
  if (!EVENT_TYPES.includes(event_type)) throw new EventError("bad_event_type", "Unknown event type.");
  const source = SOURCES.includes(raw.source) ? raw.source : null;
  if (!source) throw new EventError("bad_source", "Unknown event source.");
  if (source === "test" && raw.test !== true) throw new EventError("bad_source", "Test events must say so.");
  const confidence = num(raw.confidence, 0, 1) ?? (POLICY[event_type] && POLICY[event_type].open === "confirmed" ? 1 : 0.5);
  const signal_quality = QUALITY.includes(raw.signal_quality) ? raw.signal_quality : "unknown";
  const flags = [];
  let observed = Date.parse(raw.observed_at);
  if (!Number.isFinite(observed)) { observed = now; flags.push("observed_at_missing"); }
  if (observed > now + 5 * 60_000) { observed = now; flags.push("clock_ahead"); }
  const age_s = Math.max(0, Math.round((now - observed) / 1000));
  let location = null;
  if (raw.location && typeof raw.location === "object") {
    const lat = num(raw.location.lat, -90, 90), lng = num(raw.location.lng, -180, 180);
    if (lat !== null && lng !== null) {
      const at = Date.parse(raw.location.at);
      location = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracy_m: num(raw.location.accuracy_m, 0, 100000), at: Number.isFinite(at) ? new Date(Math.min(at, now)).toISOString() : null };
    }
  }
  // supporting features: small numbers only (never raw sensor streams), at most 12 keys
  const supporting = {};
  if (raw.supporting_features && typeof raw.supporting_features === "object") {
    for (const [k, v] of Object.entries(raw.supporting_features).slice(0, 12)) if (/^[a-z][a-z0-9_]{0,39}$/.test(k) && (typeof v === "number" ? Number.isFinite(v) : typeof v === "boolean")) supporting[k] = v;
  }
  return {
    event_id, event_type, source, confidence, signal_quality, flags, age_s, location, supporting_features: supporting,
    device_id: UUID.test(pickStr(raw.device_id, 40)) ? pickStr(raw.device_id, 40) : null,
    observed_at: new Date(observed).toISOString(), received_at: new Date(now).toISOString(),
    model_version: pickStr(raw.model_version, 40) || null,
    resolution: ["confirmed", "dismissed", "unresponsive", "rejected"].includes(raw.platform_resolution) ? raw.platform_resolution : null,
    test: raw.test === true,
  };
}

/** The opening trigger for a new incident from this event (see states.mjs NORMAL), and why. */
export function openingFor(ev) {
  if (ev.event_type === "device_failure") return { trigger: null, reason: "status_only" };
  const p = POLICY[ev.event_type];
  if (ev.age_s > p.max_age_s) return ev.event_type === "sos" ? { trigger: "open_suspected", reason: "late_sos_ask_first" } : { trigger: "open_expired", reason: "event_too_old" };
  if (p.open === "confirmed") return { trigger: "open_confirmed", reason: "person_asked_for_help" };
  if (p.open === "by_confidence" && ev.confidence >= p.high_at && ev.signal_quality === "good") return { trigger: "open_high", reason: "high_confidence_good_signal" };
  return { trigger: "open_suspected", reason: p.open === "by_confidence" ? "below_high_confidence" : "needs_check_in" };
}

/** Whether `ev` belongs to the open incident `inc` (same person is the caller's job). */
export function relatedTo(inc, ev, now = Date.now()) {
  if (!inc || Date.parse(inc.opened_at) < now - CORRELATE_WINDOW_S * 1000) return false;
  if (ev.event_type === "sos" || ev.event_type === "voice_distress") return true;          // asking for help joins whatever is open
  return (RELATED[inc.event_type] || []).includes(ev.event_type);
}

/** Independent-evidence fusion: 1 − Π(1 − c). Capped below 1 so a fused score never claims certainty. */
export const fuse = (...cs) => Math.min(0.99, 1 - cs.reduce((p, c) => p * (1 - Math.max(0, Math.min(1, c))), 1));
