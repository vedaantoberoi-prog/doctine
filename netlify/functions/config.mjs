/**
 * Doctine · /api/config — public settings the browser needs to sign people in.
 * SUPABASE_ANON_KEY is designed to be public: row-level security in the database decides what anyone can read or write.
 * Never put SUPABASE_SERVICE_ROLE_KEY here.
 */
import { json } from "../lib/ai.mjs";

/* Which kind of site this is, so smoke checks and the live evaluation can confirm they are pointed at staging.
   Only known names are reported; anything else (including unset) reads as "unset". */
const ENVS = ["production", "staging", "eval", "test", "development"];
export const environment = (v = process.env.DOCTINE_ENV) => (ENVS.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : "unset");

export default async () => {
  const env = environment();
  const url = process.env.SUPABASE_URL || "";
  const anon = process.env.SUPABASE_ANON_KEY || "";
  if (!url || !anon) return json({ supabaseUrl: null, supabaseAnonKey: null, accounts: "browser_demo", environment: env });
  // AUTH_GOOGLE=true only after Google is switched on in this Supabase project (Authentication → Sign In / Providers);
  // otherwise the button would send people to an error page.
  const googleSignIn = String(process.env.AUTH_GOOGLE || "").toLowerCase() === "true";
  return json({ supabaseUrl: url.replace(/\/$/, ""), supabaseAnonKey: anon, accounts: "supabase", environment: env, googleSignIn });
};

export const config = { path: "/api/config" };
