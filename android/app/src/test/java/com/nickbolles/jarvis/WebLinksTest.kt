package com.nickbolles.jarvis

import com.nickbolles.jarvis.web.WebLinks
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The native link → web URL table (wrapper plan §4.3). Every widget, tile, shortcut and push path. */
class WebLinksTest {
    private val o = "https://jarvis.nickbolles.com"

    private fun url(raw: String?) = WebLinks.launchUrl(raw, o)

    @Test fun samePathPagesKeepPathAndQuery() {
        for (p in listOf("/home", "/alerts", "/skylight", "/daily-compass", "/todos", "/finance", "/settings", "/more", "/chat")) {
            assertEquals(p, WebLinks.webPath("jarvis://open$p"))
        }
        assertEquals("/chat/abc?run=r1", WebLinks.webPath("/chat/abc?run=r1"))
        assertEquals("/finance/accounts", WebLinks.webPath("jarvis://open/finance/accounts"))
        assertEquals("/settings/phones", WebLinks.webPath("/settings/phones"))
        assertEquals("/home-control?entity=lock.front", WebLinks.webPath("jarvis://open/home-control?entity=lock.front"))
        assertEquals("/home-control", WebLinks.webPath("jarvis://open/home-control"))
    }

    @Test fun areasItemsBecomeQueryParams() {
        assertEquals("/areas?item=abc", WebLinks.webPath("jarvis://open/areas/abc"))
        assertEquals("/areas?item=abc", WebLinks.webPath("jarvis://areas/abc"))
        assertEquals("/areas?item=a%26b%20c", WebLinks.webPath("/areas/a%26b%20c"))
        assertEquals("/areas", WebLinks.webPath("jarvis://open/areas"))
        assertEquals("/areas?view=inbox", WebLinks.webPath("/areas/inbox"))
        assertEquals("/areas", WebLinks.webPath("/areas/today"))
        assertEquals("/areas?item=xyz", WebLinks.webPath("/work/xyz"))
        // Server deep links are already web paths.
        assertEquals("/areas?view=inbox&entry=e1", WebLinks.webPath("/areas?view=inbox&entry=e1"))
        assertEquals("/areas?item=i1&do=packet", WebLinks.webPath("/areas?item=i1&do=packet"))
    }

    @Test fun captureChipsTravelAsAttach() {
        assertEquals("/capture", WebLinks.webPath("jarvis://open/capture"))
        assertEquals("/capture?attach=home_assistant", WebLinks.webPath("/capture?source=home_assistant"))
        assertEquals("/capture?attach=skylight", WebLinks.webPath("/capture?source=skylight"))
        assertEquals("$o/capture?attach=skylight&source=android", url("jarvis://open/capture?source=skylight"))
    }

    @Test fun searchOpensThePalette() {
        assertEquals("/home?search=1", WebLinks.webPath("jarvis://open/search"))
    }

    @Test fun unknownAndUnsafeGoHome() {
        assertEquals("/home", WebLinks.webPath(null))
        assertEquals("/home", WebLinks.webPath(""))
        assertEquals("/home", WebLinks.webPath("jarvis://open"))
        assertEquals("/home", WebLinks.webPath("/nope"))
        assertEquals("/home", WebLinks.webPath("/api/devices/me"))
        assertEquals("/home", WebLinks.webPath("/chat/../api/x"))
        assertEquals("/home", WebLinks.webPath("/chat/%2E%2E/api"))
        assertEquals("/home", WebLinks.webPath("jarvis://pair?server=x&code=y"))
    }

    @Test fun everyUrlCarriesTheAppMarkerOnce() {
        assertEquals("$o/home?source=android", url(null))
        assertEquals("$o/alerts?source=android", url("jarvis://open/alerts"))
        assertEquals("$o/areas?item=abc&source=android", url("jarvis://areas/abc"))
        assertEquals("$o/chat/abc?run=r1&source=android", url("/chat/abc?run=r1"))
        assertEquals("$o/home?source=android", url("/home?source=android"))
        assertEquals("$o/alerts?source=android", url("/alerts?source=pwa"))
        assertEquals("$o/chat/abc?source=android#m2", url("/chat/abc#m2"))
    }

    @Test fun httpsLinksOnlyOnTheAppOrigin() {
        assertEquals("$o/areas?item=q&source=android", url("https://jarvis.nickbolles.com/areas?item=q"))
        // Site links are real web URLs: path and query stay as they are.
        assertEquals("$o/areas/map?source=android", url("https://JARVIS.nickbolles.com/areas/map"))
        assertEquals("$o/areas/timeline?source=android", url("https://jarvis.nickbolles.com/areas/timeline"))
        assertEquals("$o/join?code=AB12&source=android", url("https://jarvis.nickbolles.com/join?code=AB12"))
        assertEquals("$o/chat/abc?source=android#m2", url("https://jarvis.nickbolles.com/chat/abc?source=pwa#m2"))
        assertEquals("$o/home?source=android", url("https://jarvis.nickbolles.com"))
        assertEquals("$o/home?source=android", url("https://jarvis.nickbolles.com/a/../../x"))
        assertEquals("$o/home?source=android", url("https://evil.example/areas?item=q"))
        assertEquals("$o/home?source=android", url("https://jarvis.nickbolles.com.evil.example/alerts"))
    }

    @Test fun originPrefersThePairedServer() {
        assertEquals("https://jarvis.example.com", WebLinks.origin("https://Jarvis.Example.com/some/path", o))
        assertEquals("http://jarvis.lan:3000", WebLinks.origin("http://jarvis.lan:3000/", o))
        assertEquals(o, WebLinks.origin(null, o))
        assertEquals(o, WebLinks.origin("ftp://x", o))
        assertEquals("https://jarvis.example.com/alerts?source=android", WebLinks.launchUrl("jarvis://open/alerts", "https://jarvis.example.com", o))
        // App Links for the build-time host still open there.
        assertEquals("$o/alerts?source=android", WebLinks.launchUrl("$o/alerts", "https://jarvis.example.com", o))
    }

    /** Contract: every page a widget, the tile, a shortcut or a push opens exists in the web app (app/(shell)). */
    @Test fun nativeTargetsExistOnTheWeb() {
        val contracts = System.getProperty("jarvis.contracts") ?: return
        val shell = File(File(contracts).parentFile.parentFile, "app/(shell)")
        assertTrue("web app not found at $shell", shell.isDirectory)
        val native = listOf(
            "/home", "/home-control", "/capture", "/capture?source=home_assistant", "/capture?source=skylight", "/daily-compass",
            "/skylight", "/areas", "/areas/abc", "/alerts", "jarvis://open/capture", "jarvis://open/alerts", "jarvis://open/home-control",
            "jarvis://open/areas", "jarvis://areas/abc", "/chat/abc?run=r1", "/search", "/todos", "/finance", "/settings", "/more",
        )
        for (raw in native) {
            val path = WebLinks.webPath(raw).substringBefore('?').substringBefore('#').trim('/')
            val dir = File(shell, path.substringBefore('/'))
            assertTrue("$raw → /$path has no page in app/(shell)", File(dir, "page.tsx").isFile)
        }
    }
}
