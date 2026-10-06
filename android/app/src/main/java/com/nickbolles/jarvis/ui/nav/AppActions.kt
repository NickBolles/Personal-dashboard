package com.nickbolles.jarvis.ui.nav

import androidx.compose.runtime.staticCompositionLocalOf
import com.nickbolles.jarvis.data.ContextSource

/** What the user wants to ask Hermes about when the capture sheet opens. */
data class CaptureRequest(
    val text: String = "",
    val sources: Set<ContextSource> = emptySet(),
    /** free-form context, e.g. a specific action card: "Renew car registration — DMV online [todos:gt-1]" */
    val attached: String? = null,
    val attachedLabel: String? = null,
)

/** App-wide UI actions available to every screen without threading callbacks everywhere. */
interface AppActions {
    fun navigate(route: String)
    fun back()
    fun capture(request: CaptureRequest = CaptureRequest())
    fun message(text: String)
    /** Server path (/chat/x) opens in-app; http(s) opens the browser. */
    fun open(href: String)
}

val LocalAppActions = staticCompositionLocalOf<AppActions> {
    object : AppActions {
        override fun navigate(route: String) = Unit
        override fun back() = Unit
        override fun capture(request: CaptureRequest) = Unit
        override fun message(text: String) = Unit
        override fun open(href: String) = Unit
    }
}
