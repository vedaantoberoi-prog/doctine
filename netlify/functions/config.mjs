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
  return json({ supabaseUrl: url.replace(/\/$/, ""), supabaseAnonKey: anon, accounts: "supabase", environment: env });
};

export const config = { path: "/api/config" };
