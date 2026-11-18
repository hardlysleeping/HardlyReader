package ing.hardlysleep.hardlyreader

import android.app.AppGlobals
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The session token, encrypted with a key the Android Keystore holds.
 *
 * Why this exists at all: the app's own data directory is already private to the
 * app, so a plain file there is not readable by another app. What it is not is
 * protected against the device being read offline, backed up, or opened by root.
 * A Keystore key lives in hardware-backed storage and cannot be extracted from
 * the device, so the ciphertext beside it is worth nothing on its own — which is
 * the same guarantee the iOS Keychain gives, and the reason `secrets.rs` prefers
 * this over the file on Android.
 *
 * Deliberately no dependency: `EncryptedSharedPreferences` would mean another
 * androidx artifact in a generated Gradle project that `tauri android init`
 * recreates. Keystore + AES/GCM + a plain preference file is the same guarantee
 * in code this repo owns.
 *
 * Called from Rust over JNI (`secrets.rs`), which is why every method is `@JvmStatic`
 * and takes/returns strings: a JNI call is the one place a Kotlin type cannot cross.
 */
object SecureStore {
  private const val KEY_ALIAS = "hardlyreader.secrets.v1"
  private const val PREFS = "hardlyreader-secrets"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val TAG_BITS = 128

  private fun prefs() =
    AppGlobals.getInitialApplication()
      .getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        // No user-authentication requirement: a background refresh reads the token
        // while the phone is locked, and this is a speed bump over a plain file,
        // not a second password.
        .build(),
    )
    return generator.generateKey()
  }

  /** The stored value for `key`, or null. A decrypt failure answers null, never a crash. */
  @JvmStatic
  fun get(key: String): String? {
    val packed = prefs().getString(key, null) ?: return null
    return try {
      val raw = Base64.decode(packed, Base64.NO_WRAP)
      // iv (12 bytes) || ciphertext+tag
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, raw, 0, 12))
      String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
    } catch (error: Exception) {
      null
    }
  }

  /** Encrypts and stores. A failure throws, so Rust answers Err and the page falls back. */
  @JvmStatic
  fun set(key: String, value: String) {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val iv = cipher.iv
    val body = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    val packed = Base64.encodeToString(iv + body, Base64.NO_WRAP)
    prefs().edit().putString(key, packed).apply()
  }

  /** Removes one key. Not being there is success. */
  @JvmStatic
  fun delete(key: String) {
    prefs().edit().remove(key).apply()
  }
}
