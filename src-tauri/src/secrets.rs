//! The session token, kept out of the page's own storage.
//!
//! `localStorage` is fine for a reader's settings and useless for a credential:
//! it is readable by anything the page runs, it is copied by a backup, and it is
//! the first thing a store reviewer asks about. So the token lives here instead —
//! in the shell's own data directory, in a file only this user can read — and the
//! page keeps everything else about the account (server, name, API prefix).
//!
//! **This is the file-backed stage, and it is deliberate.** The OS stores are the
//! next step and not a different API: Keychain on iOS, Keystore-backed preferences
//! on Android, Secret Service on Linux each replace `read`/`write`/`remove` below
//! and nothing above them moves. Until then every platform gets the same honest
//! answer: outside the webview's storage, owner-only permissions on unix, one file
//! per key.
//!
//! Three rules:
//!
//! - **The key never becomes a path directly.** It is hashed to a file name and
//!   read back out of the file, so a server URL with a `/` in it cannot walk out of
//!   the directory and a hash collision is caught instead of answered.
//! - **A write lands whole or not at all** — staged beside the target and renamed,
//!   the same rule `files.rs` and `sync.rs` keep.
//! - **No store here is not an error the page must handle alone**: a failed write
//!   answers `Err`, and `lib/secrets` treats that as "the device store then", so a
//!   reader is never signed out because a file could not be written.

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The folder inside the app's data directory. One per app, not per account.
const FOLDER: &str = "secrets";

/// The name a write is staged under before it replaces the real file.
const TEMP_SUFFIX: &str = ".writing";

/// FNV-1a, so a key becomes a short stable name without a dependency.
fn digest(key: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no data directory: {error}"))?
        .join(FOLDER);
    fs::create_dir_all(&dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    Ok(dir)
}

/// The file one key lives in, after checking the key inside it.
fn path_for(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    Ok(folder(app)?.join(format!("{}.secret", digest(key))))
}

/// Owner-only, on the platforms that have the concept.
fn lock_down(path: &PathBuf) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, mode).map_err(|error| format!("could not set permissions: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        // Windows inherits the user's profile ACL, which is already per-user. A
        // stronger answer needs a DPAPI dependency and is the same swap as the OS
        // stores above.
        let _ = path;
    }
    Ok(())
}

/// The stored value for `key`, or `None` when there is none.
#[tauri::command]
pub fn secret_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = path_for(&app, &key)?;
    let raw = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read the secret: {error}")),
    };
    // `key\0value`: the key is checked so a digest collision answers nothing
    // rather than answering with another account's token.
    let (stored_key, value) = raw
        .split_once('\u{0}')
        .ok_or_else(|| "the stored secret is malformed".to_string())?;
    if stored_key != key {
        return Ok(None);
    }
    Ok(Some(value.to_string()))
}

/// Writes `value` for `key`, whole or not at all.
#[tauri::command]
pub fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let path = path_for(&app, &key)?;
    let staged = path.with_extension(format!("secret{TEMP_SUFFIX}"));
    fs::write(&staged, format!("{key}\u{0}{value}"))
        .map_err(|error| format!("could not write the secret: {error}"))?;
    lock_down(&staged)?;
    fs::rename(&staged, &path).map_err(|error| format!("could not store the secret: {error}"))?;
    Ok(())
}

/// Removes a key. Not being there is success, not an error.
#[tauri::command]
pub fn secret_delete(app: AppHandle, key: String) -> Result<(), String> {
    let path = path_for(&app, &key)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove the secret: {error}")),
    }
}
