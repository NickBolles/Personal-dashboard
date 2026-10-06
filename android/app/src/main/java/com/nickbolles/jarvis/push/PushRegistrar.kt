package com.nickbolles.jarvis.push

import android.content.Context
import android.util.Log
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.nickbolles.jarvis.BuildConfig
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.PushConfig
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Firebase is configured at runtime from the Jarvis server (Settings → Phones
 * → Firebase on the web), so the APK carries no google-services.json and works
 * with anyone's Jarvis. Registration sends the FCM token to /api/devices/me.
 */
object PushRegistrar {
    private const val TAG = "JarvisPush"

    fun initFirebase(context: Context, c: PushConfig): Boolean = runCatching {
        val existing = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
        if (existing != null) {
            if (existing.options.projectId == c.projectId && existing.options.applicationId == c.applicationId) return@runCatching true
            existing.delete()
        }
        FirebaseApp.initializeApp(
            context,
            FirebaseOptions.Builder()
                .setProjectId(c.projectId)
                .setApplicationId(c.applicationId)
                .setApiKey(c.apiKey)
                .setGcmSenderId(c.senderId)
                .build(),
        )
        true
    }.getOrElse {
        Log.w(TAG, "Firebase init failed", it)
        false
    }

    /** Idempotent; safe to call on every app start, after pairing and from onNewToken. */
    suspend fun register(graph: AppGraph, freshToken: String? = null) {
        try {
            val me = graph.call { it.me() }
            val config = me.push
            graph.store.savePushConfig(config)
            if (config == null) {
                if (me.device?.pushEnabled == true) graph.call { it.updateMe(clearPush = true) }
                graph.store.markPushTokenSent(null)
                return
            }
            if (!initFirebase(graph.context, config)) return
            freshToken?.let { graph.store.saveFcmToken(it) }
            val token = freshToken ?: graph.store.fcmToken()
            if (token == null) {
                // Firebase answers through JarvisMessagingService.onRegistered, which calls back here.
                FirebaseMessaging.getInstance().register().await()
                return
            }
            if (token != graph.store.sentPushToken() || me.device?.pushEnabled != true) {
                graph.call { it.updateMe(pushToken = token, appVersion = BuildConfig.VERSION_NAME) }
                graph.store.markPushTokenSent(token)
            }
        } catch (e: ApiException) {
            Log.w(TAG, "Push registration: ${e.message}")
        } catch (e: Exception) {
            Log.w(TAG, "Push registration failed", e)
        }
    }
}

suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { cont ->
    addOnCompleteListener { t ->
        if (t.isSuccessful) cont.resume(t.result) else cont.resumeWithException(t.exception ?: IllegalStateException("Task failed"))
    }
}
