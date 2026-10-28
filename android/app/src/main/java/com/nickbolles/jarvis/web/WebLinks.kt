package com.nickbolles.jarvis.web

import java.net.URLDecoder
import java.net.URLEncoder

/**
 * The app is the Jarvis web app in a Trusted Web Activity. Widgets, the Quick Settings tile,
 * launcher shortcuts and notifications still fire the native links they always did
 * (jarvis://open/<path>, jarvis://areas/<id>, server deep links like /chat/abc?run=r1);
 * this maps each one onto a web URL that exists.
 *
 * Every URL gets ?source=android so the web app knows it's inside the app (it hides the
 * web push opt-in: this phone gets notifications from the app). Plain JVM, no android.*.
 */
object WebLinks {
    const val HOME = "/home"
    const val MARKER = "source=android"

    /** Web pages whose path (and query) the native links already share. */
    private val SAME_PATH = setOf(
        "home", "alerts", "skylight", "daily-compass", "todos", "finance", "settings", "more", "chat",
        "home-control", "brain", "initiatives", "workouts",
    )

    /** Areas views the old native app used as path segments; the web has ?view=. */
    private val AREA_VIEWS = mapOf("inbox" to "inbox", "tree" to "tree", "today" to null, "dashboard" to null, "map" to null, "timeline" to null)

    /**
     * "https://host[:port]" from the paired server, or [fallback] when there's no usable pairing.
     * Only http(s) servers count; any path on the paired URL is dropped.
     */
    fun origin(paired: String?, fallback: String): String = paired?.let(::originOf) ?: originOf(fallback) ?: fallback.trimEnd('/')

    fun originOf(url: String): String? {
        val m = Regex("^(https?)://([^/?#\\s]+)", RegexOption.IGNORE_CASE).find(url.trim()) ?: return null
        return "${m.groupValues[1].lowercase()}://${m.groupValues[2].lowercase()}"
    }

    /**
     * The full URL the app opens for [raw] (null = launcher icon).
     * https links are only followed on [origin] or [defaultOrigin] (App Links); anything else opens Home.
     */
    fun launchUrl(raw: String?, origin: String, defaultOrigin: String = origin): String {
        val link = raw?.trim().orEmpty()
        val linkOrigin = originOf(link)
        if (linkOrigin != null) {
            val trusted = linkOrigin == originOf(origin) || linkOrigin == originOf(defaultOrigin)
            return if (trusted) linkOrigin + withMarker(sitePath(link.substring(linkOrigin.length))) else origin + withMarker(HOME)
        }
        return origin + withMarker(webPath(link))
    }

    /**
     * Path + query + fragment of an App Link on the Jarvis site, kept as is: these are real web
     * URLs (/join?code=…, /areas/map), not old native links, so no mapping. Only `source` is
     * dropped (the app's marker), and dot segments open Home.
     */
    fun sitePath(rest: String): String {
        var s = rest
        if (!s.startsWith("/")) s = "/$s"
        val hashAt = s.indexOf('#')
        val fragment = if (hashAt >= 0) s.substring(hashAt) else ""
        if (hashAt >= 0) s = s.substring(0, hashAt)
        val qAt = s.indexOf('?')
        val path = if (qAt >= 0) s.substring(0, qAt) else s
        val query = parseQuery(if (qAt >= 0) s.substring(qAt + 1) else "").filter { it.first != "source" }
        val segs = path.split('/').filter { it.isNotEmpty() }
        if (segs.any { decode(it) == ".." || decode(it) == "." || decode(it).contains('\\') }) return HOME
        if (segs.isEmpty()) return HOME + buildQuery(query) + fragment
        return path + buildQuery(query) + fragment
    }

    /** Native link or path → web path + query (no origin, no marker). */
    fun webPath(raw: String?): String {
        var s = raw?.trim().orEmpty()
        s = when {
            s.startsWith("jarvis://open", ignoreCase = true) -> s.substring("jarvis://open".length)
            s.startsWith("jarvis://areas", ignoreCase = true) -> "/areas" + s.substring("jarvis://areas".length)
            s.startsWith("jarvis:", ignoreCase = true) -> return HOME
            else -> s
        }
        val hashAt = s.indexOf('#')
        val fragment = if (hashAt >= 0) s.substring(hashAt) else ""
        if (hashAt >= 0) s = s.substring(0, hashAt)
        val qAt = s.indexOf('?')
        val path = if (qAt >= 0) s.substring(0, qAt) else s
        val query = parseQuery(if (qAt >= 0) s.substring(qAt + 1) else "").filter { it.first != "source" || path.trim('/').startsWith("capture") }
        val segs = path.split('/').filter { it.isNotEmpty() }
        if (segs.any { decode(it) == ".." || decode(it) == "." || decode(it).contains('\\') }) return HOME
        val first = segs.firstOrNull() ?: return HOME
        val mapped = when (first) {
            in SAME_PATH -> "/" + segs.joinToString("/") + buildQuery(query) + fragment
            "areas", "work" -> areas(segs.drop(1), query)
            // Capture widget chips (source=home_assistant|skylight): `source` is the app marker on the web,
            // so the chip travels as ?attach= (the web capture page will pick it up; until then plain capture).
            "capture" -> "/capture" + buildQuery(query.map { if (it.first == "source") "attach" to it.second else it })
            // No /search page on the web: Home with the search palette open.
            "search" -> "$HOME?search=1"
            else -> HOME
        }
        return mapped
    }

    private fun areas(rest: List<String>, query: List<Pair<String, String>>): String {
        val q = query.toMutableList()
        val id = rest.firstOrNull()
        if (id != null && q.none { it.first == "item" }) {
            if (id in AREA_VIEWS) {
                AREA_VIEWS[id]?.let { view -> if (q.none { it.first == "view" }) q.add(0, "view" to view) }
            } else {
                q.add(0, "item" to encode(decode(id)))
            }
        }
        return "/areas" + buildQuery(q)
    }

    fun withMarker(path: String): String {
        val hashAt = path.indexOf('#')
        val base = if (hashAt >= 0) path.substring(0, hashAt) else path
        val fragment = if (hashAt >= 0) path.substring(hashAt) else ""
        if (parseQuery(base.substringAfter('?', "")).any { it.first == "source" && it.second == "android" }) return path
        return base + (if (base.contains('?')) "&" else "?") + MARKER + fragment
    }

    /** Raw (still-encoded) key/value pairs; empty keys dropped. */
    private fun parseQuery(q: String): List<Pair<String, String>> =
        q.split('&').filter { it.isNotEmpty() }.map { p -> p.substringBefore('=') to p.substringAfter('=', "") }.filter { it.first.isNotEmpty() }

    private fun buildQuery(q: List<Pair<String, String>>) = if (q.isEmpty()) "" else "?" + q.joinToString("&") { "${it.first}=${it.second}" }

    private fun decode(s: String) = runCatching { URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s)

    private fun encode(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
