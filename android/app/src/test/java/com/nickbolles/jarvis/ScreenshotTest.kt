package com.nickbolles.jarvis

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.nickbolles.jarvis.data.ApprovalRequest
import com.nickbolles.jarvis.data.ControlsResponse
import com.nickbolles.jarvis.data.DailyCompassResponse
import com.nickbolles.jarvis.data.DeviceMe
import com.nickbolles.jarvis.data.DevicesResponse
import com.nickbolles.jarvis.data.FinanceOverview
import com.nickbolles.jarvis.data.HomePayload
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.NotificationsResponse
import com.nickbolles.jarvis.data.Preferences
import com.nickbolles.jarvis.data.SearchResponse
import com.nickbolles.jarvis.data.SessionDetail
import com.nickbolles.jarvis.data.SessionsResponse
import com.nickbolles.jarvis.data.SourceResult
import com.nickbolles.jarvis.ui.components.ActionHandlers
import com.nickbolles.jarvis.ui.screens.AlertsContent
import com.nickbolles.jarvis.ui.screens.ChatListContent
import com.nickbolles.jarvis.ui.screens.CompassContent
import com.nickbolles.jarvis.ui.screens.FinanceContent
import com.nickbolles.jarvis.ui.screens.SearchContent
import com.nickbolles.jarvis.ui.screens.ControlsContent
import com.nickbolles.jarvis.ui.screens.ConversationContent
import com.nickbolles.jarvis.ui.screens.ConversationState
import com.nickbolles.jarvis.ui.screens.HomeContent
import com.nickbolles.jarvis.ui.screens.LayoutContent
import com.nickbolles.jarvis.ui.screens.LiveRun
import com.nickbolles.jarvis.ui.screens.PairContent
import com.nickbolles.jarvis.ui.screens.SettingsContent
import com.nickbolles.jarvis.ui.screens.SkylightContent
import com.nickbolles.jarvis.ui.screens.TodosContent
import com.nickbolles.jarvis.ui.screens.ToolActivity
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Every screen, from real server responses (contracts/api), light + dark. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], application = TestApp::class, qualifiers = RobolectricDeviceQualifiers.Pixel7)
class ScreenshotTest {
    @get:Rule val compose = createComposeRule()

    private val home = Fixtures.load("home", HomePayload.serializer())
    private val prefs = Fixtures.load("settings", Preferences.serializer())

    @Test fun home_light() = compose.snapshot("home") { HomeContent(Loadable(home), prefs.layout, emptySet(), ActionHandlers(), {}, userName = "Nick") }

    @Test fun home_dark() = compose.snapshot("home_dark", dark = true) { HomeContent(Loadable(home), prefs.layout, emptySet(), ActionHandlers(), {}, userName = "Nick") }

    @Test fun home_offline_from_cache() = compose.snapshot("home_offline") {
        HomeContent(Loadable(home, error = "Can't reach Jarvis (timeout)", fromCache = true), prefs.layout, emptySet(), ActionHandlers(), {})
    }

    @Test fun alerts() = compose.snapshot("alerts") {
        AlertsContent(Loadable(Fixtures.load("notifications", NotificationsResponse.serializer())), false, {}, {}, {}, { _, _ -> }, {})
    }

    @Test fun chat_list() = compose.snapshot("chat_list") { ChatListContent(Loadable(Fixtures.load("sessions", SessionsResponse.serializer())), {}) }

    @Test fun conversation_with_live_run_and_approval() = compose.snapshot("conversation") {
        ConversationContent(
            ConversationState(
                detail = Loadable(Fixtures.load("session", SessionDetail.serializer())),
                pendingUser = "Clean up the build folder and tell me what's using space",
                live = LiveRun(
                    runId = "run_1",
                    text = "Checking disk usage first. ",
                    tools = listOf(ToolActivity("terminal", "du -sh build", done = true, error = false)),
                    approval = ApprovalRequest(requestId = "r1", command = "rm -rf build", description = "Recursive delete", choices = listOf("once", "session", "always", "deny")),
                ),
            ),
            onSend = { _, _, _ -> },
            onApprove = {},
            onStop = {},
            onRefresh = {},
        )
    }

    @Test fun home_control() = compose.snapshot("home_control") {
        ControlsContent(
            Loadable(Fixtures.load("source-home-assistant", SourceResult.serializer())),
            Loadable(Fixtures.load("controls", ControlsResponse.serializer())),
            pending = null,
            focusEntity = null,
            onRefresh = {},
            onExecute = { _, _ -> },
            devices = Loadable(Fixtures.load("ha-devices", DevicesResponse.serializer())),
        )
    }

    @Test fun search() = compose.snapshot("search") { SearchContent(Loadable(Fixtures.load("search", SearchResponse.serializer())), {}, autoFocus = false) }

    @Test fun finance() = compose.snapshot("finance") {
        FinanceContent(Loadable(Fixtures.load("finance-overview", FinanceOverview.serializer())), hidden = false, busy = false, {}, {}, {}, {})
    }

    @Test fun finance_amounts_hidden_dark() = compose.snapshot("finance_hidden_dark", dark = true) {
        FinanceContent(Loadable(Fixtures.load("finance-overview", FinanceOverview.serializer())), hidden = true, busy = false, {}, {}, {}, {})
    }

    @Test fun skylight() = compose.snapshot("skylight") { SkylightContent(Loadable(Fixtures.load("source-skylight", SourceResult.serializer())), emptySet(), ActionHandlers(), {}) }

    @Test fun todos() = compose.snapshot("todos") { TodosContent(Loadable(Fixtures.load("source-todos", SourceResult.serializer())), emptySet(), ActionHandlers(), {}) }

    @Test fun daily_compass() = compose.snapshot("daily_compass") { CompassContent(Loadable(Fixtures.load("daily-compass", DailyCompassResponse.serializer())), null, {}, {}, {}) }

    @Test fun settings() = compose.snapshot("settings") {
        SettingsContent("https://jarvis.example.com", Loadable(prefs), Loadable(Fixtures.load("devices-me", DeviceMe.serializer())), true, {}, {}, {}, {}, {})
    }

    @Test fun home_layout_editor() = compose.snapshot("home_layout") { LayoutContent(prefs.layout) {} }

    @Test fun pair() = compose.snapshot("pair") { PairContent("", "", false, null, null, {}, {}, {}, {}) }

    @Test fun pair_dark_with_error() = compose.snapshot("pair_dark_error", dark = true) {
        PairContent("jarvis.example.com", "ABCD-EF23", false, "That pairing code is wrong or expired. Show a new one in Settings → Phones.", null, {}, {}, {}, {})
    }
}

/** Small phone + 200% text: nothing should be cut off or overlap. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], application = TestApp::class, qualifiers = "w320dp-h640dp-xhdpi", fontScale = 2.0f)
class LargeTextScreenshotTest {
    @get:Rule val compose = createComposeRule()

    @Test fun home_large_text() = compose.snapshot("home_large_text") {
        HomeContent(Loadable(Fixtures.load("home", HomePayload.serializer())), Fixtures.load("settings", Preferences.serializer()).layout, emptySet(), ActionHandlers(), {})
    }

    @Test fun alerts_large_text() = compose.snapshot("alerts_large_text") {
        AlertsContent(Loadable(Fixtures.load("notifications", NotificationsResponse.serializer())), false, {}, {}, {}, { _, _ -> }, {})
    }
}
