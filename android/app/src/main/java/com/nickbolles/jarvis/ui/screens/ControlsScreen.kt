package com.nickbolles.jarvis.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.ContextSource
import com.nickbolles.jarvis.data.ControlView
import com.nickbolles.jarvis.data.ControlsResponse
import com.nickbolles.jarvis.data.HomeHealth
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.Resource
import com.nickbolles.jarvis.data.SourceResult
import com.nickbolles.jarvis.ui.components.EmptyState
import com.nickbolles.jarvis.ui.components.LocalClock
import com.nickbolles.jarvis.ui.components.LocalZone
import com.nickbolles.jarvis.ui.components.Pill
import com.nickbolles.jarvis.ui.components.SectionHeader
import com.nickbolles.jarvis.ui.components.SourceAvatar
import com.nickbolles.jarvis.ui.components.StatusBanner
import com.nickbolles.jarvis.ui.components.formatClock
import com.nickbolles.jarvis.ui.components.parseInstant
import com.nickbolles.jarvis.ui.components.relativeTime
import com.nickbolles.jarvis.ui.nav.CaptureRequest
import com.nickbolles.jarvis.ui.nav.LocalAppActions
import com.nickbolles.jarvis.ui.theme.LocalStatusColors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class ControlsViewModel(private val graph: AppGraph) : ViewModel() {
    val source = Resource(graph, "source-home_assistant", SourceResult.serializer()) { it.source("home_assistant") }
    /** Never cached: controls always act on live state. */
    val controls = Resource(graph, null, ControlsResponse.serializer()) { it.controls() }
    private val _pending = MutableStateFlow<String?>(null)
    val pending = _pending.asStateFlow()

    fun refresh() {
        viewModelScope.launch { source.refresh() }
        viewModelScope.launch { controls.refresh() }
    }

    /** One attempt, never queued or retried: success only after Home Assistant reads back the new state. */
    fun execute(c: ControlView, service: String, onMessage: (String) -> Unit) {
        if (_pending.value != null) return
        _pending.value = c.entityId
        viewModelScope.launch {
            try {
                val r = graph.call { it.control(c, service) }
                onMessage(r.message)
            } catch (e: ApiException) {
                onMessage(e.message ?: "Nothing was sent")
            } finally {
                _pending.value = null
                controls.refresh()
                source.refresh()
                graph.onDataChanged()
            }
        }
    }
}

@Composable
fun ControlsScreen(focusEntity: String?) {
    val graph = AppGraph.get(LocalContext.current)
    val vm: ControlsViewModel = viewModel { ControlsViewModel(graph) }
    val source by vm.source.state.collectAsState()
    val controls by vm.controls.state.collectAsState()
    val pending by vm.pending.collectAsState()
    val app = LocalAppActions.current
    LaunchedEffect(Unit) { vm.refresh() }
    ControlsContent(source, controls, pending, focusEntity, onRefresh = vm::refresh, onExecute = { c, s -> vm.execute(c, s, app::message) })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ControlsContent(
    source: Loadable<SourceResult>,
    controls: Loadable<ControlsResponse>,
    pending: String?,
    focusEntity: String?,
    onRefresh: () -> Unit,
    onExecute: (ControlView, String) -> Unit,
) {
    val app = LocalAppActions.current
    val zone = LocalZone.current
    var confirm by remember { mutableStateOf<Pair<ControlView, String>?>(null) }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Home") },
            navigationIcon = { IconButton(onClick = app::back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") } },
            actions = {
                TextButton(onClick = { app.capture(CaptureRequest(sources = setOf(ContextSource.HomeAssistant))) }) {
                    Icon(Icons.Outlined.AutoAwesome, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Ask Hermes")
                }
            },
        )
        PullToRefreshBox(isRefreshing = (source.loading || controls.loading) && source.data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val status = source.data?.status
                if (status != null && status.state !in setOf("ok", "stale")) {
                    item { StatusBanner("Home Assistant: ${status.error ?: status.state}" + if (status.fromCache) " (showing last known)" else "", tone = "danger", onRetry = onRefresh) }
                }
                source.error?.let { item { StatusBanner(it, tone = "danger", onRetry = onRefresh) } }

                item { SectionHeader("Exceptions") }
                val ex = source.data?.data?.homeExceptions.orEmpty()
                if (source.data?.data != null && ex.isEmpty()) item { EmptyState("Nothing unusual", "Your watched doors, locks, garage and alarm look normal.") }
                items(ex, key = { "ex:${it.entityId}" }) { e ->
                    val focused = e.entityId == focusEntity
                    Surface(shape = MaterialTheme.shapes.large, color = if (focused) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                            SourceAvatar("home_assistant", critical = e.severity == "critical" || e.severity == "high")
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(e.name, style = MaterialTheme.typography.titleMedium)
                                Text("${e.reason} · “${e.state}”" + (e.since?.let { " since ${formatClock(it, zone)}" } ?: ""), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Pill(e.severity, tone = if (e.severity == "critical" || e.severity == "high") "danger" else if (e.severity == "normal") "warn" else "neutral")
                        }
                    }
                }

                item { SectionHeader("Controls") }
                controls.error?.let { item { StatusBanner("Controls need live state: $it", tone = "danger", onRetry = onRefresh) } }
                val list = controls.data?.controls.orEmpty()
                if (controls.data != null && list.isEmpty()) item { EmptyState("No controls allowed", "Add entities to “Allowed controls” in Jarvis on the web (Settings → Connections → Home Assistant).") }
                items(list, key = { "c:${it.entityId}" }) { c -> ControlRow(c, pending == c.entityId, pending != null, onRequest = { s -> confirm = c to s }) }
                item {
                    Text(
                        "Every control asks first, checks the state hasn't changed, and reports success only after Home Assistant confirms. Nothing is queued while offline.",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }

                item { SectionHeader("Home Assistant health") }
                item { HealthPanel(source.data) }
            }
        }
    }
    confirm?.let { (c, service) ->
        val label = c.services.firstOrNull { it.service == service }?.label ?: service
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("$label ${c.name}?") },
            text = { Text("Current state: ${c.state}. Jarvis checks that it hasn't changed, then waits for Home Assistant to confirm.") },
            confirmButton = { Button(onClick = { confirm = null; onExecute(c, service) }) { Text("Yes, ${label.lowercase()}") } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun ControlRow(c: ControlView, running: Boolean, disabled: Boolean, onRequest: (String) -> Unit) {
    val now = LocalClock.current.now()
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                SourceAvatar("home_assistant")
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(c.name, style = MaterialTheme.typography.titleMedium)
                    Text(
                        c.state + (parseInstant(c.lastChanged)?.let { " · ${relativeTime(it, now)}" } ?: ""),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (running) Pill("Waiting for Home Assistant…", tone = "accent")
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                c.services.forEach { s ->
                    FilledTonalButton(onClick = { onRequest(s.service) }, enabled = !disabled && s.wouldChange) { Text(s.label) }
                }
            }
        }
    }
}

/** Counts only. Unknown is "unknown", never 0; when HA can't be read every value is unknown. */
@Composable
fun HealthPanel(result: SourceResult?) {
    val readable = result?.status?.state in setOf("ok", "stale")
    val h: HomeHealth? = if (readable) result?.data?.health else null
    val warn = LocalStatusColors.current.warn
    fun v(n: Int?) = n?.toString() ?: "unknown"
    val rows = listOf(
        Triple("Entities", v(h?.entities), false),
        Triple("Unavailable", v(h?.unavailable), (h?.unavailable ?: 0) > 0),
        Triple("Unknown state", v(h?.unknown), false),
        Triple("Updates pending", v(h?.updatesPending), (h?.updatesPending ?: 0) > 0),
        Triple("Integrations failing", v(h?.integrationsFailing), (h?.integrationsFailing ?: 0) > 0),
    )
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                rows.forEach { (label, value, isWarn) ->
                    Column {
                        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            value,
                            style = if (value == "unknown") MaterialTheme.typography.bodyLarge else MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold),
                            color = if (isWarn) warn else if (value == "unknown") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
            if (h?.failingDomains?.isNotEmpty() == true) Text("Failing: ${h.failingDomains.joinToString(", ")}", style = MaterialTheme.typography.bodyMedium, color = warn)
            Text(
                when {
                    h != null -> "Counts only, no device names."
                    readable -> "Home Assistant hasn't reported health yet."
                    else -> "Can't read Home Assistant right now, so these are unknown."
                },
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
