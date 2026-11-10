package com.opendronelog.bgsync

import android.content.Context
import android.os.Environment
import java.io.File

/** A folder that holds (or is meant to hold) DJI flight logs. */
class FoundFolder(
    val path: String,
    /** False when the folder exists but Android won't let this app read it (e.g. Android/data on Android 11+). */
    val readable: Boolean,
    /** Number of .txt files directly in the folder. */
    val logCount: Int,
    val newestLogMs: Long,
    /** File name of the most recent log, e.g. DJIFlightRecord_2025-06-15_[13-36-13].txt or FlightRecord_2026-11-04_[13-03-25].txt. */
    val newestLogName: String,
    /** Which DJI app the folder belongs to, from its path (e.g. com.dji.industry.pilot, dji.go.v5). */
    val app: String,
)

/**
 * Finds DJI flight log folders on internal storage and any SD card.
 *
 * A folder counts when its name looks like a flight log folder (FlightRecord, FlightRecords,
 * flight_logs, "Flight Logs"…), and its logs are the .txt files directly inside it. File names
 * vary by app (Pilot 2: DJIFlightRecord_<date>_[<time>].txt, DJI Fly: FlightRecord_<date>_[<time>].txt),
 * so they're only used as a hint: a folder with any other name also counts if it holds .txt files
 * whose names contain "FlightRecord" (e.g. logs a user copied somewhere).
 *
 * - DJI Pilot 2 (RC Plus / RC Plus 2) uses shared storage: DJI/com.dji.industry.pilot/FlightRecord.
 * - DJI Fly (RC Pro / RC Pro 2) uses Android/data/dji.go.v5/files/FlightRecord, which Android 11+
 *   hides from other apps; those are reported with readable = false so the UI can explain why.
 */
object LogFolderFinder {
    private const val MAX_DEPTH = 6
    private const val MAX_DIRS = 6000

    /** Folder names DJI apps use for flight logs, compared without case, spaces, '_' or '-'. */
    private val LOG_FOLDER_NAMES = setOf("flightrecord", "flightrecords", "flightlog", "flightlogs")

    fun isLogFolderName(name: String): Boolean =
        name.lowercase().replace(Regex("[\\s_-]"), "") in LOG_FOLDER_NAMES

    private fun isTxt(file: File): Boolean = file.isFile && file.name.endsWith(".txt", ignoreCase = true)

    private fun looksLikeFlightRecord(file: File): Boolean = file.name.contains("flightrecord", ignoreCase = true)

    fun find(context: Context): List<FoundFolder> {
        val results = LinkedHashMap<String, FoundFolder>()
        for (root in storageRoots(context)) {
            var budget = MAX_DIRS
            fun walk(dir: File, depth: Int) {
                if (depth > MAX_DEPTH || budget <= 0) return
                budget--
                val children = dir.listFiles() ?: return
                if (isLogFolderName(dir.name) || children.any { isTxt(it) && looksLikeFlightRecord(it) }) {
                    results.putIfAbsent(dir.absolutePath, describe(dir, children))
                }
                for (child in children) {
                    if (!child.isDirectory || child.name.startsWith(".")) continue
                    // Android/ is handled below; skip big media trees that never hold flight logs.
                    if (depth == 0 && child.name in SKIP_TOP_LEVEL) continue
                    walk(child, depth + 1)
                }
            }
            // Search the whole volume (bounded), so logs are found wherever the DJI app or a user put them.
            walk(root, 0)

            // DJI Fly and other DJI apps keep logs in their private Android/data folder.
            val androidData = File(root, "Android/data")
            val djiPackages = androidData.listFiles()?.filter { it.name.contains("dji", ignoreCase = true) }
            if (djiPackages != null) {
                djiPackages.forEach { walk(it, 1) }
            } else {
                // Android 11+ won't even list Android/data. Probe the well-known DJI Fly path directly.
                for (pkg in listOf("dji.go.v5", "dji.go.v4")) {
                    val known = File(androidData, "$pkg/files/FlightRecord")
                    if (!results.containsKey(known.absolutePath)) {
                        results[known.absolutePath] = describe(known, known.listFiles())
                    }
                }
            }
        }
        // Readable folders always count. A blocked one is only worth mentioning if its DJI app is installed.
        // Empty folders (e.g. DJI's own debug folders named FlightRecord, which hold .log files) are only
        // shown when nothing with logs was found, e.g. before the first flight.
        val anyWithLogs = results.values.any { it.readable && it.logCount > 0 }
        return results.values
            .filter { it.readable || isInstalled(context, it.app) }
            .filter { !anyWithLogs || !it.readable || it.logCount > 0 }
            .sortedWith(
                compareByDescending<FoundFolder> { it.readable }
                    .thenByDescending { it.logCount > 0 }
                    .thenByDescending { it.newestLogMs }
                    .thenByDescending { it.logCount }
            )
    }

    private fun describe(dir: File, children: Array<File>?): FoundFolder {
        // Logs are the .txt files directly in the folder (subfolders like si_cache are DJI internals).
        val logs = children?.filter { isTxt(it) } ?: emptyList()
        val newest = logs.maxByOrNull { it.lastModified() }
        return FoundFolder(
            path = dir.absolutePath,
            readable = children != null && dir.canRead(),
            logCount = logs.size,
            newestLogMs = newest?.lastModified() ?: 0L,
            newestLogName = newest?.name ?: "",
            app = appFromPath(dir.absolutePath),
        )
    }

    private fun appFromPath(path: String): String {
        val parts = path.split('/')
        val dji = parts.indexOfFirst { it == "DJI" }
        if (dji >= 0 && dji + 1 < parts.size) return parts[dji + 1]
        val data = parts.indexOfFirst { it == "data" }
        if (data >= 0 && data + 1 < parts.size) return parts[data + 1]
        return ""
    }

    private fun isInstalled(context: Context, pkg: String): Boolean = pkg.isNotEmpty() && try {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(pkg, 0)
        true
    } catch (e: Exception) {
        false
    }

    /** Internal storage plus any removable volumes (SD card), as their root folders. */
    @Suppress("DEPRECATION")
    private fun storageRoots(context: Context): List<File> {
        val roots = LinkedHashSet<File>()
        roots.add(Environment.getExternalStorageDirectory())
        context.getExternalFilesDirs(null).filterNotNull().forEach { appDir ->
            // .../Android/data/<pkg>/files -> volume root
            val path = appDir.absolutePath
            val idx = path.indexOf("/Android/data/")
            if (idx > 0) roots.add(File(path.substring(0, idx)))
        }
        return roots.toList()
    }

    private val SKIP_TOP_LEVEL = setOf("Android", "DCIM", "Pictures", "Movies", "Music", "Alarms", "Ringtones", "Notifications", "Podcasts")
}
