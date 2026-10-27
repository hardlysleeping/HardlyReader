//! Saving a document the reader asked for, to a path the reader picked.
//!
//! The OPML export is the only writer here. WebKitGTK does not honour an anchor
//! `download` in this window, so the old path produced no file at all and could
//! only apologise; a save needs a real dialog and a real write.
//!
//! Two rules, and they are the same two `sync.rs` keeps:
//!
//! - **The path comes from the reader's own dialog, never from the page.** The
//!   picker is `@tauri-apps/plugin-dialog`'s `save()`; the webview hands over a
//!   path it was given, so it cannot name one nobody chose.
//! - **A write lands whole or not at all.** The bytes go to a temporary file
//!   beside the target and are renamed onto it, which is atomic within one
//!   filesystem — a reader that is mid-copy never sees half an OPML document.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The name a write is staged under before it replaces the real file.
const TEMP_SUFFIX: &str = ".writing";

/// Writes `contents` to `path` and answers with the path it landed on.
///
/// The parent directory must already exist: the dialog hands back a path inside
/// a folder the reader chose, and creating directories on their behalf is a
/// decision this module is not allowed to make.
#[tauri::command]
pub fn save_text(path: String, contents: String) -> Result<String, String> {
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err("Refusing to write to a relative path.".into());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "That path has no folder to write into.".to_string())?;
    if !parent.is_dir() {
        return Err(format!("{} is not a folder.", parent.display()));
    }

    write_whole(&target, contents.as_bytes())?;
    Ok(target.display().to_string())
}

/// Staged write: temp file in the same directory, then rename onto the target.
fn write_whole(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temp = target.as_os_str().to_owned();
    temp.push(TEMP_SUFFIX);
    let staged = PathBuf::from(temp);

    let write = || -> std::io::Result<()> {
        let mut file = fs::File::create(&staged)?;
        file.write_all(bytes)?;
        file.sync_all()
    };

    if let Err(error) = write() {
        let _ = fs::remove_file(&staged);
        return Err(format!("Could not write the file: {error}"));
    }
    if let Err(error) = fs::rename(&staged, target) {
        let _ = fs::remove_file(&staged);
        return Err(format!("Could not save over the old file: {error}"));
    }
    Ok(())
}
