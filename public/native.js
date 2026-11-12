/* Doctine · native bridge for the Android app (Capacitor) and the Mac app (Tauri).
   Loaded on every platform; on the website (window.DOCTINE_NATIVE === '') it does nothing at all.
   It swaps browser-only pieces for native ones and holds no medical data itself:
   - authStorage: the sign-in session in Android Keystore-encrypted storage / the macOS Keychain (never localStorage);
   - email and Google sign-in links (doctine://auth/callback), including the link that launched the app;
   - opening Google sign-in in the system browser (Google refuses embedded web views);
   - saving exports through the share sheet (Android) or a save dialog (Mac);
   - Mac dose alarms through the same interface as Capacitor LocalNotifications (used by DoctineAlarms);
   - Android back button, status bar, splash screen; Mac menu commands and drag-and-drop uploads;
   - an offline banner; links to other sites open in the system browser.
   Nothing here logs tokens, codes, file contents or records. */
(function () {
  'use strict';
  var P = window.DOCTINE_NATIVE || '';
  if (!P) { window.DoctineNative = null; return; }
  var C = window.Capacitor, CP = (C && C.Plugins) || {};
  var T = window.__TAURI__ || {}, invoke = T.core && T.core.invoke, listen = T.event && T.event.listen;

  /* ---------- sign-in session storage ---------- */
  // Only Supabase's own keys are accepted, so this can't become a general store for page data.
  var KEY = /^sb-[a-z0-9]{6,40}-auth-token(-code-verifier)?$/;
  var ok = function (k) { return typeof k === 'string' && KEY.test(k); };
  var authStorage = P === 'android' ? {
    getItem: function (k) { if (!ok(k)) return Promise.resolve(null); return CP.DoctineSecure.get({ key: k }).then(function (r) { return r && typeof r.value === 'string' ? r.value : null; }, function () { return null; }); },
    setItem: function (k, v) { if (!ok(k)) return Promise.resolve(); return CP.DoctineSecure.set({ key: k, value: String(v) }); },
    removeItem: function (k) { if (!ok(k)) return Promise.resolve(); return CP.DoctineSecure.remove({ key: k }).catch(function () { }); }
  } : {
    getItem: function (k) { if (!ok(k)) return Promise.resolve(null); return invoke('secret_get', { key: k }).then(function (v) { return v == null ? null : v; }, function () { return null; }); },
    setItem: function (k, v) { if (!ok(k)) return Promise.resolve(); return invoke('secret_set', { key: k, value: String(v) }); },
    removeItem: function (k) { if (!ok(k)) return Promise.resolve(); return invoke('secret_remove', { key: k }).catch(function () { }); }
  };

  /* ---------- links back into the app ---------- */
  var pending = [], handler = null, launch = null, launchDone = false;
  var isAuthLink = function (u) { return typeof u === 'string' && /^doctine:\/\/auth\/callback(?:[?#]|$)/.test(u) && u.length < 4096; };
  function arrive(u) { if (!isAuthLink(u)) return; if (handler) handler(u); else pending.push(u); }
  if (P === 'android' && CP.App) {
    CP.App.addListener('appUrlOpen', function (e) { if (launchDone) arrive(e && e.url); else launch = launch || (e && e.url); });
  }
  if (P === 'macos' && listen) listen('doctine-link', function (e) { if (launchDone) arrive(e && e.payload); else launch = launch || (e && e.payload); });
  /* The link that started the app (if any), read once at start-up so it wins over any saved session. */
  function launchLink() {
    var get = P === 'android' && CP.App ? CP.App.getLaunchUrl().then(function (r) { return r && r.url; }) : invoke ? invoke('take_links').then(function (a) { return a && a[0]; }) : Promise.resolve(null);
    return Promise.race([get.catch(function () { return null; }), new Promise(function (r) { setTimeout(function () { r(null); }, 1500); })])
      .then(function (u) { launchDone = true; u = u || launch; launch = null; return isAuthLink(u) ? u : null; });
  }
  function takeLinks(fn) { handler = fn; launchDone = true; var q = pending; pending = []; q.forEach(function (u) { fn(u); }); }

  /* ---------- the system browser ---------- */
  var safeExternal = function (u) { try { var x = new URL(u); return x.protocol === 'https:' || x.protocol === 'mailto:' || x.protocol === 'tel:'; } catch (e) { return false; } };
  function openExternal(u) {
    if (!safeExternal(u)) return Promise.resolve(false);
    if (P === 'android') return (/^https:/.test(u) && CP.Browser ? CP.Browser.open({ url: u }) : Promise.resolve(window.open(u, '_system'))).then(function () { return true; }, function () { return false; });
    return invoke('open_external', { url: u }).then(function () { return true; }, function () { return false; });
  }
  function openAuthUrl(u) { return openExternal(u); }
  function closeAuthBrowser() { if (P === 'android' && CP.Browser) CP.Browser.close().catch(function () { }); if (P === 'macos' && invoke) invoke('focus_window').catch(function () { }); }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a) return;
    var href = a.getAttribute('href') || ''; if (!/^(https?:|mailto:|tel:)/i.test(href)) return;
    var u; try { u = new URL(href, location.href); } catch (x) { return; }
    if (u.origin === location.origin) return;
    e.preventDefault(); openExternal(u.href);
  }, true);

  /* ---------- saving files (exports) ---------- */
  function b64(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1] || ''); }; r.onerror = rej; r.readAsDataURL(blob); }); }
  var safeName = function (n) { return String(n || 'doctine-export').replace(/[^\w.-]+/g, '-').slice(0, 80); };
  function saveFile(name, blob) {
    name = safeName(name);
    return b64(blob).then(function (data) {
      if (P === 'macos') return invoke('save_file', { name: name, data: data }).then(function (saved) { return !!saved; });
      // Android: written to the app's private cache only for the share sheet, then removed on the next start or sign-out.
      return CP.Filesystem.writeFile({ path: 'exports/' + name, data: data, directory: 'CACHE', recursive: true })
        .then(function (w) { return CP.Share.share({ title: name, url: w.uri, dialogTitle: 'Save or share your Doctine export' }); })
        .then(function () { return true; }, function (e) { return !/cancel/i.test(String(e && e.message)); });
    }).catch(function () { return false; });
  }
  function clearExports() { if (P === 'android' && CP.Filesystem) CP.Filesystem.stat({ path: 'exports', directory: 'CACHE' }).then(function () { return CP.Filesystem.rmdir({ path: 'exports', directory: 'CACHE', recursive: true }); }).catch(function () { }); }
  clearExports();

  /* ---------- Mac: dose alarms with the LocalNotifications interface DoctineAlarms already uses ---------- */
  var localNotifications = P !== 'macos' ? null : {
    checkPermissions: function () { return invoke('notif_permission', { ask: false }).then(function (s) { return { display: s }; }); },
    requestPermissions: function () { return invoke('notif_permission', { ask: true }).then(function (s) { return { display: s }; }); },
    createChannel: function () { return Promise.resolve(); },
    registerActionTypes: function () { return Promise.resolve(); },
    checkExactNotificationSetting: function () { return Promise.resolve({ exact_alarm: 'granted' }); },
    getPending: function () { return invoke('notif_pending').then(function (ids) { return { notifications: (ids || []).map(function (id) { return { id: id }; }) }; }); },
    cancel: function (o) { return invoke('notif_cancel', { ids: ((o && o.notifications) || []).map(function (n) { return n.id; }) }); },
    schedule: function (o) {
      var list = ((o && o.notifications) || []).map(function (n) { return { id: n.id, title: String(n.title).slice(0, 120), body: String(n.body || '').slice(0, 200), at: new Date(n.schedule.at).getTime() }; });
      return invoke('notif_schedule', { items: list });
    },
    addListener: function () { return Promise.resolve({ remove: function () { } }); } // Mac notifications have no Taken/Snooze buttons
  };

  /* ---------- Android: back button, status bar, splash ---------- */
  if (P === 'android') {
    if (CP.App) CP.App.addListener('backButton', function () {
      var dlg = document.querySelector('dialog[open]'); if (dlg) { dlg.close(); return; }
      var side = document.getElementById('side'); if (side && !side.classList.contains('-translate-x-full') && typeof closeNav === 'function') { closeNav(); return; }
      try {
        if (S.email || S.sample || S.guest) { if (S.view !== 'home') { go('home'); return; } }
        else if (S.auth && S.auth !== 'login' && S.auth !== 'newpw') { S.auth = 'login'; render(); return; }
      } catch (e) { }
      CP.App.exitApp();
    });
    var paint = function () { if (!CP.StatusBar) return; var dark = document.documentElement.classList.contains('dark') || (matchMedia('(prefers-color-scheme: dark)').matches && !document.documentElement.classList.contains('light'));
      CP.StatusBar.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(function () { }); };
    new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); paint();
    window.addEventListener('load', function () { if (CP.SplashScreen) setTimeout(function () { CP.SplashScreen.hide().catch(function () { }); }, 200); });
  }

  /* ---------- Mac: menu commands and dropping files to upload ---------- */
  if (P === 'macos') {
    if (listen) listen('doctine-menu', function (e) {
      try { var v = String(e && e.payload); if (!(S.email || S.sample || S.guest)) return; if (['home', 'health', 'reports', 'medicines', 'reminders', 'settings'].indexOf(v) >= 0) go(v); } catch (x) { }
    });
    var OK = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    document.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    document.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return; e.preventDefault();
      try {
        if (!S.email || S.sample || S.guest) { toast('Sign in to add records.'); return; }
        var f = e.dataTransfer.files[0];
        if (OK.indexOf(f.type) < 0) { toast('Doctine accepts PDF, JPEG, PNG and WebP files.'); return; }
        if (f.size > 15 * 1024 * 1024) { toast('That file is larger than 15 MB.'); return; }
        if (S.view !== 'reports') go('reports');
        if (/^image\//.test(f.type)) quickScan(false, null, [f]); else startUpload(f);
      } catch (x) { }
    });
  }

  /* ---------- connection ---------- */
  function net() {
    var id = 'doctine-offline', el = document.getElementById(id);
    if (navigator.onLine) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement('div'); el.id = id; el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 16px);z-index:9999;background:#14243A;color:#F3F1EB;padding:10px 16px;border-radius:12px;font:500 14px/1.3 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.2);max-width:calc(100% - 32px)';
    el.textContent = 'You’re offline. Doctine saves your changes when you’re back online, so keep it open until then.';
    document.body.appendChild(el);
  }
  window.addEventListener('online', function () { net(); try { if (S.cloud && typeof cloudSync === 'function') cloudSync(); } catch (e) { } });
  window.addEventListener('offline', net);
  window.addEventListener('load', net);

  window.DoctineNative = {
    platform: P, authStorage: authStorage, launchLink: launchLink, takeLinks: takeLinks,
    openAuthUrl: openAuthUrl, closeAuthBrowser: closeAuthBrowser, openExternal: openExternal,
    saveFile: saveFile, clearExports: clearExports, localNotifications: localNotifications
  };
})();
