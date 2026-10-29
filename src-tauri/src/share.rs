//! The phone's own share sheet, from the app.
//!
//! A webview can hand a link to the system in exactly one way — `navigator.share`
//! — and in the packaged iOS app that way is shut: the page is served from
//! `tauri://localhost`, which WebKit does not count as a secure context, so the
//! API is not there at all and the webview's press can only copy. The sheet the
//! rest of the phone uses is `UIActivityViewController`, and it is reached from
//! here: one command, `share_sheet`, which crosses into UIKit.
//!
//! The division of labour is the same one `lan.rs` and `files.rs` keep:
//!
//! - **The decision belongs to the page.** Whether there is a share control on
//!   screen, and what it carries, is `src/lib/share.ts`'s business; this module
//!   is only the hand-off, and it is never called on a platform that has no
//!   sheet.
//! - **Nothing is invented here.** A link that is not `http(s)` is refused
//!   rather than passed to UIKit, because the sheet would happily share any
//!   string and an unvalidated one is how a `javascript:` URL reaches another
//!   app.
//!
//! The UIKit half lives in `src-tauri/ios/ShareSheet.swift` — see that file for
//! why the marker string in it matters to CI. It is compiled into the app target
//! by the Codemagic workflow, since `tauri ios init` regenerates the Xcode
//! project on the runner.

use tauri::{AppHandle, Manager};

/// The command the webview calls. Arguments arrive from `share.ts`.
///
/// `image` is the lead image's own `http(s)` link when the feed declared one; it
/// is dropped rather than refused when it is not, because a picture is an extra
/// and the link is the point.
#[tauri::command]
pub async fn share_sheet(
    app: AppHandle,
    title: String,
    url: String,
    image: Option<String>,
) -> Result<(), String> {
    if !is_http(&url) {
        return Err("Only an http(s) link can be shared.".into());
    }
    let image = image.filter(|value| is_http(value));

    #[cfg(target_os = "ios")]
    {
        present(&app, title, url, image)
    }
    #[cfg(not(target_os = "ios"))]
    {
        // Not an error the reader can reach: the page only offers this where the
        // command exists, and every other platform keeps `navigator.share` and
        // the clipboard. Registering the command everywhere keeps one name in
        // `lib.rs` instead of a cfg'd handler list.
        let _ = (app, title, url, image);
        Err("This platform has no native share sheet.".into())
    }
}

/// A document the app made, handed to the sheet as a file.
///
/// The OPML export is the caller: a phone has no downloads folder a webview may
/// write to, and Web Share — the other way a file leaves a page — is absent in
/// the packaged app for the same reason the link sheet is (see the module note).
/// So the bytes are written here, to the app's own cache directory, and UIKit is
/// handed the file's URL. The sheet's own "Save to Files" is then the reader's
/// prompt, and every app that takes an OPML is one row below it.
///
/// The name is a name, never a path: a caller that could pass `../../x` would
/// have the app write outside its cache, and the one caller that exists builds
/// the name from a date. Anything with a separator or a leading dot is refused
/// rather than cleaned, because a silent rewrite of a name the reader will see in
/// the sheet is worse than a refusal they can read.
#[tauri::command]
pub async fn share_file(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
        return Err("That is not a file name.".into());
    }
    // A feed list is kilobytes. A cap keeps a mistake in the caller from staging
    // a hundred megabytes in a directory the system prunes on its own schedule.
    if contents.len() > 8 * 1024 * 1024 {
        return Err("That document is too large to share.".into());
    }

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("There is nowhere to stage the file: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("The staging folder could not be made: {error}"))?;
    let path = dir.join(&name);
    std::fs::write(&path, contents.as_bytes())
        .map_err(|error| format!("The file could not be written: {error}"))?;

    let shown = path.to_string_lossy().to_string();

    #[cfg(target_os = "ios")]
    {
        present_file(&app, &shown)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, shown);
        Err("This platform has no native share sheet.".into())
    }
}

/// Whether a share sheet is worth trying at all, for the page's own decision.
///
/// Registered on every platform like `share_sheet`; the page only asks where
/// `src/lib/platform.ts` says a sheet exists.
#[tauri::command]
pub fn share_available() -> bool {
    cfg!(target_os = "ios")
}

fn is_http(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Whether the sheet actually went up, as the Swift side reports it.
///
/// `PRESENTED` is the only success. The others are described below; the call
/// itself is made on the main thread, because that is where UIKit lives.
#[cfg(target_os = "ios")]
const PRESENTED: i32 = 0;

#[cfg(target_os = "ios")]
fn present(
    app: &AppHandle,
    title: String,
    url: String,
    image: Option<String>,
) -> Result<(), String> {
    use std::sync::mpsc;

    // UIKit is not thread-safe, and a command handler is not a guarantee about
    // which thread it runs on. Hand the work to the event loop and wait for its
    // answer: the closure runs on the next turn of the main loop, so this is a
    // wait measured in microseconds, and the deadline only exists so a wedged
    // main thread cannot hang the press forever.
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(ios::present(&title, &url, image.as_deref()));
    })
    .map_err(|error| format!("The share sheet could not be reached: {error}"))?;

    match receiver.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(PRESENTED) => Ok(()),
        Ok(status) => Err(describe(status)),
        Err(_) => Err("The share sheet did not answer in time.".into()),
    }
}

/// Hands one staged file to UIKit, on the main thread.
#[cfg(target_os = "ios")]
fn present_file(app: &AppHandle, path: &str) -> Result<(), String> {
    use std::sync::mpsc;

    // The path is handed over owned: the closure outlives this function's
    // borrow of it, and `run_on_main_thread` wants a `'static` job.
    let staged = path.to_string();
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(ios::present_file(&staged));
    })
    .map_err(|error| format!("The share sheet could not be reached: {error}"))?;

    match receiver.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(PRESENTED) => Ok(()),
        Ok(status) => Err(describe_file(status)),
        Err(_) => Err("The share sheet did not answer in time.".into()),
    }
}

/// The failure a file share's status code stands for.
#[cfg(target_os = "ios")]
fn describe_file(status: i32) -> String {
    match status {
        1 => "There is no window to present the share sheet on.".into(),
        2 => "The file was gone before the sheet could carry it.".into(),
        other => format!("The share sheet failed ({other})."),
    }
}

/// The failure a status code stands for, in the reader's words.
#[cfg(target_os = "ios")]
fn describe(status: i32) -> String {
    match status {
        1 => "There is no window to present the share sheet on.".into(),
        2 => "The share sheet refused that link.".into(),
        other => format!("The share sheet failed ({other})."),
    }
}

/// The Swift side of the bridge.
#[cfg(target_os = "ios")]
mod ios {
    use std::ffi::{c_char, CString};

    // `unsafe extern` rather than `extern`: this crate is edition 2024, where an
    // extern block has to say so — the block is the promise that the pointers
    // below are what the C signature claims.
    unsafe extern "C" {
        /// `src-tauri/ios/ShareSheet.swift`, compiled into the app target. Every
        /// pointer is a NUL-terminated string and may be null; the answer is the
        /// status documented in `PRESENTED` and `describe`.
        fn hardlyreader_share(title: *const c_char, url: *const c_char, image: *const c_char) -> i32;

        /// `src-tauri/ios/ShareSheet.swift`, the document half: one absolute path.
        /// The answer is the status documented in `describe_file`.
        fn hardlyreader_share_file(path: *const c_char) -> i32;
    }

    /// Hand one post to UIKit, on the main thread.
    pub fn present(title: &str, url: &str, image: Option<&str>) -> i32 {
        // A string with an interior NUL cannot cross into C. The link is the one
        // thing that must survive, so it is refused rather than truncated.
        let Ok(link) = CString::new(url) else {
            return 2;
        };
        let headline = CString::new(title).unwrap_or_default();
        let picture = image.and_then(|value| CString::new(value).ok());
        let picture_ptr = picture
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr());

        // SAFETY: `headline` and `link` outlive the call, and every pointer is
        // either a live `CString` or null — which the Swift side reads as
        // "absent" and never dereferences.
        unsafe { hardlyreader_share(headline.as_ptr(), link.as_ptr(), picture_ptr) }
    }

    /// Hand one file to UIKit, on the main thread.
    pub fn present_file(path: &str) -> i32 {
        // A path with an interior NUL cannot cross into C. There is nothing to
        // fall back to here — the file is the whole point — so it is refused.
        let Ok(staged) = CString::new(path) else {
            return 2;
        };

        // SAFETY: `staged` outlives the call and is a live `CString`.
        unsafe { hardlyreader_share_file(staged.as_ptr()) }
    }
}
