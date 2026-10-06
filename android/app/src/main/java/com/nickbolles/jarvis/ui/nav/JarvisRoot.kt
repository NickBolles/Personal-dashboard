package com.nickbolles.jarvis.ui.nav

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.Layout
import com.nickbolles.jarvis.data.PairingState
import com.nickbolles.jarvis.data.UnreadCount
import com.nickbolles.jarvis.ui.screens.AlertsScreen
import com.nickbolles.jarvis.ui.screens.CaptureSheet
import com.nickbolles.jarvis.ui.screens.ChatListScreen
import com.nickbolles.jarvis.ui.screens.CompassScreen
import com.nickbolles.jarvis.ui.screens.ControlsScreen
import com.nickbolles.jarvis.ui.screens.ConversationScreen
import com.nickbolles.jarvis.ui.screens.HomeScreen
import com.nickbolles.jarvis.ui.screens.LayoutScreen
import com.nickbolles.jarvis.ui.screens.MoreScreen
import com.nickbolles.jarvis.ui.screens.PairLink
import com.nickbolles.jarvis.ui.screens.PairScreen
import com.nickbolles.jarvis.ui.screens.FinanceScreen
import com.nickbolles.jarvis.ui.screens.SearchScreen
import com.nickbolles.jarvis.ui.screens.SettingsScreen
import com.nickbolles.jarvis.ui.screens.SkylightScreen
import com.nickbolles.jarvis.ui.screens.TodosScreen
import com.nickbolles.jarvis.ui.theme.JarvisTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** Something an intent asked for: a pairing link, an in-app route, or the capture sheet. */
sealed interface LaunchRequest {
    data class Pair(val link: PairLink) : LaunchRequest
    data class Route(val route: String) : LaunchRequest
    data class Capture(val request: CaptureRequest) : LaunchRequest

    companion object {
        fun from(intent: Intent?): LaunchRequest? {
            intent ?: return null
            if (intent.action == Intent.ACTION_SEND) {
                val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getStringExtra(Intent.EXTRA_TEXT)).joinToString("\n").trim()
                return Capture(CaptureRequest(text = text))
            }
            val data: Uri = intent.data ?: return null
            if (data.scheme != "jarvis") return null
            PairLink.parse(data.toString())?.let { return Pair(it) }
            if (data.host == "open") {
                val path = data.path.orEmpty() + (data.query?.let { "?$it" } ?: "")
                if (path.startsWith("/capture")) {
                    val src = data.getQueryParameter("source")?.let { com.nickbolles.jarvis.data.ContextSource.forSource(it) }
                    return Capture(CaptureRequest(sources = setOfNotNull(src)))
                }
                return Routes.fromPath(path)?.let { Route(it) }
            }
            return null
        }
    }
}

private data class Tab(val route: String, val label: String, val icon: ImageVector, val selected: ImageVector, val capability: String? = null)

private val TABS = listOf(
    Tab(Routes.HOME, "Home", Icons.Outlined.Home, Icons.Filled.Home),
    Tab(Routes.CHAT, "Chat", Icons.Outlined.ChatBubbleOutline, Icons.Filled.ChatBubble, capability = "hermes.chat"),
    Tab(Routes.ALERTS, "Alerts", Icons.Outlined.Notifications, Icons.Filled.Notifications),
    Tab(Routes.MORE, "More", Icons.Outlined.Menu, Icons.Filled.Menu),
)

@Composable
fun JarvisRoot(requests: MutableStateFlow<LaunchRequest?>) {
    val graph = AppGraph.get(LocalContext.current)
    val prefs by graph.prefs.state.collectAsState()
    val layout = prefs.data?.layout ?: Layout()
    JarvisTheme(theme = layout.theme, dynamicColor = layout.dynamicColor, density = layout.density) {
        val pairing by graph.pairingState.collectAsState()
        val request by requests.collectAsState()
        val signedOut by graph.signedOutReason.collectAsState()
        // A themed surface so text outside other surfaces gets the right color (dark mode).
        androidx.compose.material3.Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when (val p = pairing) {
            PairingState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            PairingState.Unpaired -> {
                val link = (request as? LaunchRequest.Pair)?.link
                PairScreen(graph, link, signedOut)
                LaunchedEffect(link) { if (link != null) requests.value = null }
            }
            is PairingState.Paired -> MainScaffold(graph, requests)
        }
        }
    }
}

@Composable
private fun MainScaffold(graph: AppGraph, requests: MutableStateFlow<LaunchRequest?>) {
    val nav = rememberNavController()
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var capture by remember { mutableStateOf<CaptureRequest?>(null) }
    var unread by remember { mutableStateOf(graph.store.readCache("unread", UnreadCount.serializer())?.unread ?: 0) }
    val request by requests.collectAsState()
    val access by graph.access.state.collectAsState()
    LaunchedEffect(Unit) { graph.access.refresh() }

    val actions = remember(nav) {
        object : AppActions {
            override fun navigate(route: String) = nav.navigate(route) { launchSingleTop = true }
            override fun back() {
                if (!nav.popBackStack()) nav.navigate(Routes.HOME)
            }
            override fun capture(request: CaptureRequest) {
                capture = request
            }
            override fun message(text: String) {
                scope.launch { snack.showSnackbar(text) }
            }
            override fun open(href: String) {
                when {
                    href.startsWith("http://") || href.startsWith("https://") ->
                        runCatching { graph.context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(href)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    else -> Routes.fromPath(href)?.let { navigate(it) } ?: message("That opens in Jarvis on the web")
                }
            }
        }
    }

    // Intents (notification taps, widgets, shortcuts, share sheet) arrive here.
    LaunchedEffect(request) {
        when (val r = request) {
            is LaunchRequest.Route -> actions.navigate(r.route)
            is LaunchRequest.Capture -> capture = r.request
            is LaunchRequest.Pair -> actions.message("This phone is already paired. Sign out in Settings to pair again.")
            null -> Unit
        }
        if (request != null) requests.value = null
    }

    // Badge: unread alerts, refreshed while the app is open.
    LaunchedEffect(Unit) {
        while (true) {
            runCatching { graph.call { it.unread() } }.getOrNull()?.let {
                unread = it.unread
                graph.store.writeCache("unread", UnreadCount.serializer(), it)
            }
            delay(60_000)
        }
    }

    CompositionLocalProvider(LocalAppActions provides actions, LocalAccess provides access.data) {
        Scaffold(
            snackbarHost = { SnackbarHost(snack) },
            bottomBar = { BottomBar(nav, unread, TABS.filter { t -> t.capability == null || access.data?.can(t.capability) != false }) },
        ) { padding ->
            NavHost(nav, startDestination = Routes.HOME, modifier = Modifier.padding(padding)) {
                composable(Routes.HOME) { HomeScreen() }
                composable(Routes.CHAT) { ChatListScreen() }
                composable(
                    Routes.CONVERSATION,
                    arguments = listOf(navArgument("id") { type = NavType.StringType }, navArgument("run") { type = NavType.StringType; nullable = true; defaultValue = null }),
                ) { e -> ConversationScreen(e.arguments?.getString("id")!!, e.arguments?.getString("run")) }
                composable(Routes.ALERTS) { AlertsScreen() }
                composable(Routes.MORE) { MoreScreen() }
                composable(Routes.CONTROLS, arguments = listOf(navArgument("entity") { type = NavType.StringType; nullable = true; defaultValue = null })) { e ->
                    ControlsScreen(e.arguments?.getString("entity"))
                }
                composable(Routes.SKYLIGHT) { SkylightScreen() }
                composable(Routes.COMPASS) { CompassScreen() }
                composable(Routes.TODOS) { TodosScreen() }
                composable(Routes.SETTINGS) { SettingsScreen() }
                composable(Routes.LAYOUT) { LayoutScreen() }
                composable(Routes.SEARCH) { SearchScreen() }
                composable(Routes.FINANCE) { FinanceScreen() }
            }
        }
        capture?.let { c -> CaptureSheet(graph, c, onDismiss = { capture = null }, onNavigate = actions::navigate) }
    }
}

@Composable
private fun BottomBar(nav: NavHostController, unread: Int, tabs: List<Tab>) {
    val entry by nav.currentBackStackEntryAsState()
    val current = entry?.destination?.route
    NavigationBar {
        tabs.forEach { tab ->
            val selected = current == tab.route || (tab.route == Routes.CHAT && current == Routes.CONVERSATION) ||
                (tab.route == Routes.MORE && current in setOf(Routes.CONTROLS, Routes.SKYLIGHT, Routes.COMPASS, Routes.TODOS, Routes.SETTINGS, Routes.LAYOUT, Routes.SEARCH, Routes.FINANCE))
            NavigationBarItem(
                selected = selected,
                onClick = {
                    nav.navigate(tab.route) {
                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                icon = {
                    if (tab.route == Routes.ALERTS && unread > 0) {
                        BadgedBox(badge = { Badge { Text(if (unread > 99) "99+" else unread.toString()) } }) { Icon(if (selected) tab.selected else tab.icon, contentDescription = null) }
                    } else Icon(if (selected) tab.selected else tab.icon, contentDescription = null)
                },
                label = { Text(if (tab.route == Routes.ALERTS && unread > 0) "Alerts ($unread)" else tab.label, style = MaterialTheme.typography.labelMedium) },
            )
        }
    }
}
