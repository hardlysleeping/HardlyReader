//! The one file a device sync reads and writes.
//!
//! Local mode has no server, so two devices share their reading state through a
//! document in a folder both of them can already see: an iCloud Drive folder, a
//! Google Drive folder, a synced directory on a network share. The merge itself
//! is the webview's job (`src/api/local/sync.ts`) — this module only moves the
//! bytes, and it is deliberately the smallest thing that can.
//!
//! Two rules are why it exists instead of a dozen lines of JavaScript in a
//! filesystem plugin:
//!
//! - **The page names a folder, never a file.** A webview that could name any
//!   path could write any file the app can reach. Everything it may touch is
//!   `SYNC_FILE_NAME` inside the folder the reader pointed at.
//! - **A write lands whole or not at all.** Cloud folders upload what they see,
//!   and a second device may read the file at any moment: a document written
//!   straight over the old one would be read half-written, and a merge of half a
//!   document is a merge that deletes records. The new contents go to a
//!   temporary file in the same directory and are renamed onto the real name,
//!   which is atomic within one filesystem.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The file inside the reader's chosen folder.
///
/// `src/api/local/sync.ts` carries the same name on the client side, because the
/// panel shows it and the suite parses what this module wrote; the sync suite
/// asserts the two spellings match so neither can drift alone.
pub const SYNC_FILE_NAME: &str = "hardlyreader-sync.json";

/// The name a write is staged under before it replaces the real file.
const TEMP_SUFFIX: &str = ".writing";

/// Turns what the reader typed into an absolute directory.
///
/// `~` is expanded by hand: the panel suggests a path under the reader's home
/// (an iCloud Drive or Google Drive folder lives there), and a shell is not in
/// the loop to expand it. A relative path is refused rather than guessed at,
/// because it would be resolved against whatever directory the app happened to
/// start in — which is a different folder every time it is launched from
/// somewhere else.
fn resolve(folder: &str) -> Result<PathBuf, String> {
    let trimmed = folder.trim();
    if trimmed.is_empty() {
        return Err("A sync folder needs a path before it can hold anything".to_string());
    }

    let expanded = if trimmed == "~" {
        home()?
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home()?.join(rest)
    } else {
        PathBuf::from(trimmed)
    };

    if !expanded.is_absolute() {
        return Err(format!(
            "\"{trimmed}\" is not a full path: a sync folder has to start at / or ~"
        ));
    }
    Ok(expanded)
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "This device does not say where the home folder is".to_string())
}

/// The document inside a folder, whether or not it exists yet.
fn file_in(folder: &str) -> Result<PathBuf, String> {
    Ok(resolve(folder)?.join(SYNC_FILE_NAME))
}

/// Reads the document, or answers `None` when the folder has never been used.
///
/// A missing file is not a failure: it is the first device to sync, and the
/// caller writes one. Anything else — no permission, a folder that is a file, a
/// disk that went away — is reported, because it is the difference between "this
/// has never synced" and "this cannot sync".
#[tauri::command]
pub fn sync_read(folder: String) -> Result<Option<String>, String> {
    let path = file_in(&folder)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{} could not be read: {error}", path.display())),
    }
}

/// Writes the document into the folder, creating the folder if it is not there.
///
/// The staging file sits beside the real one rather than in a temporary
/// directory, because a rename is only atomic within one filesystem and `/tmp`
/// is frequently a different one.
#[tauri::command]
pub fn sync_write(folder: String, contents: String) -> Result<(), String> {
    let directory = resolve(&folder)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("{} could not be created: {error}", directory.display()))?;
    write_atomic(&directory.join(SYNC_FILE_NAME), contents.as_bytes())
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let staged = staged_path(path);
    {
        let mut file = fs::File::create(&staged)
            .map_err(|error| format!("{} could not be written: {error}", staged.display()))?;
        file.write_all(contents)
            .map_err(|error| format!("{} could not be written: {error}", staged.display()))?;
        // Flushed to the device before the rename, so a crash cannot leave the
        // real name pointing at a file whose contents never landed.
        file.sync_all()
            .map_err(|error| format!("{} could not be written: {error}", staged.display()))?;
    }
    fs::rename(&staged, path).map_err(|error| {
        let _ = fs::remove_file(&staged);
        format!("{} could not be replaced: {error}", path.display())
    })
}

/// `hardlyreader-sync.json` becomes `hardlyreader-sync.json.writing`: the whole
/// name is kept, because `with_extension` would trade the `.json` away.
fn staged_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(SYNC_FILE_NAME);
    path.with_file_name(format!("{name}{TEMP_SUFFIX}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hardlyreader-sync-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("a scratch folder");
        root
    }

    #[test]
    fn a_tilde_is_expanded_and_a_relative_path_is_refused() {
        let resolved = resolve("~/HardlyReader").expect("an expanded path");
        assert!(resolved.is_absolute(), "{} is not absolute", resolved.display());
        assert!(resolved.ends_with("HardlyReader"));

        let refused = resolve("HardlyReader").expect_err("a relative path");
        assert!(refused.contains("full path"), "unexpected message: {refused}");
        assert!(resolve("   ").is_err(), "an empty path was accepted");
    }

    #[test]
    fn a_folder_that_was_never_synced_answers_none() {
        let root = scratch("missing");
        let read = sync_read(root.to_string_lossy().to_string()).expect("a read");
        assert!(read.is_none(), "an unused folder answered with a document");
    }

    #[test]
    fn a_write_lands_whole_and_leaves_no_staging_file() {
        let root = scratch("write");
        let folder = root.to_string_lossy().to_string();
        sync_write(folder.clone(), "{\"version\":1}".to_string()).expect("a write");

        let read = sync_read(folder.clone()).expect("a read");
        assert_eq!(read.as_deref(), Some("{\"version\":1}"));

        let staged = root.join(format!("{SYNC_FILE_NAME}{TEMP_SUFFIX}"));
        assert!(!staged.exists(), "the staging file was left behind");

        // A second write replaces the first rather than appending to it.
        sync_write(folder, "{\"version\":1,\"device\":\"laptop\"}".to_string()).expect("a second write");
        let after = sync_read(root.to_string_lossy().to_string()).expect("a read");
        assert_eq!(after.as_deref(), Some("{\"version\":1,\"device\":\"laptop\"}"));
    }

    #[test]
    fn a_missing_folder_is_created_by_a_write() {
        let root = scratch("create");
        let folder = root.join("nested").join("iCloud Drive");
        sync_write(folder.to_string_lossy().to_string(), "{}".to_string()).expect("a write");
        assert!(folder.join(SYNC_FILE_NAME).is_file(), "the document is not there");
    }
}
