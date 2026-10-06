package com.nickbolles.jarvis

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nickbolles.jarvis.data.AuthMe
import com.nickbolles.jarvis.data.ContextSource
import com.nickbolles.jarvis.data.DevicesResponse
import com.nickbolles.jarvis.data.ControlView
import com.nickbolles.jarvis.data.ControlsResponse
import com.nickbolles.jarvis.data.HomePayload
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.NextAction
import com.nickbolles.jarvis.data.SourceResult
import com.nickbolles.jarvis.ui.components.ActionCard
import com.nickbolles.jarvis.ui.components.ActionHandlers
import com.nickbolles.jarvis.ui.nav.LocalAccess
import com.nickbolles.jarvis.ui.nav.Routes
import com.nickbolles.jarvis.ui.screens.MoreScreen
import com.nickbolles.jarvis.ui.screens.Composer
import com.nickbolles.jarvis.ui.screens.ControlsContent
import com.nickbolles.jarvis.ui.screens.PairContent
import com.nickbolles.jarvis.ui.screens.PairLink
import com.nickbolles.jarvis.ui.theme.JarvisTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// Tall screen so whole screens are composed (lazy lists) and tappable.
@Config(sdk = [36], application = TestApp::class, qualifiers = "w411dp-h1800dp")
class InteractionTest {
    @get:Rule val compose = createComposeRule()

    private val todo = Fixtures.load("home", HomePayload.serializer()).let { h -> (h.now + h.later.laterToday + h.later.upcoming).first { "complete" in it.secondaryActions } }

    @Test fun actionCardMenuCompletesAndAsks() {
        val acted = mutableListOf<Pair<String, String>>()
        val asked = mutableListOf<NextAction>()
        compose.setContent { JarvisTheme(dynamicColor = false) { ActionCard(todo, ActionHandlers(onAct = { a, k -> acted += a.id to k }, onAsk = { asked += it })) } }
        compose.onNodeWithContentDescription("More actions for ${todo.title}").performClick()
        compose.onNodeWithText("Mark done").performClick()
        assertEquals(listOf(todo.id to "complete"), acted)
        compose.onNodeWithContentDescription("More actions for ${todo.title}").performClick()
        compose.onNodeWithText("Ask Hermes about this").performClick()
        assertEquals(todo.id, asked.single().id)
    }

    @Test fun controlsAskBeforeActing() {
        val executed = mutableListOf<Pair<ControlView, String>>()
        val controls = Fixtures.load("controls", ControlsResponse.serializer())
        compose.setContent {
            JarvisTheme(dynamicColor = false) {
                ControlsContent(Loadable(Fixtures.load("source-home-assistant", SourceResult.serializer())), Loadable(controls), null, null, {}, { c, s -> executed += c to s })
            }
        }
        val garage = controls.controls.first { it.services.any { s -> s.wouldChange } }
        val service = garage.services.first { it.wouldChange }
        val button = hasText(service.label) and isEnabled() and hasClickAction()
        compose.onNode(button).performClick()
        assertTrue("nothing runs until confirmed", executed.isEmpty())
        compose.onNodeWithText("Cancel").performClick()
        assertTrue(executed.isEmpty())
        compose.onNode(button).performClick()
        compose.onNodeWithText("Yes, ${service.label.lowercase()}").performClick()
        assertEquals(garage.entityId to service.service, executed.single().first.entityId to executed.single().second)
    }

    @Test fun composerAttachesChosenSources() {
        var sent: Triple<String, Set<ContextSource>, String?>? = null
        compose.setContent { JarvisTheme(dynamicColor = false) { Composer(enabled = true, busyLabel = null, onSend = { t, s, a -> sent = Triple(t, s, a) }, attached = "Garage door [home_assistant:cover.garage_door]", attachedLabel = "Garage door") } }
        compose.onNodeWithText("Skylight").performClick()
        compose.onNodeWithText("Home").performClick()
        compose.onNodeWithText("Ask about Skylight, Home").performTextInput("Can I leave the garage open during soccer?")
        compose.onNodeWithContentDescription("Send").performClick()
        assertEquals("Can I leave the garage open during soccer?", sent!!.first)
        assertEquals(setOf(ContextSource.Skylight, ContextSource.HomeAssistant), sent!!.second)
        assertEquals("Garage door [home_assistant:cover.garage_door]", sent!!.third)
    }

    @Test fun pairNeedsServerAndCode() {
        var server by mutableStateOf("")
        var code by mutableStateOf("")
        compose.setContent { JarvisTheme(dynamicColor = false) { PairContent(server, code, false, null, null, { server = it }, { code = it }, {}, {}) } }
        compose.onNodeWithText("Connect").assertIsNotEnabled()
        compose.onNodeWithText("Server address").performTextInput("jarvis.example.com")
        compose.onNodeWithText("Pairing code").performTextInput("ABCD-EF23")
        compose.onNodeWithText("Connect").assertIsEnabled()
    }

    @Test fun pairingLinksAndDeepLinksParse() {
        val link = PairLink.parse("jarvis://pair?server=https%3A%2F%2Fjarvis.example.com&code=ABCD-EF23")!!
        assertEquals("https://jarvis.example.com", link.server)
        assertEquals("ABCD-EF23", link.code)
        assertNull(PairLink.parse("https://evil.example.com/pair?server=x&code=y"))
        assertEquals("chat/sess_1?run=run_2", Routes.fromPath("/chat/sess_1?run=run_2"))
        assertEquals("home-control?entity=cover.garage_door", Routes.fromPath("/home-control?entity=cover.garage_door"))
        assertEquals(Routes.ALERTS, Routes.fromPath("jarvis://open/alerts"))
        assertNull(Routes.fromPath("/settings/connections/hermes").takeIf { it != Routes.SETTINGS })
    }

    private val owner = Fixtures.load("auth-me", AuthMe.serializer())
    private val kid = owner.copy(user = owner.user.copy(role = "kid"), capabilities = listOf("todos.view", "skylight.view", "home_assistant.calendar"))

    @Test fun moreShowsOnlyWhatThisPersonCanUse() {
        var who by mutableStateOf(owner)
        compose.setContent { JarvisTheme(dynamicColor = false) { CompositionLocalProvider(LocalAccess provides who) { MoreScreen() } } }
        compose.onNodeWithText("Finance").assertExists()
        who = kid
        compose.onNodeWithText("Finance").assertDoesNotExist()
        compose.onNodeWithText("Daily Compass").assertDoesNotExist()
        compose.onNodeWithText("Todos").assertExists()
    }

    @Test fun lightsSwitchOnlyWithLightControl() {
        val devices = Fixtures.load("ha-devices", DevicesResponse.serializer())
        val light = devices.lights.first { it.state == "off" && it.services.isNotEmpty() }
        val switched = mutableListOf<Pair<String, Boolean>>()
        var who by mutableStateOf(owner)
        compose.setContent {
            JarvisTheme(dynamicColor = false) {
                CompositionLocalProvider(LocalAccess provides who) {
                    ControlsContent(
                        Loadable(Fixtures.load("source-home-assistant", SourceResult.serializer())),
                        Loadable(Fixtures.load("controls", ControlsResponse.serializer())),
                        pending = null, focusEntity = null, onRefresh = {}, onExecute = { _, _ -> },
                        devices = Loadable(devices),
                        onLight = { d, on -> switched += d.entityId to on },
                    )
                }
            }
        }
        compose.onNodeWithContentDescription("${light.name} light").performClick()
        assertEquals(listOf(light.entityId to true), switched)
        who = owner.copy(capabilities = owner.capabilities - "home_assistant.control_lights")
        compose.onNodeWithContentDescription("${light.name} light").assertIsNotEnabled()
    }
}
