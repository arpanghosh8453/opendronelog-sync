package com.opendronelog.bgsync

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Settings the web UI hands over, plus the last sync result shown back to it. */
class SyncConfig(
    val serverUrl: String,
    val profile: String,
    val sessionToken: String,
    val folder: String,
    val autoSync: Boolean,
    val rememberPassword: Boolean,
)

class Store(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(): SyncConfig = SyncConfig(
        serverUrl = prefs.getString(K_SERVER, "") ?: "",
        profile = prefs.getString(K_PROFILE, "") ?: "",
        sessionToken = token(),
        folder = prefs.getString(K_FOLDER, "") ?: "",
        autoSync = prefs.getBoolean(K_AUTO, false),
        rememberPassword = prefs.getBoolean(K_REMEMBER, false),
    )

    fun saveConfig(
        serverUrl: String,
        profile: String,
        sessionToken: String,
        folder: String,
        autoSync: Boolean,
        rememberPassword: Boolean,
    ) {
        val old = config()
        val edit = prefs.edit()
            .putString(K_SERVER, serverUrl)
            .putString(K_PROFILE, profile)
            .putString(K_FOLDER, folder)
            .putBoolean(K_AUTO, autoSync)
            .putBoolean(K_REMEMBER, rememberPassword)
        // A saved password belongs to one server + profile. Drop it if either changes.
        if (!rememberPassword || old.serverUrl != serverUrl || old.profile != profile) {
            edit.remove(K_PASSWORD)
        }
        edit.apply()
        saveToken(sessionToken)
    }

    // ---- session token, encrypted like the password: it works as a login on its own ----

    fun saveToken(token: String) {
        val edit = prefs.edit().remove(K_TOKEN_PLAIN)
        if (token.isEmpty()) edit.remove(K_TOKEN) else edit.putString(K_TOKEN, encrypt(token))
        edit.apply()
    }

    private fun token(): String {
        // Builds before this change stored the token in plain text: move it over once.
        prefs.getString(K_TOKEN_PLAIN, null)?.let { plain ->
            saveToken(plain)
            return plain
        }
        val stored = prefs.getString(K_TOKEN, null) ?: return ""
        return decrypt(stored) ?: run {
            prefs.edit().remove(K_TOKEN).apply()
            ""
        }
    }

    // ---- status shown in the UI and notification ----

    fun setStatus(ok: Boolean, message: String) {
        prefs.edit()
            .putLong(K_LAST_AT, System.currentTimeMillis())
            .putBoolean(K_LAST_OK, ok)
            .putString(K_LAST_MSG, message)
            .apply()
    }

    fun lastAt(): Long = prefs.getLong(K_LAST_AT, 0L)
    fun lastOk(): Boolean = prefs.getBoolean(K_LAST_OK, true)
    fun lastMessage(): String = prefs.getString(K_LAST_MSG, "") ?: ""

    /** Set when a re-login with the saved password failed; cleared by the next manual login. */
    fun setNeedsLogin(value: Boolean) {
        prefs.edit().putBoolean(K_NEEDS_LOGIN, value).apply()
    }

    fun needsLogin(): Boolean = prefs.getBoolean(K_NEEDS_LOGIN, false)

    // ---- password, encrypted with an Android Keystore key that never leaves the device ----

    fun hasPassword(): Boolean = prefs.contains(K_PASSWORD)

    fun savePassword(password: String) {
        prefs.edit().putString(K_PASSWORD, encrypt(password)).apply()
    }

    fun password(): String? {
        val stored = prefs.getString(K_PASSWORD, null) ?: return null
        // Key was wiped or data is corrupt: forget it rather than fail every sync.
        return decrypt(stored) ?: run {
            clearPassword()
            null
        }
    }

    fun clearPassword() {
        prefs.edit().remove(K_PASSWORD).apply()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val blob = cipher.iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(blob, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String? = try {
        val blob = Base64.decode(stored, Base64.NO_WRAP)
        val iv = blob.copyOfRange(0, IV_BYTES)
        val data = blob.copyOfRange(IV_BYTES, blob.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        String(cipher.doFinal(data), Charsets.UTF_8)
    } catch (e: Exception) {
        null
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    companion object {
        private const val PREFS = "odl_bgsync"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "odl_bgsync_password_key"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12

        private const val K_SERVER = "server_url"
        private const val K_PROFILE = "profile"
        private const val K_TOKEN_PLAIN = "session_token"
        private const val K_TOKEN = "session_token_enc"
        private const val K_FOLDER = "folder"
        private const val K_AUTO = "auto_sync"
        private const val K_REMEMBER = "remember_password"
        private const val K_PASSWORD = "password_enc"
        private const val K_LAST_AT = "last_sync_at"
        private const val K_LAST_OK = "last_sync_ok"
        private const val K_LAST_MSG = "last_sync_message"
        private const val K_NEEDS_LOGIN = "needs_login"
    }
}
