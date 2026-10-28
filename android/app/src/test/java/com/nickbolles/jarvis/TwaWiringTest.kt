package com.nickbolles.jarvis

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nickbolles.jarvis.web.TwaLauncherActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Manifest wiring: the web app is the launcher and handles in-app links; the classic screens keep pairing. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [36], application = TestApp::class)
class TwaWiringTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val pm = ctx.packageManager

    private fun handlers(intent: Intent) = pm.queryIntentActivities(intent.setPackage(ctx.packageName), 0).map { it.activityInfo.name }

    @Test fun launcherIsTheTrustedWebActivity() {
        val launcher = handlers(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER))
        assertEquals(listOf(TwaLauncherActivity::class.java.name), launcher)
    }

    @Test fun inAppLinksOpenTheWebAppAndPairingStaysNative() {
        assertEquals(listOf(TwaLauncherActivity::class.java.name), handlers(Intent(Intent.ACTION_VIEW, Uri.parse("jarvis://open/alerts")).addCategory(Intent.CATEGORY_BROWSABLE)))
        assertEquals(listOf(TwaLauncherActivity::class.java.name), handlers(Intent(Intent.ACTION_VIEW, Uri.parse("jarvis://areas/abc")).addCategory(Intent.CATEGORY_BROWSABLE)))
        assertEquals(listOf(TwaLauncherActivity::class.java.name), handlers(Intent(Intent.ACTION_VIEW, Uri.parse("https://jarvis.nickbolles.com/alerts")).addCategory(Intent.CATEGORY_BROWSABLE)))
        assertEquals(listOf(MainActivity::class.java.name), handlers(Intent(Intent.ACTION_VIEW, Uri.parse("jarvis://pair?server=x&code=y")).addCategory(Intent.CATEGORY_BROWSABLE)))
    }

    @Test fun widgetTileAndNotificationIntentsTargetTheLauncher() {
        val i = TwaLauncherActivity.intent(ctx, "/areas/abc")
        assertEquals(ComponentName(ctx, TwaLauncherActivity::class.java), i.component)
        assertEquals("jarvis://open/areas/abc", i.dataString)
        assertTrue(i.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertEquals("https://jarvis.nickbolles.com/areas?item=abc&source=android", TwaLauncherActivity.resolve(i.dataString, null))
        assertEquals("https://jarvis.nickbolles.com/home?source=android", TwaLauncherActivity.resolve(null, null))
        assertEquals("https://jarvis.example.com/alerts?source=android", TwaLauncherActivity.resolve("jarvis://open/alerts", "https://jarvis.example.com"))
    }

    @Test fun anUnpairedPhoneGoesThroughNativePairingFirst() {
        assertTrue(TwaLauncherActivity.needsNativeSetup(Result.success(null)))
        assertFalse(TwaLauncherActivity.needsNativeSetup(Result.success("https://jarvis.nickbolles.com")))
        // Slow or failing store read: open the web app rather than strand the user.
        assertFalse(TwaLauncherActivity.needsNativeSetup(null))
        assertFalse(TwaLauncherActivity.needsNativeSetup(Result.failure(IllegalStateException("x"))))
        val i = TwaLauncherActivity.setupIntent(ctx)
        assertEquals(ComponentName(ctx, MainActivity::class.java), i.component)
        assertTrue(i.getBooleanExtra(TwaLauncherActivity.EXTRA_SETUP, false))
    }

    @Test fun assetStatementsNameTheSite() {
        val id = ctx.resources.getIdentifier("asset_statements", "string", ctx.packageName)
        val json = ctx.getString(id)
        assertTrue(json, json.contains("\"site\": \"https://jarvis.nickbolles.com\""))
        assertTrue(json, json.contains("delegate_permission/common.handle_all_urls"))
    }
}
