package com.nickbolles.jarvis.ui.screens

import android.content.Intent
import android.provider.Settings
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.ArrowDownward
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Explore
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.AccountBalanceWallet
import com.nickbolles.jarvis.ui.nav.can
import com.nickbolles.jarvis.ui.nav.canAny
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nickbolles.jarvis.BuildConfig
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.DeviceMe
import com.nickbolles.jarvis.data.HomeSection
import com.nickbolles.jarvis.data.Layout
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.PairingState
import com.nickbolles.jarvis.data.Preferences
import com.nickbolles.jarvis.data.Resource
import com.nickbolles.jarvis.push.PushRegistrar
import com.nickbolles.jarvis.ui.components.SectionHeader
import com.nickbolles.jarvis.ui.components.StatusBanner
import com.nickbolles.jarvis.ui.nav.LocalAppActions
import com.nickbolles.jarvis.ui.nav.Routes
import kotlinx.coroutines.launch

/* ---------------------------------------------------------------- More */

@Composable
fun MoreScreen() {
    val app = LocalAppActions.current
    // Only what this person can use (Settings → People on the web decides).
    val items = listOfNotNull(
        Triple(Icons.Outlined.Search, "Search", Routes.SEARCH),
        if (can("finance.view")) Triple(Icons.Outlined.AccountBalanceWallet, "Finance", Routes.FINANCE) else null,
        if (canAny("home_assistant.view", "home_assistant.calendar", "home_assistant.cameras")) Triple(Icons.Outlined.Home, "Home controls", Routes.controls()) else null,
        if (can("skylight.view")) Triple(Icons.Outlined.CalendarMonth, "Skylight", Routes.SKYLIGHT) else null,
        if (can("todos.view")) Triple(Icons.Outlined.CheckCircle, "Todos", Routes.TODOS) else null,
        if (can("daily_compass.use")) Triple(Icons.Outlined.Explore, "Daily Compass", Routes.COMPASS) else null,
        Triple(Icons.Outlined.Dashboard, "Home layout", Routes.LAYOUT),
        Triple(Icons.Outlined.Settings, "Settings", Routes.SETTINGS),
    )
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item { Text("More", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.semantics { heading() }.padding(bottom = 8.dp)) }
        items(items.size) { i ->
            val (icon, label, route) = items[i]
            NavRow(icon, label) { app.navigate(route) }
        }
    }
}

@Composable
fun NavRow(icon: ImageVector, label: String, supporting: String? = null, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        ListItem(
            headlineContent = { Text(label) },
            supportingContent = supporting?.let { { Text(it) } },
            leadingContent = { Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary) },
            trailingContent = { Icon(Icons.AutoMirrored.Outlined.ArrowForward, contentDescription = null) },
            colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        )
    }
}

/* ------------------------------------------------------------ Settings */

class SettingsViewModel(private val graph: AppGraph) : ViewModel() {
    val prefs = graph.prefs
    val me = Resource(graph, null, DeviceMe.serializer()) { it.me() }

    fun refresh() {
        viewModelScope.launch { prefs.refresh() }
        viewModelScope.launch { me.refresh() }
    }

    /** Optimistic; the server validates and normalises the layout. */
    fun saveLayout(layout: Layout, onMessage: (String) -> Unit) {
        prefs.state.value.data?.let { prefs.set(it.copy(layout = layout)) }
        viewModelScope.launch {
            try {
                prefs.set(graph.call { it.saveLayout(layout) })
                graph.onDataChanged()
            } catch (e: ApiException) {
                onMessage(e.message ?: "Couldn't save")
                prefs.refresh()
            }
        }
    }

    fun testNotification(onMessage: (String) -> Unit) {
        viewModelScope.launch {
            try {
                PushRegistrar.register(graph)
                graph.call { it.testNotification() }
                onMessage("Test alert sent. It should arrive in a few seconds.")
            } catch (e: ApiException) {
                onMessage(e.message ?: "Couldn't send a test")
            }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            val p = graph.store.current()
            if (p != null) runCatching { graph.api().signOut(p.deviceId) }
            graph.signOutLocally()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    val graph = AppGraph.get(context)
    val vm: SettingsViewModel = viewModel { SettingsViewModel(graph) }
    val prefs by vm.prefs.state.collectAsState()
    val me by vm.me.state.collectAsState()
    val pairing by graph.pairingState.collectAsState()
    val app = LocalAppActions.current
    var confirmSignOut by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.refresh() }
    val server = (pairing as? PairingState.Paired)?.pairing?.server
    SettingsContent(
        server = server,
        prefs = prefs,
        me = me,
        notificationsAllowed = NotificationManagerCompat.from(context).areNotificationsEnabled(),
        onLayout = { vm.saveLayout(it, app::message) },
        onEditLayout = { app.navigate(Routes.LAYOUT) },
        onTestNotification = { vm.testNotification(app::message) },
        onSystemNotifications = {
            context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        },
        onSignOut = { confirmSignOut = true },
    )
    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out this phone?") },
            text = { Text("Jarvis forgets this phone and stops sending it notifications. You can pair it again any time.") },
            confirmButton = { Button(onClick = { confirmSignOut = false; vm.signOut() }) { Text("Sign out") } },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsContent(
    server: String?,
    prefs: Loadable<Preferences>,
    me: Loadable<DeviceMe>,
    notificationsAllowed: Boolean,
    onLayout: (Layout) -> Unit,
    onEditLayout: () -> Unit,
    onTestNotification: () -> Unit,
    onSystemNotifications: () -> Unit,
    onSignOut: () -> Unit,
) {
    val app = LocalAppActions.current
    val layout = prefs.data?.layout ?: Layout()
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("Settings") }, navigationIcon = { IconButton(onClick = app::back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") } })
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            prefs.error?.let { item { StatusBanner(it, onRetry = null) } }
            item { SectionHeader("Appearance") }
            item {
                Card {
                    Text("Theme", style = MaterialTheme.typography.titleMedium)
                    val options = listOf("system" to "System", "light" to "Light", "dark" to "Dark")
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                        options.forEachIndexed { i, (value, label) ->
                            SegmentedButton(selected = layout.theme == value, onClick = { onLayout(layout.copy(theme = value)) }, shape = SegmentedButtonDefaults.itemShape(i, options.size)) { Text(label) }
                        }
                    }
                    ToggleRow("Colors from my wallpaper", "Material You. Off uses Jarvis blue.", layout.dynamicColor) { onLayout(layout.copy(dynamicColor = it)) }
                    ToggleRow("Compact lists", "Tighter cards to fit more on screen.", layout.density == "compact") { onLayout(layout.copy(density = if (it) "compact" else "comfortable")) }
                }
            }
            item { NavRow(Icons.Outlined.Dashboard, "Home layout", "Reorder or hide sections (also used on the web)", onEditLayout) }

            item { SectionHeader("Notifications") }
            item {
                Card {
                    val push = me.data?.push
                    Text(
                        when {
                            !notificationsAllowed -> "Notifications are turned off for Jarvis on this phone."
                            push == null && me.data != null -> "Phone notifications aren't set up on the server yet. In Jarvis on the web: Settings → Phones → Firebase."
                            me.data?.device?.pushEnabled == true -> "This phone gets Jarvis notifications."
                            else -> "Registering this phone for notifications…"
                        },
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    Text("Quiet hours and categories are in Jarvis on the web (Settings → Notifications).", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = onTestNotification, enabled = notificationsAllowed && me.data?.push != null) { Text("Send a test") }
                        OutlinedButton(onClick = onSystemNotifications) { Text("System settings") }
                    }
                }
            }

            item { SectionHeader("This phone") }
            item {
                Card {
                    Text(me.data?.device?.name ?: "This phone", style = MaterialTheme.typography.titleMedium)
                    Text("Signed in to ${server ?: "—"}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (server?.startsWith("http://") == true) Text("Not using HTTPS: only OK on your home network.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                    Text("App ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    OutlinedButton(onClick = onSignOut, modifier = Modifier.padding(top = 8.dp)) { Text("Sign out this phone") }
                }
            }
            item {
                Text(
                    "Connections, integrations and pairing other phones are managed in Jarvis on the web.",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) { content() }
    }
}

@Composable
private fun ToggleRow(title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/* ---------------------------------------------------------- Home layout */

@Composable
fun LayoutScreen() {
    val graph = AppGraph.get(LocalContext.current)
    val vm: SettingsViewModel = viewModel { SettingsViewModel(graph) }
    val prefs by vm.prefs.state.collectAsState()
    val app = LocalAppActions.current
    LaunchedEffect(Unit) { vm.refresh() }
    LayoutContent(prefs.data?.layout ?: Layout()) { vm.saveLayout(it, app::message) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LayoutContent(layout: Layout, onChange: (Layout) -> Unit) {
    val app = LocalAppActions.current
    val sections = layout.homeSections
    fun move(i: Int, d: Int) {
        val j = i + d
        if (j !in sections.indices) return
        val list = sections.toMutableList()
        list[i] = sections[j].also { list[j] = sections[i] }
        onChange(layout.copy(homeSections = list))
    }
    Column(Modifier.fillMaxSize()) {
        TopAppBar(title = { Text("Home layout") }, navigationIcon = { IconButton(onClick = app::back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") } })
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { Text("Order and show the sections of Home. Jarvis on the web uses the same layout.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            itemsIndexed(sections, key = { _, s -> s.id }) { i, s ->
                Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Row(Modifier.padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(Layout.labelFor(s.id), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                        Switch(checked = s.visible, onCheckedChange = { v -> onChange(layout.copy(homeSections = sections.map { if (it.id == s.id) HomeSection(it.id, v) else it })) })
                        IconButton(onClick = { move(i, -1) }, enabled = i > 0) { Icon(Icons.Outlined.ArrowUpward, contentDescription = "Move ${Layout.labelFor(s.id)} up") }
                        IconButton(onClick = { move(i, 1) }, enabled = i < sections.lastIndex) { Icon(Icons.Outlined.ArrowDownward, contentDescription = "Move ${Layout.labelFor(s.id)} down") }
                    }
                }
            }
        }
    }
}
