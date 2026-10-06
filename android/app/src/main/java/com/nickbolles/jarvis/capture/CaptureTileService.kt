package com.nickbolles.jarvis.capture

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.service.quicksettings.TileService
import com.nickbolles.jarvis.MainActivity

/** Quick Settings tile: "Ask Hermes" from anywhere. */
class CaptureTileService : TileService() {
    override fun onClick() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("jarvis://open/capture"), this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
