//! The session token, kept out of the page's own storage.
//!
//! `localStorage` is fine for a reader's settings and useless for a credential:
//! it is readable by anything the page runs, it is copied by a backup, and it is
//! the first thing a store reviewer asks about. So the token lives here instead,
//! and the page keeps everything else about the account (server, name, API prefix).
//!
//! **Two backends so far, one more to come.**
//!
//! - **iOS** answers from the Keychain through `ios/Keychain.m` — the same
//!   `@cdecl`-style bridge the share sheet uses, because Security framework is
//!   only reachable from ObjC/Swift.
//! - **Everything else** answers from a file in the shell's own data directory:
//!   outside the webview's storage, owner-only on unix, one file per key.
//! - **Android** keeps the file for now; Keystore-backed preferences are the last
//!   swap and it is the same three functions again.
//!
//! Nothing above `get`/`set`/`remove` knows which one answered.
//!
//! Two rules the file backend keeps:
//!
//! - **The key never becomes a path directly.** It is hashed to a file name and
//!   read back out of the file, so a server URL with a `/` in it cannot walk out of
//!   the directory and a hash collision is caught instead of answered.
//! - **A write lands whole or not at all** — staged beside the target and renamed,
//!   the same rule `files.rs` and `sync.rs` keep.
//!
//! And one rule for both: a store that refuses answers `Err`, and `lib/secrets`
//! treats that as "this device's storage then", so a reader is never signed out
//! because a key could not be written.

use tauri::AppHandle;

#[cfg(target_os = "ios")]
use platform_ios as platform;
#[cfg(target_os = "android")]
use platform_android as platform;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use platform_file as platform;

/// The Keychain, through the Objective-C half.
#[cfg(target_os = "ios")]
mod platform_ios {
    use std::ffi::{c_char, CStr, CString};

    // Edition 2024: an `extern` block is `unsafe` itself, not only the calls
    // inside it. The Linux build never sees this file's iOS half, so the IPA is
    // the only thing that compiles it — this line cost one red CI run to learn.
    unsafe extern "C" {
        fn hr_keychain_set(key: *const c_char, value: *const c_char) -> i32;
        fn hr_keychain_get(key: *const c_char) -> *mut c_char;
        fn hr_keychain_free(value: *mut c_char);
        fn hr_keychain_delete(key: *const c_char) -> i32;
    }

    fn c_text(text: &str) -> Result<CString, String> {
        CString::new(text).map_err(|_| "the secret's name contains a zero byte".to_string())
    }

    pub fn get(_app: &tauri::AppHandle, key: &str) -> Result<Option<String>, String> {
        let name = c_text(key)?;
        // SAFETY: the pointer comes from `hr_keychain_get`, which either returns
        // null or a string it allocated; it is freed exactly once, here.
        unsafe {
            let raw = hr_keychain_get(name.as_ptr());
            if raw.is_null() {
                return Ok(None);
            }
            let value = CStr::from_ptr(raw).to_string_lossy().into_owned();
            hr_keychain_free(raw);
            Ok(if value.is_empty() { None } else { Some(value) })
        }
    }

    pub fn set(_app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
        let name = c_text(key)?;
        let secret = c_text(value)?;
        // SAFETY: both pointers are live for the call; the callee copies what it needs.
        if unsafe { hr_keychain_set(name.as_ptr(), secret.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("the Keychain refused the write".to_string())
        }
    }

    pub fn remove(_app: &tauri::AppHandle, key: &str) -> Result<(), String> {
        let name = c_text(key)?;
        // SAFETY: live pointer for the call; a missing item is success on the ObjC side.
        if unsafe { hr_keychain_delete(name.as_ptr()) } == 1 {
            Ok(())
        } else {
            Err("the Keychain refused the removal".to_string())
        }
    }
}


/// The Keystore, through the Kotlin half and the JVM.
///
/// `android/SecureStore.kt` does the encryption; this module only reaches it. The
/// JVM comes from `ndk_context` (initialised by the runtime that started the app),
/// so nothing here owns a `JNI_OnLoad` — a second one would collide at link time.
#[cfg(target_os = "android")]
mod platform_android {
    use jni::objects::{JObject, JString, JValue};
    use jni::{JNIEnv, JavaVM};


    /// `ing.hardlysleep.hardlyreader.SecureStore`, in JNI's own spelling.
    const CLASS: &str = "ing/hardlysleep/hardlyreader/SecureStore";

    /// Runs `body` with the current thread attached to the app's JVM.
    ///
    /// A thread that has never called in is attached for the duration of the call
    /// and detached when the guard drops, so a token read from a background refresh
    /// costs one attach and no leaks.
    fn with_env<T>(
        body: impl FnOnce(&mut JNIEnv, &JObject) -> Result<T, String>,
    ) -> Result<T, String> {
        let context = ndk_context::android_context();
        // SAFETY: the pointer is the JavaVM of the process that started this
        // library; `from_raw` only wraps it and never takes ownership.
        let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
            .map_err(|error| format!("no JVM: {error}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|error| format!("could not attach to the JVM: {error}"))?;
        // SAFETY: the app's Context jobject, owned by the runtime for the life of
        // the process; borrowed only for this call.
        let activity = unsafe { JObject::from_raw(context.context().cast()) };
        body(&mut env, &activity)
    }

    fn text<'local>(env: &mut JNIEnv<'local>, value: &str) -> Result<JString<'local>, String> {
        env.new_string(value)
            .map_err(|error| format!("could not pass the secret's name: {error}"))
    }

    pub fn get(_app: &tauri::AppHandle, key: &str) -> Result<Option<String>, String> {
        with_env(|env, context| {
            let name = text(env, key)?;
            let answer = env
                .call_static_method(
                    CLASS,
                    "get",
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(context), JValue::Object(&name)],
                )
                .map_err(|error| format!("SecureStore.get failed: {error}"))?;
            let value = answer.l().map_err(|error| format!("bad answer: {error}"))?;
            if value.is_null() {
                return Ok(None);
            }
            let value: JString = value.into();
            let value = env
                .get_string(&value)
                .map_err(|error| format!("could not read the secret: {error}"))?;
            let value = value.to_string_lossy().into_owned();
            Ok(if value.is_empty() { None } else { Some(value) })
        })
    }

    pub fn set(_app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
        with_env(|env, context| {
            let name = text(env, key)?;
            let secret = text(env, value)?;
            env.call_static_method(
                CLASS,
                "set",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
                &[JValue::Object(context), JValue::Object(&name), JValue::Object(&secret)],
            )
            .map_err(|error| format!("SecureStore.set failed: {error}"))?;
            Ok(())
        })
    }

    pub fn remove(_app: &tauri::AppHandle, key: &str) -> Result<(), String> {
        with_env(|env, context| {
            let name = text(env, key)?;
            let _: JObject = env
                .call_static_method(
                    CLASS,
                    "delete",
                    "(Landroid/content/Context;Ljava/lang/String;)V",
                    &[JValue::Object(context), JValue::Object(&name)],
                )
                .map_err(|error| format!("SecureStore.delete failed: {error}"))?
                .l()
                .map_err(|error| format!("bad answer: {error}"))?;
            Ok(())
        })
    }
}

/// One owner-only file per key, in the app's data directory.
#[cfg(not(target_os = "ios"))]
mod platform_file {
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
        fs::create_dir_all(&dir)
            .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
        Ok(dir)
    }

    fn path_for(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
        Ok(folder(app)?.join(format!("{}.secret", digest(key))))
    }

    /// Owner-only, on the platforms that have the concept.
    fn lock_down(path: &PathBuf) -> Result<(), String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("could not set permissions: {error}"))?;
        }
        #[cfg(not(unix))]
        {
            // Windows inherits the user's profile ACL, which is already per-user.
            let _ = path;
        }
        Ok(())
    }

    pub fn get(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
        let path = path_for(app, key)?;
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

    pub fn set(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
        let path = path_for(app, key)?;
        let staged = path.with_extension(format!("secret{TEMP_SUFFIX}"));
        fs::write(&staged, format!("{key}\u{0}{value}"))
            .map_err(|error| format!("could not write the secret: {error}"))?;
        lock_down(&staged)?;
        fs::rename(&staged, &path).map_err(|error| format!("could not store the secret: {error}"))?;
        Ok(())
    }

    pub fn remove(app: &AppHandle, key: &str) -> Result<(), String> {
        let path = path_for(app, key)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("could not remove the secret: {error}")),
        }
    }
}

/// The stored value for `key`, or `None` when there is none.
#[tauri::command]
pub fn secret_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    platform::get(&app, &key)
}

/// Writes `value` for `key`, whole or not at all.
#[tauri::command]
pub fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    platform::set(&app, &key, &value)
}

/// Removes a key. Not being there is success, not an error.
#[tauri::command]
pub fn secret_delete(app: AppHandle, key: String) -> Result<(), String> {
    platform::remove(&app, &key)
}
