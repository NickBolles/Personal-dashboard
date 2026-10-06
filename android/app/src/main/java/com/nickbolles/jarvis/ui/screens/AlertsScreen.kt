package com.nickbolles.jarvis.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.JarvisNotification
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.NotificationsResponse
import com.nickbolles.jarvis.data.Resource
import com.nickbolles.jarvis.ui.components.EmptyState
import com.nickbolles.jarvis.ui.components.LocalClock
import com.nickbolles.jarvis.ui.components.Pill
import com.nickbolles.jarvis.ui.components.SourceAvatar
import com.nickbolles.jarvis.ui.components.StatusBanner
import com.nickbolles.jarvis.ui.components.parseInstant
import com.nickbolles.jarvis.ui.components.relativeTime
import com.nickbolles.jarvis.ui.nav.LocalAppActions
import com.nickbolles.jarvis.ui.theme.LocalStatusColors
import kotlinx.coroutines.launch

class AlertsViewModel(private val graph: AppGraph) : ViewModel() {
    var showAll = false
        private set
    val list = Resource(graph, "alerts", NotificationsResponse.serializer()) { it.notifications(all = showAll) }

    fun refresh() {
        viewModelScope.launch { list.refresh() }
    }

    fun setShowAll(all: Boolean) {
        showAll = all
        refresh()
    }

    /** read | dismiss | acted | restore. Optimistic, then the server's state. */
    fun transition(n: JarvisNotification, t: String, onMessage: (String) -> Unit) {
        val current = list.state.value.data
        if (current != null && t in setOf("dismiss", "acted") && !showAll) {
            list.set(current.copy(notifications = current.notifications.filterNot { it.id == n.id }))
        }
        viewModelScope.launch {
            try {
                graph.call { it.transition(n.id, t) }
                graph.onDataChanged()
                list.refresh()
            } catch (e: ApiException) {
                onMessage(e.message ?: "Couldn't update the alert")
                list.refresh()
            }
        }
    }

    fun markAllRead() {
        viewModelScope.launch {
            runCatching { graph.call { it.markAllRead() } }
            graph.onDataChanged()
            list.refresh()
        }
    }
}

@Composable
fun AlertsScreen() {
    val graph = AppGraph.get(LocalContext.current)
    val vm: AlertsViewModel = viewModel { AlertsViewModel(graph) }
    val state by vm.list.state.collectAsState()
    var all by remember { mutableStateOf(vm.showAll) }
    val app = LocalAppActions.current
    LaunchedEffect(Unit) { vm.refresh() }
    AlertsContent(
        state = state,
        showAll = all,
        onShowAll = { all = it; vm.setShowAll(it) },
        onRefresh = vm::refresh,
        onOpen = { n -> vm.transition(n, "read", app::message); app.open(n.deepLink) },
        onTransition = { n, t -> vm.transition(n, t, app::message) },
        onMarkAllRead = vm::markAllRead,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AlertsContent(
    state: Loadable<NotificationsResponse>,
    showAll: Boolean,
    onShowAll: (Boolean) -> Unit,
    onRefresh: () -> Unit,
    onOpen: (JarvisNotification) -> Unit,
    onTransition: (JarvisNotification, String) -> Unit,
    onMarkAllRead: () -> Unit,
) {
    val data = state.data
    PullToRefreshBox(isRefreshing = state.loading && data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Alerts", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f).semantics { heading() })
                    if ((data?.unread ?: 0) > 0) {
                        TextButton(onClick = onMarkAllRead) {
                            Icon(Icons.Outlined.DoneAll, contentDescription = null, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(6.dp))
                            Text("Mark all read")
                        }
                    }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = !showAll, onClick = { onShowAll(false) }, label = { Text("Inbox" + (data?.unread?.takeIf { it > 0 }?.let { " · $it" } ?: "")) })
                    FilterChip(selected = showAll, onClick = { onShowAll(true) }, label = { Text("All") })
                }
            }
            state.error?.let { item { StatusBanner(if (data != null) "Showing saved alerts · $it" else it, tone = if (data != null) "warn" else "danger", onRetry = onRefresh) } }
            val list = data?.notifications.orEmpty()
            if (data != null && list.isEmpty()) item { EmptyState("You're all caught up", "New alerts from Hermes, your home and your todos land here.") }
            items(list, key = { it.id }) { n -> AlertRow(n, onOpen, onTransition) }
            item { Text("Swipe right when it's handled, left to dismiss.", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp)) }
        }
    }
}

@Composable
private fun AlertRow(n: JarvisNotification, onOpen: (JarvisNotification) -> Unit, onTransition: (JarvisNotification, String) -> Unit) {
    val state = rememberSwipeToDismissBoxState()
    LaunchedEffect(state.currentValue) {
        when (state.currentValue) {
            SwipeToDismissBoxValue.StartToEnd -> onTransition(n, "acted")
            SwipeToDismissBoxValue.EndToStart -> onTransition(n, "dismiss")
            else -> Unit
        }
        if (state.currentValue != SwipeToDismissBoxValue.Settled) state.reset()
    }
    val unread = n.readAt == null && n.dismissedAt == null && n.actedAt == null
    val now = LocalClock.current.now()
    val status = LocalStatusColors.current
    SwipeToDismissBox(
        state = state,
        modifier = Modifier.semantics {
            customActions = listOf(
                CustomAccessibilityAction("Mark handled") { onTransition(n, "acted"); true },
                CustomAccessibilityAction("Dismiss") { onTransition(n, "dismiss"); true },
                CustomAccessibilityAction(if (unread) "Mark read" else "Mark unread") { onTransition(n, if (unread) "read" else "unread"); true },
            )
        },
        backgroundContent = {
            val toEnd = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            Box(
                Modifier.fillMaxSize().clip(MaterialTheme.shapes.large)
                    .background(if (toEnd) status.okContainer else MaterialTheme.colorScheme.surfaceContainerHighest)
                    .padding(horizontal = 24.dp),
                contentAlignment = if (toEnd) Alignment.CenterStart else Alignment.CenterEnd,
            ) {
                Icon(if (toEnd) Icons.Outlined.DoneAll else Icons.Outlined.Archive, contentDescription = null)
            }
        },
    ) {
        Surface(onClick = { onOpen(n) }, shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.Top) {
                SourceAvatar(n.source, critical = n.severity == "critical" || n.severity == "high")
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (n.severity == "critical" || n.severity == "high") Pill(n.severity.replaceFirstChar { it.uppercase() }, tone = "danger")
                        if (n.occurrences > 1) Pill("×${n.occurrences}")
                        if (n.dismissedAt != null) Pill("Dismissed")
                        if (n.actedAt != null) Pill("Handled", tone = "ok")
                    }
                    Text(n.title, style = MaterialTheme.typography.titleMedium.copy(fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal))
                    if (n.body.isNotBlank()) Text(n.body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3)
                    parseInstant(n.updatedAt)?.let {
                        Text(relativeTime(it, now), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (unread) Box(Modifier.padding(top = 6.dp).size(10.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
            }
        }
    }
}
