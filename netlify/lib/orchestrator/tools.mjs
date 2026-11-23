/**
 * Doctine · tool registry policy and the execution gateway.
 *
 * Every capability the orchestrator can run has a permission level:
 *   0 read · 1 draft (nothing saved or sent) · 2 request (proposes a change; needs confirmation)
 *   3 execute after confirmation · 4 human-privileged (never run by the AI)
 * The 16 gateway capabilities are level 0. No write capability is registered: server-side writes would race the app's
 * own sync of the person's records, so they are designed (confirmation tokens below) but not switched on.
 *
 * Execution is deterministic: the gateway, not the model, binds the call to the signed-in person (their own database
 * client); arguments are checked against the capability's schema; any argument that names a person or account is
 * refused, never silently dropped; level 2-3 calls return a confirmation request and run only with a fresh, single-use
 * token signed by the server for exactly this person, tool and arguments; each call leaves an audit record (names,
 * timings, counts; no values).
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BY_NAME, validateArgs } from "../gateway/registry.mjs";
import { POLICY } from "./policy.mjs";

export const LEVEL = Object.freeze({ READ: 0, DRAFT: 1, REQUEST: 2, EXECUTE_CONFIRMED: 3, HUMAN: 4 });
const IDENTITY_KEY = /^(user|patient|person|owner|account|subject|member|profile)(_?id|_?uuid)?$|^(uid|user_?id|patient_?id|on_behalf_of|as_user|impersonate)$/i;

const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}` : JSON.stringify(v ?? null);
const argsHash = (a) => createHash("sha256").update(stable(a)).digest("hex").slice(0, 24);

export function createToolGateway({ secret = process.env.ORCHESTRATOR_SECRET || "", extra = [], now = Date.now, audit = () => {}, nonces = null } = {}) {
  const tools = new Map();
  for (const [name, cap] of BY_NAME) tools.set(name, { name, level: LEVEL.READ, input: cap.input, run: (ctx, args) => cap.run({ db: ctx.db }, args), validate: (args) => validateArgs(cap, args) });
  for (const t of extra) tools.set(t.name, { validate: (a) => a, ...t });
  // single-use confirmation nonces and their results; pass `nonces` to keep them across requests on this server.
  // Across servers a replay is still harmless for the only action (a second identical reminder is refused as already set).
  const used = (nonces && nonces.used) || new Set();
  const done = (nonces && nonces.done) || new Map();

  function sign(payload) { return createHmac("sha256", secret).update(payload).digest("base64url"); }
  function confirmationFor(envelope, name, args) {
    const exp = Math.floor(now() / 1000) + POLICY.tools.confirmation_ttl_s, nonce = randomBytes(9).toString("base64url");
    const payload = [envelope.subject, name, argsHash(args), exp, nonce].join(".");
    return { token: payload + "." + sign(payload), expires_at: new Date(exp * 1000).toISOString() };
  }
  function checkConfirmation(envelope, name, args, token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 6) return "malformed";
    const [subject, tool, h, exp, nonce, mac] = parts, payload = parts.slice(0, 5).join(".");
    const want = Buffer.from(sign(payload)), got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return "bad_signature";
    if (subject !== envelope.subject) return "other_person";
    if (tool !== name || h !== argsHash(args)) return "different_action";
    if (+exp < Math.floor(now() / 1000)) return "expired";
    if (used.has(nonce)) return "already_used";
    return { nonce };
  }

  /** Run one tool for the signed-in person. Returns { status, result?, confirmation?, error?, audit }. Never throws. */
  async function execute(envelope, name, rawArgs = {}, { confirmation } = {}) {
    const t0 = now();
    const rec = (status, extraA = {}) => { const a = { tool: name, level: tools.has(name) ? tools.get(name).level : null, status, ms: now() - t0, arg_keys: Object.keys(rawArgs || {}).slice(0, 10), ...extraA }; audit(a); return a; };
    const t = tools.get(name);
    if (!t) return { status: "refused", error: "unknown_tool", audit: rec("refused", { error: "unknown_tool" }) };
    if (!envelope || !envelope.db) return { status: "refused", error: "no_identity", audit: rec("refused", { error: "no_identity" }) };
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
    const idKeys = Object.keys(args).filter((k) => IDENTITY_KEY.test(k));
    if (idKeys.length) return { status: "refused", error: "identity_in_args", message: "The person is always the signed-in person; tools take no person or account argument.", audit: rec("refused", { error: "identity_in_args" }) };
    let clean;
    try { clean = t.validate(args); } catch (e) { return { status: "refused", error: e.code || "bad_args", message: e.message, audit: rec("refused", { error: "bad_args" }) }; }
    if (t.level >= LEVEL.HUMAN) return { status: "refused", error: "human_privileged", message: "Only a person on the Doctine team can do this.", audit: rec("refused", { error: "human_privileged" }) };
    if (t.level >= LEVEL.REQUEST) {
      if (!secret) return { status: "refused", error: "confirmations_not_configured", audit: rec("refused", { error: "no_secret" }) };
      if (!confirmation) return { status: "confirmation_required", confirmation: confirmationFor(envelope, name, clean), summary: t.summary ? t.summary(clean) : `Run ${name}`, audit: rec("confirmation_required") };
      const ok = checkConfirmation(envelope, name, clean, confirmation);
      if (typeof ok === "string") return { status: "refused", error: "confirmation_" + ok, audit: rec("refused", { error: "confirmation_" + ok }) };
      if (done.has(ok.nonce)) return { ...done.get(ok.nonce), replay: true };
      used.add(ok.nonce);
      try {
        const result = await t.run({ db: envelope.db }, clean);
        const out = { status: "done", result, audit: rec("done") };
        done.set(ok.nonce, out);
        if (t.verify) { const v = await t.verify({ db: envelope.db }, clean, result); out.verified = !!v; }
        return out;
      } catch (e) { return { status: "failed", error: e.code || "error", audit: rec("failed", { error: e.code || "error" }) }; }
    }
    try {
      const result = await t.run({ db: envelope.db }, clean);
      return { status: "done", result, audit: rec("done", { rows: Array.isArray(result && result.evidence) ? result.evidence.length : undefined }) };
    } catch (e) {
      const err = Object.assign(new Error(e.message), { code: e.code || "error", status: e.status, retryable: e.code === "unavailable" || e.code === "timeout" });
      rec("failed", { error: err.code });
      throw err;                                           // reads fail loudly: the state machine decides on retry or FAILED
    }
  }

  const list = () => [...tools.values()].map((t) => ({ name: t.name, level: t.level, level_name: POLICY.tools.levels[t.level] }));
  return { execute, list, has: (n) => tools.has(n) };
}
