package com.nickbolles.jarvis.widgets

import android.content.Context
import androidx.glance.appwidget.updateAll
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.WidgetSummary
import java.util.concurrent.TimeUnit

const val WIDGET_CACHE = "widget-summary"

fun readWidgetSummary(context: Context): WidgetSummary? = AppGraph.get(context).store.readCache(WIDGET_CACHE, WidgetSummary.serializer())

/** Fetches /api/widget/summary into the cache and redraws every widget. */
class WidgetRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = AppGraph.get(applicationContext)
        if (graph.store.current() == null) {
            WidgetUpdater.redrawAll(applicationContext)
            return Result.success()
        }
        return try {
            val summary = graph.call { it.widgetSummary() }
            graph.store.writeCache(WIDGET_CACHE, WidgetSummary.serializer(), summary)
            WidgetUpdater.redrawAll(applicationContext)
            Result.success()
        } catch (e: Exception) {
            WidgetUpdater.redrawAll(applicationContext)
            if (runAttemptCount < 2) Result.retry() else Result.failure()
        }
    }
}

object WidgetUpdater {
    private const val PERIODIC = "widget-refresh"
    private const val NOW = "widget-refresh-now"
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(context: Context) {
        runCatching {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<WidgetRefreshWorker>(30, TimeUnit.MINUTES).setConstraints(online).build(),
            )
        }
    }

    fun requestRefresh(context: Context) {
        runCatching {
            WorkManager.getInstance(context).enqueueUniqueWork(
                NOW,
                ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<WidgetRefreshWorker>().setConstraints(online).setInitialDelay(1, TimeUnit.SECONDS).build(),
            )
        }
    }

    suspend fun redrawAll(context: Context) {
        NextUpWidget().updateAll(context)
        HomeStatusWidget().updateAll(context)
        CaptureWidget().updateAll(context)
        CompassWidget().updateAll(context)
    }
}
