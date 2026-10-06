package com.nickbolles.jarvis

import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.ContextSource
import com.nickbolles.jarvis.data.JarvisApi
import com.nickbolles.jarvis.data.RunEvent
import com.nickbolles.jarvis.data.RunStream
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * End to end against a real Jarvis server (scripts/android-live-check.sh starts
 * one with the mock upstreams and mints a pairing code). Skipped otherwise.
 *
 *   JARVIS_LIVE_URL=http://127.0.0.1:3200 JARVIS_LIVE_CODE=ABCD-EF23 ./gradlew testDebugUnitTest --tests '*LiveServerTest'
 */
class LiveServerTest {
    private val url = System.getenv("JARVIS_LIVE_URL")
    private val code = System.getenv("JARVIS_LIVE_CODE")

    @Test fun pairAskActAndSignOut() = runBlocking {
        assumeTrue("set JARVIS_LIVE_URL and JARVIS_LIVE_CODE to run", url != null && code != null)
        val paired = JarvisApi(url, null).pair(code, "Live test phone", "test")
        val api = JarvisApi(url, paired.token)

        assertEquals("Live test phone", api.me().device?.name)
        val home = api.home(cached = false)
        assertTrue("home has actions", home.now.isNotEmpty() || home.later.laterToday.isNotEmpty())
        assertTrue(api.widgetSummary().next.isNotEmpty())

        // Ask about Skylight and the house: the server attaches fresh snapshots.
        assertTrue(api.context("skylight").text.startsWith("Skylight"))
        val session = api.createSession("Live: garage and soccer")
        val run = api.startRun(session.id, "Is the garage open, and what's on the calendar? search", JarvisApi.newIdempotencyKey(), listOf(ContextSource.HomeAssistant, ContextSource.Skylight))
        val events = withTimeout(30_000) { RunStream(api).events(run.runId).toList() }
        assertTrue("streamed text: $events", events.any { it is RunEvent.TextDelta })
        assertEquals("completed", (events.last() as RunEvent.Terminal).status)
        val user = api.session(session.id).timeline.first { it.kind == "user" }.text!!
        assertTrue("context attached: ${user.take(600)}", user.contains("Home Assistant — as of") && user.contains("Skylight — as of"))

        // Act: complete a todo, close the garage (readback), handle an alert.
        val todo = (home.now + home.later.laterToday + home.later.upcoming).first { "complete" in it.secondaryActions }
        assertTrue(api.act(todo.id, "complete").ok)
        val garage = api.controls().controls.first { c -> c.services.any { it.service == "close_cover" && it.wouldChange } }
        val result = api.control(garage, "close_cover")
        assertTrue("confirmed by readback: ${result.message}", result.verified)
        api.notifications().notifications.firstOrNull()?.let { assertTrue(api.transition(it.id, "acted").ok) }

        // Sign out: the token stops working.
        api.signOut(paired.deviceId)
        try {
            api.unread()
            throw AssertionError("token still works after sign-out")
        } catch (e: ApiException) {
            assertEquals(401, e.status)
        }
    }
}
