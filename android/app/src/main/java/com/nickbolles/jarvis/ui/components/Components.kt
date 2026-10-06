package com.nickbolles.jarvis.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Explore
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Snooze
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nickbolles.jarvis.data.NextAction
import com.nickbolles.jarvis.ui.theme.LocalJarvisDensity
import com.nickbolles.jarvis.ui.theme.LocalStatusColors
import com.nickbolles.jarvis.ui.theme.SectionLabel

fun sourceIcon(source: String): ImageVector = when (source) {
    "hermes" -> Icons.Outlined.AutoAwesome
    "todos" -> Icons.Outlined.CheckCircle
    "skylight" -> Icons.Outlined.CalendarMonth
    "daily_compass" -> Icons.Outlined.Explore
    "home_assistant" -> Icons.Outlined.Home
    "paperclip" -> Icons.Outlined.Flag
    else -> Icons.Outlined.Notifications
}

@Composable
fun SourceAvatar(source: String, modifier: Modifier = Modifier, critical: Boolean = false) {
    val bg = if (critical) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer
    val fg = if (critical) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onPrimaryContainer
    Box(modifier.size(36.dp).clip(CircleShape).background(bg), contentAlignment = Alignment.Center) {
        Icon(sourceIcon(source), contentDescription = null, tint = fg, modifier = Modifier.size(20.dp))
    }
}

@Composable
fun SectionHeader(title: String, modifier: Modifier = Modifier, trailing: @Composable (() -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(top = 20.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            title.uppercase(),
            style = SectionLabel,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        trailing?.invoke()
    }
}

@Composable
fun EmptyState(title: String, body: String? = null, modifier: Modifier = Modifier, action: @Composable (() -> Unit)? = null) {
    Surface(modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            body?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            action?.let { Spacer(Modifier.size(4.dp)); it() }
        }
    }
}

/** Honest status line: errors and offline never look like "nothing to do". */
@Composable
fun StatusBanner(text: String, modifier: Modifier = Modifier, tone: String = "warn", onRetry: (() -> Unit)? = null) {
    val status = LocalStatusColors.current
    val (bg, fg) = when (tone) {
        "danger" -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        "ok" -> status.okContainer to status.ok
        else -> status.warnContainer to status.warn
    }
    Surface(modifier.fillMaxWidth(), color = bg, shape = MaterialTheme.shapes.medium) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (tone == "danger") Icons.Outlined.WarningAmber else Icons.Outlined.CloudOff, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Text(text, color = fg, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            onRetry?.let {
                Text("Retry", color = fg, style = MaterialTheme.typography.labelLarge, modifier = Modifier.clickable(onClick = it).padding(8.dp))
            }
        }
    }
}

@Composable
fun Pill(text: String, modifier: Modifier = Modifier, tone: String = "neutral") {
    val status = LocalStatusColors.current
    val (bg, fg) = when (tone) {
        "danger" -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
        "warn" -> status.warnContainer to status.warn
        "ok" -> status.okContainer to status.ok
        "accent" -> MaterialTheme.colorScheme.primaryContainer to MaterialTheme.colorScheme.onPrimaryContainer
        else -> MaterialTheme.colorScheme.surfaceContainerHigh to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = fg,
        modifier = modifier.clip(CircleShape).background(bg).padding(horizontal = 10.dp, vertical = 3.dp),
    )
}

fun priorityTone(reason: String) = when (reason) {
    "critical", "overdue" -> "danger"
    "awaiting_user", "due_soon", "checkin_window" -> "warn"
    "today" -> "accent"
    else -> "neutral"
}

/** Everything an action card can do; the screen decides how (and confirms the result). */
data class ActionHandlers(
    val onPrimary: (NextAction) -> Unit = {},
    val onAct: (NextAction, String) -> Unit = { _, _ -> },
    val onAsk: (NextAction) -> Unit = {},
    val onOpen: (NextAction) -> Unit = {},
)

/**
 * A next action. Swipe right to complete (or acknowledge), left to snooze;
 * the same actions are in the ⋮ menu and exposed to TalkBack as custom actions.
 */
@Composable
fun ActionCard(action: NextAction, handlers: ActionHandlers, modifier: Modifier = Modifier, busy: Boolean = false) {
    val clock = LocalClock.current
    val zone = LocalZone.current
    val density = LocalJarvisDensity.current
    val canComplete = "complete" in action.secondaryActions || action.primaryAction?.kind == "complete"
    val canSnooze = "snooze" in action.secondaryActions || action.primaryAction?.kind == "snooze"
    val canAck = "acknowledge" in action.secondaryActions || action.primaryAction?.kind == "acknowledge"
    val swipeRight = if (canComplete) "complete" else if (canAck) "acknowledge" else null
    val swipeLeft = if (canSnooze) "snooze" else null

    val state = rememberSwipeToDismissBoxState()
    LaunchedEffect(state.currentValue) {
        when (state.currentValue) {
            SwipeToDismissBoxValue.StartToEnd -> swipeRight?.let { handlers.onAct(action, it) }
            SwipeToDismissBoxValue.EndToStart -> swipeLeft?.let { handlers.onAct(action, it) }
            else -> Unit
        }
        if (state.currentValue != SwipeToDismissBoxValue.Settled) state.reset()
    }

    var menu by remember { mutableStateOf(false) }
    val due = formatDue(action.dueAt, action.dueIsDate, clock.now(), zone)
    val critical = action.priorityReason == "critical"
    val labels = mapOf("complete" to "Mark done", "snooze" to "Snooze until tomorrow", "acknowledge" to "Acknowledge")

    SwipeToDismissBox(
        state = state,
        modifier = modifier.semantics {
            customActions = listOfNotNull(
                swipeRight?.let { k -> CustomAccessibilityAction(labels[k]!!) { handlers.onAct(action, k); true } },
                swipeLeft?.let { k -> CustomAccessibilityAction(labels[k]!!) { handlers.onAct(action, k); true } },
                CustomAccessibilityAction("Ask Hermes about this") { handlers.onAsk(action); true },
            )
        },
        enableDismissFromStartToEnd = swipeRight != null && !busy,
        enableDismissFromEndToStart = swipeLeft != null && !busy,
        backgroundContent = {
            val dir = state.dismissDirection
            val status = LocalStatusColors.current
            val color by animateColorAsState(
                when (dir) {
                    SwipeToDismissBoxValue.StartToEnd -> status.okContainer
                    SwipeToDismissBoxValue.EndToStart -> MaterialTheme.colorScheme.primaryContainer
                    else -> Color.Transparent
                },
                label = "swipe",
            )
            Box(Modifier.fillMaxSize().clip(MaterialTheme.shapes.large).background(color).padding(horizontal = 24.dp), contentAlignment = if (dir == SwipeToDismissBoxValue.EndToStart) Alignment.CenterEnd else Alignment.CenterStart) {
                when (dir) {
                    SwipeToDismissBoxValue.StartToEnd -> Icon(if (swipeRight == "complete") Icons.Outlined.CheckCircle else Icons.Outlined.Visibility, contentDescription = null, tint = status.ok)
                    SwipeToDismissBoxValue.EndToStart -> Icon(Icons.Outlined.Snooze, contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
                    else -> Unit
                }
            }
        },
    ) {
        Surface(
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surfaceContainer,
            tonalElevation = 0.dp,
            modifier = Modifier.fillMaxWidth().clickable { handlers.onOpen(action) },
        ) {
            Row(Modifier.padding(density.cardPadding.dp), verticalAlignment = Alignment.Top) {
                SourceAvatar(action.source, critical = critical)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Pill(PRIORITY_LABELS[action.priorityReason] ?: action.priorityReason, tone = priorityTone(action.priorityReason))
                        if (action.pinned) Icon(Icons.Outlined.PushPin, contentDescription = "Pinned", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
                    }
                    Text(action.title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    val meta = listOfNotNull(action.detail, due).joinToString(" · ")
                    if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    action.primaryAction?.let { p ->
                        Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilledTonalButton(onClick = { handlers.onPrimary(action) }, enabled = !busy) { Text(if (busy) "Working…" else p.label) }
                            if (canComplete && p.kind != "complete") OutlinedButton(onClick = { handlers.onAct(action, "complete") }, enabled = !busy) { Text("Done") }
                        }
                    }
                }
                Box {
                    IconButton(onClick = { menu = true }, modifier = Modifier.semantics { contentDescription = "More actions for ${action.title}" }) {
                        Icon(Icons.Outlined.MoreVert, contentDescription = null)
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        if (canComplete) DropdownMenuItem(text = { Text("Mark done") }, onClick = { menu = false; handlers.onAct(action, "complete") })
                        if (canSnooze) DropdownMenuItem(text = { Text("Snooze until tomorrow") }, onClick = { menu = false; handlers.onAct(action, "snooze") })
                        if (canAck) DropdownMenuItem(text = { Text("Acknowledge") }, onClick = { menu = false; handlers.onAct(action, "acknowledge") })
                        DropdownMenuItem(text = { Text(if (action.pinned) "Unpin" else "Pin to top") }, onClick = { menu = false; handlers.onAct(action, if (action.pinned) "unpin" else "pin") })
                        DropdownMenuItem(text = { Text("Ask Hermes about this") }, onClick = { menu = false; handlers.onAsk(action) })
                        DropdownMenuItem(text = { Text(if (action.external) "Open in source" else "Open") }, onClick = { menu = false; handlers.onOpen(action) })
                    }
                }
            }
        }
    }
}
