package com.nickbolles.jarvis

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nickbolles.jarvis.data.*
import com.nickbolles.jarvis.ui.components.ActionHandlers
import com.nickbolles.jarvis.ui.nav.*
import com.nickbolles.jarvis.ui.screens.HomeContent
import com.nickbolles.jarvis.ui.theme.JarvisTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Semantic gates for Home's opt-in planning, feedback and server-owned counts. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], application = TestApp::class, qualifiers = "w411dp-h1800dp")
class HomePriorityTest {
    @get:Rule val compose = createComposeRule()
    private val owner = Fixtures.load("auth-me", AuthMe.serializer())
    private val card = AssistCard(
        id = "assist:plan:test", kind = "plan_ahead", category = "assist:plan_ahead",
        title = "Birthday in two weeks", body = "Want to make a plan?",
        basis = "From a date you saved in Home priorities", origin = "milestone",
        chat = AssistChat("Brainstorm ideas", "Read-only: help me plan, do not buy anything.", "Saved date: birthday."),
    )
    private val home = HomePayload(
        generatedAt = "2026-10-10T17:00:00Z",
        attention = AttentionSummary(totals = AttentionTotals(open = 12, upcoming = 4, backlog = 8)),
        assists = listOf(card),
    )
    private val layout = Layout(homeSections = listOf(HomeSection("now")))

    @Test fun suggestionsRemainVisibleWithNowHidden() {
        compose.setContent {
            JarvisTheme(dynamicColor = false) {
                HomeContent(Loadable(home), Layout(homeSections = listOf(HomeSection("now", visible = false))), emptySet(), ActionHandlers(), {})
            }
        }
        compose.onNodeWithText("Now").assertDoesNotExist()
        compose.onNodeWithText("Suggestions").assertExists()
        compose.onNodeWithText(card.title).assertExists()
    }

    @Test fun pendingFeedbackDisablesBothControls() {
        val feedback = mutableListOf<String>()
        compose.setContent {
            JarvisTheme(dynamicColor = false) {
                HomeContent(Loadable(home), layout, emptySet(), ActionHandlers(), {},
                    onAssistFeedback = { _, v -> feedback += v }, feedbackBusy = setOf(card.id))
            }
        }
        compose.onNodeWithText("Not now").assertIsNotEnabled().performClick()
        compose.onNodeWithText("Less like this").assertIsNotEnabled().performClick()
        assertTrue(feedback.isEmpty())
    }

    @Test fun planningOnlyOpensADraftAndFeedbackHasExplicitTargets() {
        val captures = mutableListOf<CaptureRequest>()
        val feedback = mutableListOf<Pair<String, String>>()
        val actions = object : AppActions {
            override fun navigate(route: String) = Unit
            override fun back() = Unit
            override fun capture(request: CaptureRequest) { captures += request }
            override fun message(text: String) = Unit
            override fun open(href: String) = Unit
        }
        compose.setContent {
            JarvisTheme(dynamicColor = false) {
                CompositionLocalProvider(LocalAccess provides owner, LocalAppActions provides actions) {
                    HomeContent(Loadable(home), layout, emptySet(), ActionHandlers(), {}, onAssistFeedback = { c, v -> feedback += c.id to v })
                }
            }
        }
        assertTrue(captures.isEmpty())
        assertTrue(feedback.isEmpty())
        compose.onNodeWithText("Brainstorm ideas").performClick()
        assertEquals(card.chat!!.draft, captures.single().text)
        assertEquals(card.chat!!.context, captures.single().attached)
        assertTrue(feedback.isEmpty())
        compose.onNodeWithText("Not now").performClick()
        compose.onNodeWithText("Less like this").performClick()
        assertEquals(listOf(card.id to "not_now", card.id to "less_like_this"), feedback)
        compose.onNodeWithText("Backlog · 8").assertExists()
    }

    @Test fun noChatCapabilityHidesPlanningEvenForACachedCard() {
        compose.setContent {
            JarvisTheme(dynamicColor = false) {
                CompositionLocalProvider(LocalAccess provides owner.copy(capabilities = emptyList())) {
                    HomeContent(Loadable(home), layout, emptySet(), ActionHandlers(), {})
                }
            }
        }
        compose.onNodeWithText("Brainstorm ideas").assertDoesNotExist()
        compose.onNodeWithText("Birthday in two weeks").assertExists()
    }

    @Test fun homePriorityContractCountsAllOpenItems() {
        val recorded = Fixtures.load("home", HomePayload.serializer())
        val attention = requireNotNull(recorded.attention)
        val t = attention.totals
        assertEquals(t.open, t.now + t.today + t.upcoming + t.backlog)
        assertTrue(recorded.now.all { it.rank != null && it.why.isNotEmpty() })
        assertTrue(recorded.later.upcoming.size <= attention.budget.upcoming)
    }

    @Test fun suggestion_mobile() = compose.snapshot("home_suggestion") {
        CompositionLocalProvider(LocalAccess provides owner) {
            HomeContent(Loadable(home), layout, emptySet(), ActionHandlers(), {})
        }
    }
}
