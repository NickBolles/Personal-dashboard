package com.nickbolles.jarvis.web

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.google.androidbrowserhelper.trusted.LauncherActivity
import com.nickbolles.jarvis.BuildConfig
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.widgets.WidgetUpdater
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The app's launcher: opens the Jarvis web app full screen in Chrome (Trusted Web Activity).
 * Also the target of every widget, tile, shortcut and notification tap: their native links
 * (jarvis://open/<path>, jarvis://areas/<id>) become web URLs through [WebLinks].
 *
 * Origin = the paired server when there is one, else the build-time default (jarvisOrigin).
 * Chrome checks /.well-known/assetlinks.json on that origin; if it fails, the page still opens
 * but with a URL bar.
 */
class TwaLauncherActivity : LauncherActivity() {
    private val scope = MainScope()
    private var target: Uri? = null

    // The paired server is read from DataStore first (async), then the TWA launches.
    override fun shouldLaunchImmediately() = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (isFinishing) return
        // Web actions can't refresh widgets; opening the app does.
        runCatching { WidgetUpdater.requestRefresh(this) }
        val raw = intent?.data?.toString()
        scope.launch {
            val paired = withTimeoutOrNull(2_000) { pairedServer(this@TwaLauncherActivity) }
            target = Uri.parse(resolve(raw, paired))
            if (!isFinishing) launchTwa()
        }
    }

    override fun getLaunchingUrl(): Uri = target ?: Uri.parse(resolve(intent?.data?.toString(), null))

    // The launch URL above is already the mapped web URL; don't forward jarvis:// links to the browser.
    override fun getUrlForIntent(intent: Intent?): Uri? = null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        fun resolve(raw: String?, pairedServer: String?): String =
            WebLinks.launchUrl(raw, WebLinks.origin(pairedServer, BuildConfig.JARVIS_ORIGIN), BuildConfig.JARVIS_ORIGIN)

        private suspend fun pairedServer(context: Context): String? = runCatching { AppGraph.get(context).store.pairedServer() }.getOrNull()

        /** Explicit intent for widgets, the tile and notifications: opens [path] (a native or web path) in the app. */
        fun intent(context: Context, path: String): Intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("jarvis://open" + if (path.startsWith("/")) path else "/$path"), context, TwaLauncherActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
