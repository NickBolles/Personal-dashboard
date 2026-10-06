package com.nickbolles.jarvis.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Explore
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.ContextSource
import com.nickbolles.jarvis.data.HomePayload
import com.nickbolles.jarvis.data.Layout
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.NextAction
import com.nickbolles.jarvis.data.Preferences
import com.nickbolles.jarvis.data.Resource
import com.nickbolles.jarvis.ui.components.ActionCard
import com.nickbolles.jarvis.ui.components.ActionHandlers
import com.nickbolles.jarvis.ui.components.EmptyState
import com.nickbolles.jarvis.ui.components.LocalClock
import com.nickbolles.jarvis.ui.components.LocalZone
import com.nickbolles.jarvis.ui.components.Pill
import com.nickbolles.jarvis.ui.components.SectionHeader
import com.nickbolles.jarvis.ui.components.SourceAvatar
import com.nickbolles.jarvis.ui.components.StatusBanner
import com.nickbolles.jarvis.ui.components.formatWhen
import com.nickbolles.jarvis.ui.components.greeting
import com.nickbolles.jarvis.ui.components.longDate
import com.nickbolles.jarvis.ui.components.parseInstant
import com.nickbolles.jarvis.ui.components.relativeTime
import com.nickbolles.jarvis.ui.nav.CaptureRequest
import com.nickbolles.jarvis.ui.nav.LocalAppActions
import com.nickbolles.jarvis.ui.nav.Routes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Runs a server action with readback and reports the server's own message. */
abstract class ActionViewModel(protected val graph: AppGraph) : ViewModel() {
    private val _busy = MutableStateFlow<Set<String>>(emptySet())
    val busy = _busy.asStateFlow()

    protected abstract suspend fun reload()

    fun act(action: NextAction, kind: String, onMessage: (String) -> Unit) {
        if (action.id in _busy.value) return
        _busy.value = _busy.value + action.id
        viewModelScope.launch {
            try {
                val r = graph.call { it.act(action.id, kind) }
                onMessage(r.message)
                reload()
                graph.onDataChanged()
            } catch (e: ApiException) {
                onMessage(e.message ?: "That didn't work")
            } finally {
                _busy.value = _busy.value - action.id
            }
        }
    }
}

class HomeViewModel(graph: AppGraph) : ActionViewModel(graph) {
    val home = Resource(graph, "home", HomePayload.serializer()) { it.home(cached = false) }
    val prefs = graph.prefs

    override suspend fun reload() = home.refresh()

    fun refresh() {
        viewModelScope.launch { home.refresh() }
        viewModelScope.launch { prefs.refresh() }
    }
}

/** Handlers every action list shares: complete/snooze/ack via the server, Ask Hermes, open. */
@Composable
fun actionHandlers(vm: ActionViewModel): ActionHandlers {
    val app = LocalAppActions.current
    return ActionHandlers(
        onPrimary = { a ->
            when (val k = a.primaryAction?.kind) {
                "complete", "snooze", "acknowledge" -> vm.act(a, k, app::message)
                else -> app.open(a.href)
            }
        },
        onAct = { a, kind -> vm.act(a, kind, app::message) },
        onAsk = { a ->
            app.capture(
                CaptureRequest(
                    sources = setOfNotNull(ContextSource.forSource(a.source)),
                    attached = "${a.title}${a.detail?.let { " — $it" } ?: ""} [${a.source}:${a.sourceId}]",
                    attachedLabel = a.title,
                ),
            )
        },
        onOpen = { a -> app.open(a.href) },
    )
}

@Composable
fun HomeScreen() {
    val graph = AppGraph.get(androidx.compose.ui.platform.LocalContext.current)
    val vm: HomeViewModel = viewModel { HomeViewModel(graph) }
    val state by vm.home.state.collectAsState()
    val prefs by vm.prefs.state.collectAsState()
    val busy by vm.busy.collectAsState()
    LaunchedEffect(Unit) { vm.refresh() }
    HomeContent(state, prefs.data?.layout ?: Layout(), busy, actionHandlers(vm), onRefresh = vm::refresh, userName = prefs.data?.displayName)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeContent(
    state: Loadable<HomePayload>,
    layout: Layout,
    busy: Set<String>,
    handlers: ActionHandlers,
    onRefresh: () -> Unit,
    userName: String? = null,
) {
    val app = LocalAppActions.current
    val now = LocalClock.current.now()
    val zone = LocalZone.current
    val data = state.data
    PullToRefreshBox(isRefreshing = state.loading && data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Column(Modifier.padding(top = 8.dp, bottom = 4.dp)) {
                    Text(longDate(now, zone), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(
                        greeting(now, zone) + (userName?.takeIf { it.isNotBlank() }?.let { ", $it" } ?: ""),
                        style = MaterialTheme.typography.headlineMedium,
                        modifier = Modifier.semantics { heading() },
                    )
                }
            }
            item { CaptureBar { app.capture() } }
            item { FreshnessBanner(state, data, onRefresh) }
            if (data == null) {
                item { if (state.loading) LoadingCard("Loading your next actions…") }
                return@LazyColumn
            }
            for (section in layout.homeSections.filter { it.visible }) {
                when (section.id) {
                    "now" -> nowSection(data, busy, handlers)
                    "glance" -> item { GlanceSection(data) }
                    "later_today" -> compactSection("Later today", data.later.laterToday, busy, handlers)
                    "upcoming" -> compactSection("Upcoming", data.later.upcoming, busy, handlers)
                    "waiting" -> compactSection("Waiting on", data.later.waitingOn, busy, handlers)
                    "completed" -> compactSection("Recently completed", data.later.recentlyCompleted, busy, handlers, done = true)
                }
            }
            item {
                val generated = parseInstant(data.generatedAt)
                if (generated != null) {
                    Text(
                        "Updated ${relativeTime(generated, now)}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    )
                }
            }
        }
    }
}

private fun LazyListScope.nowSection(data: HomePayload, busy: Set<String>, handlers: ActionHandlers) {
    item { SectionHeader("Now") }
    if (data.now.isEmpty()) {
        item {
            val checked = data.sources.filter { it.state == "ok" || it.state == "stale" }
            if (checked.isEmpty()) {
                EmptyState("No sources connected yet", "Connect Hermes, todos, Home Assistant and more from Jarvis on the web (Settings → Connections).")
            } else {
                EmptyState("Nothing needs you right now", "Checked ${checked.joinToString(", ") { it.label }}.")
            }
        }
    } else {
        items(data.now, key = { "now:${it.id}" }) { a -> ActionCard(a, handlers, busy = a.id in busy) }
    }
}

private fun LazyListScope.compactSection(title: String, list: List<NextAction>, busy: Set<String>, handlers: ActionHandlers, done: Boolean = false) {
    if (list.isEmpty()) return
    item { SectionHeader(title) }
    items(list, key = { "$title:${it.id}" }) { a ->
        if (done) CompactRow(a, onClick = { handlers.onOpen(a) }) else ActionCard(a, handlers, busy = a.id in busy)
    }
}

@Composable
private fun CompactRow(a: NextAction, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SourceAvatar(a.source)
        Spacer(Modifier.width(12.dp))
        Text(a.title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun CaptureBar(onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.extraLarge,
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().semantics { role = Role.Button },
    ) {
        Row(Modifier.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.AutoAwesome, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Text("Ask Hermes or capture something", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

@Composable
private fun FreshnessBanner(state: Loadable<HomePayload>, data: HomePayload?, onRefresh: () -> Unit) {
    val problems = data?.sources?.filter { it.state == "error" || it.state == "unauthorized" }.orEmpty()
    when {
        state.error != null && data != null -> StatusBanner("Showing saved data · ${state.error}", onRetry = onRefresh)
        state.error != null -> StatusBanner(state.error, tone = "danger", onRetry = onRefresh)
        problems.isNotEmpty() -> StatusBanner(
            problems.joinToString(" · ") { "${it.label}: ${if (it.state == "unauthorized") "sign-in needed" else "can't reach it"}" } + if (problems.any { it.fromCache }) " (showing last known)" else "",
            tone = "danger",
        )
    }
}

@Composable
fun LoadingCard(text: String) {
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer) {
        Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            androidx.compose.material3.CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(12.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun GlanceSection(data: HomePayload) {
    val app = LocalAppActions.current
    val now = LocalClock.current.now()
    val zone = LocalZone.current
    val g = data.glance
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SectionHeader("Household")
        // Side by side normally; stacked on narrow screens or with large text so words never break mid-word.
        val stacked = androidx.compose.ui.platform.LocalDensity.current.fontScale > 1.3f ||
            androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp < 360
        AdaptiveRow(stacked) { tileModifier ->
            GlanceTile(
                icon = Icons.Outlined.CalendarMonth,
                label = "Next up",
                value = g.nextEvent?.title ?: "Nothing scheduled",
                detail = g.nextEvent?.let { formatWhen(it.startsAt, it.allDay, now, zone) },
                modifier = tileModifier,
                onClick = { app.navigate(Routes.SKYLIGHT) },
            )
            GlanceTile(
                icon = Icons.Outlined.Explore,
                label = "Daily Compass",
                value = when {
                    g.compass == null -> "Not set up"
                    g.compass.completed -> "Done today"
                    g.compass.inWindow -> "Check in now"
                    else -> "Opens ${g.compass.windowLabel.substringBefore("–")}"
                },
                detail = g.compass?.windowLabel,
                modifier = tileModifier,
                onClick = { app.navigate(Routes.COMPASS) },
            )
        }
        val ex = g.homeExceptions
        Surface(
            onClick = { app.navigate(Routes.controls()) },
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surfaceContainer,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                SourceAvatar("home_assistant", critical = ex.any { it.severity == "critical" || it.severity == "high" })
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text("Home", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (ex.isEmpty()) {
                        Text(
                            if (data.sources.any { it.source == "home_assistant" && (it.state == "ok" || it.state == "stale") }) "All quiet" else "Not connected",
                            style = MaterialTheme.typography.titleMedium,
                        )
                    } else {
                        ex.take(3).forEach { e ->
                            Text("${e.name}: ${e.reason}", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                TextButton(onClick = { app.capture(CaptureRequest(sources = setOf(ContextSource.HomeAssistant))) }) { Text("Ask") }
            }
        }
    }
}

@Composable
private fun AdaptiveRow(stacked: Boolean, content: @Composable (Modifier) -> Unit) {
    if (stacked) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { content(Modifier.fillMaxWidth()) }
    } else {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { content(Modifier.weight(1f)) }
    }
}

@Composable
private fun GlanceTile(icon: ImageVector, label: String, value: String, detail: String?, modifier: Modifier, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = modifier) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            detail?.let { Pill(it) }
        }
    }
}
