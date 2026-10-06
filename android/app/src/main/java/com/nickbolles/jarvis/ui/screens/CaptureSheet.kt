package com.nickbolles.jarvis.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.nickbolles.jarvis.data.ApiException
import com.nickbolles.jarvis.data.AppGraph
import com.nickbolles.jarvis.data.ContextSource
import com.nickbolles.jarvis.data.JarvisApi
import com.nickbolles.jarvis.ui.nav.CaptureRequest
import com.nickbolles.jarvis.ui.nav.Routes
import com.nickbolles.jarvis.ui.components.StatusBanner
import kotlinx.coroutines.launch

/** Start a new Hermes conversation; the server attaches fresh snapshots of the chosen sources. */
suspend fun startConversation(graph: AppGraph, text: String, sources: Set<ContextSource>, attached: String?): Pair<String, String> {
    val title = text.trim().lineSequence().first().take(60)
    val session = graph.call { it.createSession(title) }
    val run = graph.call { it.startRun(session.id, text.trim(), JarvisApi.newIdempotencyKey("cap"), sources.toList(), attached) }
    graph.onDataChanged()
    return session.id to run.runId
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaptureSheet(graph: AppGraph, request: CaptureRequest, onDismiss: () -> Unit, onNavigate: (String) -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attached by remember { mutableStateOf(request.attached) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().padding(bottom = 8.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                if (request.sources.isNotEmpty()) "Ask about ${request.sources.joinToString(", ") { it.label }}" else "Ask Hermes",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            Text(
                "Tap a chip to attach what Jarvis knows right now (calendar, chores, home state…).",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp),
            )
            error?.let { StatusBanner(it, tone = "danger", modifier = Modifier.padding(horizontal = 16.dp)) }
            Composer(
                enabled = !sending,
                busyLabel = if (sending) "Starting…" else null,
                initialText = request.text,
                initialSources = request.sources,
                attached = attached,
                attachedLabel = request.attachedLabel,
                onClearAttached = { attached = null },
                clearOnSend = false,
                onSend = { text, sources, att ->
                    sending = true
                    error = null
                    scope.launch {
                        try {
                            val (session, run) = startConversation(graph, text, sources, att)
                            sheet.hide()
                            onDismiss()
                            onNavigate(Routes.conversation(session, run))
                        } catch (e: ApiException) {
                            error = e.message
                            sending = false
                        }
                    }
                },
            )
        }
    }
}
