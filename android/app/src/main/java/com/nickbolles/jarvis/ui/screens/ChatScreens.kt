package com.nickbolles.jarvis.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.ApprovalRequest
import com.nickbolles.jarvis.data.ContextSource
import com.nickbolles.jarvis.data.JarvisApi
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.Resource
import com.nickbolles.jarvis.data.RunEvent
import com.nickbolles.jarvis.data.RunStream
import com.nickbolles.jarvis.data.SessionDetail
import com.nickbolles.jarvis.data.SessionSummary
import com.nickbolles.jarvis.data.SessionsResponse
import com.nickbolles.jarvis.data.TERMINAL_STATUSES
import com.nickbolles.jarvis.data.TimelineItem
import com.nickbolles.jarvis.ui.components.EmptyState
import com.nickbolles.jarvis.ui.components.LocalClock
import com.nickbolles.jarvis.ui.components.Pill
import com.nickbolles.jarvis.ui.components.StatusBanner
import com.nickbolles.jarvis.ui.components.parseInstant
import com.nickbolles.jarvis.ui.components.relativeTime
import com.nickbolles.jarvis.ui.nav.LocalAppActions
import com.nickbolles.jarvis.ui.nav.Routes
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/* ---------------------------------------------------------------- list */

class ChatListViewModel(graph: AppGraph) : ViewModel() {
    val sessions = Resource(graph, "sessions", SessionsResponse.serializer()) { it.sessions() }
    fun refresh() {
        viewModelScope.launch { sessions.refresh() }
    }
}

@Composable
fun ChatListScreen() {
    val graph = AppGraph.get(LocalContext.current)
    val vm: ChatListViewModel = viewModel { ChatListViewModel(graph) }
    val state by vm.sessions.state.collectAsState()
    LaunchedEffect(Unit) { vm.refresh() }
    ChatListContent(state, vm::refresh)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListContent(state: Loadable<SessionsResponse>, onRefresh: () -> Unit) {
    val app = LocalAppActions.current
    val now = LocalClock.current.now()
    Box(Modifier.fillMaxSize()) {
        PullToRefreshBox(isRefreshing = state.loading && state.data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 96.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item { Text("Hermes", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() }) }
                state.error?.let { item { StatusBanner(it, tone = if (state.data != null) "warn" else "danger", onRetry = onRefresh) } }
                val list = state.data?.sessions.orEmpty().sortedWith(compareByDescending<SessionSummary> { it.pinned }.thenByDescending { it.lastActiveAt ?: "" })
                if (state.data != null && list.isEmpty()) item { EmptyState("No conversations yet", "Ask Hermes anything — or ask about your Skylight calendar or your home.") }
                items(list, key = { it.id }) { s ->
                    Surface(onClick = { app.navigate(Routes.conversation(s.id)) }, shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (s.pinned) Icon(Icons.Outlined.PushPin, contentDescription = "Pinned", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                                Text(s.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                s.activeRun?.let { r ->
                                    Pill(if (r.pendingApproval != null || r.status == "waiting_for_approval") "Needs you" else "Working", tone = if (r.pendingApproval != null) "warn" else "accent")
                                }
                            }
                            s.preview?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                            parseInstant(s.lastActiveAt)?.let { Text(relativeTime(it, now), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { app.capture() },
            icon = { Icon(Icons.Outlined.Add, contentDescription = null) },
            text = { Text("New") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

/* -------------------------------------------------------- conversation */

data class ToolActivity(val tool: String, val preview: String?, val done: Boolean, val error: Boolean)

data class LiveRun(
    val runId: String,
    val text: String = "",
    val tools: List<ToolActivity> = emptyList(),
    val approval: ApprovalRequest? = null,
    val stopping: Boolean = false,
    val reconnecting: Boolean = false,
)

data class ConversationState(
    val detail: Loadable<SessionDetail> = Loadable(loading = true),
    val live: LiveRun? = null,
    val pendingUser: String? = null,
    val sending: Boolean = false,
    /** shown after a run ends badly: failed / stopped / lost connection */
    val outcome: String? = null,
)

class ConversationViewModel(private val graph: AppGraph, private val sessionId: String, initialRun: String?) : ViewModel() {
    private val _state = MutableStateFlow(ConversationState(detail = Loadable(data = graph.store.readCache("session-$sessionId", SessionDetail.serializer()), loading = true, fromCache = true)))
    val state = _state.asStateFlow()
    private var streamJob: Job? = null

    init {
        viewModelScope.launch {
            load()
            val active = initialRun ?: _state.value.detail.data?.session?.activeRun?.takeIf { it.status !in TERMINAL_STATUSES }?.runId
            active?.let { attach(it) }
        }
    }

    suspend fun load() {
        try {
            val d = graph.call { it.session(sessionId) }
            graph.store.writeCache("session-$sessionId", SessionDetail.serializer(), d)
            _state.update { it.copy(detail = Loadable(data = d)) }
        } catch (e: ApiException) {
            _state.update { it.copy(detail = it.detail.copy(loading = false, error = e.message)) }
        }
    }

    fun refresh() {
        viewModelScope.launch { load() }
    }

    fun send(text: String, sources: Set<ContextSource>, attached: String?) {
        if (text.isBlank() || _state.value.sending || _state.value.live != null) return
        _state.update { it.copy(sending = true, pendingUser = text, outcome = null) }
        viewModelScope.launch {
            try {
                val run = graph.call { it.startRun(sessionId, text.trim(), JarvisApi.newIdempotencyKey(), sources.toList(), attached) }
                _state.update { it.copy(sending = false) }
                attach(run.runId)
            } catch (e: ApiException) {
                _state.update { it.copy(sending = false, pendingUser = null, outcome = "Not sent: ${e.message}") }
            }
        }
    }

    private fun attach(runId: String) {
        streamJob?.cancel()
        _state.update { it.copy(live = LiveRun(runId)) }
        streamJob = viewModelScope.launch {
            val api = runCatching { graph.api() }.getOrNull() ?: return@launch
            try {
                RunStream(api).events(runId).collect { ev -> onEvent(ev) }
            } catch (e: ApiException) {
                _state.update { it.copy(live = null, outcome = e.message) }
            }
        }
    }

    private suspend fun onEvent(ev: RunEvent) {
        when (ev) {
            is RunEvent.TextDelta -> _state.update { s -> s.copy(live = s.live?.copy(text = s.live.text + ev.delta, reconnecting = false)) }
            is RunEvent.ToolStarted -> _state.update { s -> s.copy(live = s.live?.copy(tools = s.live.tools + ToolActivity(ev.tool, ev.preview, done = false, error = false))) }
            is RunEvent.ToolCompleted -> _state.update { s ->
                val tools = s.live?.tools.orEmpty().toMutableList()
                val i = tools.indexOfLast { it.tool == ev.tool && !it.done }
                if (i >= 0) tools[i] = tools[i].copy(done = true, error = ev.error, preview = ev.preview ?: tools[i].preview) else tools += ToolActivity(ev.tool, ev.preview, true, ev.error)
                s.copy(live = s.live?.copy(tools = tools))
            }
            is RunEvent.ApprovalRequested -> _state.update { s -> s.copy(live = s.live?.copy(approval = ev.request)) }
            is RunEvent.ApprovalResolved -> _state.update { s -> s.copy(live = s.live?.copy(approval = null)) }
            is RunEvent.Terminal -> {
                load()
                graph.onDataChanged()
                _state.update {
                    it.copy(
                        live = null,
                        pendingUser = null,
                        outcome = when (ev.status) {
                            "failed" -> "Hermes couldn't finish: ${ev.error ?: "the run failed"}"
                            "cancelled", "interrupted" -> "Stopped."
                            else -> null
                        },
                    )
                }
            }
            is RunEvent.StreamClosed -> _state.update { it.copy(live = it.live?.copy(reconnecting = false), outcome = ev.message ?: "Lost connection to the run.") }
            is RunEvent.Other -> if (ev.type == "reconnecting") _state.update { s -> s.copy(live = s.live?.copy(reconnecting = true)) }
        }
    }

    fun approve(choice: String) {
        val live = _state.value.live ?: return
        val req = live.approval ?: return
        _state.update { s -> s.copy(live = s.live?.copy(approval = null)) }
        viewModelScope.launch {
            try {
                graph.call { it.approve(live.runId, choice, req.requestId) }
            } catch (e: ApiException) {
                _state.update { s -> s.copy(live = s.live?.copy(approval = req), outcome = e.message) }
            }
        }
    }

    fun stop() {
        val live = _state.value.live ?: return
        _state.update { s -> s.copy(live = s.live?.copy(stopping = true)) }
        viewModelScope.launch { runCatching { graph.call { it.stopRun(live.runId) } } }
    }
}

@Composable
fun ConversationScreen(sessionId: String, runId: String?) {
    val graph = AppGraph.get(LocalContext.current)
    val vm: ConversationViewModel = viewModel(key = "conv-$sessionId") { ConversationViewModel(graph, sessionId, runId) }
    val state by vm.state.collectAsState()
    ConversationContent(state, onSend = vm::send, onApprove = vm::approve, onStop = vm::stop, onRefresh = vm::refresh)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationContent(
    state: ConversationState,
    onSend: (String, Set<ContextSource>, String?) -> Unit,
    onApprove: (String) -> Unit,
    onStop: () -> Unit,
    onRefresh: () -> Unit,
    initialText: String = "",
) {
    val app = LocalAppActions.current
    val detail = state.detail.data
    val listState = rememberLazyListState()
    val itemCount = (detail?.timeline?.size ?: 0) + (if (state.pendingUser != null) 1 else 0) + (if (state.live != null) 1 else 0)
    LaunchedEffect(itemCount, state.live?.text?.length) { if (itemCount > 0) listState.animateScrollToItem(itemCount - 1) }

    Column(Modifier.fillMaxSize().imePadding()) {
        TopAppBar(
            title = { Text(detail?.session?.title ?: "Conversation", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClick = app::back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") } },
        )
        PullToRefreshBox(isRefreshing = state.detail.loading && detail != null, onRefresh = onRefresh, modifier = Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                state.detail.error?.let { item { StatusBanner(it, tone = if (detail != null) "warn" else "danger", onRetry = onRefresh) } }
                items(detail?.timeline.orEmpty(), key = { it.id }) { TimelineRow(it) }
                state.pendingUser?.let { item(key = "pending") { Bubble(it, mine = true) } }
                state.live?.let { live -> item(key = "live") { LiveBubble(live, onApprove, onStop) } }
                state.outcome?.let { item(key = "outcome") { StatusBanner(it, tone = "danger") } }
            }
        }
        Composer(
            enabled = state.live == null && !state.sending,
            busyLabel = when {
                state.sending -> "Sending…"
                state.live?.approval != null -> "Waiting for your approval"
                state.live != null -> "Hermes is working…"
                else -> null
            },
            initialText = initialText,
            onSend = onSend,
        )
    }
}

@Composable
private fun TimelineRow(item: TimelineItem) {
    when (item.kind) {
        "user" -> Bubble(item.text ?: "", mine = true)
        "assistant" -> Bubble(item.text ?: "", mine = false)
        "tool" -> ToolRow(item.summary ?: item.tool ?: "Tool", item.detail, error = item.error)
        else -> Text(item.text ?: "", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp))
    }
}

@Composable
fun Bubble(text: String, mine: Boolean) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Surface(
            shape = MaterialTheme.shapes.large,
            color = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
            modifier = Modifier.widthIn(max = 340.dp),
        ) {
            SelectionContainer { Text(text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) }
        }
    }
}

@Composable
private fun ToolRow(label: String, detail: String?, error: Boolean, running: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp)) {
        Icon(Icons.Outlined.Build, contentDescription = null, modifier = Modifier.size(14.dp), tint = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(8.dp))
        Text(
            buildString {
                append(label)
                if (running) append("…")
                detail?.takeIf { it.isNotBlank() }?.let { append(" · ").append(it.take(80)) }
            },
            style = MaterialTheme.typography.labelMedium,
            color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private val TOOL_LABELS = mapOf(
    "terminal" to "Ran a command",
    "web_search" to "Searched the web",
    "web_extract" to "Read a web page",
    "read_file" to "Read a file",
    "write_file" to "Wrote a file",
    "memory" to "Updated memory",
    "delegate_task" to "Delegated to a subagent",
    "send_message" to "Sent a message",
)

@Composable
private fun LiveBubble(live: LiveRun, onApprove: (String) -> Unit, onStop: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
        live.tools.forEach { t -> ToolRow(TOOL_LABELS[t.tool] ?: "Used ${t.tool.replace('_', ' ')}", t.preview, t.error, running = !t.done) }
        if (live.text.isNotEmpty()) Bubble(live.text, mine = false)
        live.approval?.let { a ->
            Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Hermes needs your approval", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onErrorContainer)
                    a.description?.let { Text(it, color = MaterialTheme.colorScheme.onErrorContainer) }
                    a.command?.let { Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surface) { Text(it, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace), modifier = Modifier.padding(8.dp)) } }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if ("once" in a.choices) Button(onClick = { onApprove("once") }) { Text("Allow once") }
                        if ("session" in a.choices) OutlinedButton(onClick = { onApprove("session") }) { Text("This conversation") }
                        if ("always" in a.choices) OutlinedButton(onClick = { onApprove("always") }) { Text("Always") }
                        if ("deny" in a.choices) OutlinedButton(onClick = { onApprove("deny") }) { Text("Deny") }
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                when {
                    live.stopping -> "Stopping…"
                    live.reconnecting -> "Reconnecting…"
                    live.approval != null -> "Paused for approval"
                    else -> "Hermes is working…"
                },
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            if (!live.stopping) OutlinedButton(onClick = onStop) {
                Icon(Icons.Outlined.Stop, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Stop")
            }
        }
    }
}

/** Message box with "attach" chips: the server adds a fresh snapshot of each chosen source. */
@Composable
fun Composer(
    enabled: Boolean,
    busyLabel: String?,
    onSend: (String, Set<ContextSource>, String?) -> Unit,
    initialText: String = "",
    initialSources: Set<ContextSource> = emptySet(),
    attached: String? = null,
    attachedLabel: String? = null,
    onClearAttached: () -> Unit = {},
    /** keep the text when the caller may fail and want a retry (capture sheet) */
    clearOnSend: Boolean = true,
) {
    var text by rememberSaveable { mutableStateOf(initialText) }
    var sources by rememberSaveable { mutableStateOf(initialSources.map { it.name }.toSet()) }
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (attached != null) {
                    InputChip(
                        selected = true,
                        onClick = onClearAttached,
                        label = { Text(attachedLabel ?: "Attached", maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp)) },
                        trailingIcon = { Icon(Icons.Outlined.Close, contentDescription = "Remove attachment", modifier = Modifier.size(16.dp)) },
                    )
                }
                ContextSource.entries.forEach { s ->
                    FilterChip(
                        selected = s.name in sources,
                        onClick = { sources = if (s.name in sources) sources - s.name else sources + s.name },
                        label = { Text(s.label) },
                    )
                }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text(busyLabel ?: if (sources.isEmpty()) "Message Hermes" else "Ask about ${sources.mapNotNull { n -> ContextSource.entries.firstOrNull { it.name == n }?.label }.joinToString(", ")}") },
                    maxLines = 6,
                    enabled = enabled,
                )
                Spacer(Modifier.width(8.dp))
                FilledIconButton(
                    onClick = {
                        onSend(text, sources.mapNotNull { n -> ContextSource.entries.firstOrNull { it.name == n } }.toSet(), attached)
                        if (clearOnSend) text = ""
                    },
                    enabled = enabled && text.isNotBlank(),
                    modifier = Modifier.size(52.dp),
                ) { Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "Send") }
            }
        }
    }
}
