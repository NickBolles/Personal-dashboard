package com.nickbolles.jarvis

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import com.nickbolles.jarvis.ui.components.Clock
import com.nickbolles.jarvis.ui.components.LocalClock
import com.nickbolles.jarvis.ui.components.LocalZone
import com.nickbolles.jarvis.ui.theme.JarvisTheme
import java.time.ZoneId

/** Tolerates sub-pixel anti-aliasing differences between machines (0.5% of pixels). */
val ScreenshotOptions = RoborazziOptions(compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.005f))

/**
 * Renders a screen the way the app does (Jarvis palette, pinned clock and
 * timezone) and compares it with src/test/screenshots/<name>.png.
 * Record: ./gradlew recordRoborazziDebug · Verify: ./gradlew verifyRoborazziDebug
 */
fun ComposeContentTestRule.snapshot(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
    setContent {
        CompositionLocalProvider(LocalClock provides Clock { Fixtures.now }, LocalZone provides ZoneId.of("America/Chicago")) {
            JarvisTheme(theme = if (dark) "dark" else "light", dynamicColor = false) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() }
            }
        }
    }
    onRoot().captureRoboImage("src/test/screenshots/$name.png", roborazziOptions = ScreenshotOptions)
}
