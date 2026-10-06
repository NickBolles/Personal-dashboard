package com.nickbolles.jarvis

import com.nickbolles.jarvis.data.RunEvent
import com.nickbolles.jarvis.data.SseParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SseTest {
    @Test fun parsesTheServerRelayStream() {
        val parser = SseParser()
        // Feed in awkward chunks, like a slow network.
        val events = Fixtures.text("run-events.sse").chunked(37).flatMap { parser.feed(it) }.mapNotNull { RunEvent.parse(it.data) }
        assertTrue(events.first() is RunEvent.ToolStarted)
        assertTrue(events.any { it is RunEvent.ToolCompleted })
        val text = events.filterIsInstance<RunEvent.TextDelta>().joinToString("") { it.delta }
        assertTrue(text.startsWith("Got it"))
        val last = events.last()
        assertTrue(last is RunEvent.Terminal)
        assertEquals("completed", (last as RunEvent.Terminal).status)
        assertEquals(last.seq?.toString(), parser.lastEventId)
    }

    @Test fun ignoresCommentsAndUnknownEvents() {
        val p = SseParser()
        val out = p.feed(": keepalive\n\nid: 7\ndata: {\"type\":\"something.new\",\"seq\":7}\n\n")
        assertEquals(1, out.size)
        val ev = RunEvent.parse(out[0].data)
        assertTrue(ev is RunEvent.Other)
        assertEquals("7", p.lastEventId)
    }
}
