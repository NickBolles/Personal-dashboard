package com.nickbolles.jarvis.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import com.nickbolles.jarvis.data.AppGraph
import kotlinx.coroutines.launch

/** "Mark handled" on a notification: tells Jarvis (alert → acted), then clears it. */
class NotificationActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_HANDLED = "com.nickbolles.jarvis.HANDLED"
        const val EXTRA_ID = "id"
        const val EXTRA_NOTIF = "notif"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_HANDLED) return
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val pending = goAsync()
        val graph = AppGraph.get(context)
        graph.scope.launch {
            try {
                runCatching { graph.call { it.transition(id, "acted") } }
                val nm = NotificationManagerCompat.from(context)
                nm.activeNotifications.filter { it.id == intent.getIntExtra(EXTRA_NOTIF, 0) }.forEach { nm.cancel(it.tag, it.id) }
                graph.onDataChanged()
            } finally {
                pending.finish()
            }
        }
    }
}
