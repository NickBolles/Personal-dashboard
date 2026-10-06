package com.nickbolles.jarvis.ui.nav

import android.net.Uri

/** Navigation routes. Server deep links (/chat/abc, /alerts…) map onto these. */
object Routes {
    const val HOME = "home"
    const val CHAT = "chat"
    const val CONVERSATION = "chat/{id}?run={run}"
    const val ALERTS = "alerts"
    const val MORE = "more"
    const val CONTROLS = "home-control?entity={entity}"
    const val SKYLIGHT = "skylight"
    const val COMPASS = "daily-compass"
    const val TODOS = "todos"
    const val SETTINGS = "settings"
    const val LAYOUT = "settings/layout"

    fun conversation(id: String, run: String? = null) = "chat/${Uri.encode(id)}" + (run?.let { "?run=${Uri.encode(it)}" } ?: "")
    fun controls(entity: String? = null) = "home-control" + (entity?.let { "?entity=${Uri.encode(it)}" } ?: "")

    /**
     * "/chat/abc?run=r1" (server deepLink) or "jarvis://open/alerts" → app route.
     * Returns null for capture (handled as a sheet) and unknown paths.
     */
    fun fromPath(raw: String): String? {
        val path = raw.removePrefix("jarvis://open").let { if (it.startsWith("/")) it else "/$it" }
        val uri = Uri.parse("https://x$path")
        val segs = uri.pathSegments
        return when (segs.firstOrNull()) {
            null, "", "home" -> HOME
            "chat" -> segs.getOrNull(1)?.let { conversation(it, uri.getQueryParameter("run")) } ?: CHAT
            "alerts" -> ALERTS
            "home-control" -> controls(uri.getQueryParameter("entity"))
            "skylight" -> SKYLIGHT
            "daily-compass" -> COMPASS
            "todos" -> TODOS
            "settings" -> SETTINGS
            "more" -> MORE
            else -> null
        }
    }
}
