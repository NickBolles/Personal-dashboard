package com.nickbolles.jarvis.ui.screens

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.FinanceOverview
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.Resource
import com.nickbolles.jarvis.data.SearchResponse
import com.nickbolles.jarvis.ui.components.EmptyState
import com.nickbolles.jarvis.ui.components.LocalClock
import com.nickbolles.jarvis.ui.components.Pill
import com.nickbolles.jarvis.ui.components.SectionHeader
import com.nickbolles.jarvis.ui.components.SourceAvatar
import com.nickbolles.jarvis.ui.components.StatusBanner
import com.nickbolles.jarvis.ui.components.parseInstant
import com.nickbolles.jarvis.ui.components.relativeTime
import com.nickbolles.jarvis.ui.nav.LocalAppActions
import com.nickbolles.jarvis.ui.nav.can
import java.text.NumberFormat
import java.util.Locale
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/* ------------------------------------------------------------- search */

class SearchViewModel(private val graph: AppGraph) : ViewModel() {
    private val _state = MutableStateFlow(Loadable<SearchResponse>())
    val state = _state.asStateFlow()
    private var job: Job? = null

    /** Debounced: one request per pause in typing. */
    fun query(q: String) {
        job?.cancel()
        if (q.isBlank()) {
            _state.value = Loadable()
            return
        }
        job = viewModelScope.launch {
            delay(250)
            _state.value = _state.value.copy(loading = true, error = null)
            _state.value = try {
                Loadable(data = graph.call { it.search(q.trim()) })
            } catch (e: ApiException) {
                Loadable(error = e.message)
            }
        }
    }
}

private val KIND_LABEL = mapOf(
    "page" to "Page", "setting" to "Settings", "action" to "Card", "event" to "Event",
    "conversation" to "Conversation", "device" to "Device", "person" to "Person", "finance" to "Finance",
)

@Composable
fun SearchScreen() {
    val graph = AppGraph.get(LocalContext.current)
    val vm: SearchViewModel = viewModel { SearchViewModel(graph) }
    val state by vm.state.collectAsState()
    SearchContent(state, vm::query)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchContent(state: Loadable<SearchResponse>, onQuery: (String) -> Unit, autoFocus: Boolean = true) {
    val app = LocalAppActions.current
    var q by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (autoFocus) runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Search") },
            navigationIcon = { IconButton(onClick = app::back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") } },
        )
        OutlinedTextField(
            value = q,
            onValueChange = { q = it; onQuery(it) },
            label = { Text("Search Jarvis") },
            leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).focusRequester(focus),
        )
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            state.error?.let { item { StatusBanner(it, tone = "danger") } }
            val data = state.data
            if (data != null && data.results.isEmpty()) item { EmptyState("Nothing found", "Try another word.") }
            if (data != null && data.partial.isNotEmpty()) item { Text("${data.partial.joinToString()} didn't answer in time.", style = MaterialTheme.typography.labelMedium) }
            items(data?.results.orEmpty(), key = { it.id }) { r ->
                Surface(onClick = { app.open(r.href) }, shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    ListItem(
                        headlineContent = { Text(r.title) },
                        supportingContent = r.subtitle?.let { { Text(it, maxLines = 2) } },
                        leadingContent = { SourceAvatar(if (r.module == "jarvis") "settings" else r.module) },
                        trailingContent = { Text(KIND_LABEL[r.kind] ?: r.kind, style = MaterialTheme.typography.labelMedium) },
                        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                    )
                }
            }
        }
    }
}

/* ------------------------------------------------------------ finance */

/** "1,500.00"; amounts are integer cents. */
fun formatCents(cents: Long): String {
    val f = NumberFormat.getNumberInstance(Locale.US).apply { minimumFractionDigits = 2; maximumFractionDigits = 2 }
    return (if (cents < 0) "negative " else "") + f.format(kotlin.math.abs(cents) / 100.0)
}

private const val UI_PREFS = "jarvis_ui"
private const val HIDE_KEY = "finance_hide_amounts"

class FinanceViewModel(private val graph: AppGraph) : ViewModel() {
    val overview = Resource(graph, "finance-overview", FinanceOverview.serializer()) { it.financeOverview() }
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    fun refresh() {
        viewModelScope.launch { overview.refresh() }
    }

    /** Monarch refresh-and-read; the server reports partial and failed runs as they are. */
    fun refreshBalances(onMessage: (String) -> Unit) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            try {
                val r = graph.call { it.refreshFinance() }
                onMessage(if (r.outcome == "ready") "Balances refreshed" else "Refreshed, with things to look at")
            } catch (e: ApiException) {
                onMessage(e.message ?: "Refresh failed")
            } finally {
                _busy.value = false
                overview.refresh()
                graph.onDataChanged()
            }
        }
    }
}

@Composable
fun FinanceScreen() {
    val graph = AppGraph.get(LocalContext.current)
    val vm: FinanceViewModel = viewModel { FinanceViewModel(graph) }
    val state by vm.overview.state.collectAsState()
    val busy by vm.busy.collectAsState()
    val app = LocalAppActions.current
    val context = LocalContext.current
    val ui = context.getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE)
    var hidden by remember { mutableStateOf(ui.getBoolean(HIDE_KEY, false)) }
    LaunchedEffect(Unit) { vm.refresh() }
    FinanceContent(
        state = state,
        hidden = hidden,
        busy = busy,
        onHidden = { hidden = it; ui.edit().putBoolean(HIDE_KEY, it).apply() },
        onRefresh = vm::refresh,
        onRefreshBalances = { vm.refreshBalances(app::message) },
        onOpenWeb = { path ->
            graph.launch {
                val server = runCatching { graph.api().url(path) }.getOrNull() ?: return@launch
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(server)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FinanceContent(
    state: Loadable<FinanceOverview>,
    hidden: Boolean,
    busy: Boolean,
    onHidden: (Boolean) -> Unit,
    onRefresh: () -> Unit,
    onRefreshBalances: () -> Unit,
    onOpenWeb: (String) -> Unit,
) {
    val app = LocalAppActions.current
    val now = LocalClock.current.now()
    val canEdit = can("finance.edit")
    fun money(c: Long?) = if (c == null) "unknown" else if (hidden) "•••••" else formatCents(c)
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Finance") },
            navigationIcon = { IconButton(onClick = app::back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") } },
        )
        PullToRefreshBox(isRefreshing = state.loading && state.data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.error?.let { item { StatusBanner(if (state.data != null) "Showing saved data · $it" else it, tone = if (state.data != null) "warn" else "danger", onRetry = onRefresh) } }
                val o = state.data ?: return@LazyColumn
                item {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        Text("Hide amounts on this phone", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        Switch(checked = hidden, onCheckedChange = onHidden, modifier = Modifier.semantics { contentDescription = "Hide amounts on this phone" })
                    }
                }
                item {
                    val tone = when (o.status) { "ready" -> "ok"; "failed" -> "danger"; "setup" -> "neutral"; else -> "warn" }
                    val word = when (o.status) { "ready" -> "Ready"; "failed" -> "Refresh failed"; "setup" -> "Set up"; else -> "Needs attention" }
                    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Pill(word, tone = tone)
                            Text(o.statusText, style = MaterialTheme.typography.titleMedium)
                            Text(
                                parseInstant(o.asOf)?.let { "Balances updated ${relativeTime(minOf(it, now), now)}" } ?: if (o.setup.accounts > 0) "Some balances have no known as-of time" else "Add accounts on the web to start",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                if (o.setup.releaseBlocker) item { StatusBanner("Release blocker: Monarch hasn't worked with your real account yet. Manual and CSV balances work meanwhile.", tone = "danger") }
                o.totals?.let { t ->
                    item { SectionHeader("Where we stand") }
                    item {
                        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Total("Net position (all accounts)", money(t.net), strong = true)
                                Total("Liquid cash (banks only)", money(t.liquid), strong = true)
                                Total("Checking reserve (a restriction)", money(t.reserve))
                                Total("Unrestricted checking", money(t.unrestricted))
                                if (t.inTransit != 0L) Total("In transit", money(t.inTransit))
                            }
                        }
                    }
                }
                o.checkin?.let { c ->
                    item { SectionHeader("${c.month} check-in") }
                    item {
                        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(
                                    if (c.status == "closed") "Closed" else listOfNotNull(
                                        if (c.blocking > 0) "${c.blocking} to fix" else null,
                                        if (c.warnings > 0) "${c.warnings} warning${if (c.warnings == 1) "" else "s"}" else null,
                                        "${c.open} open action${if (c.open == 1) "" else "s"}",
                                    ).joinToString(" · "),
                                    style = MaterialTheme.typography.bodyLarge,
                                )
                                OutlinedButton(onClick = { onOpenWeb("/finance/checkin/${c.id}") }) { Text("Open the check-in on the web") }
                            }
                        }
                    }
                }
                if (o.issues.isNotEmpty()) {
                    item { SectionHeader("To look at") }
                    items(o.issues.take(8), key = { "${it.code}:${it.ref}" }) { i ->
                        Row(verticalAlignment = Alignment.Top, modifier = Modifier.fillMaxWidth()) {
                            Pill(if (i.blocking) "Must fix" else "Warning", tone = if (i.blocking) "danger" else "warn")
                            Spacer(Modifier.width(8.dp))
                            Text(i.message, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                        }
                    }
                }
                if (o.upcoming.isNotEmpty()) {
                    item { SectionHeader("Coming up") }
                    items(o.upcoming, key = { it.id }) { u ->
                        Row(Modifier.fillMaxWidth()) {
                            Text("${u.date}  ${u.label}", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                            u.amount?.let { Text(money(it), style = MaterialTheme.typography.bodyMedium) }
                        }
                    }
                }
                if (o.funds.isNotEmpty()) {
                    item { SectionHeader("Funds") }
                    items(o.funds, key = { it.fundId }) { f ->
                        Row(Modifier.fillMaxWidth()) {
                            Text(f.name + if (f.protected) " (protected)" else "", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                            Text(money(f.available), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                if (canEdit && o.setup.balanceSource == "monarch" && o.setup.accounts > 0) {
                    item { FilledTonalButton(onClick = onRefreshBalances, enabled = !busy, modifier = Modifier.padding(top = 8.dp)) { Text(if (busy) "Refreshing…" else "Refresh balances") } }
                }
                item {
                    Text(
                        "Jarvis plans and records; it never moves money. Plan payments, close check-ins and edit the long-term plan on the web.",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun Total(label: String, value: String, strong: Boolean = false) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyLarge, fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal)
    }
}
