/**
 * Doctine · headers for server-side Supabase calls made with the privileged key.
 * Supabase has two kinds of privileged key: the legacy `service_role` key (a JWT, sent as both `apikey` and
 * `Authorization: Bearer`) and the newer secret key (`sb_secret_…`, not a JWT, sent on `apikey` only — Supabase says
 * not to put it in `Authorization`). Legacy keys are being retired by the end of 2026, so both are accepted here and
 * switching is just a change of the SUPABASE_SERVICE_ROLE_KEY setting.
 */
export const isNewKey = (key) => typeof key === "string" && /^sb_(secret|publishable)_/.test(key);
export function serviceHeaders(key, extra = {}) {
  return isNewKey(key) ? { apikey: key, ...extra } : { apikey: key, authorization: `Bearer ${key}`, ...extra };
}
