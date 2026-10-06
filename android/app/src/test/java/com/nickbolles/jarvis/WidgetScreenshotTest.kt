package com.nickbolles.jarvis

import android.app.Activity
import android.content.Context
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceTheme
import androidx.glance.appwidget.ExperimentalGlanceRemoteViewsApi
import androidx.glance.appwidget.GlanceRemoteViews
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.nickbolles.jarvis.data.WidgetSummary
import com.nickbolles.jarvis.widgets.CaptureContent
import com.nickbolles.jarvis.widgets.CompassContent
import com.nickbolles.jarvis.widgets.HomeStatusContent
import com.nickbolles.jarvis.widgets.NextUpContent
import java.time.ZoneId
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Home-screen widgets rendered the way the launcher does: Glance → RemoteViews
 * → inflated views, then compared with src/test/screenshots/widget_*.png.
 */
@OptIn(ExperimentalGlanceRemoteViewsApi::class)
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], application = TestApp::class, qualifiers = RobolectricDeviceQualifiers.Pixel7)
class WidgetScreenshotTest {
    private val summary = Fixtures.load("widget-summary", WidgetSummary.serializer())
    private val zone = ZoneId.of("America/Chicago")

    private fun render(name: String, size: DpSize, content: @Composable (Context) -> Unit) = runBlocking {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val result = GlanceRemoteViews().compose(activity, size) { GlanceTheme { content(activity) } }
        val density = activity.resources.displayMetrics.density
        val frame = FrameLayout(activity).apply { setBackgroundColor(0xFF6D7B8C.toInt()) }
        val view: View = result.remoteViews.apply(activity, frame)
        frame.addView(view, FrameLayout.LayoutParams((size.width.value * density).toInt(), (size.height.value * density).toInt()))
        activity.setContentView(frame, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        frame.captureRoboImage("src/test/screenshots/widget_$name.png", roborazziOptions = ScreenshotOptions)
    }

    @Test fun next_up() = render("next_up", DpSize(320.dp, 260.dp)) { NextUpContent(it, summary, 3, Fixtures.now, zone) }

    @Test fun next_up_small() = render("next_up_small", DpSize(250.dp, 110.dp)) { NextUpContent(it, summary, 3, Fixtures.now, zone) }

    @Test fun home_status() = render("home_status", DpSize(250.dp, 120.dp)) { HomeStatusContent(it, summary) }

    @Test fun capture() = render("capture", DpSize(300.dp, 64.dp)) { CaptureContent(it) }

    @Test fun compass() = render("compass", DpSize(180.dp, 130.dp)) { CompassContent(it, summary, Fixtures.now, zone) }

    @Test fun not_loaded_yet() = render("next_up_empty", DpSize(250.dp, 180.dp)) { NextUpContent(it, null, 3, Fixtures.now, zone) }
}
