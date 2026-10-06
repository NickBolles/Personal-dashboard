package com.nickbolles.jarvis

import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.ContextSource
import com.nickbolles.jarvis.data.JarvisApi
import com.nickbolles.jarvis.data.RunEvent
import com.nickbolles.jarvis.data.RunStream
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Headers.Companion.headersOf
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class ApiTest {
    private val server = MockWebServer()

    @Before fun start() = server.start()

    @After fun stop() = server.close()

    private fun api(token: String? = "jdv_test") = JarvisApi(server.url("").toString().trimEnd('/'), token)

    private fun json(body: String, code: Int = 200) = MockResponse.Builder().code(code).headers(headersOf("content-type", "application/json")).body(body).build()

    @Test fun sendsTheDeviceTokenAndNoBrowserHeaders() = runBlocking {
        server.enqueue(json(Fixtures.text("home.json")))
        val home = api().home(cached = true)
        assertTrue(home.now.isNotEmpty())
        val req = server.takeRequest()
        assertEquals("Bearer jdv_test", req.headers["Authorization"])
        assertNull(req.headers["Cookie"])
        assertNull(req.headers["x-jarvis-csrf"])
        assertEquals("/api/home?cached=1", req.target)
    }

    @Test fun surfacesTheServersErrorMessage() = runBlocking {
        server.enqueue(json("""{"error":"That pairing code is wrong or expired.","code":"bad_pairing_code"}""", 400))
        try {
            api(null).pair("ZZZZ-ZZZZ", "Test", "1.0")
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(400, e.status)
            assertEquals("bad_pairing_code", e.code)
            assertEquals("That pairing code is wrong or expired.", e.message)
        }
    }

    @Test fun networkFailureIsReportedAsSuch() = runBlocking {
        val dead = JarvisApi("http://127.0.0.1:1", "x")
        try {
            dead.unread()
            fail("expected an error")
        } catch (e: ApiException) {
            assertTrue(e.isNetwork)
        }
    }

    @Test fun startRunSendsContextSources() = runBlocking {
        server.enqueue(json(Fixtures.text("run-started.json")))
        api().startRun("s1", "Is the garage open?", "key-1", listOf(ContextSource.HomeAssistant, ContextSource.Skylight))
        val body = server.takeRequest().body!!.utf8()
        assertTrue(body.contains("\"contextSources\":[\"home_assistant\",\"skylight\"]"))
    }

    @Test fun runStreamReconnectsAndReconcilesInsteadOfAssumingCompletion() = runBlocking {
        val sse = Fixtures.text("run-events.sse")
        // First connection dies after two events, without a terminal event.
        val firstTwo = sse.split("\n\n").filter { it.contains("data:") }.take(2).joinToString("\n\n") + "\n\n"
        server.enqueue(MockResponse.Builder().headers(headersOf("content-type", "text/event-stream")).body(firstTwo).build())
        // Status check: still running → reconnect with Last-Event-ID.
        server.enqueue(json("""{"runId":"r1","sessionId":"s1","status":"running"}"""))
        server.enqueue(MockResponse.Builder().headers(headersOf("content-type", "text/event-stream")).body(sse).build())

        val events = RunStream(api()).events("r1").toList()
        assertTrue(events.last() is RunEvent.Terminal)
        assertEquals(1, events.count { it is RunEvent.Terminal })
        server.takeRequest()
        server.takeRequest()
        val reconnect = server.takeRequest()
        assertEquals("1", reconnect.headers["Last-Event-ID"])
    }

    @Test fun normalizesServerAddresses() {
        assertEquals("https://jarvis.example.com", JarvisApi.normalizeServer(" jarvis.example.com/ "))
        assertEquals("http://192.168.1.10:3000", JarvisApi.normalizeServer("http://192.168.1.10:3000"))
    }
}
