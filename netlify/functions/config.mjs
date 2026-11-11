/**
 * Doctine · /api/config — public settings the browser needs to sign people in.
 * SUPABASE_ANON_KEY is designed to be public: row-level security in the database decides what anyone can read or write.
 * Never put SUPABASE_SERVICE_ROLE_KEY here.
 */
import { json } from "../lib/ai.mjs";
import { getSettings } from "../lib/settings.mjs";

/* Which kind of site this is, so smoke checks and the live evaluation can confirm they are pointed at staging.
   Only known names are reported; anything else (including unset) reads as "unset". */
const ENVS = ["production", "staging", "eval", "test", "development"];
export const environment = (v = process.env.DOCTINE_ENV) => (ENVS.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : "unset");

export function isPublicKey(k) {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(k)) return true;
  if (/^sb_/.test(k)) return false;
  try { return JSON.parse(Buffer.from(String(k).split(".")[1] || "", "base64url").toString()).role === "anon"; } catch { return false; }
}

export default async () => {
  const env = environment();
  const url = process.env.SUPABASE_URL || "";
  const anon = process.env.SUPABASE_ANON_KEY || "";
  if (!url || !anon) return json({ supabaseUrl: null, supabaseAnonKey: null, accounts: "browser_demo", environment: env });
  // Refuse to publish a privileged key pasted into SUPABASE_ANON_KEY by mistake: a new secret key (sb_secret_…) or a
  // legacy JWT whose role isn't "anon". Only a publishable key (sb_publishable_…) or a legacy anon key goes to browsers.
  if (!isPublicKey(anon)) { console.error("[config] SUPABASE_ANON_KEY is not a public key; refusing to publish it"); return json({ error: "misconfigured" }, 500); }
  // AUTH_GOOGLE=true only after Google is switched on in this Supabase project (Authentication → Sign In / Providers);
  // otherwise the button would send people to an error page.
  const googleSignIn = String(process.env.AUTH_GOOGLE || "").toLowerCase() === "true";
  // Only whether an AI model is switched on, so the app can say so up front. Never the key itself.
  // Platform switches, maintenance and live announcements set in the admin console (safe defaults if unavailable).
  const st = await getSettings();
  const aiAvailable = Boolean(process.env.ANTHROPIC_API_KEY) && st.flags.ai_assistant === true;
  return json({ supabaseUrl: url.replace(/\/$/, ""), supabaseAnonKey: anon, accounts: "supabase", environment: env, googleSignIn, aiAvailable,
    features: st.flags, maintenance: st.maintenance, announcements: st.announcements, settingsSource: st.source });
};

export const config = { path: "/api/config" };
