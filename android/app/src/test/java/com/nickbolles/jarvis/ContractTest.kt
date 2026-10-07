package com.nickbolles.jarvis

import com.nickbolles.jarvis.data.ActionResult
import com.nickbolles.jarvis.data.AssistantStatus
import com.nickbolles.jarvis.data.AuthMe
import com.nickbolles.jarvis.data.ContextPreview
import com.nickbolles.jarvis.data.ControlResult
import com.nickbolles.jarvis.data.ControlsResponse
import com.nickbolles.jarvis.data.DailyCompassResponse
import com.nickbolles.jarvis.data.DeviceMe
import com.nickbolles.jarvis.data.DevicesResponse
import com.nickbolles.jarvis.data.FinanceOverview
import com.nickbolles.jarvis.data.HomePayload
import com.nickbolles.jarvis.data.NotificationsResponse
import com.nickbolles.jarvis.data.OkResponse
import com.nickbolles.jarvis.data.PairResponse
import com.nickbolles.jarvis.data.Preferences
import com.nickbolles.jarvis.data.RunView
import com.nickbolles.jarvis.data.SearchResponse
import com.nickbolles.jarvis.data.SessionDetail
import com.nickbolles.jarvis.data.SessionSummary
import com.nickbolles.jarvis.data.SessionsResponse
import com.nickbolles.jarvis.data.SourceResult
import com.nickbolles.jarvis.data.UnreadCount
import com.nickbolles.jarvis.data.WidgetSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The app parses exactly what the server sends. Fixtures are recorded by
 * test/mobile.test.ts against the real route handlers; the server test fails
 * when a field these models rely on disappears.
 */
class ContractTest {
    @Test fun home() {
        val h = Fixtures.load("home", HomePayload.serializer())
        assertTrue(h.now.isNotEmpty())
        assertTrue(h.sources.any { it.source == "home_assistant" })
        h.now.forEach { assertTrue(it.id.startsWith(it.source + ":")) }
    }

    @Test fun widgetSummary() {
        val w = Fixtures.load("widget-summary", WidgetSummary.serializer())
        assertTrue(w.next.size in 1..5)
        assertNotNull(w.home)
    }

    @Test fun alerts() {
        val n = Fixtures.load("notifications", NotificationsResponse.serializer())
        assertTrue(n.notifications.isNotEmpty())
        assertEquals(n.notifications.size >= 0, true)
        Fixtures.load("notification-count", UnreadCount.serializer())
        assertTrue(Fixtures.load("notification-transition", OkResponse.serializer()).ok)
    }

    @Test fun chat() {
        val list = Fixtures.load("sessions", SessionsResponse.serializer())
        assertTrue(list.sessions.isNotEmpty())
        val detail = Fixtures.load("session", SessionDetail.serializer())
        assertTrue(detail.timeline.any { it.kind == "assistant" })
        assertTrue(detail.timeline.any { it.kind == "tool" })
        Fixtures.load("session-created", SessionSummary.serializer())
        val started = Fixtures.load("run-started", RunView.serializer())
        val done = Fixtures.load("run", RunView.serializer())
        assertEquals(started.runId, done.runId)
        assertEquals("completed", done.status)
    }

    @Test fun homeControl() {
        val c = Fixtures.load("controls", ControlsResponse.serializer())
        assertTrue(c.controls.all { it.stateToken.isNotBlank() && it.services.isNotEmpty() })
        val r = Fixtures.load("control-result", ControlResult.serializer())
        assertTrue(r.verified)
        val ha = Fixtures.load("source-home-assistant", SourceResult.serializer())
        assertNotNull("health counts parse", ha.data?.health)
    }

    @Test fun sources() {
        val sky = Fixtures.load("source-skylight", SourceResult.serializer())
        assertTrue(sky.data!!.events.isNotEmpty())
        Fixtures.load("source-todos", SourceResult.serializer())
        val compass = Fixtures.load("source-daily-compass", SourceResult.serializer())
        assertNotNull(compass.data?.compass)
        assertNotNull(Fixtures.load("daily-compass", DailyCompassResponse.serializer()).state)
    }

    @Test fun pairingAndSettings() {
        assertTrue(Fixtures.load("pair", PairResponse.serializer()).token.startsWith("jdv_"))
        val me = Fixtures.load("devices-me", DeviceMe.serializer())
        assertNotNull(me.push)
        val prefs = Fixtures.load("settings", Preferences.serializer())
        assertEquals(6, prefs.layout.homeSections.size)
        assertTrue(Fixtures.load("context", ContextPreview.serializer()).text.contains("Home Assistant"))
        assertTrue(Fixtures.load("action-result", ActionResult.serializer()).ok)
    }

    @Test fun peopleAndSearch() {
        val me = Fixtures.load("auth-me", AuthMe.serializer())
        assertTrue(me.can("finance.view"))
        assertTrue(me.can("home_assistant.control_lights"))
        assertFalse(me.can("not.a.capability"))
        val s = Fixtures.load("search", SearchResponse.serializer())
        assertTrue(s.results.isNotEmpty())
        assertTrue(s.results.all { it.href.startsWith("/") })
    }

    @Test fun finance() {
        val f = Fixtures.load("finance-overview", FinanceOverview.serializer())
        assertTrue(f.status in setOf("ready", "attention", "failed", "setup"))
        assertNotNull(f.totals)
        assertTrue("Monarch stays a release blocker until validated", f.setup.releaseBlocker)
    }

    @Test fun devicesAndAssistant() {
        val d = Fixtures.load("ha-devices", DevicesResponse.serializer())
        assertTrue(d.doors.isNotEmpty() && d.lights.isNotEmpty() && d.cameras.isNotEmpty())
        assertTrue(d.lights.all { it.entityId.startsWith("light.") })
        assertTrue(Fixtures.load("light-result", ControlResult.serializer()).verified)
        val a = Fixtures.load("assistant", AssistantStatus.serializer())
        assertTrue(a.available.any { it.id == a.defaultBackend })
    }
}
