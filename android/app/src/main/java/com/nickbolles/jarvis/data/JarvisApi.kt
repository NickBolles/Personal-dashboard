package com.nickbolles.jarvis.data

import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Server error with the message the server wrote for people (safe to show). */
class ApiException(val status: Int, val code: String?, message: String) : Exception(message) {
    val isAuth get() = status == 401
    val isNetwork get() = status == 0
}

/**
 * Thin typed client for the Jarvis server. Every call sends the device token
 * as a bearer; there are no cookies or CSRF headers on this side.
 */
class JarvisApi(
    private val server: String,
    private val token: String?,
    val http: OkHttpClient = defaultClient(),
) {
    companion object {
        private val JSON_TYPE = "application/json".toMediaType()

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .build()

        /** "jarvis.example.com" → "https://jarvis.example.com"; keeps http:// for LAN testing. */
        fun normalizeServer(input: String): String {
            val t = input.trim().trimEnd('/')
            val withScheme = if (t.startsWith("http://") || t.startsWith("https://")) t else "https://$t"
            return withScheme.toHttpUrl().toString().trimEnd('/')
        }

        fun newIdempotencyKey(prefix: String = "and") = "$prefix-${UUID.randomUUID()}"
    }

    fun url(path: String) = "$server$path"

    fun authed(builder: Request.Builder): Request.Builder = token?.let { builder.header("Authorization", "Bearer $it") } ?: builder

    private suspend fun <T> send(method: String, path: String, body: JsonElement?, serializer: KSerializer<T>): T = withContext(Dispatchers.IO) {
        val req = authed(Request.Builder().url(url(path)))
            .header("Accept", "application/json")
            .method(method, body?.let { JarvisJson.encodeToString(JsonElement.serializer(), it).toRequestBody(JSON_TYPE) } ?: if (method == "GET") null else "{}".toRequestBody(JSON_TYPE))
            .build()
        val res = try {
            http.newCall(req).execute()
        } catch (e: IOException) {
            throw ApiException(0, "network", "Can't reach Jarvis (${e.message ?: "network error"})")
        }
        res.use { r ->
            val text = r.body.string()
            if (!r.isSuccessful) {
                val err = runCatching { JarvisJson.decodeFromString(ApiErrorBody.serializer(), text) }.getOrNull()
                throw ApiException(r.code, err?.code, err?.error ?: "Jarvis returned ${r.code}")
            }
            try {
                JarvisJson.decodeFromString(serializer, text.ifBlank { "{}" })
            } catch (e: Exception) {
                throw ApiException(r.code, "bad_response", "Unexpected response from Jarvis")
            }
        }
    }

    private suspend fun <T> get(path: String, s: KSerializer<T>) = send("GET", path, null, s)
    private suspend fun <T> post(path: String, body: JsonElement, s: KSerializer<T>) = send("POST", path, body, s)

    /* ------------------------------------------------------------ pairing */

    suspend fun pair(code: String, name: String, appVersion: String) =
        post("/api/devices/pair", buildJsonObject { put("code", code); put("name", name); put("platform", "android"); put("appVersion", appVersion) }, PairResponse.serializer())

    suspend fun me() = get("/api/devices/me", DeviceMe.serializer())

    suspend fun updateMe(pushToken: String? = null, clearPush: Boolean = false, appVersion: String? = null) = send(
        "PATCH",
        "/api/devices/me",
        buildJsonObject {
            if (clearPush) put("pushToken", JsonPrimitive(null as String?)) else pushToken?.let { put("pushToken", it) }
            appVersion?.let { put("appVersion", it) }
        },
        OkResponse.serializer(),
    )

    suspend fun signOut(deviceId: String) = send("DELETE", "/api/devices/$deviceId", JsonObject(emptyMap()), OkResponse.serializer())

    /* -------------------------------------------------------- home & actions */

    suspend fun home(cached: Boolean) = get(if (cached) "/api/home?cached=1" else "/api/home", HomePayload.serializer())

    suspend fun widgetSummary() = get("/api/widget/summary", WidgetSummary.serializer())

    suspend fun act(actionId: String, kind: String, until: String? = null) =
        post("/api/actions", buildJsonObject { put("actionId", actionId); put("kind", kind); until?.let { put("until", it) } }, ActionResult.serializer())

    suspend fun source(source: String, cached: Boolean = false) = get("/api/sources/$source${if (cached) "?cached=1" else ""}", SourceResult.serializer())

    suspend fun context(source: String) = get("/api/context?source=$source", ContextPreview.serializer())

    /* ------------------------------------------------------------- alerts */

    suspend fun notifications(all: Boolean = false) = get("/api/notifications${if (all) "?filter=all" else ""}", NotificationsResponse.serializer())

    suspend fun unread() = get("/api/notifications/count", UnreadCount.serializer())

    suspend fun transition(id: String, transition: String) =
        send("PATCH", "/api/notifications/$id", buildJsonObject { put("transition", transition) }, OkResponse.serializer())

    suspend fun markAllRead() = post("/api/notifications/read-all", JsonObject(emptyMap()), OkResponse.serializer())

    /* --------------------------------------------------------------- chat */

    suspend fun sessions() = get("/api/hermes/sessions", SessionsResponse.serializer())

    suspend fun session(id: String) = get("/api/hermes/sessions/$id", SessionDetail.serializer())

    suspend fun createSession(title: String?) =
        post("/api/hermes/sessions", buildJsonObject { title?.let { put("title", it) } }, SessionSummary.serializer())

    suspend fun startRun(sessionId: String, input: String, idempotencyKey: String, contextSources: List<ContextSource> = emptyList(), context: String? = null) = post(
        "/api/hermes/sessions/$sessionId/runs",
        buildJsonObject {
            put("input", input)
            put("idempotencyKey", idempotencyKey)
            context?.let { put("context", it.take(4000)) }
            if (contextSources.isNotEmpty()) put("contextSources", buildJsonArray { contextSources.forEach { add(JsonPrimitive(it.id)) } })
        },
        RunView.serializer(),
    )

    suspend fun run(runId: String) = get("/api/hermes/runs/$runId", RunView.serializer())

    suspend fun stopRun(runId: String) = post("/api/hermes/runs/$runId/stop", JsonObject(emptyMap()), RunView.serializer())

    suspend fun approve(runId: String, choice: String, requestId: String?) =
        post("/api/hermes/runs/$runId/approval", buildJsonObject { put("choice", choice); requestId?.let { put("requestId", it) } }, JsonObject.serializer())

    suspend fun renameSession(id: String, title: String) = send("PATCH", "/api/hermes/sessions/$id", buildJsonObject { put("title", title) }, SessionSummary.serializer())

    suspend fun archiveSession(id: String) = send("PATCH", "/api/hermes/sessions/$id", buildJsonObject { put("archived", true) }, SessionSummary.serializer())

    /* -------------------------------------------------------- home control */

    suspend fun controls() = get("/api/home-assistant/controls", ControlsResponse.serializer())

    suspend fun control(c: ControlView, service: String) = post(
        "/api/home-assistant/control",
        buildJsonObject { put("entityId", c.entityId); put("service", service); put("stateToken", c.stateToken); put("confirmed", true) },
        ControlResult.serializer(),
    )

    /* ------------------------------------------------------ daily compass */

    suspend fun compass() = get("/api/daily-compass", DailyCompassResponse.serializer())

    suspend fun startCompass() = post("/api/daily-compass/start", JsonObject(emptyMap()), CompassStart.serializer())

    suspend fun completeCompass() = post("/api/daily-compass/complete", JsonObject(emptyMap()), OkResponse.serializer())

    /* ----------------------------------------------------------- settings */

    suspend fun preferences() = get("/api/settings", Preferences.serializer())

    suspend fun saveLayout(layout: Layout) =
        send("PUT", "/api/settings", buildJsonObject { put("layout", JarvisJson.encodeToJsonElement(Layout.serializer(), layout)) }, Preferences.serializer())

    suspend fun testNotification() = post("/api/notifications/test", JsonObject(emptyMap()), OkResponse.serializer())
}

@kotlinx.serialization.Serializable
data class CompassStart(val sessionId: String, val runId: String? = null, val resumed: Boolean = false)
