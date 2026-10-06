package com.nickbolles.jarvis.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.CalendarEvent
import com.nickbolles.jarvis.data.ContextSource
import com.nickbolles.jarvis.data.DailyCompassResponse
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.Resource
import com.nickbolles.jarvis.data.SourceResult
import com.nickbolles.jarvis.ui.components.ActionCard
import com.nickbolles.jarvis.ui.components.ActionHandlers
import com.nickbolles.jarvis.ui.components.EmptyState
import com.nickbolles.jarvis.ui.components.LocalClock
import com.nickbolles.jarvis.ui.components.LocalZone
import com.nickbolles.jarvis.ui.components.Pill
import com.nickbolles.jarvis.ui.components.SectionHeader
import com.nickbolles.jarvis.ui.components.StatusBanner
import com.nickbolles.jarvis.ui.components.formatClock
import com.nickbolles.jarvis.ui.components.parseInstant
import com.nickbolles.jarvis.ui.components.relativeTime
import com.nickbolles.jarvis.ui.nav.CaptureRequest
import com.nickbolles.jarvis.ui.nav.LocalAppActions
import com.nickbolles.jarvis.ui.nav.Routes
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class SourceViewModel(graph: AppGraph, val sourceId: String) : ActionViewModel(graph) {
    val source = Resource(graph, "source-$sourceId", SourceResult.serializer()) { it.source(sourceId) }
    override suspend fun reload() = source.refresh()
    fun refresh() {
        viewModelScope.launch { source.refresh() }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SourceScaffold(title: String, ask: ContextSource?, content: @Composable () -> Unit) {
    val app = LocalAppActions.current
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(title) },
            navigationIcon = { IconButton(onClick = app::back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") } },
            actions = {
                if (ask != null) TextButton(onClick = { app.capture(CaptureRequest(sources = setOf(ask))) }) {
                    Icon(Icons.Outlined.AutoAwesome, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Ask Hermes")
                }
            },
        )
        content()
    }
}

/** Freshness + error line shared by source screens; never silent about stale or failing data. */
fun LazyListScope.sourceStatus(state: Loadable<SourceResult>, onRefresh: () -> Unit) {
    val st = state.data?.status
    when {
        state.error != null -> item { StatusBanner(if (state.data != null) "Showing saved data · ${state.error}" else state.error, tone = if (state.data != null) "warn" else "danger", onRetry = onRefresh) }
        st != null && st.state in setOf("error", "unauthorized") -> item { StatusBanner("${st.label}: ${st.error ?: st.state}" + if (st.fromCache) " (last known)" else "", tone = "danger", onRetry = onRefresh) }
        st != null && st.state == "unconfigured" -> item { EmptyState("${st.label} isn't connected", "Connect it from Jarvis on the web: Settings → Connections.") }
        st != null && st.state == "stale" -> item { StatusBanner("This may be out of date (last read ${parseInstant(st.fetchedAt)?.let { relativeTime(it, java.time.Instant.now()) } ?: "a while ago"}).", onRetry = onRefresh) }
    }
}

/* ------------------------------------------------------------- Skylight */

@Composable
fun SkylightScreen() {
    val graph = AppGraph.get(LocalContext.current)
    val vm: SourceViewModel = viewModel(key = "skylight") { SourceViewModel(graph, "skylight") }
    val state by vm.source.state.collectAsState()
    val busy by vm.busy.collectAsState()
    LaunchedEffect(Unit) { vm.refresh() }
    SkylightContent(state, busy, actionHandlers(vm), vm::refresh)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SkylightContent(state: Loadable<SourceResult>, busy: Set<String>, handlers: ActionHandlers, onRefresh: () -> Unit) {
    val zone = LocalZone.current
    val today = LocalClock.current.now().atZone(zone).toLocalDate()
    SourceScaffold("Skylight", ContextSource.Skylight) {
        PullToRefreshBox(isRefreshing = state.loading && state.data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                sourceStatus(state, onRefresh)
                val data = state.data?.data
                val chores = data?.actions.orEmpty().filter { it.status == "open" }
                item { SectionHeader("Chores today") }
                if (data != null && chores.isEmpty()) item { EmptyState("No chores left today") }
                items(chores, key = { it.id }) { ActionCard(it, handlers, busy = it.id in busy) }
                val byDay = data?.events.orEmpty().groupBy { eventDate(it, zone) }.toSortedMap()
                if (data != null && byDay.isEmpty()) {
                    item { SectionHeader("Calendar") }
                    item { EmptyState("Nothing on the calendar this week") }
                }
                byDay.forEach { (day, events) ->
                    item(key = "day:$day") { SectionHeader(dayLabel(day, today)) }
                    items(events.sortedBy { if (it.allDay) "" else it.startsAt }, key = { "ev:${it.id}:${it.startsAt}" }) { EventRow(it) }
                }
            }
        }
    }
}

private fun eventDate(e: CalendarEvent, zone: java.time.ZoneId): LocalDate =
    if (e.allDay) runCatching { LocalDate.parse(e.startsAt.take(10)) }.getOrElse { LocalDate.now(zone) }
    else parseInstant(e.startsAt)?.atZone(zone)?.toLocalDate() ?: LocalDate.now(zone)

private fun dayLabel(day: LocalDate, today: LocalDate) = when (day) {
    today -> "Today"
    today.plusDays(1) -> "Tomorrow"
    else -> DateTimeFormatter.ofPattern("EEEE, MMM d", Locale.US).format(day)
}

@Composable
private fun EventRow(e: CalendarEvent) {
    val zone = LocalZone.current
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
            Text(
                if (e.allDay) "All day" else formatClock(e.startsAt, zone),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.widthIn(min = 72.dp),
            )
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(e.title, style = MaterialTheme.typography.titleMedium)
                val meta = listOfNotNull(e.endsAt?.takeIf { !e.allDay }?.let { "until ${formatClock(it, zone)}" }, e.location, e.calendar).joinToString(" · ")
                if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/* ---------------------------------------------------------------- Todos */

@Composable
fun TodosScreen() {
    val graph = AppGraph.get(LocalContext.current)
    val vm: SourceViewModel = viewModel(key = "todos") { SourceViewModel(graph, "todos") }
    val state by vm.source.state.collectAsState()
    val busy by vm.busy.collectAsState()
    LaunchedEffect(Unit) { vm.refresh() }
    TodosContent(state, busy, actionHandlers(vm), vm::refresh)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodosContent(state: Loadable<SourceResult>, busy: Set<String>, handlers: ActionHandlers, onRefresh: () -> Unit) {
    SourceScaffold("Todos", ContextSource.Todos) {
        PullToRefreshBox(isRefreshing = state.loading && state.data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                sourceStatus(state, onRefresh)
                val open = state.data?.data?.actions.orEmpty().filter { it.status == "open" || it.status == "waiting" }
                val order = listOf("overdue", "due_soon", "today", "upcoming")
                val groups = open.groupBy { if (it.priorityReason in order) it.priorityReason else "upcoming" }
                if (state.data?.data != null && open.isEmpty()) item { EmptyState("No open todos", "Nice.") }
                order.forEach { reason ->
                    val list = groups[reason].orEmpty()
                    if (list.isNotEmpty()) {
                        item(key = "h:$reason") { SectionHeader(com.nickbolles.jarvis.ui.components.PRIORITY_LABELS[reason] ?: reason) }
                        items(list, key = { it.id }) { ActionCard(it, handlers, busy = it.id in busy) }
                    }
                }
                val done = state.data?.data?.actions.orEmpty().filter { it.status == "completed" }
                if (done.isNotEmpty()) {
                    item { SectionHeader("Completed") }
                    items(done, key = { "done:${it.id}" }) { Text(it.title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp)) }
                }
            }
        }
    }
}

/* -------------------------------------------------------- Daily Compass */

class CompassViewModel(private val graph: AppGraph) : androidx.lifecycle.ViewModel() {
    val compass = Resource(graph, "compass", DailyCompassResponse.serializer()) { it.compass() }
    private val _working = MutableStateFlow<String?>(null)
    val working = _working.asStateFlow()

    fun refresh() {
        viewModelScope.launch { compass.refresh() }
    }

    fun start(onNavigate: (String) -> Unit, onMessage: (String) -> Unit) {
        _working.value = "start"
        viewModelScope.launch {
            try {
                val r = graph.call { it.startCompass() }
                onNavigate(Routes.conversation(r.sessionId, r.runId))
            } catch (e: ApiException) {
                onMessage(e.message ?: "Couldn't start the check-in")
            } finally {
                _working.value = null
            }
        }
    }

    fun complete(onMessage: (String) -> Unit) {
        _working.value = "complete"
        viewModelScope.launch {
            try {
                graph.call { it.completeCompass() }
                onMessage("Check-in complete")
                graph.onDataChanged()
            } catch (e: ApiException) {
                onMessage(e.message ?: "Couldn't mark it complete")
            } finally {
                _working.value = null
                compass.refresh()
            }
        }
    }
}

@Composable
fun CompassScreen() {
    val graph = AppGraph.get(LocalContext.current)
    val vm: CompassViewModel = viewModel { CompassViewModel(graph) }
    val state by vm.compass.state.collectAsState()
    val working by vm.working.collectAsState()
    val app = LocalAppActions.current
    LaunchedEffect(Unit) { vm.refresh() }
    CompassContent(state, working, onStart = { vm.start(app::navigate, app::message) }, onComplete = { vm.complete(app::message) }, onRefresh = vm::refresh)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CompassContent(state: Loadable<DailyCompassResponse>, working: String?, onStart: () -> Unit, onComplete: () -> Unit, onRefresh: () -> Unit) {
    val now = LocalClock.current.now()
    val zone = LocalZone.current
    SourceScaffold("Daily Compass", ContextSource.DailyCompass) {
        PullToRefreshBox(isRefreshing = state.loading && state.data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                state.error?.let { item { StatusBanner(it, tone = if (state.data != null) "warn" else "danger", onRetry = onRefresh) } }
                val d = state.data
                if (d != null && !d.enabled) item { EmptyState("Daily Compass isn't set up", "Set it up from Jarvis on the web: Settings → Connections.") }
                val s = d?.state
                if (d != null && d.enabled && s != null) {
                    item {
                        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    when {
                                        s.completed -> Pill("Completed", tone = "ok")
                                        s.inWindow -> Pill("Window open", tone = "accent")
                                        else -> Pill("Window ${s.windowStart}–${s.windowEnd}")
                                    }
                                    Text("Reminder at ${d.reminderTime}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Text(
                                    if (s.completed) "Done for today${s.completedAt?.let { " at ${formatClock(it, zone)}" } ?: ""}. Nice."
                                    else "A short conversation with Hermes to close out the day: how it went, what mattered, and tomorrow's one thing.",
                                    style = MaterialTheme.typography.bodyLarge,
                                )
                                s.summary?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                parseInstant(s.asOf)?.let { Text("Read via Hermes ${relativeTime(it, now)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Button(onClick = onStart, enabled = working == null) { Text(if (working == "start") "Starting…" else if (s.sessionId != null) "Continue check-in" else "Start check-in") }
                                    if (!s.completed) OutlinedButton(onClick = onComplete, enabled = working == null) {
                                        Text(if (working == "complete") (if (d.mode == "hermes") "Asking Hermes…" else "Saving…") else "Mark complete")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
