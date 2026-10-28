// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod files;
// The native half of the safe area: iOS insets the webview on top of the padding
// the page already pays for the notch. See `insets.rs`.
#[cfg(target_os = "ios")]
mod insets;
mod lan;
mod share;
mod sync;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        // The save dialog the OPML export opens. The picker is the plugin's; the
        // write is `files::save_text`, so a page can only save to a path the
        // reader chose in it.
        .plugin(tauri_plugin_dialog::init())
        // The local library's SQLite file. The schema is created by
        // `src/api/local/sqlite-db.ts` on first open rather than by a Rust
        // migration, so the table definitions have exactly one home and the
        // unit suite can run the same `CREATE TABLE` text against real SQLite.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(lan::LanState::default())
        .invoke_handler(tauri::generate_handler![
            lan::lan_start,
            lan::lan_stop,
            lan::lan_status,
            // The device-sync document: one file, in a folder the reader
            // chose. The page names the folder; `sync.rs` names the file.
            sync::sync_read,
            sync::sync_write,
            // The OPML export: the dialog picks the path, this writes the bytes.
            files::save_text,

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
        // iOS only: the webview is inset by the safe area on top of the padding
        // the page already pays for the notch, which leaves strips of the
        // window's own background above the header and under the last row.
        // One call, before anything is drawn — see `insets.rs`.
        .setup(|_app| {
            #[cfg(target_os = "ios")]
            {
                let status = insets::apply();
                if status != insets::APPLIED {
                    eprintln!("the webview could not be uninset (status {status})");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
