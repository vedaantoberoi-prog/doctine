/**
 * Doctine Guardian · how alerts reach trusted contacts.
 *
 * A delivery is one message to one contact on one channel. Its status only ever reports what actually happened:
 *   pending          created, not attempted yet
 *   not_configured   no provider is set up for this channel, so nothing was sent
 *   user_initiated   the person opened their own SMS/WhatsApp/phone app with the message (Doctine can't see if it went)
 *   sent             the provider accepted it (NOT proof the contact received it)
 *   delivered        the provider confirmed delivery to the handset
 *   failed           the provider refused it or it bounced
 *   acknowledged     the contact opened their link and pressed "I'm on it" — the only proof a person was reached
 *
 * No messaging provider is connected yet. `noProvider` is the only adapter: it records `not_configured` and sends
 * nothing. A real provider (SMS with DLT-registered templates, WhatsApp Business, voice) plugs in as another adapter
 * with `live: true` once there is an agreement and keys; until then the app tells the person to contact people
 * themselves and shows them how.
 */
export const DELIVERY_STATUSES = Object.freeze(["pending", "not_configured", "user_initiated", "sent", "delivered", "failed", "acknowledged"]);
export const CHANNELS = Object.freeze(["sms", "whatsapp", "voice", "manual_share"]);
/** Statuses that still might reach someone (so the incident has not failed to deliver). */
export const REACHING = Object.freeze(["pending", "sent", "delivered", "acknowledged"]);

export const noProvider = Object.freeze({
  name: "none", live: false, channels: ["sms", "whatsapp", "voice"],
  async send() { return { status: "not_configured", error: "no_provider" }; },
});

/** The adapter to use. Only `none` exists today; the env var is read so a future adapter can't be enabled by accident. */
export function deliveryAdapter(env = process.env) {
  const want = String(env.GUARDIAN_DELIVERY_PROVIDER || "none").toLowerCase();
  if (want !== "none") return { ...noProvider, requested: want, note: "unknown_provider_falls_back_to_none" };
  return noProvider;
}
