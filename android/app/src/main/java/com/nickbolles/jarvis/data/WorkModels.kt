package com.nickbolles.jarvis.data

import kotlinx.serialization.Serializable

/*
 * Areas (the /api/work routes): the same tree the web shows. Areas and projects
 * organise work; threads, investigations and notes are the work itself;
 * conversation nodes point at a Hermes/Claude session.
 */

@Serializable
data class WorkItem(
    val id: String,
    val parentId: String? = null,
    val kind: String = "thread",
    val title: String = "",
    val summary: String = "",
    val nextAction: String = "",
    val status: String = "captured",
    val sortOrder: Double = 0.0,
    val startDate: String? = null,
    val targetDate: String? = null,
    val completedAt: String? = null,
    val archived: Boolean = false,
    val builtIn: Boolean = false,
    val sessionId: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
) {
    /** Containers (areas, projects, anything at the top) get an overview page; the rest is work. */
    val isContainer get() = parentId == null || kind == "area" || kind == "project"
    val isConversation get() = kind == "conversation"
    val isClosed get() = status in WorkLabels.CLOSED
}

@Serializable
data class LinkedConversationRow(val itemId: String, val sessionId: String, val title: String = "")

@Serializable
data class WorkItemsResponse(val items: List<WorkItem> = emptyList(), val linkedConversations: List<LinkedConversationRow> = emptyList())

@Serializable
data class WorkItemEnvelope(val item: WorkItem)

@Serializable
data class WorkPathResult(val item: WorkItem, val created: Int = 0)

object WorkLabels {
    val CLOSED = setOf("settled", "superseded", "abandoned")

    /** Kinds a person creates (conversation nodes come from filing a chat). */
    val CREATABLE = listOf("area", "project", "thread", "investigation", "note")

    val KIND = mapOf(
        "area" to "Area",
        "project" to "Project",
        "thread" to "Thread",
        "investigation" to "Investigation",
        "note" to "Note",
        "conversation" to "Conversation",
    )

    val STATUS = linkedMapOf(
        "captured" to "Captured",
        "exploring" to "Exploring",
        "ready" to "Ready",
        "in_progress" to "In progress",
        "in_review" to "In review",
        "awaiting_validation" to "Awaiting validation",
        "ready_to_settle" to "Ready to settle",
        "settled" to "Settled",
        "reopened" to "Reopened",
        "on_hold" to "On hold",
        "superseded" to "Superseded",
        "abandoned" to "Abandoned",
    )

    /** Statuses a person sets directly from the phone; settle/validation flows stay on the server's rules. */
    val SETTABLE = listOf("captured", "exploring", "ready", "in_progress", "on_hold", "abandoned")

    fun kind(k: String) = KIND[k] ?: k.replaceFirstChar { it.uppercase() }
    fun status(s: String) = STATUS[s] ?: s.replace('_', ' ')

    fun statusTone(s: String) = when (s) {
        "in_progress", "in_review" -> "accent"
        "awaiting_validation", "ready_to_settle", "on_hold" -> "warn"
        "settled" -> "ok"
        else -> "neutral"
    }
}
