package com.opendronelog.bgsync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Starts background sync when the controller boots (or the app is updated), if the user turned it on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!Store(context).config().autoSync) return
        try {
            SyncService.start(context)
            Log.i("OdlBgSync", "started after $action")
        } catch (e: Exception) {
            Log.e("OdlBgSync", "could not start after $action", e)
        }
    }
}
