package com.nickbolles.jarvis.capture

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService
import com.nickbolles.jarvis.web.TwaLauncherActivity

/** Quick Settings tile: "Ask Hermes" from anywhere. */
class CaptureTileService : TileService() {
    override fun onClick() {
        val intent = TwaLauncherActivity.intent(this, "/capture")
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
