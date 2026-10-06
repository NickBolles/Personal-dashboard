package com.nickbolles.jarvis

import android.app.Application
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.push.Notifications
import com.nickbolles.jarvis.push.PushRegistrar
import com.nickbolles.jarvis.widgets.WidgetUpdater
import kotlinx.coroutines.runBlocking

class JarvisApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        val graph = AppGraph.get(this)
        Notifications.createChannels(this)
        // A push can start the process cold: Firebase must be ready before the service runs.
        runBlocking { graph.store.pushConfig() }?.let { PushRegistrar.initFirebase(this, it) }
        graph.onDataChanged = { WidgetUpdater.requestRefresh(this) }
        WidgetUpdater.schedulePeriodic(this)
    }
}
