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
        if (st.op === "upsert") { const keys = conflictKeys(n, st.oc); const ex = T(n).find((r) => r.user_id === u && keys.every((k) => String(r[k]) === String(row[k]))); if (ex) { if (!st.ign) Object.assign(ex, row); out.push(ex); continue; } }
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
  window.supabase = { createClient: () => ({
    auth: {
      async getSession() { return { data: { session } }; },
      async getUser() { return { data: { user: session ? session.user : null } }; },
      onAuthStateChange(fn) { listeners.push(fn); },
      async signUp({ email, password, options }) { if (DBS.users[email]) return { data: {}, error: { message: "User already registered" } }; const user = { id: uuid(), email, user_metadata: options.data }; DBS.users[email] = { user, password }; session = { user, access_token: "tok-" + user.id }; localStorage.setItem("__sbsession", JSON.stringify(session)); save(); return { data: { user, session }, error: null }; },
      async signInWithPassword({ email, password }) { const u = DBS.users[email]; if (!u || u.password !== password) return { data: {}, error: { message: "Invalid login credentials" } }; session = { user: u.user, access_token: "tok-" + u.user.id }; localStorage.setItem("__sbsession", JSON.stringify(session)); return { data: { user: u.user, session }, error: null }; },
      // Google: records the call, then behaves like the round trip through Google: the page is reloaded at redirectTo
      // with a session for the Google account (created on first use). window.__googleEmail picks the account.
      async signInWithOAuth({ provider, options }) {
        const calls = JSON.parse(localStorage.getItem("__oauthCalls") || "[]"); calls.push({ provider, redirectTo: options && options.redirectTo }); localStorage.setItem("__oauthCalls", JSON.stringify(calls));
        if (window.__oauthFail) return { data: {}, error: { message: "Unsupported provider: provider is not enabled" } };
        const email = window.__googleEmail || "priya.google@example.com";
        if (!DBS.users[email]) DBS.users[email] = { user: { id: uuid(), email, app_metadata: { provider: "google" }, user_metadata: { full_name: "Priya (Google)" } }, password: null };
        save(); localStorage.setItem("__sbsession", JSON.stringify({ user: DBS.users[email].user, access_token: "tok-" + DBS.users[email].user.id }));
        setTimeout(() => location.assign(options.redirectTo), 50); return { data: { provider, url: "https://accounts.google.com/o/oauth2/v2/auth" }, error: null };
      },
      async signOut() { session = null; localStorage.removeItem("__sbsession"); listeners.forEach((f) => f("SIGNED_OUT", null)); return {}; },
      async resetPasswordForEmail() { return { error: null }; }, async updateUser() { return { data: { user: session.user }, error: null }; },
    },
    from: q,
    storage: { from: () => ({
      async upload(path, blob) { if (!session || path.split("/")[0] !== session.user.id) return { error: { message: "row-level security" } }; DBS.files[path] = await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); }); save(); return { error: null }; },
      async download(path) { if (!session || path.split("/")[0] !== session.user.id || !DBS.files[path]) return { data: null, error: { message: "not found" } }; return { data: await (await fetch(DBS.files[path])).blob(), error: null }; },
      async remove(paths) { paths.forEach((p) => delete DBS.files[p]); save(); return { error: null }; },
    }) },
  }) };
})();
