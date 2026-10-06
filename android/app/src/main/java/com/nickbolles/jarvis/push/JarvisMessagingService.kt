package com.nickbolles.jarvis.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.nickbolles.jarvis.data.AppGraph

class JarvisMessagingService : FirebaseMessagingService() {
    override fun onRegistered(token: String) {
        val graph = AppGraph.get(this)
        graph.launch { PushRegistrar.register(graph, token) }
    }

    override fun onUnregistered(token: String) {
        val graph = AppGraph.get(this)
        graph.launch {
            graph.store.saveFcmToken(null)
            runCatching { graph.call { it.updateMe(clearPush = true) } }
            graph.store.markPushTokenSent(null)
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data["type"] == "notification") Notifications.show(this, data)
        AppGraph.get(this).onDataChanged()
    }
}
