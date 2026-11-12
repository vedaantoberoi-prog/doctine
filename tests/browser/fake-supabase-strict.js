// In-memory stand-in for supabase-js, used only by the browser tests.
// Each request is bound to the session that was active when it was sent (like a real HTTP request carrying a token),
// inserts/upserts are refused when user_id differs from that session (like RLS), and every write attempt is logged.
window.__sbdb = JSON.parse(localStorage.getItem("__sbdb") || '{"users":{},"tables":{},"files":{}}');
window.__writes = []; window.__failTable = null; window.__delay = {};
(() => {
  const DBS = window.__sbdb, save = () => localStorage.setItem("__sbdb", JSON.stringify(DBS));
  let session = JSON.parse(localStorage.getItem("__sbsession") || "null"); const listeners = [];
  const uuid = () => crypto.randomUUID(), T = (n) => (DBS.tables[n] = DBS.tables[n] || []);
  const conflictKeys = (n, oc) => (oc ? oc.split(",") : n === "health_profiles" ? ["user_id"] : n === "consents" ? ["user_id", "kind"] : ["id"]);
  function q(n) {
    const st = { filters: [], op: "select", rows: null, oc: null, ign: false, single: false, maybe: false };
    const exec = (u) => {
      if (!u) return { data: null, error: { message: "JWT missing" } };
      const mine = T(n).filter((r) => r.user_id === u && st.filters.every(([k, v]) => String(r[k]) === String(v)));
      if (st.op === "select") return st.single || st.maybe ? { data: mine[0] || null, error: null } : { data: mine, error: null };
      if (st.op === "delete") {
        DBS.tables[n] = T(n).filter((r) => !mine.includes(r));
        const ids = mine.map((m) => m.id);
        if (n === "medicines") for (const t of ["medication_schedules", "dose_events"]) DBS.tables[t] = T(t).filter((r) => !ids.includes(r.medicine_id));
        if (n === "documents") DBS.tables.document_files = T("document_files").filter((r) => !ids.includes(r.document_id));
        if (n === "conversations") DBS.tables.messages = T("messages").filter((r) => !ids.includes(r.conversation_id));
        save(); return { data: null, error: null };
      }
      const rows = [].concat(st.rows);
      window.__writes.push({ table: n, op: st.op, session: u, rows: JSON.parse(JSON.stringify(rows)) });
      if (window.__failTable === n) return { data: null, error: { message: "Failed to fetch" } };
      if (rows.some((r) => r.user_id && r.user_id !== u)) return { data: null, error: { message: "new row violates row-level security policy" } };
      if ((n === "conversations" || n === "messages") && st.op === "insert" && !T("consents").some((c) => c.user_id === u && c.kind === "chat_history" && c.granted))
        return { data: null, error: { message: "new row violates row-level security policy" } };
      if (n === "messages") for (const r of rows) if (!T("conversations").some((c) => c.id === r.conversation_id && c.user_id === u)) return { data: null, error: { message: "insert or update on table \"messages\" violates foreign key constraint" } };
      const out = [];
      for (const row of rows) {
        if (st.op === "upsert") { const keys = conflictKeys(n, st.oc); const ex = T(n).find((r) => r.user_id === u && keys.every((k) => String(r[k]) === String(row[k]))); if (ex) { if (!st.ign) Object.assign(ex, row, { updated_at: new Date().toISOString() }); out.push(ex); continue; } }
        const r = { id: uuid(), created_at: new Date(Date.now() + (window.__tick = (window.__tick || 0) + 1)).toISOString(), updated_at: new Date().toISOString(), user_id: u, ...row };
        T(n).push(r); out.push(r);
      }
      save(); return { data: st.single ? out[0] : out, error: null };
    };
    const api = {
      select() { return api; }, order() { return api; }, limit() { return api; }, eq(k, v) { st.filters.push([k, v]); return api; },
      maybeSingle() { st.maybe = true; return api; }, single() { st.single = true; return api; },
      upsert(rows, o) { st.op = "upsert"; st.rows = rows; st.oc = o && o.onConflict; st.ign = !!(o && o.ignoreDuplicates); return api; },
      insert(rows) { st.op = "insert"; st.rows = rows; return api; }, delete() { st.op = "delete"; return api; },
      then(res, rej) {
        const u = session && session.user.id; // the session at the moment the request is sent
        const wait = window.__delay[n] || 0;
        return new Promise((ok) => setTimeout(() => ok(exec(u)), wait)).then(res, rej);
      },
    };
    return api;
  }
  // The people-facing support and feedback functions (migration 20261112040000_leadership.sql), bound to the session
  // like a real request: each person reaches only their own requests; staff replies are added by tests via __sbdb.
  async function rpc(fn, args = {}) {
    const u = session && session.user.id; if (!u) return { data: null, error: { message: "sign in first", code: "42501" } };
    window.__writes.push({ table: "rpc:" + fn, op: "rpc", session: u, rows: [JSON.parse(JSON.stringify(args))] });
    const S = T("support_requests"), M = T("support_messages"), now = new Date().toISOString();
    if (fn === "support_submit") {
      if (S.filter((r) => r.user_id === u).length >= 5) return { data: { ok: false, error: "too_many" }, error: null };
      const id = uuid(), ref = "S-" + (S.length + 1); S.push({ id, ref, user_id: u, category: args.p_category, subject: args.p_subject, status: "open", created_at: now, updated_at: now });
      M.push({ request_id: id, at: now, from_staff: false, internal: false, body: args.p_body }); save(); return { data: { ok: true, id, ref }, error: null };
    }
    if (fn === "support_mine") return { data: S.filter((r) => r.user_id === u).map((r) => ({ ...r, messages: M.filter((m) => m.request_id === r.id && !m.internal).map((m) => ({ at: m.at, from: m.from_staff ? "Doctine support" : "You", body: m.body })) })), error: null };
    if (fn === "support_reply") { const r = S.find((x) => x.id === args.p_id && x.user_id === u); if (!r) return { data: null, error: { message: "not found", code: "P0002" } }; M.push({ request_id: r.id, at: now, from_staff: false, internal: false, body: args.p_body }); r.status = "open"; save(); return { data: { ok: true }, error: null }; }
    if (fn === "feedback_submit") { T("feedback").push({ user_id: u, kind: args.p_kind, area: args.p_area, body: args.p_body, at: now }); save(); return { data: { ok: true }, error: null }; }
    return { data: null, error: { message: "function not found", code: "PGRST202" } };
  }
  // Email links, as supabase-js 2.45.4 handles them (its "implicit" flow, the default): while starting, if
  // detectSessionInUrl is on and the address holds a session (#access_token=…) or an error, it saves the session from the
  // address (or, for an error, removes the saved session), clears the address fragment, and only on the next turn of the
  // event loop announces PASSWORD_RECOVERY (type=recovery) or SIGNED_IN. getSession waits for that start-up.
  // Recovery tokens live in localStorage.__sbrecovery; the test plays Supabase's /verify step (one use, then an error).
  const startUp = (opts) => (async () => {
    await Promise.resolve();
    if (!(opts && opts.auth && opts.auth.detectSessionInUrl)) return;
    const h = new URLSearchParams(location.hash.slice(1));
    if (!h.get("access_token") && !h.get("error_description")) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (h.get("error_description")) { session = null; localStorage.removeItem("__sbsession"); return; }
    const rec = JSON.parse(localStorage.getItem("__sbrecovery") || "{}")[h.get("access_token")], u = rec && DBS.users[rec.email];
    if (!u) return;
    session = { user: u.user, access_token: "tok-" + u.user.id, recovery: h.get("type") === "recovery" }; localStorage.setItem("__sbsession", JSON.stringify(session));
    const ev = h.get("type") === "recovery" ? "PASSWORD_RECOVERY" : "SIGNED_IN";
    setTimeout(() => listeners.forEach((f) => f(ev, session)), 0);
  })();
  window.supabase = { createClient: (url, key, opts) => { window.__sbOpts = { flowType: opts && opts.auth && opts.auth.flowType, detectSessionInUrl: opts && opts.auth && opts.auth.detectSessionInUrl, customStorage: !!(opts && opts.auth && opts.auth.storage) };
    const store = opts && opts.auth && opts.auth.storage; const SK = "sb-fakeprojectref-auth-token"; if (store) Promise.resolve(store.getItem(SK)).then((v) => { if (v && !session) { session = JSON.parse(v); } });
    const persist = () => { if (store) { if (session) store.setItem(SK, JSON.stringify(session)); else store.removeItem(SK); } };
    const ready = startUp(opts); return {
    rpc,
    auth: {
      async getSession() { await ready; return { data: { session } }; },
      async exchangeCodeForSession(code) { const C = JSON.parse(localStorage.getItem("__sbcodes") || "{}"), c = C[code];
        if (!c || c.used) return { data: { session: null }, error: { message: "invalid flow state, no valid flow state found" } };
        c.used = true; localStorage.setItem("__sbcodes", JSON.stringify(C)); const u = DBS.users[c.email];
        session = { user: u.user, access_token: "tok-" + u.user.id }; localStorage.setItem("__sbsession", JSON.stringify(session)); persist();
        const ev = c.recovery ? "PASSWORD_RECOVERY" : "SIGNED_IN"; listeners.forEach((f) => f(ev, session)); return { data: { session, user: u.user }, error: null }; },
      async getUser() { return { data: { user: session ? session.user : null } }; },
      onAuthStateChange(fn) { listeners.push(fn); },
      async signUp({ email, password, options }) { if (DBS.users[email]) return { data: {}, error: { message: "User already registered" } }; const user = { id: uuid(), email, user_metadata: options.data }; DBS.users[email] = { user, password }; session = { user, access_token: "tok-" + user.id }; localStorage.setItem("__sbsession", JSON.stringify(session)); persist(); save(); return { data: { user, session }, error: null }; },
      async signInWithPassword({ email, password }) { const u = DBS.users[email]; if (!u || u.password !== password) return { data: {}, error: { message: "Invalid login credentials" } }; session = { user: u.user, access_token: "tok-" + u.user.id }; localStorage.setItem("__sbsession", JSON.stringify(session)); persist(); return { data: { user: u.user, session }, error: null }; },
      // Google: records the call, then behaves like the round trip through Google: the page is reloaded at redirectTo
      // with a session for the Google account (created on first use). window.__googleEmail picks the account.
      async signInWithOAuth({ provider, options }) {
        const calls = JSON.parse(localStorage.getItem("__oauthCalls") || "[]"); calls.push({ provider, redirectTo: options && options.redirectTo, skip: !!(options && options.skipBrowserRedirect) }); localStorage.setItem("__oauthCalls", JSON.stringify(calls));
        if (options && options.skipBrowserRedirect) return { data: { provider, url: "https://x.supabase.co/auth/v1/authorize?provider=google&redirect_to=" + encodeURIComponent(options.redirectTo) }, error: null };
        if (window.__oauthFail) return { data: {}, error: { message: "Unsupported provider: provider is not enabled" } };
        const email = window.__googleEmail || "priya.google@example.com";
        if (!DBS.users[email]) DBS.users[email] = { user: { id: uuid(), email, app_metadata: { provider: "google" }, user_metadata: { full_name: "Priya (Google)" } }, password: null };
        save(); localStorage.setItem("__sbsession", JSON.stringify({ user: DBS.users[email].user, access_token: "tok-" + DBS.users[email].user.id }));
        setTimeout(() => location.assign(options.redirectTo), 50); return { data: { provider, url: "https://accounts.google.com/o/oauth2/v2/auth" }, error: null };
      },
      async signOut(o) { const L = JSON.parse(localStorage.getItem("__signOuts") || "[]"); L.push((o && o.scope) || "global"); localStorage.setItem("__signOuts", JSON.stringify(L));
        session = null; localStorage.removeItem("__sbsession"); persist(); listeners.forEach((f) => f("SIGNED_OUT", null)); return {}; },
      // Records the request; for an existing account, issues a one-time recovery token, as Supabase emails one.
      async resetPasswordForEmail(email, o) {
        const calls = JSON.parse(localStorage.getItem("__resetCalls") || "[]"); calls.push({ email, redirectTo: o && o.redirectTo }); localStorage.setItem("__resetCalls", JSON.stringify(calls));
        if (DBS.users[email]) { const tok = "rec-" + uuid(), R = JSON.parse(localStorage.getItem("__sbrecovery") || "{}"); R[tok] = { email, used: false }; localStorage.setItem("__sbrecovery", JSON.stringify(R)); localStorage.setItem("__lastRecovery", tok); }
        return { error: null }; },
      async updateUser(attrs) { await ready;
        if (!session) return { data: { user: null }, error: { message: "Auth session missing!" } };
        const u = Object.values(DBS.users).find((x) => x.user.id === session.user.id);
        if (attrs && typeof attrs.password === "string") {
          if (attrs.password.length < 8) return { data: { user: null }, error: { message: "Password should be at least 8 characters." } };
          if (u && attrs.password === u.password) return { data: { user: null }, error: { message: "New password should be different from the old password." } };
          if (u) { u.password = attrs.password; save(); }
        }
        return { data: { user: session.user }, error: null }; },
    },
    from: q,
    storage: { from: () => ({
      async upload(path, blob) { if (!session || path.split("/")[0] !== session.user.id) return { error: { message: "row-level security" } }; DBS.files[path] = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); }); save(); return { error: null }; },
      async download(path) { if (!session || path.split("/")[0] !== session.user.id || !DBS.files[path]) return { data: null, error: { message: "not found" } }; return { data: await (await fetch(DBS.files[path])).blob(), error: null }; },
      async remove(paths) { paths.forEach((p) => delete DBS.files[p]); save(); return { error: null }; },
    }) },
  }; } };
})();
