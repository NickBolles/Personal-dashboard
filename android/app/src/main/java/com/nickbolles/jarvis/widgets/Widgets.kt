package com.nickbolles.jarvis.widgets

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.nickbolles.jarvis.MainActivity
import com.nickbolles.jarvis.R
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.WidgetAction
import com.nickbolles.jarvis.data.WidgetSummary
import com.nickbolles.jarvis.ui.components.PRIORITY_LABELS
import com.nickbolles.jarvis.ui.components.SOURCE_LABELS
import com.nickbolles.jarvis.ui.components.formatDue
import com.nickbolles.jarvis.ui.components.formatWhen
import java.time.Instant
import java.time.ZoneId

/* Shared bits ------------------------------------------------------------ */

fun openApp(context: Context, path: String) = actionStartActivity(
    Intent(Intent.ACTION_VIEW, Uri.parse("jarvis://open$path"), context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
)

@Composable
private fun Title(text: String, trailing: String? = null) {
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Image(ImageProvider(R.drawable.ic_stat_jarvis), contentDescription = null, modifier = GlanceModifier.size(16.dp), colorFilter = ColorFilter.tint(GlanceTheme.colors.primary))
        Spacer(GlanceModifier.width(6.dp))
        Text(text, style = TextStyle(fontWeight = FontWeight.Medium, fontSize = 13.sp, color = GlanceTheme.colors.onSurfaceVariant), modifier = GlanceModifier.defaultWeight())
        trailing?.let { Text(it, style = TextStyle(fontSize = 12.sp, color = GlanceTheme.colors.onSurfaceVariant)) }
    }
}

@Composable
private fun WidgetFrame(content: @Composable () -> Unit) {
    Box(GlanceModifier.fillMaxSize().background(GlanceTheme.colors.widgetBackground).cornerRadius(24.dp).padding(14.dp)) { content() }
}

@Composable
private fun NotPaired(context: Context) {
    WidgetFrame {
        Column(GlanceModifier.fillMaxSize().clickable(openApp(context, "/home"))) {
            Title("Jarvis")
            Spacer(GlanceModifier.height(8.dp))
            Text("Open Jarvis to connect this phone", style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp))
        }
    }
}

private suspend fun paired(context: Context) = AppGraph.get(context).store.current() != null

/* Next up ----------------------------------------------------------------- */

val NEXT_COUNT = intPreferencesKey("next_count")

/** Top actions; tap ✓ to complete (readback on the server), tap the row to open it. */
class NextUpWidget : GlanceAppWidget() {
    override val stateDefinition = PreferencesGlanceStateDefinition
    override val sizeMode = SizeMode.Responsive(setOf(DpSize(180.dp, 110.dp), DpSize(250.dp, 180.dp), DpSize(320.dp, 260.dp)))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val summary = readWidgetSummary(context)
        val isPaired = paired(context)
        provideContent {
            GlanceTheme {
                if (!isPaired) NotPaired(context) else {
                    val count = currentState<Preferences>()[NEXT_COUNT] ?: 3
                    NextUpContent(context, summary, count)
                }
            }
        }
    }
}

@Composable
fun NextUpContent(context: Context, summary: WidgetSummary?, count: Int, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()) {
    val size = LocalSize.current
    val n = if (size.height < 150.dp) 1 else count
    WidgetFrame {
        Column(GlanceModifier.fillMaxSize()) {
            Title("Next up", trailing = summary?.unread?.takeIf { it > 0 }?.let { if (it == 1) "1 alert" else "$it alerts" })
            Spacer(GlanceModifier.height(8.dp))
            val items = summary?.next.orEmpty().take(n)
            when {
                summary == null -> Text("Open Jarvis to load", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))
                items.isEmpty() -> Text("Nothing needs you right now", style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 15.sp))
                // At most 5 rows: a plain column renders the same on every launcher (no remote collection).
                else -> Column { items.forEach { a -> NextRow(context, a, now, zone) } }
            }
        }
    }
}

@Composable
private fun NextRow(context: Context, a: WidgetAction, now: Instant, zone: ZoneId) {
    val canComplete = "complete" in a.secondaryActions || a.primaryAction?.kind == "complete"
    Column(GlanceModifier.fillMaxWidth().padding(bottom = 8.dp)) {
        Row(GlanceModifier.fillMaxWidth().background(GlanceTheme.colors.surface).cornerRadius(14.dp).padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(GlanceModifier.defaultWeight().clickable(openApp(context, a.href.takeIf { it.startsWith("/") } ?: "/home"))) {
                Text(a.title, maxLines = 2, style = TextStyle(color = GlanceTheme.colors.onSurface, fontWeight = FontWeight.Medium, fontSize = 14.sp))
                val meta = listOfNotNull(PRIORITY_LABELS[a.priorityReason], formatDue(a.dueAt, a.dueIsDate, now, zone), SOURCE_LABELS[a.source]).joinToString(" · ")
                Text(meta, maxLines = 1, style = TextStyle(color = if (a.priorityReason in setOf("critical", "overdue")) GlanceTheme.colors.error else GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
            }
            if (canComplete) {
                Spacer(GlanceModifier.width(8.dp))
                Box(
                    GlanceModifier.size(36.dp).background(GlanceTheme.colors.primaryContainer).cornerRadius(18.dp)
                        .clickable(actionRunCallback<CompleteAction>(actionParametersOf(CompleteAction.ID to a.id))),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("✓", style = TextStyle(color = GlanceTheme.colors.onPrimaryContainer, fontWeight = FontWeight.Bold, fontSize = 16.sp))
                }
            }
        }
    }
}

class CompleteAction : ActionCallback {
    companion object {
        val ID = ActionParameters.Key<String>("action_id")
    }

    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[ID] ?: return
        val graph = AppGraph.get(context)
        // Optimistically drop it, then refresh with the server's readback.
        readWidgetSummary(context)?.let { s -> graph.store.writeCache(WIDGET_CACHE, WidgetSummary.serializer(), s.copy(next = s.next.filterNot { it.id == id })) }
        NextUpWidget().update(context, glanceId)
        runCatching { graph.call { it.act(id, "complete") } }
        WidgetUpdater.requestRefresh(context)
    }
}

class NextUpWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NextUpWidget()
}

/* Home status -------------------------------------------------------------- */

class HomeStatusWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(DpSize(110.dp, 110.dp), DpSize(250.dp, 110.dp)))
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val summary = readWidgetSummary(context)
        val isPaired = paired(context)
        provideContent { GlanceTheme { if (!isPaired) NotPaired(context) else HomeStatusContent(context, summary) } }
    }
}

@Composable
fun HomeStatusContent(context: Context, summary: WidgetSummary?) {
    val ex = summary?.home?.exceptions.orEmpty()
    val critical = (summary?.home?.critical ?: 0) > 0
    WidgetFrame {
        Column(GlanceModifier.fillMaxSize().clickable(openApp(context, "/home-control"))) {
            Title("Home", trailing = summary?.unread?.takeIf { it > 0 }?.let { "🔔 $it" })
            Spacer(GlanceModifier.height(6.dp))
            when {
                summary == null -> Text("Open Jarvis to load", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant))
                ex.isEmpty() -> Text("All quiet", style = TextStyle(color = GlanceTheme.colors.onSurface, fontWeight = FontWeight.Medium, fontSize = 18.sp))
                else -> Column {
                    ex.take(if (LocalSize.current.width < 200.dp) 2 else 3).forEach { e ->
                        Text(
                            "${e.name}: ${e.reason}",
                            maxLines = 1,
                            style = TextStyle(color = if (critical && (e.severity == "critical" || e.severity == "high")) GlanceTheme.colors.error else GlanceTheme.colors.onSurface, fontSize = 13.sp),
                        )
                    }
                }
            }
            if (summary?.degradedSources?.isNotEmpty() == true) {
                Spacer(GlanceModifier.height(4.dp))
                Text("Can't reach: ${summary.degradedSources.joinToString()}", maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
            }
        }
    }
}

class HomeStatusWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = HomeStatusWidget()
}

/* Ask Hermes -------------------------------------------------------------- */

class CaptureWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent { GlanceTheme { CaptureContent(context) } }
    }
}

@Composable
fun CaptureContent(context: Context) {
    Row(
        GlanceModifier.fillMaxSize().background(GlanceTheme.colors.primaryContainer).cornerRadius(28.dp).padding(horizontal = 16.dp).clickable(openApp(context, "/capture")),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(ImageProvider(R.drawable.ic_stat_jarvis), contentDescription = null, modifier = GlanceModifier.size(20.dp), colorFilter = ColorFilter.tint(GlanceTheme.colors.onPrimaryContainer))
        Spacer(GlanceModifier.width(10.dp))
        Text("Ask Hermes…", style = TextStyle(color = GlanceTheme.colors.onPrimaryContainer, fontSize = 16.sp, fontWeight = FontWeight.Medium), modifier = GlanceModifier.defaultWeight())
        Box(GlanceModifier.size(36.dp).cornerRadius(18.dp).background(GlanceTheme.colors.surface).clickable(openApp(context, "/capture?source=home_assistant")), contentAlignment = Alignment.Center) {
            Text("🏠", style = TextStyle(fontSize = 16.sp))
        }
        Spacer(GlanceModifier.width(6.dp))
        Box(GlanceModifier.size(36.dp).cornerRadius(18.dp).background(GlanceTheme.colors.surface).clickable(openApp(context, "/capture?source=skylight")), contentAlignment = Alignment.Center) {
            Text("📅", style = TextStyle(fontSize = 16.sp))
        }
    }
}

class CaptureWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = CaptureWidget()
}

/* Daily Compass + next event ------------------------------------------------ */

class CompassWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val summary = readWidgetSummary(context)
        val isPaired = paired(context)
        provideContent { GlanceTheme { if (!isPaired) NotPaired(context) else CompassContent(context, summary) } }
    }
}

@Composable
fun CompassContent(context: Context, summary: WidgetSummary?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()) {
    val c = summary?.compass
    WidgetFrame {
        Column(GlanceModifier.fillMaxSize()) {
            Column(GlanceModifier.fillMaxWidth().clickable(openApp(context, "/daily-compass"))) {
                Title("Daily Compass")
                Spacer(GlanceModifier.height(4.dp))
                Text(
                    when {
                        c == null -> if (summary == null) "Open Jarvis to load" else "Not set up"
                        c.completed -> "Done today ✓"
                        c.inWindow -> "Check in now"
                        else -> "Opens ${c.windowLabel.substringBefore("–")}"
                    },
                    style = TextStyle(color = if (c?.inWindow == true && !c.completed) GlanceTheme.colors.primary else GlanceTheme.colors.onSurface, fontWeight = FontWeight.Medium, fontSize = 17.sp),
                )
            }
            summary?.nextEvent?.let { e ->
                Spacer(GlanceModifier.height(10.dp))
                Column(GlanceModifier.fillMaxWidth().clickable(openApp(context, "/skylight"))) {
                    Text("Next: ${e.title}", maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp))
                    Text(formatWhen(e.startsAt, e.allDay, now, zone), maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
                }
            }
        }
    }
}

class CompassWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = CompassWidget()
}
