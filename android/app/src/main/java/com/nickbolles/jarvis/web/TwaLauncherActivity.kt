package com.nickbolles.jarvis.web

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.google.androidbrowserhelper.trusted.LauncherActivity
import com.nickbolles.jarvis.BuildConfig
import com.nickbolles.jarvis.MainActivity
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.widgets.WidgetUpdater
import com.nickbolles.jarvis.push.PushRegistrar
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.SupervisorJob
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
 *
 * A phone that isn't paired yet goes through the native pairing screen first: pairing is what
 * registers FCM and asks for the notification permission, and the web app turns web push off
 * inside the app. After pairing, [MainActivity] hands back to this activity.
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
            val read = withTimeoutOrNull(2_000) { readPairedServer(this@TwaLauncherActivity) }
            if (needsNativeSetup(read)) {
                startActivity(setupIntent(this@TwaLauncherActivity))
                finish()
                return@launch
            }
            // Paired launches skip MainActivity, which used to refresh the FCM registration on every
            // start (e.g. Firebase configured on the server after pairing): do it here, off the UI path.
            if (read?.getOrNull() != null) refreshPush(applicationContext)
            target = Uri.parse(resolve(raw, read?.getOrNull()))
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

        /** Outlives this activity (it finishes once the web app is up); register() handles its own errors. */
        private fun refreshPush(app: Context) {
            CoroutineScope(SupervisorJob() + Dispatchers.IO).launch { runCatching { PushRegistrar.register(AppGraph.get(app)) } }
        }

        private suspend fun readPairedServer(context: Context): Result<String?> = runCatching { AppGraph.get(context).store.pairedServer() }

        /**
         * Native setup first only when we know the phone isn't paired (the store read worked and
         * holds no pairing). A slow or failing read opens the web app as before.
         */
        fun needsNativeSetup(read: Result<String?>?): Boolean = read != null && read.isSuccess && read.getOrNull() == null

        /** Extra on [setupIntent]: once paired, MainActivity opens the web app and finishes. */
        const val EXTRA_SETUP = "com.nickbolles.jarvis.extra.SETUP"

        fun setupIntent(context: Context): Intent =
            Intent(context, MainActivity::class.java).putExtra(EXTRA_SETUP, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        /** Explicit intent for widgets, the tile and notifications: opens [path] (a native or web path) in the app. */
        fun intent(context: Context, path: String): Intent =
            Intent(Intent.ACTION_VIEW, Uri.parse("jarvis://open" + if (path.startsWith("/")) path else "/$path"), context, TwaLauncherActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
