package com.nickbolles.jarvis.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import okhttp3.Request

/** One server-sent event. */
data class SseEvent(val id: String?, val event: String?, val data: String)

/** Incremental SSE parser (same rules as lib/sse.ts): feed text chunks, get complete events. */
class SseParser {
    private val buffer = StringBuilder()
    private var id: String? = null
    private var event: String? = null
    private val data = StringBuilder()
    var lastEventId: String? = null
        private set

    fun feed(chunk: String): List<SseEvent> {
        buffer.append(chunk)
        val out = mutableListOf<SseEvent>()
        while (true) {
            val nl = buffer.indexOf("\n")
            if (nl < 0) break
            var line = buffer.substring(0, nl)
            buffer.delete(0, nl + 1)
            if (line.endsWith("\r")) line = line.dropLast(1)
            if (line.isEmpty()) {
                if (data.isNotEmpty()) {
                    val e = SseEvent(id, event, data.toString().removeSuffix("\n"))
                    if (id != null) lastEventId = id
                    out += e
                }
                data.clear()
                event = null
                id = null
                continue
            }
            if (line.startsWith(":")) continue
            val colon = line.indexOf(':')
            val field = if (colon < 0) line else line.substring(0, colon)
            val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
            when (field) {
                "data" -> data.append(value).append('\n')
                "id" -> id = value
                "event" -> event = value
            }
        }
        return out
    }
}

/**
 * Live run events from /api/hermes/runs/:id/events. Reconnects with
 * Last-Event-ID when the stream drops and, like the web app, never infers
 * completion from a closed stream: it asks the server for the run's real
 * status and emits Terminal only when Hermes says so.
 */
class RunStream(private val api: JarvisApi) {
    fun events(runId: String, afterSeq: String? = null, maxReconnects: Int = 8): Flow<RunEvent> = flow {
        var last = afterSeq
        var attempts = 0
        val streaming = api.http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).callTimeout(0, TimeUnit.MILLISECONDS).build()
        while (currentCoroutineContext().isActive) {
            var terminal = false
            try {
                val req = api.authed(Request.Builder().url(api.url("/api/hermes/runs/$runId/events")))
                    .header("Accept", "text/event-stream")
                    .apply { last?.let { header("Last-Event-ID", it) } }
                    .build()
                streaming.newCall(req).execute().use { res ->
                    if (res.code == 401) throw ApiException(401, "unauthenticated", "Signed out")
                    if (!res.isSuccessful) throw ApiException(res.code, null, "Stream failed (${res.code})")
                    val parser = SseParser()
                    val source = res.body.source()
                    while (!source.exhausted() && currentCoroutineContext().isActive) {
                        val line = source.readUtf8Line() ?: break
                        for (e in parser.feed(line + "\n")) {
                            val ev = RunEvent.parse(e.data) ?: continue
                            e.id?.let { last = it }
                            if (ev is RunEvent.StreamClosed) break
                            emit(ev)
                            attempts = 0
                            if (ev is RunEvent.Terminal) {
                                terminal = true
                                return@use
                            }
                        }
                    }
                }
            } catch (e: ApiException) {
                if (e.isAuth || e.status == 404) throw e
            } catch (_: IOException) {
                // fall through to reconcile + reconnect
            }
            if (terminal) return@flow
            // Stream ended without a terminal event: check the authoritative status.
            val status = runCatching { api.run(runId) }.getOrNull()
            if (status != null && status.status in TERMINAL_STATUSES) {
                emit(RunEvent.Terminal(null, status.status, status.output, status.error))
                return@flow
            }
            if (++attempts > maxReconnects) {
                emit(RunEvent.StreamClosed("error", "Lost connection to the run. Pull to refresh."))
                return@flow
            }
            emit(RunEvent.Other(null, "reconnecting", null))
            delay((500L shl attempts.coerceAtMost(5)).coerceAtMost(10_000))
        }
    }.flowOn(Dispatchers.IO)
}
