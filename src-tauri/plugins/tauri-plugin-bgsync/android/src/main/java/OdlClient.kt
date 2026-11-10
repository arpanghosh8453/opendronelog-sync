package com.opendronelog.bgsync

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/** HTTP status other than 2xx. `code == 401` means the session is no longer valid. */
class HttpException(val code: Int, message: String) : IOException("HTTP $code: $message")

/**
 * Minimal client for the OpenDronelog server, using the same endpoints and
 * headers (X-Profile, X-Session) as the web UI and the Rust uploader.
 */
class OdlClient(serverUrl: String) {
    private val base = serverUrl.trim().trimEnd('/')

    init {
        // Passwords and session tokens go to this address, so never in the clear over the internet.
        if (!isSafeServerUrl(base)) {
            throw IOException("Use https:// for this server. Plain http:// is only allowed on your own network.")
        }
    }

    /** POST /api/profiles/switch. Returns the new session token ("" for profiles without a password). */
    fun login(profile: String, password: String?): String {
        val body = JSONObject().put("name", profile).put("password", password ?: JSONObject.NULL)
        val json = JSONObject(request("POST", "/api/profiles/switch", null, null, body.toString()))
        return if (json.isNull("session")) "" else json.optString("session", "")
    }

    fun allowedExtensions(profile: String, token: String): Set<String> {
        val json = JSONObject(request("GET", "/api/allowed_log_extensions", profile, token, null))
        val arr = json.optJSONArray("extensions") ?: JSONArray()
        return (0 until arr.length())
            .map { arr.optString(it).trim().trimStart('.').lowercase() }
            .filter { it.isNotEmpty() }
            .toSet()
    }

    /** Hashes of logs already imported on the server (same field the web UI reads). */
    fun importedHashes(profile: String, token: String): Set<String> {
        val arr = JSONArray(request("GET", "/api/flights", profile, token, null))
        val hashes = HashSet<String>()
        for (i in 0 until arr.length()) {
            val flight = arr.optJSONObject(i) ?: continue
            val hash = flight.optString("fileHash", "").ifEmpty { flight.optString("file_hash", "") }
            if (hash.isNotEmpty()) hashes.add(hash)
        }
        return hashes
    }

    fun blacklistedHashes(profile: String, token: String): Set<String> {
        val json = JSONObject(request("GET", "/api/sync/blacklist", profile, token, null))
        val arr = json.optJSONArray("hashes") ?: JSONArray()
        return (0 until arr.length()).map { arr.optString(it) }.filter { it.isNotEmpty() }.toSet()
    }

    /**
     * POST /api/import as multipart field "file", like the Rust uploader. Takes a stream opener so it
     * works for plain files and for documents read through a folder-picker grant.
     * The body is buffered to a temp file first so the request has an exact Content-Length.
     */
    fun upload(profile: String, token: String, name: String, openStream: () -> InputStream, tempDir: File) {
        val tmp = File.createTempFile("odl-upload", ".bin", tempDir)
        try {
            openStream().use { input -> tmp.outputStream().use { input.copyTo(it, 64 * 1024) } }
            val boundary = "----odlsync" + UUID.randomUUID().toString().replace("-", "")
            val conn = open("POST", "/api/import", profile, token, UPLOAD_TIMEOUT_MS)
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            val safeName = name.replace("\"", "_")
            val head = ("--$boundary\r\n" +
                "Content-Disposition: form-data; name=\"file\"; filename=\"$safeName\"\r\n" +
                "Content-Type: application/octet-stream\r\n\r\n").toByteArray(Charsets.UTF_8)
            val tail = "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(head.size.toLong() + tmp.length() + tail.size.toLong())
            conn.outputStream.use { out ->
                out.write(head)
                tmp.inputStream().use { it.copyTo(out, 64 * 1024) }
                out.write(tail)
            }
            readResponse(conn)
        } finally {
            tmp.delete()
        }
    }

    private fun request(method: String, path: String, profile: String?, token: String?, jsonBody: String?): String {
        val conn = open(method, path, profile, token, REQUEST_TIMEOUT_MS)
        if (jsonBody != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(jsonBody.toByteArray(Charsets.UTF_8)) }
        }
        return readResponse(conn)
    }

    private fun open(method: String, path: String, profile: String?, token: String?, timeoutMs: Int): HttpURLConnection {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = timeoutMs
        conn.setRequestProperty("Accept", "application/json")
        if (!profile.isNullOrEmpty()) conn.setRequestProperty("X-Profile", profile)
        if (!token.isNullOrEmpty()) conn.setRequestProperty("X-Session", token)
        return conn
    }

    private fun readResponse(conn: HttpURLConnection): String {
        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw HttpException(code, text.take(300))
            return text
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val CONNECT_TIMEOUT_MS = 10_000
        // A server busy importing a batch of logs can take well over 20 s to list its flights,
        // and parsing a large mapping log (2,000+ photos) before /api/import answers takes longer still.
        private const val REQUEST_TIMEOUT_MS = 90_000
        private const val UPLOAD_TIMEOUT_MS = 300_000
    }
}

/** https:// anywhere; plain http:// only for hosts on the local network. */
fun isSafeServerUrl(url: String): Boolean {
    val parsed = try { URL(url) } catch (e: Exception) { return false }
    return when (parsed.protocol.lowercase()) {
        "https" -> true
        "http" -> isLocalNetworkHost(parsed.host ?: "")
        else -> false
    }
}

/**
 * True for hosts that can't be reached from the public internet: this device,
 * private (RFC 1918), carrier-grade NAT (Tailscale), link-local and IPv6
 * unique-local addresses, and .local / .lan / .home.arpa / .internal names.
 * Keep in step with isLocalNetworkHost in src/lib/platform.ts and src-tauri/src/lib.rs.
 */
fun isLocalNetworkHost(hostname: String): Boolean {
    val host = hostname.lowercase().trim('[', ']').trimEnd('.')
    if (host == "localhost" || host.endsWith(".localhost")) return true
    if (listOf(".local", ".lan", ".home.arpa", ".internal").any { host.endsWith(it) }) return true
    Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""").matchEntire(host)?.let { m ->
        val a = m.groupValues[1].toInt()
        val b = m.groupValues[2].toInt()
        return a == 127 || a == 10 || (a == 192 && b == 168) || (a == 172 && b in 16..31) ||
            (a == 169 && b == 254) || (a == 100 && b in 64..127)
    }
    if (host.contains(':')) {
        return host == "::1" || Regex("^f[cd][0-9a-f]{2}:").containsMatchIn(host) ||
            Regex("^fe[89ab][0-9a-f]:").containsMatchIn(host)
    }
    return false
}
