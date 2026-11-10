package com.opendronelog.bgsync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Log
import java.io.File

/**
 * Foreground service that keeps logs syncing while the app is closed.
 * Runs a pass on start, every [POLL_MS], and shortly after a log file stops changing.
 */
class SyncService : Service() {
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private var observer: FileObserver? = null
    private var observedFolder: String = ""

    private val periodic = object : Runnable {
        override fun run() {
            runSync()
            handler.postDelayed(this, POLL_MS)
        }
    }

    private val debounced = Runnable { runSync() }

    override fun onCreate() {
        super.onCreate()
        thread = HandlerThread("odl-bgsync").apply { start() }
        handler = Handler(thread.looper)
        createChannel()
        startInForeground(Store(this).lastMessage().ifEmpty { "Starting…" })
        running = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val store = Store(this)
        if (!store.config().autoSync) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground(store.lastMessage().ifEmpty { "Starting…" })
        watchFolder(store.config().folder)
        handler.removeCallbacks(periodic)
        handler.removeCallbacks(debounced)
        // ACTION_SYNC_NOW runs right away; a plain start (boot, app opened) waits a moment for the network.
        val delay = if (intent?.action == ACTION_SYNC_NOW) 0L else START_DELAY_MS
        handler.postDelayed(periodic, delay)
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        observer?.stopWatching()
        observer = null
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun runSync() {
        val result = SyncEngine.runOnce(this)
        startInForeground(Store(this).lastMessage())
        // A log that was still being written gets another look once it should be finished.
        if (result.waiting > 0) {
            handler.removeCallbacks(debounced)
            handler.postDelayed(debounced, SyncEngine.STABLE_MS + 5_000L)
        }
    }

    @Suppress("DEPRECATION")
    private fun watchFolder(path: String) {
        if (path == observedFolder && observer != null) return
        observer?.stopWatching()
        observer = null
        observedFolder = path
        if (path.isBlank() || path.startsWith("content://") || !File(path).isDirectory) return
        val mask = FileObserver.CLOSE_WRITE or FileObserver.MOVED_TO or FileObserver.CREATE or FileObserver.MODIFY
        observer = object : FileObserver(path, mask) {
            override fun onEvent(event: Int, file: String?) {
                // Every write pushes the check back, so it runs once the log has been quiet for STABLE_MS.
                handler.removeCallbacks(debounced)
                handler.postDelayed(debounced, SyncEngine.STABLE_MS + 5_000L)
            }
        }.also { it.startWatching() }
        Log.i("OdlBgSync", "watching $path")
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(CHANNEL_ID, "Background sync", NotificationManager.IMPORTANCE_LOW)
        channel.description = "Shows that flight logs are being synced to your OpenDronelog server"
        manager.createNotificationChannel(channel)
    }

    private fun startInForeground(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @Suppress("DEPRECATION")
    private fun buildNotification(text: String): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pending = launch?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("OpenDronelog Sync")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pending)
            .build()
    }

    companion object {
        const val ACTION_SYNC_NOW = "com.opendronelog.bgsync.SYNC_NOW"
        private const val CHANNEL_ID = "odl_bgsync"
        private const val NOTIFICATION_ID = 4711
        private const val POLL_MS = 5 * 60_000L
        private const val START_DELAY_MS = 20_000L

        @Volatile
        var running: Boolean = false
            private set

        fun start(context: Context, syncNow: Boolean = false) {
            val intent = Intent(context, SyncService::class.java)
            if (syncNow) intent.action = ACTION_SYNC_NOW
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SyncService::class.java))
        }
    }
}
