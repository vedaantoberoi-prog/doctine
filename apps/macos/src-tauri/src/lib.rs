//! Doctine for Mac. The window shows the same Doctine app as app.doctine.com (bundled in the app, never loaded from a
//! remote address). This file adds only what a browser can't do, as a few narrow commands the page may call:
//! - the sign-in session in the macOS Keychain (only Supabase's own session keys are accepted);
//! - doctine://auth/callback links (email confirmation, password reset, Google sign-in), including one that launched the app;
//! - opening links in the default browser (https, mailto and tel only);
//! - saving an export through a Save dialog;
//! - dose-alarm notifications while Doctine is running (closing the window keeps it running; quitting stops them);
//! - native menus with keyboard shortcuts.
//! Nothing here logs tokens, codes, file contents or medical records.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Deserialize;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;

const SERVICE: &str = "com.doctine.app";

#[derive(Default)]
struct Links(Mutex<Vec<String>>);

#[derive(Clone, Deserialize)]
struct Alarm {
    id: i64,
    title: String,
    body: String,
    at: i64, // milliseconds since 1970
}

#[derive(Default)]
struct Alarms(Mutex<Vec<Alarm>>);

/// Supabase's session keys look like `sb-<project ref>-auth-token` (plus `-code-verifier` during PKCE sign-in).
fn session_key(k: &str) -> bool {
    let mid = k
        .strip_prefix("sb-")
        .and_then(|r| r.strip_suffix("-auth-token-code-verifier").or_else(|| r.strip_suffix("-auth-token")));
    matches!(mid, Some(m) if (6..=40).contains(&m.len()) && m.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

fn auth_link(u: &str) -> bool {
    url::Url::parse(u).map(|x| x.scheme() == "doctine" && x.host_str() == Some("auth") && x.path() == "/callback").unwrap_or(false)
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    if !session_key(&key) { return Err("invalid key".into()); }
    match keyring::Entry::new(SERVICE, &key).and_then(|e| e.get_password()) {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    if !session_key(&key) { return Err("invalid key".into()); }
    keyring::Entry::new(SERVICE, &key).and_then(|e| e.set_password(&value)).map_err(|_| "could not store the session".into())
}

#[tauri::command]
fn secret_remove(key: String) -> Result<(), String> {
    if !session_key(&key) { return Err("invalid key".into()); }
    match keyring::Entry::new(SERVICE, &key).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("could not remove the session".into()),
    }
}

/// Links that arrived before the page asked for them (for example the link that opened the app).
#[tauri::command]
fn take_links(links: State<Links>) -> Vec<String> {
    std::mem::take(&mut *links.0.lock().unwrap())
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let ok = url::Url::parse(&url).map(|u| matches!(u.scheme(), "https" | "mailto" | "tel")).unwrap_or(false);
    if !ok { return Err("only https, mailto and tel links open outside Doctine".into()); }
    app.opener().open_url(url, None::<&str>).map_err(|_| "could not open the link".into())
}

#[tauri::command]
fn focus_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Asks where to save, then writes the file there. Returns false when the person cancels.
#[tauri::command]
async fn save_file(app: AppHandle, name: String, data: String) -> Result<bool, String> {
    let name: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).take(80).collect();
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|_| "invalid file".to_string())?;
    let picked = app.dialog().file().set_file_name(if name.is_empty() { "doctine-export.zip" } else { &name }).add_filter("ZIP archive", &["zip"]).blocking_save_file();
    match picked {
        None => Ok(false),
        Some(p) => {
            let path = p.into_path().map_err(|_| "invalid location".to_string())?;
            std::fs::write(path, bytes).map_err(|_| "the file could not be saved".to_string())?;
            Ok(true)
        }
    }
}

fn state_name(s: PermissionState) -> &'static str {
    match s {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        _ => "prompt",
    }
}

#[tauri::command]
fn notif_permission(app: AppHandle, ask: bool) -> String {
    let n = app.notification();
    let s = n.permission_state().unwrap_or(PermissionState::Prompt);
    if ask && !matches!(s, PermissionState::Granted | PermissionState::Denied) {
        return state_name(n.request_permission().unwrap_or(PermissionState::Denied)).into();
    }
    state_name(s).into()
}

#[tauri::command]
fn notif_schedule(alarms: State<Alarms>, items: Vec<Alarm>) {
    let mut list = alarms.0.lock().unwrap();
    for a in items.into_iter().take(120) {
        if let Some(i) = list.iter().position(|x| x.id == a.id) { list[i] = a; } else { list.push(a); }
    }
}

#[tauri::command]
fn notif_pending(alarms: State<Alarms>) -> Vec<i64> {
    alarms.0.lock().unwrap().iter().map(|a| a.id).collect()
}

#[tauri::command]
fn notif_cancel(alarms: State<Alarms>, ids: Vec<i64>) {
    alarms.0.lock().unwrap().retain(|a| !ids.contains(&a.id));
}

/// Shows due alarms. One that is more than 30 minutes late (the Mac was asleep) is dropped rather than shown late.
fn alarm_loop(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        let now = now_ms();
        let due: Vec<Alarm> = {
            let state = app.state::<Alarms>();
            let mut list = state.0.lock().unwrap();
            let (due, rest): (Vec<Alarm>, Vec<Alarm>) = list.drain(..).partition(|a| a.at <= now);
            *list = rest;
            due
        };
        for a in due.into_iter().filter(|a| now - a.at <= 30 * 60 * 1000) {
            let _ = app.notification().builder().title(&a.title).body(&a.body).show();
        }
    });
}

fn deliver(app: &AppHandle, urls: Vec<String>) {
    let urls: Vec<String> = urls.into_iter().filter(|u| auth_link(u)).collect();
    if urls.is_empty() { return; }
    focus_window(app.clone());
    for u in urls {
        app.state::<Links>().0.lock().unwrap().push(u.clone());
        let _ = app.emit("doctine-link", u);
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let nav = |id: &str, label: &str, key: &str| MenuItem::with_id(app, id, label, true, Some(key));
    let about = AboutMetadata { name: Some("Doctine".into()), copyright: Some("Doctine keeps your health records. It is not a doctor or an emergency service; in an emergency in India, call 112.".into()), ..Default::default() };
    Menu::with_items(app, &[
        &Submenu::with_items(app, "Doctine", true, &[
            &PredefinedMenuItem::about(app, Some("About Doctine"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &nav("nav:settings", "Settings…", "CmdOrCtrl+,")?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit Doctine"))?,
        ])?,
        &Submenu::with_items(app, "Edit", true, &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ])?,
        &Submenu::with_items(app, "View", true, &[
            &nav("nav:home", "Overview", "CmdOrCtrl+1")?,
            &nav("nav:health", "My Health", "CmdOrCtrl+2")?,
            &nav("nav:reports", "Medical records", "CmdOrCtrl+3")?,
            &nav("nav:medicines", "Medicines", "CmdOrCtrl+4")?,
            &nav("nav:reminders", "Reminders", "CmdOrCtrl+5")?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ])?,
        &Submenu::with_items(app, "Window", true, &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ])?,
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Links::default())
        .manage(Alarms::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.set_menu(menu(&handle)?)?;
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let urls: Vec<String> = urls.into_iter().map(|u| u.to_string()).filter(|u| auth_link(u)).collect();
                app.state::<Links>().0.lock().unwrap().extend(urls);
            }
            let h = handle.clone();
            app.deep_link().on_open_url(move |event| deliver(&h, event.urls().into_iter().map(|u| u.to_string()).collect()));
            alarm_loop(handle);
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(view) = event.id().as_ref().strip_prefix("nav:") {
                focus_window(app.clone());
                let _ = app.emit("doctine-menu", view.to_string());
            }
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Doctine running (so dose alarms still show); Quit (⌘Q) ends it.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            secret_get, secret_set, secret_remove, take_links, open_external, focus_window, save_file,
            notif_permission, notif_schedule, notif_pending, notif_cancel
        ])
        .build(tauri::generate_context!())
        .expect("Doctine could not start");
    app.run(|handle, event| {
        if let RunEvent::Reopen { .. } = event {
            focus_window(handle.clone());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_supabase_session_keys() {
        assert!(session_key("sb-ggqctflfwpfkemgehizq-auth-token"));
        assert!(session_key("sb-ggqctflfwpfkemgehizq-auth-token-code-verifier"));
        for bad in ["", "sb--auth-token", "sb-ABC123-auth-token", "token", "sb-ggqctflfwpfkemgehizq-auth-token-x", "../sb-x", "sb-abc-auth-token"] {
            assert!(!session_key(bad), "{bad}");
        }
    }
    #[test]
    fn accepts_only_doctine_auth_links() {
        assert!(auth_link("doctine://auth/callback?code=abc&next=reset"));
        for bad in ["https://auth/callback", "doctine://evil/callback", "doctine://auth/other", "javascript:alert(1)", "doctine:auth/callback"] {
            assert!(!auth_link(bad), "{bad}");
        }
    }
}
