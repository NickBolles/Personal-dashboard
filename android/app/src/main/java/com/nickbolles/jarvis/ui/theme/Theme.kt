package com.nickbolles.jarvis.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape

/* Jarvis palette (matches app/globals.css): calm neutrals, one blue accent. */
private val Blue = Color(0xFF2749D8)
private val BlueDark = Color(0xFF8FA6FF)

private val LightScheme = lightColorScheme(
    primary = Blue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE7ECFF),
    onPrimaryContainer = Color(0xFF0B1A66),
    secondary = Color(0xFF5B5F57),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE8E9E3),
    onSecondaryContainer = Color(0xFF1C1D1A),
    background = Color(0xFFF6F6F3),
    onBackground = Color(0xFF1C1D1A),
    surface = Color(0xFFF6F6F3),
    onSurface = Color(0xFF1C1D1A),
    surfaceVariant = Color(0xFFF0F0EC),
    onSurfaceVariant = Color(0xFF5B5F57),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFBFBF9),
    surfaceContainer = Color.White,
    surfaceContainerHigh = Color(0xFFF0F0EC),
    surfaceContainerHighest = Color(0xFFE8E9E3),
    outline = Color(0xFF8A8F85),
    outlineVariant = Color(0xFFD9DBD4),
    error = Color(0xFFB3261E),
    onError = Color.White,
    errorContainer = Color(0xFFFDECEB),
    onErrorContainer = Color(0xFF5C0F0A),
)

private val DarkScheme = darkColorScheme(
    primary = BlueDark,
    onPrimary = Color(0xFF0B1024),
    primaryContainer = Color(0xFF1F2748),
    onPrimaryContainer = Color(0xFFDDE3FF),
    secondary = Color(0xFFA8ACA4),
    onSecondary = Color(0xFF111210),
    secondaryContainer = Color(0xFF2C2E2A),
    onSecondaryContainer = Color(0xFFF1F2EE),
    background = Color(0xFF111210),
    onBackground = Color(0xFFF1F2EE),
    surface = Color(0xFF111210),
    onSurface = Color(0xFFF1F2EE),
    surfaceVariant = Color(0xFF232521),
    onSurfaceVariant = Color(0xFFA8ACA4),
    surfaceContainerLowest = Color(0xFF0C0D0B),
    surfaceContainerLow = Color(0xFF161715),
    surfaceContainer = Color(0xFF1A1B19),
    surfaceContainerHigh = Color(0xFF232521),
    surfaceContainerHighest = Color(0xFF2C2E2A),
    outline = Color(0xFF7B8074),
    outlineVariant = Color(0xFF33362F),
    error = Color(0xFFFF8A80),
    onError = Color(0xFF3A1A18),
    errorContainer = Color(0xFF3A1A18),
    onErrorContainer = Color(0xFFFFDAD6),
)

/** Status colors Material doesn't have: ok/warn alongside error. */
@Immutable
data class StatusColors(val ok: Color, val okContainer: Color, val warn: Color, val warnContainer: Color)

private val LightStatus = StatusColors(Color(0xFF1D6B3A), Color(0xFFE5F4EA), Color(0xFF8A5300), Color(0xFFFFF3DE))
private val DarkStatus = StatusColors(Color(0xFF7FD49A), Color(0xFF15301F), Color(0xFFFFC56B), Color(0xFF33260F))

val LocalStatusColors = staticCompositionLocalOf { LightStatus }

/** Spacing scale; compact density tightens lists. */
@Immutable
data class Density(val cardPadding: Int, val itemGap: Int)

val LocalJarvisDensity = staticCompositionLocalOf { Density(16, 12) }

private val JarvisTypography = Typography().let { t ->
    t.copy(
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.SemiBold, letterSpacing = (-0.3).sp),
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.SemiBold),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelLarge = t.labelLarge.copy(fontWeight = FontWeight.SemiBold),
    )
}

private val JarvisShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

val SectionLabel = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp)

@Composable
fun JarvisTheme(
    theme: String = "system",
    dynamicColor: Boolean = true,
    density: String = "comfortable",
    content: @Composable () -> Unit,
) {
    val dark = when (theme) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val context = LocalContext.current
    val scheme: ColorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        dark -> DarkScheme
        else -> LightScheme
    }
    CompositionLocalProvider(
        LocalStatusColors provides if (dark) DarkStatus else LightStatus,
        LocalJarvisDensity provides if (density == "compact") Density(12, 8) else Density(16, 12),
    ) {
        MaterialTheme(colorScheme = scheme, typography = JarvisTypography, shapes = JarvisShapes, content = content)
    }
}
