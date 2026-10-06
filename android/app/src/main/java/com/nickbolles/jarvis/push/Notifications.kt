package com.nickbolles.jarvis.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.nickbolles.jarvis.MainActivity
import com.nickbolles.jarvis.R

/** Builds phone notifications from Jarvis's FCM data messages. */
object Notifications {
    const val CH_CRITICAL = "critical"
    const val CH_HERMES = "hermes"
    const val CH_ALERTS = "alerts"
    const val CH_INFO = "info"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CH_CRITICAL, "Critical home alerts", NotificationManager.IMPORTANCE_HIGH).apply { description = "Alarm, doors, locks, leaks" },
                NotificationChannel(CH_HERMES, "Hermes needs you", NotificationManager.IMPORTANCE_HIGH).apply { description = "Approvals and questions from Hermes" },
                NotificationChannel(CH_ALERTS, "Alerts", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Overdue todos, Daily Compass, finished runs" },
                NotificationChannel(CH_INFO, "Status", NotificationManager.IMPORTANCE_LOW).apply { description = "Integration problems and other info" },
            ),
        )
    }

    fun channelFor(category: String?, severity: String?) = when {
        severity == "critical" || category == "ha_critical" -> CH_CRITICAL
        category == "hermes_input" -> CH_HERMES
        category == "integration_failure" || category == "info" -> CH_INFO
        else -> CH_ALERTS
    }

    fun openIntent(context: Context, path: String, requestCode: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("jarvis://open${if (path.startsWith("/")) path else "/$path"}"), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun show(context: Context, data: Map<String, String>) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val id = data["id"] ?: return
        val tag = data["tag"] ?: id
        val notifId = tag.hashCode()
        val path = data["url"] ?: "/alerts"
        val markHandled = PendingIntent.getBroadcast(
            context,
            notifId,
            Intent(context, NotificationActionReceiver::class.java).setAction(NotificationActionReceiver.ACTION_HANDLED)
                .putExtra(NotificationActionReceiver.EXTRA_ID, id)
                .putExtra(NotificationActionReceiver.EXTRA_NOTIF, notifId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, channelFor(data["category"], data["severity"]))
            .setSmallIcon(R.drawable.ic_stat_jarvis)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setContentTitle(data["title"] ?: "Jarvis")
            .setContentText(data["body"])
            .setStyle(NotificationCompat.BigTextStyle().bigText(data["body"]))
            .setContentIntent(openIntent(context, path, notifId))
            .setAutoCancel(true)
            .setCategory(if (data["severity"] == "critical") NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (data["severity"] == "critical") NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_DEFAULT)
            .addAction(0, "Mark handled", markHandled)
            .apply { data["unread"]?.toIntOrNull()?.let { setNumber(it) } }
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(tag, notifId, n) }
    }
}
