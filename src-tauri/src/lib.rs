// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod lan;
mod share;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(lan::LanState::default())
        .invoke_handler(tauri::generate_handler![
            lan::lan_start,
            lan::lan_stop,
            lan::lan_status,
            // The phone's own share sheet. Registered on every platform so the
            // page has one name to call; it answers "no sheet here" everywhere
            // but iOS, where `src/lib/share.ts` never asks it in the first place.
            share::share_sheet
        ])
        // A window that is gone is not a server: closing the reader stops the
        // share rather than leaving a socket open behind a closed window.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.app_handle().state::<lan::LanState>();
                let _ = lan::stop(state.inner());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
