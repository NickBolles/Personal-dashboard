package com.nickbolles.jarvis

import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.nickbolles.jarvis.data.JarvisJson
import com.nickbolles.jarvis.data.Loadable
import com.nickbolles.jarvis.data.WorkItemsResponse
import com.nickbolles.jarvis.data.WorkTree
import com.nickbolles.jarvis.ui.components.Markdown
import com.nickbolles.jarvis.ui.components.MdBlock
import com.nickbolles.jarvis.ui.nav.Routes
import com.nickbolles.jarvis.ui.screens.AreasContent
import com.nickbolles.jarvis.ui.screens.ItemContent
import com.nickbolles.jarvis.ui.theme.JarvisTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Areas tree logic, deep links, Markdown parsing and the Areas screens' main interactions. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [36], application = TestApp::class, qualifiers = "w411dp-h1800dp")
class AreasTest {
    @get:Rule val compose = createComposeRule()

    companion object {
        fun work(): WorkItemsResponse = JarvisJson.decodeFromString(WorkItemsResponse.serializer(), AreasTest::class.java.classLoader!!.getResource("work-items.json")!!.readText())
    }

    private val items = work().items

    @Test fun quickPathSplitsOnlyOnSpacedSlashes() {
        assertEquals(listOf("Home", "Garage", "Fix CI/CD"), WorkTree.parseQuickPath("Home / Garage /  Fix CI/CD "))
        assertEquals(listOf("one"), WorkTree.parseQuickPath("one"))
        assertEquals(6, WorkTree.parseQuickPath((1..9).joinToString(" / ")).size)
        assertTrue(WorkTree.parseQuickPath("  /  ").isEmpty())
    }

    @Test fun defaultChildKinds() {
        assertEquals("area", WorkTree.defaultChildKind(null))
        assertEquals("project", WorkTree.defaultChildKind(items.first { it.id == "a_home" }))
        assertEquals("thread", WorkTree.defaultChildKind(items.first { it.id == "p_garage" }))
    }

    @Test fun treeRowsRespectExpansionFilterAndDone() {
        val collapsed = WorkTree.rows(items, emptySet())
        assertEquals(listOf("a_home", "a_work", "a_misc"), collapsed.map { it.item.id })
        val open = WorkTree.rows(items, setOf("a_work", "p_v5"))
        assertTrue(open.any { it.item.id == "i_hydr" && it.depth == 2 })
        assertFalse("settled work is hidden by default", open.any { it.item.id == "t_done" })
        assertTrue(WorkTree.rows(items, setOf("a_work", "p_v5"), showClosed = true).any { it.item.id == "t_done" })
        // A filter shows matches with their ancestors, expanded.
        assertEquals(listOf("a_home", "p_garage", "t_door"), WorkTree.rows(items, emptySet(), filter = "spring").map { it.item.id })
    }

    @Test fun nextActionsPutInProgressFirst() {
        val next = WorkTree.nextActions(items)
        assertEquals("t_door", next.first().id)
        assertEquals(setOf("t_door", "t_ladder", "i_hydr", "t_ther"), next.map { it.id }.toSet())
        assertEquals(listOf("i_hydr"), WorkTree.nextActions(items, "a_work").map { it.id })
    }

    @Test fun moveTargetsExcludeSelfDescendantsAndCurrentParent() {
        val garage = items.first { it.id == "p_garage" }
        val targets = WorkTree.moveTargets(items, garage).map { it.id }
        assertFalse("p_garage" in targets)
        assertFalse("t_door" in targets)
        assertFalse("a_home" in targets)
        assertFalse("c_chat" in targets)
        assertTrue("a_work" in targets && "p_v5" in targets)
    }

    @Test fun rollupCountsWork() {
        val r = WorkTree.rollup(items, "a_work")
        assertEquals(1, r.open); assertEquals(1, r.proofDue); assertEquals(1, r.done); assertEquals(1, r.conversations)
        assertEquals("Home / Garage / Fix the garage door", WorkTree.path(items, "t_door"))
    }

    @Test fun deepLinksOpenAreas() {
        assertEquals(Routes.AREAS, Routes.fromPath("/areas"))
        assertEquals(Routes.item("abc"), Routes.fromPath("/areas?item=abc"))
        assertEquals(Routes.item("abc"), Routes.fromPath("/areas/abc"))
        assertEquals(Routes.item("abc"), Routes.fromPath("jarvis://areas/abc"))
        assertEquals(Routes.item("abc"), Routes.fromPath("jarvis://open/areas/abc"))
        assertEquals(Routes.AREAS, Routes.fromPath("/areas/dashboard"))
    }

    @Test fun markdownBlocks() {
        val b = Markdown.parse("Do this week (6):\n1. Return ladder: check\n2. **Therapists**\n\n- a\n  - nested\n- [x] done\n\n## Later\n```\ncode\n```\n> quote\n\n| A | B |\n|---|---|\n| 1 | 2 |")
        assertEquals(MdBlock.Paragraph("Do this week (6):"), b[0])
        assertEquals(MdBlock.ListItem("1.", "Return ladder: check", 0), b[1])
        assertEquals(MdBlock.ListItem("•", "nested", 1), b[4])
        assertEquals(MdBlock.ListItem("•", "done", 0, checked = true), b[5])
        assertEquals(MdBlock.Heading(2, "Later"), b[6])
        assertEquals(MdBlock.Code("code", null), b[7])
        assertEquals(MdBlock.Quote("quote"), b[8])
        assertEquals(MdBlock.Table(listOf("A", "B"), listOf(listOf("1", "2"))), b[9])
        val s = Markdown.inline("**bold** and *it* and `code` [link](https://x.y) snake_case_name")
        assertEquals("bold and it and code link snake_case_name", s.text)
        assertEquals(1, s.getLinkAnnotations(0, s.length).size)
    }

    @Test fun quickAddSendsPathAndTreeOpensItems() {
        val added = mutableListOf<String>()
        val opened = mutableListOf<String>()
        val toggled = mutableListOf<String>()
        compose.setContent {
            JarvisTheme(dynamicColor = false) {
                AreasContent(Loadable(work()), setOf("a_home"), false, { toggled += it }, { opened += it.id }, { t, done -> added += t; done() }, {}, {}, {})
            }
        }
        compose.onNode(hasSetTextAction()).performTextInput("Home / Garage / Paint trim")
        compose.onNodeWithText("Creates or reuses: Home › Garage › Paint trim").assertExists()
        compose.onNodeWithText("Add").performClick()
        assertEquals(listOf("Home / Garage / Paint trim"), added)
        compose.onNodeWithText("Garage").performClick()
        assertEquals(listOf("p_garage"), opened)
        compose.onNodeWithContentDescription("Expand Momentum bets").performClick()
        assertEquals(listOf("a_work"), toggled)
    }

    @Test fun workItemPageShowsNextActionAndChangesStatus() {
        val status = mutableListOf<String>()
        val chats = mutableListOf<String>()
        compose.setContent {
            JarvisTheme(dynamicColor = false) {
                ItemContent(Loadable(work()), "t_door", false, {}, {}, {}, { _, _, _ -> }, { _, s -> status += s }, {}, {}, { chats += it }, {})
            }
        }
        compose.onNodeWithText("Order the replacement torsion spring").assertExists()
        compose.onNode(hasText("In progress") and hasClickAction()).performClick()
        compose.onNodeWithText("On hold").performClick()
        assertEquals(listOf("on_hold"), status)
        compose.onNodeWithText("Garage door spring options").performClick()
        assertEquals(listOf("sess_9"), chats)
    }
}
