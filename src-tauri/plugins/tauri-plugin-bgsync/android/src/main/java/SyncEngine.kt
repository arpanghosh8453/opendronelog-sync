package com.opendronelog.bgsync

import android.content.Context
import android.util.Log
import java.io.IOException
import java.security.MessageDigest
import java.text.DateFormat
import java.util.Date

/** The server needs an interactive login (no saved password, or it was rejected). */
class LoginNeededException(message: String) : IOException(message)

class SyncResult(val ok: Boolean, val uploaded: Int, val failed: Int, val waiting: Int, val message: String)

/**
 * One sync pass: list finished logs in the folder, compare their SHA-256 with what the
 * server already has, upload the rest. Stateless apart from small in-memory caches;
 * the server's hash list is the source of truth, exactly like the web UI.
 */
object SyncEngine {
    private const val TAG = "OdlBgSync"

    /** A log is only uploaded once it hasn't changed for this long (Pilot 2 writes it during the flight). */
    const val STABLE_MS = 120_000L

    /** After a file fails to upload (server rejected it), leave it alone for this long. */
    private const val FAILED_BACKOFF_MS = 30 * 60_000L

    private val lock = Any()
    private val hashCache = HashMap<String, Triple<Long, Long, String>>() // path -> (size, mtime, hash)
    private val failedAt = HashMap<String, Long>() // hash -> time of last failed upload

    fun runOnce(context: Context): SyncResult = synchronized(lock) {
        val store = Store(context)
        val result = try {
            syncFolder(context, store)
        } catch (e: LoginNeededException) {
            SyncResult(false, 0, 0, 0, e.message ?: "Login needed")
        } catch (e: HttpException) {
            SyncResult(false, 0, 0, 0, "Server error ${e.code}")
        } catch (e: IOException) {
            SyncResult(false, 0, 0, 0, "Server unreachable, will retry (${e.javaClass.simpleName})")
        } catch (e: Exception) {
            Log.e(TAG, "sync failed", e)
            SyncResult(false, 0, 0, 0, "Sync error: ${e.message ?: e.javaClass.simpleName}")
        }
        val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date())
        store.setStatus(result.ok, "$time · ${result.message}")
        Log.i(TAG, "sync result ok=${result.ok} ${result.message}")
        result
    }

    /**
     * Log in again with the saved password. Makes exactly one attempt: a rejected password is
     * deleted immediately so the server's lockout (5 bad tries) can never be reached by retries.
     */
    fun relogin(store: Store): String {
        val cfg = store.config()
        if (store.needsLogin()) throw LoginNeededException("Login needed: saved password was rejected")
        val password = if (cfg.rememberPassword) store.password() else null
        if (password == null) {
            store.setNeedsLogin(true)
            throw LoginNeededException("Session expired. Open the app and log in")
        }
        val token = try {
            OdlClient(cfg.serverUrl).login(cfg.profile, password)
        } catch (e: HttpException) {
            if (e.code == 401 || e.code == 403) {
                store.clearPassword()
                store.setNeedsLogin(true)
                throw LoginNeededException("Saved password was rejected. Open the app and log in")
            }
            throw e
        }
        store.saveToken(token)
        return token
    }

    private fun syncFolder(context: Context, store: Store): SyncResult {
        val cfg = store.config()
        if (cfg.serverUrl.isBlank() || cfg.profile.isBlank()) {
            return SyncResult(false, 0, 0, 0, "Not set up yet. Open the app and log in")
        }
        LogSource.problem(context, cfg.folder)?.let { return SyncResult(false, 0, 0, 0, it) }
        if (store.needsLogin()) return SyncResult(false, 0, 0, 0, "Login needed. Open the app and log in")

        val client = OdlClient(cfg.serverUrl)
        var token = cfg.sessionToken
        fun <T> authed(call: (String) -> T): T = try {
            call(token)
        } catch (e: HttpException) {
            if (e.code != 401) throw e
            token = relogin(store)
            call(token)
        }

        val extensions = authed { client.allowedExtensions(cfg.profile, it) }
        val imported = authed { client.importedHashes(cfg.profile, it) }
        val blacklisted = authed { client.blacklistedHashes(cfg.profile, it) }

        val now = System.currentTimeMillis()
        val candidates = LogSource.list(context, cfg.folder, extensions)

        var uploaded = 0
        var failed = 0
        var waiting = 0
        for (entry in candidates) {
            if (now - entry.lastModified < STABLE_MS) {
                waiting++ // still being written (or just copied); next pass picks it up
                continue
            }
            val hash = hashOf(entry)
            if (hash in imported || hash in blacklisted) continue
            val lastFail = failedAt[hash]
            if (lastFail != null && now - lastFail < FAILED_BACKOFF_MS) {
                failed++
                continue
            }
            try {
                authed { client.upload(cfg.profile, it, entry.name, entry::open, context.cacheDir) }
                uploaded++
                failedAt.remove(hash)
            } catch (e: HttpException) {
                if (e.code == 401) throw e
                Log.w(TAG, "upload rejected ${entry.name}: ${e.message}")
                failedAt[hash] = now
                failed++
            }
        }

        val parts = mutableListOf<String>()
        parts += if (uploaded > 0) "Uploaded $uploaded" else "Up to date"
        if (waiting > 0) parts += "$waiting waiting for flight to finish"
        if (failed > 0) parts += "$failed rejected by server"
        return SyncResult(failed == 0, uploaded, failed, waiting, parts.joinToString(", "))
    }

    /** Local files with their hashes, for the dashboard when the folder is a picker grant. */
    fun scan(context: Context, folder: String, extensions: Set<String>): List<Pair<LogEntry, String>> =
        synchronized(lock) {
            LogSource.problem(context, folder)?.let { throw IOException(it) }
            LogSource.list(context, folder, extensions).map { it to hashOf(it) }
        }

    /**
     * Uploads one file (by path or document URI) with the stored session, for "Sync Now" in the UI.
     * Returns the HTTP status (0 for network errors) and the server's message.
     */
    fun uploadOne(context: Context, key: String): Pair<Int, String> = synchronized(lock) {
        val cfg = Store(context).config()
        val (name, opener) = LogSource.openByKey(context, key)
        try {
            OdlClient(cfg.serverUrl).upload(cfg.profile, cfg.sessionToken, name, opener, context.cacheDir)
            200 to "Uploaded"
        } catch (e: HttpException) {
            e.code to (e.message ?: "HTTP ${e.code}")
        } catch (e: IOException) {
            0 to (e.message ?: "Upload failed")
        }
    }

    private fun hashOf(entry: LogEntry): String {
        hashCache[entry.key]?.let { (s, m, h) -> if (s == entry.size && m == entry.lastModified) return h }
        val digest = MessageDigest.getInstance("SHA-256")
        entry.open().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        hashCache[entry.key] = Triple(entry.size, entry.lastModified, hash)
        return hash
    }
}
