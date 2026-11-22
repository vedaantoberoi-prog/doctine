// Doctine for Mac: entry point (the app itself is in lib.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    doctine_lib::run()
}
