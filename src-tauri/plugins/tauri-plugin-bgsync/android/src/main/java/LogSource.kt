package com.opendronelog.bgsync

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File
import java.io.InputStream

/** One log file in the sync folder, whether it's a plain file or a document reached through a picker grant. */
class LogEntry(
    val name: String,
    val size: Long,
    val lastModified: Long,
    /** Stable identity: the absolute path, or the document URI. */
    val key: String,
    private val opener: () -> InputStream,
) {
    fun open(): InputStream = opener()
}

/**
 * Lists the files in the sync folder. The folder is either a normal path (Pilot 2's shared-storage
 * folder) or a `content://` tree URI the user granted with Android's folder picker — the only way
 * to read DJI Fly's Android/data folder on Android 11+ (and any folder picked with Browse).
 */
object LogSource {
    private const val EXTERNAL_STORAGE_AUTHORITY = "com.android.externalstorage.documents"

    fun isTreeUri(folder: String): Boolean = folder.startsWith("content://")

    /** Problem with the folder that stops a sync, or null if it can be read. */
    fun problem(context: Context, folder: String): String? {
        if (folder.isBlank()) return "No sync folder set. Use Find DJI log folder"
        if (isTreeUri(folder)) {
            val uri = Uri.parse(folder)
            val granted = context.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }
            return if (granted) null else "Folder access was removed. Use Find DJI log folder and grant access again"
        }
        val dir = File(folder)
        if (!dir.isDirectory) return "Folder not found: $folder"
        if (!dir.canRead()) return "No storage access. Grant all files access"
        return null
    }

    /** Files directly in the folder whose extension the server accepts. */
    fun list(context: Context, folder: String, extensions: Set<String>): List<LogEntry> {
        fun allowed(name: String) = name.substringAfterLast('.', "").lowercase() in extensions
        if (!isTreeUri(folder)) {
            return (File(folder).listFiles() ?: emptyArray())
                .filter { it.isFile && allowed(it.name) }
                .map { f -> LogEntry(f.name, f.length(), f.lastModified(), f.absolutePath) { f.inputStream() } }
        }
        val tree = Uri.parse(folder)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        val columns = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        val entries = mutableListOf<LogEntry>()
        context.contentResolver.query(children, columns, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val docId = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                val mime = c.getString(2) ?: ""
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR || !allowed(name)) continue
                val size = if (c.isNull(3)) 0L else c.getLong(3)
                val modified = if (c.isNull(4)) 0L else c.getLong(4)
                val doc = DocumentsContract.buildDocumentUriUsingTree(tree, docId)
                entries += LogEntry(name, size, modified, doc.toString()) {
                    context.contentResolver.openInputStream(doc) ?: throw java.io.IOException("Can't open $name")
                }
            }
        }
        return entries
    }

    /** Opens one entry by its key (path or document URI), for uploads started from the UI. */
    fun openByKey(context: Context, key: String): Pair<String, () -> InputStream> {
        if (isTreeUri(key)) {
            val uri = Uri.parse(key)
            val name = context.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "log.txt"
            return name to { context.contentResolver.openInputStream(uri) ?: throw java.io.IOException("Can't open $name") }
        }
        val f = File(key)
        return f.name to { f.inputStream() }
    }

    /**
     * The picker's starting point for a folder on internal storage, e.g.
     * /storage/emulated/0/Android/data/dji.go.v5/files/FlightRecord ->
     * content://com.android.externalstorage.documents/document/primary%3AAndroid%2Fdata%2F…
     */
    fun initialPickerUri(path: String): Uri? {
        val prefix = "/storage/emulated/0/"
        if (!path.startsWith(prefix)) return null
        return DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE_AUTHORITY, "primary:" + path.removePrefix(prefix))
    }
}
