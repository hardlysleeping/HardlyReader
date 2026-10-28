//! Saving a document the reader asked for, to a path the reader picked.
//!
//! The OPML export and the sync archive are the writers here. WebKitGTK does not
//! honour an anchor `download` in this window, so the old path produced no file
//! at all and could only apologise; a save needs a real dialog and a real write.
//!
//! Two rules, and they are the same two `sync.rs` keeps:
//!
//! - **The path comes from the reader's own dialog, never from the page.** The
//!   picker is `@tauri-apps/plugin-dialog`'s `save()`; the webview hands over a
//!   path it was given, so it cannot name one nobody chose.
//! - **A write lands whole or not at all.** The bytes go to a temporary file
//!   beside the target and are renamed onto it, which is atomic within one
//!   filesystem — a reader that is mid-copy never sees half an OPML document.
//!
//! `save_text` writes a document, `save_bytes` writes a zip. The second one takes
//! base64 because a Tauri command's arguments are JSON and a `Uint8Array` does
//! not survive that trip; base64 is the shortest encoding that does, and it is
//! decoded by hand in `base64.rs` rather than by a dependency in the binary.

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
    let target = target_for(&path)?;
    write_whole(&target, contents.as_bytes())?;
    Ok(target.display().to_string())
}

/// `save_text` for bytes rather than a document: what a zip needs.
///
/// The archive is written by the webview (`src/api/local/sync-archive.ts`) and
/// arrives here base64-encoded; the same path rules and the same staged write
/// apply, so a zip can no more land half-written than an OPML file can.
#[tauri::command]
pub fn save_bytes(path: String, contents_base64: String) -> Result<String, String> {
    let target = target_for(&path)?;
    let bytes = crate::base64::decode(&contents_base64)?;
    write_whole(&target, &bytes)?;
    Ok(target.display().to_string())
}

/// The absolute path, inside a folder that exists, or a sentence saying why not.
fn target_for(path: &str) -> Result<PathBuf, String> {
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
    Ok(target)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hardlyreader-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("a scratch folder");
        root
    }

    #[test]
    fn a_relative_path_is_refused_for_bytes_too() {
        assert!(target_for("HardlyReader-Sync.zip").is_err());
        assert!(save_bytes("HardlyReader-Sync.zip".into(), "UEsDBAoA".into()).is_err());
    }

    #[test]
    fn bytes_land_whole_and_leave_no_staging_file() {
        let root = scratch("bytes");
        let target = root.join("HardlyReader-Sync.zip");
        let written = save_bytes(
            target.to_string_lossy().to_string(),
            "UEsDBAoA".into(),
        )
        .expect("a write");
        assert_eq!(written, target.to_string_lossy());
        assert_eq!(
            fs::read(&target).expect("the file"),
            vec![0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]
        );

        let mut staged = target.as_os_str().to_owned();
        staged.push(TEMP_SUFFIX);
        assert!(!PathBuf::from(staged).exists(), "the staging file was left behind");
    }
}
