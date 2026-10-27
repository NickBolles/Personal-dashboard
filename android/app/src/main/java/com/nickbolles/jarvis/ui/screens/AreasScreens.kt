package com.nickbolles.jarvis.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Category
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.OpenWith
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TaskAlt
import androidx.compose.material.icons.outlined.TravelExplore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.WorkItem
import com.nickbolles.jarvis.data.WorkItemsResponse
import com.nickbolles.jarvis.data.WorkLabels
import com.nickbolles.jarvis.data.WorkTree
import com.nickbolles.jarvis.ui.components.EmptyState
import com.nickbolles.jarvis.ui.components.MarkdownText
import com.nickbolles.jarvis.ui.components.Pill
import com.nickbolles.jarvis.ui.components.SectionHeader
import com.nickbolles.jarvis.ui.components.StatusBanner
import com.nickbolles.jarvis.ui.nav.LocalAppActions
import com.nickbolles.jarvis.ui.nav.Routes
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.coroutines.launch

/* ------------------------------------------------------------------ model */

/** Every Areas mutation goes through here: server first, then the shared tree is re-read. */
class AreasViewModel(private val graph: AppGraph) : ViewModel() {
    val work = graph.work
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    fun refresh() {
        viewModelScope.launch { work.refresh() }
    }

    private fun mutate(onMessage: (String) -> Unit, done: String?, onDone: (WorkItem?) -> Unit = {}, block: suspend () -> WorkItem?) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            try {
                val item = block()
                work.refresh()
                graph.onDataChanged()
                done?.let(onMessage)
                onDone(item)
            } catch (e: ApiException) {
                onMessage(e.message ?: "That didn't work")
            } finally {
                _busy.value = false
            }
        }
    }

    /** "Area / Project / item" under `parentId`; the server reuses levels by title. */
    fun quickAdd(parentId: String?, text: String, onMessage: (String) -> Unit, onDone: (WorkItem?) -> Unit = {}) {
        val segs = WorkTree.parseQuickPath(text)
        if (segs.isEmpty()) return
        mutate(onMessage, if (segs.size > 1) "Added ${segs.joinToString(" / ")}" else "Added ${segs[0]}", onDone) {
            try {
                graph.call { it.createWorkPath(parentId, segs) }.item
            } catch (e: ApiException) {
                // Servers before the path endpoint: walk the levels here.
                if (e.status != 404 && e.status != 405) throw e
                quickAddLocally(parentId, segs)
            }
        }
    }

    private suspend fun quickAddLocally(parentId: String?, segs: List<String>): WorkItem {
        val items = work.state.value.data?.items.orEmpty().toMutableList()
        var parent: WorkItem? = parentId?.let { id -> items.firstOrNull { it.id == id } }
        var made: WorkItem? = null
        segs.forEachIndexed { i, title ->
            val last = i == segs.lastIndex
            val existing = if (last) null else WorkTree.children(items, parent?.id).firstOrNull { it.title.equals(title, ignoreCase = true) }
            val next = existing ?: graph.call { it.createWorkItem(if (last) WorkTree.defaultChildKind(parent) else if (parent == null) "area" else "project", title, parent?.id) }.also { items.add(it) }
            parent = next
            made = next
        }
        return made!!
    }

    fun create(kind: String, title: String, parentId: String?, summary: String?, onMessage: (String) -> Unit, onDone: (WorkItem?) -> Unit = {}) =
        mutate(onMessage, "Added ${title.trim()}", onDone) { graph.call { it.createWorkItem(kind, title.trim(), parentId, summary = summary) } }

    fun move(item: WorkItem, parentId: String?, onMessage: (String) -> Unit) {
        val target = parentId?.let { id -> work.state.value.data?.items?.firstOrNull { it.id == id }?.title } ?: "the top level"
        mutate(onMessage, "Moved to $target") { graph.call { it.moveWorkItem(item.id, parentId) } }
    }

    fun update(item: WorkItem, fields: Map<String, Any?>, onMessage: (String) -> Unit, done: String? = "Saved") = mutate(onMessage, done) {
        val body = JsonObject(fields.mapValues { (_, v) -> when (v) { null -> JsonPrimitive(null as String?); is Boolean -> JsonPrimitive(v); else -> JsonPrimitive(v.toString()) } })
        graph.call { it.updateWorkItem(item.id, body) }
    }
}

/* ------------------------------------------------------------------ icons */

fun kindIcon(kind: String): ImageVector = when (kind) {
    "area" -> Icons.Outlined.Category
    "project" -> Icons.Outlined.Folder
    "conversation" -> Icons.Outlined.Forum
    "note" -> Icons.Outlined.Description
    "investigation" -> Icons.Outlined.TravelExplore
    else -> Icons.Outlined.TaskAlt
}

/** Dialog/menu state shared by the tree and item pages. */
sealed interface AreasDialog {
    data class New(val kind: String, val parentId: String?, val title: String = "", val summary: String = "") : AreasDialog
    data class Move(val item: WorkItem) : AreasDialog
    data class Edit(val item: WorkItem) : AreasDialog
}

/* ------------------------------------------------------------------ tab */

@Composable
fun AreasScreen(shareText: String? = null) {
    val graph = AppGraph.get(LocalContext.current)
    val app = LocalAppActions.current
    val vm: AreasViewModel = viewModel(key = "areas") { AreasViewModel(graph) }
    val state by vm.work.state.collectAsState()
    val busy by vm.busy.collectAsState()
    var expanded by rememberSaveable { mutableStateOf(setOf<String>()) }
    var dialog by remember { mutableStateOf<AreasDialog?>(null) }
    LaunchedEffect(Unit) { vm.refresh() }
    // Shared text (share sheet → "Save to Areas") opens the New dialog once the tree is known.
    LaunchedEffect(shareText, state.data != null) {
        if (shareText != null && state.data != null && dialog == null) {
            val misc = state.data!!.items.firstOrNull { it.builtIn && it.parentId == null }
            dialog = AreasDialog.New("note", misc?.id, title = shareText.lineSequence().first().take(200), summary = shareText)
        }
    }
    // First open: areas expanded one level, so projects are visible.
    LaunchedEffect(state.data?.items?.size) {
        if (expanded.isEmpty()) state.data?.items?.filter { it.parentId == null }?.map { it.id }?.toSet()?.let { expanded = it }
    }
    AreasContent(
        state = state,
        expanded = expanded,
        busy = busy,
        onToggle = { id -> expanded = if (id in expanded) expanded - id else expanded + id },
        onOpen = { app.navigate(Routes.item(it.id)) },
        onQuickAdd = { text, done -> vm.quickAdd(null, text, app::message) { done() } },
        onNew = { kind -> dialog = AreasDialog.New(kind, null) },
        onMove = { dialog = AreasDialog.Move(it) },
        onRefresh = vm::refresh,
    )
    AreasDialogs(dialog, state.data, vm, onClose = { dialog = null })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AreasContent(
    state: Loadable<WorkItemsResponse>,
    expanded: Set<String>,
    busy: Boolean,
    onToggle: (String) -> Unit,
    onOpen: (WorkItem) -> Unit,
    onQuickAdd: (String, () -> Unit) -> Unit,
    onNew: (String) -> Unit,
    onMove: (WorkItem) -> Unit,
    onRefresh: () -> Unit,
) {
    var filter by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var showDone by rememberSaveable { mutableStateOf(false) }
    val all = state.data?.items.orEmpty()
    val rows = remember(all, expanded, filter, showDone) { WorkTree.rows(all, expanded, filter, showDone) }
    val next = remember(all) { WorkTree.nextActions(all, limit = 5) }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Areas", modifier = Modifier.semantics { heading() }) },
            actions = {
                IconButton(onClick = { searching = !searching; if (!searching) filter = "" }) {
                    Icon(if (searching) Icons.Outlined.Close else Icons.Outlined.Search, contentDescription = if (searching) "Close filter" else "Filter areas")
                }
                NewMenu(onNew)
            },
        )
        PullToRefreshBox(isRefreshing = state.loading && state.data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                if (searching) item(key = "filter") {
                    OutlinedTextField(
                        filter,
                        { filter = it },
                        singleLine = true,
                        placeholder = { Text("Filter by title or next action") },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
                item(key = "quickadd") { QuickAdd(null, busy, onQuickAdd, Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) }
                state.error?.let { e ->
                    item(key = "error") { StatusBanner(if (state.data != null) "Showing saved areas · $e" else e, tone = if (state.data != null) "warn" else "danger", onRetry = onRefresh, modifier = Modifier.padding(horizontal = 16.dp)) }
                }
                if (state.data == null && state.loading) item { Text("Loading areas…", modifier = Modifier.padding(16.dp)) }
                if (next.isNotEmpty() && filter.isBlank()) {
                    item(key = "next-h") { SectionHeader("Next actions", Modifier.padding(horizontal = 16.dp)) }
                    items(next, key = { "next:${it.id}" }) { NextActionRow(it, all, onOpen) }
                    item(key = "next-d") { HorizontalDivider(Modifier.padding(vertical = 8.dp)) }
                }
                item(key = "tree-h") {
                    SectionHeader("All areas", Modifier.padding(horizontal = 16.dp)) {
                        FilterChip(selected = showDone, onClick = { showDone = !showDone }, label = { Text("Show done") })
                    }
                }
                if (state.data != null && rows.isEmpty()) {
                    item { EmptyState(if (filter.isBlank()) "No areas yet" else "Nothing matches “$filter”", if (filter.isBlank()) "Add one above, e.g. “Home / Garage / Fix the door”." else null) }
                }
                items(rows, key = { it.item.id }) { r -> TreeRow(r, all, onToggle, onOpen, onMove) }
            }
        }
    }
}

@Composable
private fun NewMenu(onNew: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }) {
            Icon(Icons.Outlined.Add, contentDescription = null)
            Spacer(Modifier.width(4.dp))
            Text("New")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            WorkLabels.CREATABLE.forEach { k ->
                DropdownMenuItem(text = { Text(WorkLabels.kind(k)) }, leadingIcon = { Icon(kindIcon(k), contentDescription = null) }, onClick = { open = false; onNew(k) })
            }
        }
    }
}

/** One-line add with path syntax: "Area / Project / item" (spaces around the slash). */
@Composable
fun QuickAdd(parent: WorkItem?, busy: Boolean, onAdd: (String, () -> Unit) -> Unit, modifier: Modifier = Modifier) {
    var text by rememberSaveable(parent?.id) { mutableStateOf("") }
    val segs = WorkTree.parseQuickPath(text)
    val submit = { if (segs.isNotEmpty() && !busy) onAdd(text) { text = "" } }
    OutlinedTextField(
        text,
        { text = it },
        singleLine = true,
        enabled = !busy,
        leadingIcon = { Icon(Icons.Outlined.Add, contentDescription = null) },
        trailingIcon = { if (segs.isNotEmpty()) TextButton(onClick = submit, enabled = !busy) { Text("Add") } },
        placeholder = { Text(if (parent == null) "Quick add…" else "Add to ${parent.title}…", maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingText = {
            Text(
                when {
                    segs.size > 1 -> "Creates or reuses: ${segs.joinToString(" › ")}"
                    parent == null -> "Area / Project / item creates the levels"
                    else -> "New ${WorkLabels.kind(WorkTree.defaultChildKind(parent)).lowercase()} · use “ / ” for levels"
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { submit() }),
        modifier = modifier.fillMaxWidth(),
    )
}

@Composable
private fun NextActionRow(item: WorkItem, all: List<WorkItem>, onOpen: (WorkItem) -> Unit) {
    val where = remember(item, all) { WorkTree.breadcrumb(all, item.id).joinToString(" › ") { it.title } }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).combinedClickableCompat(onClick = { onOpen(item) }).padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(kindIcon(item.kind), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(item.nextAction, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                if (item.status != "captured") {
                    Pill(WorkLabels.status(item.status), tone = WorkLabels.statusTone(item.status))
                    Spacer(Modifier.width(6.dp))
                }
                Text("${item.title}${if (where.isNotEmpty()) " · $where" else ""}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun TreeRow(r: WorkTree.Row, all: List<WorkItem>, onToggle: (String) -> Unit, onOpen: (WorkItem) -> Unit, onMove: (WorkItem) -> Unit) {
    val i = r.item
    var menu by remember { mutableStateOf(false) }
    val open = remember(all, i.id) { if (i.isContainer) WorkTree.rollup(all, i.id).open else 0 }
    Box {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .combinedClickableCompat(onClick = { onOpen(i) }, onLongClick = { menu = true })
                .padding(start = (4 + r.depth * 20).dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (r.hasChildren) {
                IconButton(onClick = { onToggle(i.id) }) {
                    Icon(Icons.Outlined.ExpandMore, contentDescription = if (r.expanded) "Collapse ${i.title}" else "Expand ${i.title}", modifier = Modifier.rotate(if (r.expanded) 0f else -90f))
                }
            } else Spacer(Modifier.width(48.dp))
            Icon(kindIcon(i.kind), contentDescription = WorkLabels.kind(i.kind), tint = if (i.isContainer) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                Text(
                    i.title,
                    style = if (r.depth == 0) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyLarge,
                    color = if (i.isClosed) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                val pill = !i.isContainer && !i.isConversation && i.status != "captured"
                if (pill || (i.nextAction.isNotBlank() && !i.isClosed)) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                    if (pill) {
                        Pill(WorkLabels.status(i.status), tone = WorkLabels.statusTone(i.status))
                        Spacer(Modifier.width(6.dp))
                    }
                    if (i.nextAction.isNotBlank() && !i.isClosed) Text("→ ${i.nextAction}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (i.isContainer && open > 0) Text("$open open", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text("Open") }, onClick = { menu = false; onOpen(i) })
            if (!i.builtIn) DropdownMenuItem(text = { Text(if (i.isConversation) "File under…" else "Move to…") }, leadingIcon = { Icon(Icons.Outlined.OpenWith, null) }, onClick = { menu = false; onMove(i) })
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.combinedClickableCompat(onClick: () -> Unit, onLongClick: (() -> Unit)? = null) = combinedClickable(onClick = onClick, onLongClick = onLongClick)

/* ------------------------------------------------------------------ item page */

@Composable
fun ItemScreen(id: String) {
    val graph = AppGraph.get(LocalContext.current)
    val app = LocalAppActions.current
    val vm: AreasViewModel = viewModel(key = "areas") { AreasViewModel(graph) }
    val state by vm.work.state.collectAsState()
    val busy by vm.busy.collectAsState()
    var dialog by remember { mutableStateOf<AreasDialog?>(null) }
    LaunchedEffect(id) { vm.refresh() }
    ItemContent(
        state = state,
        id = id,
        busy = busy,
        onOpen = { app.navigate(Routes.item(it.id)) },
        onAreas = { app.navigate(Routes.AREAS) },
        onBack = app::back,
        onQuickAdd = { parent, text, done -> vm.quickAdd(parent.id, text, app::message) { done() } },
        onStatus = { item, s -> vm.update(item, mapOf("status" to s), app::message, "Marked ${WorkLabels.status(s).lowercase()}") },
        onDialog = { dialog = it },
        onArchive = { item -> vm.update(item, mapOf("archived" to true), app::message, "Archived ${item.title}"); app.back() },
        onChat = { sessionId -> app.navigate(Routes.conversation(sessionId)) },
        onRefresh = vm::refresh,
    )
    AreasDialogs(dialog, state.data, vm, onClose = { dialog = null })
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ItemContent(
    state: Loadable<WorkItemsResponse>,
    id: String,
    busy: Boolean,
    onOpen: (WorkItem) -> Unit,
    onAreas: () -> Unit,
    onBack: () -> Unit,
    onQuickAdd: (WorkItem, String, () -> Unit) -> Unit,
    onStatus: (WorkItem, String) -> Unit,
    onDialog: (AreasDialog) -> Unit,
    onArchive: (WorkItem) -> Unit,
    onChat: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    val all = state.data?.items.orEmpty()
    val node = all.firstOrNull { it.id == id }
    var menu by remember { mutableStateOf(false) }
    var expanded by rememberSaveable(id) { mutableStateOf(setOf<String>()) }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(node?.title ?: "Areas", maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") } },
            actions = {
                if (node != null && !node.builtIn) {
                    IconButton(onClick = { onDialog(AreasDialog.Move(node)) }) { Icon(Icons.Outlined.OpenWith, contentDescription = if (node.isConversation) "File under…" else "Move to…") }
                }
                if (node != null) Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, contentDescription = "More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(text = { Text("Edit") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { menu = false; onDialog(AreasDialog.Edit(node)) })
                        if (!node.isConversation) WorkLabels.CREATABLE.filter { it != "area" }.forEach { k ->
                            DropdownMenuItem(text = { Text("New ${WorkLabels.kind(k).lowercase()} inside") }, leadingIcon = { Icon(kindIcon(k), null) }, onClick = { menu = false; onDialog(AreasDialog.New(k, node.id)) })
                        }
                        if (!node.builtIn) DropdownMenuItem(text = { Text("Archive") }, leadingIcon = { Icon(Icons.Outlined.Archive, null) }, onClick = { menu = false; onArchive(node) })
                    }
                }
            },
        )
        PullToRefreshBox(isRefreshing = state.loading && state.data != null, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            if (node == null) {
                Column(Modifier.fillMaxSize().padding(16.dp)) {
                    if (state.loading || state.data == null) Text("Loading…")
                    else EmptyState("That item isn't here", "It may have been archived or moved.") { OutlinedButton(onClick = onAreas) { Text("All areas") } }
                }
                return@PullToRefreshBox
            }
            val crumbs = remember(all, id) { WorkTree.breadcrumb(all, id) }
            val rows = remember(all, id, expanded) {
                // The subtree, rooted here: rows() walks from the top, so re-root by shifting depth.
                val sub = WorkTree.descendants(all, id)
                WorkTree.rows(sub.map { if (it.parentId == id) it.copy(parentId = null) else it }, expanded, showClosed = true)
            }
            val roll = remember(all, id) { WorkTree.rollup(all, id) }
            val next = remember(all, id) { WorkTree.nextActions(all, id, limit = 8) }
            val convs = state.data?.linkedConversations.orEmpty().filter { it.itemId == id }
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.error?.let { e -> item { StatusBanner("Showing saved copy · $e", onRetry = onRefresh) } }
                item(key = "crumbs") {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.Center) {
                        TextButton(onClick = onAreas, contentPadding = PaddingValues(horizontal = 4.dp)) { Text("Areas") }
                        crumbs.forEach { c ->
                            Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.CenterVertically))
                            TextButton(onClick = { onOpen(c) }, contentPadding = PaddingValues(horizontal = 4.dp)) { Text(c.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        }
                    }
                }
                item(key = "head") {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(kindIcon(node.kind), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.align(Alignment.CenterVertically))
                            Pill(WorkLabels.kind(node.kind), tone = "accent")
                            if (!node.isContainer && !node.isConversation) Pill(WorkLabels.status(node.status), tone = WorkLabels.statusTone(node.status))
                            if (node.builtIn) Pill("Built in")
                        }
                        Text(node.title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                        val dates = listOfNotNull(node.startDate?.let { "Starts $it" }, node.targetDate?.let { "Due $it" }).joinToString(" · ")
                        if (dates.isNotEmpty()) Text(dates, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                when {
                    node.isConversation -> item(key = "conv") {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            node.sessionId?.let { s -> Button(onClick = { onChat(s) }) { Icon(Icons.Outlined.ChatBubbleOutline, null); Spacer(Modifier.width(6.dp)); Text("Open conversation") } }
                            OutlinedButton(onClick = { onDialog(AreasDialog.Move(node)) }) { Text("File under…") }
                        }
                    }
                    node.isContainer -> item(key = "stats") {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Stat("Open", roll.open)
                            Stat("Active", roll.active)
                            Stat("Proof due", roll.proofDue)
                            Stat("Done", roll.done)
                            if (roll.conversations > 0) Stat("Chats", roll.conversations)
                        }
                    }
                    else -> item(key = "work") {
                        Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("Next action", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(node.nextAction.ifBlank { "None yet. Add one so this shows up in Next actions." }, style = MaterialTheme.typography.bodyLarge)
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    TextButton(onClick = { onDialog(AreasDialog.Edit(node)) }) { Text(if (node.nextAction.isBlank()) "Add next action" else "Edit") }
                                    StatusMenu(node, busy, onStatus)
                                }
                            }
                        }
                    }
                }
                if (node.summary.isNotBlank()) item(key = "summary") { MarkdownText(node.summary, style = MaterialTheme.typography.bodyMedium) }
                if (convs.isNotEmpty()) {
                    item(key = "convs-h") { SectionHeader("Conversations") }
                    items(convs, key = { "c:${it.sessionId}" }) { c ->
                        AssistChip(onClick = { onChat(c.sessionId) }, label = { Text(c.title.ifBlank { "Conversation" }, maxLines = 1, overflow = TextOverflow.Ellipsis) }, leadingIcon = { Icon(Icons.Outlined.Forum, null) })
                    }
                }
                if (node.isContainer && next.isNotEmpty()) {
                    item(key = "next-h") { SectionHeader("Next actions") }
                    items(next, key = { "n:${it.id}" }) { n ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).combinedClickableCompat(onClick = { onOpen(n) }), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(n.nextAction, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                                    if (n.status != "captured") {
                                        Pill(WorkLabels.status(n.status), tone = WorkLabels.statusTone(n.status))
                                        Spacer(Modifier.width(6.dp))
                                    }
                                    Text(n.title, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
                if (!node.isConversation) {
                    item(key = "inside-h") { SectionHeader(if (node.isContainer) "Inside" else "Sub-items") }
                    item(key = "inside-add") { QuickAdd(node, busy, { text, done -> onQuickAdd(node, text, done) }) }
                    if (rows.isEmpty()) item(key = "inside-empty") { Text("Nothing here yet.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    items(rows, key = { "r:${it.item.id}" }) { r ->
                        Box(Modifier.padding(start = 0.dp)) {
                            TreeRow(r, all, { k -> expanded = if (k in expanded) expanded - k else expanded + k }, onOpen) { onDialog(AreasDialog.Move(it)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Stat(label: String, n: Int) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 8.dp)) {
            Text(n.toString(), style = MaterialTheme.typography.titleLarge)
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun StatusMenu(item: WorkItem, busy: Boolean, onStatus: (WorkItem, String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, enabled = !busy) {
            Text(WorkLabels.status(item.status), maxLines = 1)
            Icon(Icons.Outlined.ExpandMore, contentDescription = null, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            WorkLabels.SETTABLE.filter { it != item.status }.forEach { s ->
                DropdownMenuItem(text = { Text(WorkLabels.status(s)) }, onClick = { open = false; onStatus(item, s) })
            }
        }
    }
}

/* ------------------------------------------------------------------ dialogs */

@Composable
fun AreasDialogs(dialog: AreasDialog?, data: WorkItemsResponse?, vm: AreasViewModel, onClose: () -> Unit) {
    val app = LocalAppActions.current
    val all = data?.items.orEmpty()
    when (val d = dialog) {
        null -> Unit
        is AreasDialog.Move -> PickerDialog(
            title = if (d.item.isConversation) "File “${d.item.title}” under…" else "Move “${d.item.title}” to…",
            targets = WorkTree.moveTargets(all, d.item),
            all = all,
            allowTop = d.item.kind == "area",
            onDismiss = onClose,
            onPick = { p -> onClose(); vm.move(d.item, p, app::message) },
        )
        is AreasDialog.New -> NewItemDialog(d, all, onDismiss = onClose) { kind, title, parent, summary ->
            onClose()
            vm.create(kind, title, parent, summary, app::message) { made -> made?.let { app.navigate(Routes.item(it.id)) } }
        }
        is AreasDialog.Edit -> EditItemDialog(d.item, onDismiss = onClose) { fields ->
            onClose()
            vm.update(d.item, fields, app::message)
        }
    }
}

/** Move/File picker: every valid target as an indented, filterable list. */
@Composable
fun PickerDialog(title: String, targets: List<WorkItem>, all: List<WorkItem>, allowTop: Boolean, onDismiss: () -> Unit, onPick: (String?) -> Unit) {
    var q by remember { mutableStateOf("") }
    val shown = remember(q, targets) { targets.filter { q.isBlank() || WorkTree.path(all, it.id).contains(q.trim(), ignoreCase = true) } }
    val depth = remember(all) { all.associate { it.id to WorkTree.breadcrumb(all, it.id).size } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("Search areas and projects") }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 380.dp)) {
                    if (allowTop && q.isBlank()) item { PickRow("Top level", null, 0) { onPick(null) } }
                    items(shown, key = { it.id }) { t ->
                        PickRow(t.title, if (q.isBlank()) null else WorkTree.breadcrumb(all, t.id).joinToString(" › ") { it.title }, if (q.isBlank()) depth[t.id] ?: 0 else 0, kindIcon(t.kind)) { onPick(t.id) }
                    }
                    if (shown.isEmpty()) item { Text("No matching places", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp)) }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun PickRow(title: String, supporting: String?, depth: Int, icon: ImageVector? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).combinedClickableCompat(onClick = onClick).padding(start = (depth * 16).dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        icon?.let { Icon(it, null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary); Spacer(Modifier.width(8.dp)) }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            supporting?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun NewItemDialog(d: AreasDialog.New, all: List<WorkItem>, onDismiss: () -> Unit, onCreate: (String, String, String?, String?) -> Unit) {
    var kind by remember { mutableStateOf(d.kind) }
    var title by remember { mutableStateOf(d.title) }
    var parentId by remember { mutableStateOf(d.parentId ?: if (d.kind != "area") all.firstOrNull { it.builtIn && it.parentId == null }?.id else null) }
    var picking by remember { mutableStateOf(false) }
    val parent = all.firstOrNull { it.id == parentId }
    val needsParent = kind != "area"
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New ${WorkLabels.kind(kind).lowercase()}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    WorkLabels.CREATABLE.forEach { k -> FilterChip(selected = kind == k, onClick = { kind = k }, label = { Text(WorkLabels.kind(k)) }) }
                }
                OutlinedTextField(title, { title = it.take(200) }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (needsParent) OutlinedButton(onClick = { picking = true }, modifier = Modifier.fillMaxWidth()) {
                    Text("In: ${parent?.let { WorkTree.path(all, it.id) } ?: "Choose a place"}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (d.summary.isNotBlank() && d.summary != title) Text("The shared text is saved as its notes.", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        confirmButton = {
            TextButton(onClick = { onCreate(kind, title, if (needsParent) parentId else null, d.summary.takeIf { it.isNotBlank() && it != title }) }, enabled = title.isNotBlank() && (!needsParent || parentId != null)) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
    if (picking) PickerDialog(
        title = "Put it in…",
        targets = WorkTree.rows(all, all.map { it.id }.toSet()).map { it.item }.filter { !it.isConversation },
        all = all,
        allowTop = false,
        onDismiss = { picking = false },
        onPick = { parentId = it; picking = false },
    )
}

@Composable
private fun EditItemDialog(item: WorkItem, onDismiss: () -> Unit, onSave: (Map<String, Any?>) -> Unit) {
    var title by remember { mutableStateOf(item.title) }
    var next by remember { mutableStateOf(item.nextAction) }
    var summary by remember { mutableStateOf(item.summary) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit ${WorkLabels.kind(item.kind).lowercase()}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(title, { title = it.take(200) }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (!item.isConversation) OutlinedTextField(next, { next = it.take(2000) }, label = { Text("Next action") }, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(summary, { summary = it }, label = { Text("Notes") }, minLines = 3, maxLines = 8, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val f = linkedMapOf<String, Any?>()
                    if (title.trim() != item.title) f["title"] = title.trim()
                    if (next.trim() != item.nextAction) f["nextAction"] = next.trim()
                    if (summary != item.summary) f["summary"] = summary
                    if (f.isEmpty()) onDismiss() else onSave(f)
                },
                enabled = title.isNotBlank(),
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
