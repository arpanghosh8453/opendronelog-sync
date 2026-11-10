package com.opendronelog.bgsync

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.concurrent.thread

@InvokeArg
class ConfigureArgs {
    var serverUrl: String = ""
    var profile: String = ""
    var sessionToken: String = ""
    var folder: String = ""
    var autoSync: Boolean = false
    var rememberPassword: Boolean = false
    /** Only sent right after a successful manual login with "remember password" ticked. */
    var password: String? = null
}

@InvokeArg
class GrantArgs {
    var path: String = ""
}

@InvokeArg
class ScanArgs {
    var folder: String = ""
    var extensions: Array<String> = arrayOf()
}

@InvokeArg
class UploadArgs {
    var path: String = ""
}

@TauriPlugin
class BgSyncPlugin(private val activity: Activity) : Plugin(activity) {
    private val store by lazy { Store(activity) }

    @Command
    fun configure(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ConfigureArgs::class.java)
            val old = store.config()
            store.saveConfig(
                serverUrl = args.serverUrl,
                profile = args.profile,
                sessionToken = args.sessionToken,
                folder = args.folder,
                autoSync = args.autoSync,
                rememberPassword = args.rememberPassword,
            )
            val password = args.password
            if (args.rememberPassword && !password.isNullOrEmpty()) {
                store.savePassword(password)
            }
            // A new token from a manual login means the user has dealt with any "login needed" state.
            if (args.sessionToken.isNotEmpty() && args.sessionToken != old.sessionToken) {
                store.setNeedsLogin(false)
            }
            if (args.autoSync) SyncService.start(activity) else SyncService.stop(activity)
            invoke.resolve(status())
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Could not save background sync settings")
        }
    }

    @Command
    fun getStatus(invoke: Invoke) {
        invoke.resolve(status())
    }

    /** Used by the web UI after a 401: one re-login attempt with the saved password. */
    @Command
    fun relogin(invoke: Invoke) {
        thread(name = "odl-bgsync-relogin") {
            try {
                val token = SyncEngine.relogin(store)
                invoke.resolve(JSObject().put("session", token))
            } catch (e: Exception) {
                invoke.reject(e.message ?: "Re-login failed")
            }
        }
    }

    @Command
    fun clearPassword(invoke: Invoke) {
        store.clearPassword()
        invoke.resolve(status())
    }

    /** Opens the "All files access" screen (Android 11+) or asks for storage permission (Android 10). */
    @Command
    fun requestStorageAccess(invoke: Invoke) {
        try {
            if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
            }
            if (!hasStorageAccess()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
                        .setData(Uri.parse("package:${activity.packageName}"))
                    try {
                        activity.startActivity(intent)
                    } catch (e: Exception) {
                        activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    }
                } else {
                    ActivityCompat.requestPermissions(
                        activity,
                        arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE),
                        REQ_STORAGE,
                    )
                }
            }
            invoke.resolve(status())
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Could not open the storage permission screen")
        }
    }

    @Command
    fun syncNow(invoke: Invoke) {
        if (store.config().autoSync) {
            SyncService.start(activity, syncNow = true)
            invoke.resolve(status())
            return
        }
        thread(name = "odl-bgsync-once") {
            SyncEngine.runOnce(activity)
            invoke.resolve(status())
        }
    }

    /**
     * Opens Android's folder picker at `path` (e.g. DJI Fly's Android/data/.../FlightRecord) so the
     * user can tap "Allow access" once. The grant is kept across reboots; resolves to the tree URI,
     * which is then used as the sync folder.
     */
    @Command
    fun grantFolderAccess(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(GrantArgs::class.java)
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                LogSource.initialPickerUri(args.path)?.let { intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, it) }
            }
            startActivityForResult(invoke, intent, "grantFolderResult")
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Could not open the folder picker")
        }
    }

    @ActivityCallback
    fun grantFolderResult(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.reject("Folder access was not granted")
            return
        }
        try {
            activity.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            invoke.resolve(JSObject().put("folder", uri.toString()))
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Could not keep folder access")
        }
    }

    /** Lists the sync folder's files with hashes (dashboard view for picker-granted folders). */
    @Command
    fun scanFolder(invoke: Invoke) {
        val args = invoke.parseArgs(ScanArgs::class.java)
        thread(name = "odl-bgsync-scan") {
            try {
                val exts = args.extensions.map { it.trim().trimStart('.').lowercase() }.filter { it.isNotEmpty() }.toSet()
                val files = JSArray()
                for ((entry, hash) in SyncEngine.scan(activity, args.folder, exts)) {
                    files.put(
                        JSObject()
                            .put("name", entry.name)
                            .put("path", entry.key)
                            .put("size", entry.size)
                            .put("modifiedMs", entry.lastModified)
                            .put("hash", hash)
                    )
                }
                invoke.resolve(JSObject().put("files", files))
            } catch (e: Exception) {
                invoke.reject(e.message ?: "Could not read the sync folder")
            }
        }
    }

    /** Uploads one file by path or document URI with the stored session ("Sync Now" for picker folders). */
    @Command
    fun uploadFile(invoke: Invoke) {
        val args = invoke.parseArgs(UploadArgs::class.java)
        thread(name = "odl-bgsync-upload") {
            val (code, message) = SyncEngine.uploadOne(activity, args.path)
            invoke.resolve(
                JSObject()
                    .put("success", code in 200..299)
                    .put("statusCode", code)
                    .put("message", message)
                    .put("fileHash", "")
            )
        }
    }

    /** Searches storage for DJI FlightRecord folders (runs off the UI thread). */
    @Command
    fun findLogFolders(invoke: Invoke) {
        thread(name = "odl-bgsync-find") {
            try {
                val folders = JSArray()
                for (f in LogFolderFinder.find(activity)) {
                    folders.put(
                        JSObject()
                            .put("path", f.path)
                            .put("readable", f.readable)
                            .put("logCount", f.logCount)
                            .put("newestLogMs", f.newestLogMs)
                            .put("newestLogName", f.newestLogName)
                            .put("app", f.app)
                    )
                }
                invoke.resolve(JSObject().put("folders", folders).put("storageAccess", hasStorageAccess()))
            } catch (e: Exception) {
                invoke.reject(e.message ?: "Folder search failed")
            }
        }
    }

    private fun hasStorageAccess(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            ContextCompat.checkSelfPermission(activity, Manifest.permission.READ_EXTERNAL_STORAGE) ==
                PackageManager.PERMISSION_GRANTED
        }

    @Suppress("DEPRECATION")
    private fun status(): JSObject {
        val cfg = store.config()
        val pilotFolder = File(Environment.getExternalStorageDirectory(), PILOT2_RELATIVE)
        return JSObject()
            .put("autoSync", cfg.autoSync)
            .put("serviceRunning", SyncService.running)
            .put("rememberPassword", cfg.rememberPassword)
            .put("hasSavedPassword", store.hasPassword())
            .put("needsLogin", store.needsLogin())
            .put("storageAccess", hasStorageAccess())
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("pilotFolder", pilotFolder.absolutePath)
            .put("pilotFolderExists", pilotFolder.isDirectory)
            .put("lastSyncAt", store.lastAt())
            .put("lastSyncOk", store.lastOk())
            .put("lastSyncMessage", store.lastMessage())
    }

    companion object {
        private const val REQ_STORAGE = 4712
        private const val REQ_NOTIFY = 4713
        /** Where DJI Pilot 2 keeps flight logs on the RC Plus / RC Plus 2 (shared storage). */
        const val PILOT2_RELATIVE = "DJI/com.dji.industry.pilot/FlightRecord"
    }
}
