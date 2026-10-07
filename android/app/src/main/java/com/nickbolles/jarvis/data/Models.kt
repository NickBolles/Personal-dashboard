package com.nickbolles.jarvis.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * Mirrors the server's normalized types (lib/contracts.ts, lib/hermes.ts).
 * Unknown fields are ignored and every optional field has a default, so a
 * newer server never breaks an older app. contracts/api (JSON fixtures) (recorded by
 * the server tests) is parsed by ContractTest to keep these in sync.
 */
val JarvisJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

@Serializable
data class PrimaryAction(val kind: String, val label: String)

@Serializable
data class NextAction(
    val id: String,
    val source: String,
    val sourceId: String = "",
    val title: String,
    val detail: String? = null,
    val status: String = "open",
    val priorityReason: String = "upcoming",
    val dueAt: String? = null,
    val dueIsDate: Boolean = false,
    val availableAt: String? = null,
    val updatedAt: String? = null,
    val fetchedAt: String? = null,
    val staleAfter: String? = null,
    val href: String = "",
    val external: Boolean = false,
    val pinned: Boolean = false,
    val primaryAction: PrimaryAction? = null,
    val secondaryActions: List<String> = emptyList(),
)

@Serializable
data class SourceStatus(
    val source: String,
    val label: String,
    val state: String,
    val fetchedAt: String? = null,
    val staleAfter: String? = null,
    val error: String? = null,
    val fromCache: Boolean = false,
)

@Serializable
data class CalendarEvent(
    val id: String = "",
    val title: String,
    val startsAt: String,
    val endsAt: String? = null,
    val allDay: Boolean = false,
    val location: String? = null,
    val calendar: String? = null,
    val source: String = "",
    val href: String? = null,
)

@Serializable
data class GlanceCompass(val date: String, val completed: Boolean, val inWindow: Boolean, val windowLabel: String = "")

@Serializable
data class HomeException(
    val entityId: String = "",
    val name: String,
    val state: String,
    val severity: String,
    val reason: String,
    val since: String? = null,
)

@Serializable
data class HouseholdGlance(
    val nextEvent: CalendarEvent? = null,
    val compass: GlanceCompass? = null,
    val homeExceptions: List<HomeException> = emptyList(),
)

@Serializable
data class LaterGroups(
    val laterToday: List<NextAction> = emptyList(),
    val upcoming: List<NextAction> = emptyList(),
    val waitingOn: List<NextAction> = emptyList(),
    val recentlyCompleted: List<NextAction> = emptyList(),
)

@Serializable
data class HomePayload(
    val generatedAt: String,
    val now: List<NextAction> = emptyList(),
    val later: LaterGroups = LaterGroups(),
    val glance: HouseholdGlance = HouseholdGlance(),
    val sources: List<SourceStatus> = emptyList(),
)

@Serializable
data class JarvisNotification(
    val id: String,
    val type: String = "",
    val category: String = "info",
    val severity: String = "normal",
    val title: String,
    val body: String = "",
    val createdAt: String,
    val updatedAt: String = createdAt,
    val readAt: String? = null,
    val dismissedAt: String? = null,
    val actedAt: String? = null,
    val occurrences: Int = 1,
    val deepLink: String = "/alerts",
    val source: String = "jarvis",
)

@Serializable
data class NotificationsResponse(val notifications: List<JarvisNotification> = emptyList(), val unread: Int = 0)

@Serializable
data class UnreadCount(val unread: Int = 0)

@Serializable
data class ApprovalRequest(
    val requestId: String? = null,
    val command: String? = null,
    val description: String? = null,
    val choices: List<String> = listOf("once", "deny"),
)

@Serializable
data class ActiveRun(val runId: String, val status: String, val pendingApproval: ApprovalRequest? = null)

@Serializable
data class SessionSummary(
    val id: String,
    val title: String = "Conversation",
    val preview: String? = null,
    val startedAt: String? = null,
    val lastActiveAt: String? = null,
    val messageCount: Int? = null,
    val parentSessionId: String? = null,
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val source: String? = null,
    val model: String? = null,
    val activeRun: ActiveRun? = null,
    /** visible read-only to the household */
    val shared: Boolean = false,
    /** someone else's shared conversation: read and fork only */
    val readOnly: Boolean = false,
) {
    /** "Claude" for Claude-direct conversations, otherwise Hermes. */
    val assistantName: String get() = if (source == "claude") "Claude" else "Hermes"
}

@Serializable
data class SessionsResponse(val sessions: List<SessionSummary> = emptyList(), val unavailable: List<String> = emptyList())

/** Transcript entry; `kind` is user | assistant | tool | system. */
@Serializable
data class TimelineItem(
    val kind: String,
    val id: String,
    val text: String? = null,
    val at: String? = null,
    val reasoning: String? = null,
    val tool: String? = null,
    val summary: String? = null,
    val detail: String? = null,
    val error: Boolean = false,
)

@Serializable
data class SessionDetail(
    val session: SessionSummary,
    val timeline: List<TimelineItem> = emptyList(),
    val parent: SessionSummary? = null,
    val children: List<SessionSummary> = emptyList(),
)

@Serializable
data class RunView(
    val runId: String,
    val sessionId: String,
    val status: String,
    val output: String? = null,
    val error: String? = null,
    val pendingSteer: String? = null,
    val pendingApproval: ApprovalRequest? = null,
)

@Serializable
data class ControlService(val service: String, val label: String, val wouldChange: Boolean = true)

@Serializable
data class ControlView(
    val entityId: String,
    val name: String,
    val domain: String,
    val state: String,
    val lastChanged: String? = null,
    val observedAt: String,
    val stateToken: String,
    val services: List<ControlService> = emptyList(),
)

@Serializable
data class ControlsResponse(val controls: List<ControlView> = emptyList(), val fetchedAt: String = "")

@Serializable
data class ControlResult(val verified: Boolean, val state: String = "", val message: String)

@Serializable
data class CompassState(
    val date: String,
    val completed: Boolean,
    val completedAt: String? = null,
    val inWindow: Boolean = false,
    val windowStart: String = "",
    val windowEnd: String = "",
    val sessionId: String? = null,
    val url: String? = null,
    val asOf: String? = null,
    val summary: String? = null,
)

@Serializable
data class DailyCompassResponse(val enabled: Boolean, val mode: String = "", val reminderTime: String = "", val state: CompassState? = null)

@Serializable
data class HomeHealth(
    val checkedAt: String,
    val entities: Int,
    val unavailable: Int,
    val unknown: Int,
    val updatesPending: Int? = null,
    val integrationsFailing: Int? = null,
    val failingDomains: List<String> = emptyList(),
)

@Serializable
data class SourceData(
    val actions: List<NextAction> = emptyList(),
    val events: List<CalendarEvent> = emptyList(),
    val compass: CompassState? = null,
    val homeExceptions: List<HomeException> = emptyList(),
    val extra: JsonObject? = null,
) {
    val health: HomeHealth?
        get() = extra?.get("health")?.let { runCatching { JarvisJson.decodeFromJsonElement(HomeHealth.serializer(), it) }.getOrNull() }
}

@Serializable
data class SourceResult(val status: SourceStatus, val data: SourceData? = null)

@Serializable
data class ContextPreview(val source: String, val text: String, val lines: Int = 0)

@Serializable
data class WidgetAction(
    val id: String,
    val source: String,
    val title: String,
    val detail: String? = null,
    val priorityReason: String = "upcoming",
    val dueAt: String? = null,
    val dueIsDate: Boolean = false,
    val primaryAction: PrimaryAction? = null,
    val secondaryActions: List<String> = emptyList(),
    val href: String = "",
)

@Serializable
data class WidgetEvent(val title: String, val startsAt: String, val endsAt: String? = null, val allDay: Boolean = false, val location: String? = null, val source: String = "")

@Serializable
data class WidgetHome(val exceptions: List<HomeException> = emptyList(), val critical: Int = 0)

@Serializable
data class WidgetSummary(
    val generatedAt: String,
    val unread: Int = 0,
    val next: List<WidgetAction> = emptyList(),
    val nextEvent: WidgetEvent? = null,
    val compass: GlanceCompass? = null,
    val home: WidgetHome = WidgetHome(),
    val degradedSources: List<String> = emptyList(),
)

@Serializable
data class HomeSection(val id: String, val visible: Boolean = true)

@Serializable
data class Layout(
    val homeSections: List<HomeSection> = DEFAULT_SECTIONS.map { HomeSection(it.first) },
    val dynamicColor: Boolean = true,
    val theme: String = "system",
    val density: String = "comfortable",
) {
    companion object {
        val DEFAULT_SECTIONS = listOf(
            "now" to "Now",
            "glance" to "Household glance",
            "later_today" to "Later today",
            "upcoming" to "Upcoming",
            "waiting" to "Waiting on",
            "completed" to "Recently completed",
        )

        fun labelFor(id: String) = DEFAULT_SECTIONS.firstOrNull { it.first == id }?.second ?: id
    }
}

@Serializable
data class Preferences(val displayName: String = "", val timezone: String = "UTC", val layout: Layout = Layout())

@Serializable
data class PushConfig(val projectId: String, val senderId: String, val applicationId: String, val apiKey: String)

@Serializable
data class DeviceInfo(val id: String, val name: String, val platform: String = "android", val appVersion: String? = null, val pushEnabled: Boolean = false)

@Serializable
data class UserName(val name: String = "")

@Serializable
data class DeviceMe(val device: DeviceInfo? = null, val user: UserName = UserName(), val push: PushConfig? = null)

@Serializable
data class PairResponse(val token: String, val deviceId: String, val user: UserName = UserName())

@Serializable
data class ActionResult(val ok: Boolean = true, val message: String = "Done")

@Serializable
data class OkResponse(val ok: Boolean = true, val unread: Int? = null)

@Serializable
data class ApiErrorBody(val error: String? = null, val code: String? = null)

/** Streaming run events (lib/hermes.ts RunEvent), decoded leniently by `type`. */
sealed interface RunEvent {
    val seq: Int?

    data class TextDelta(override val seq: Int?, val delta: String) : RunEvent
    data class ToolStarted(override val seq: Int?, val tool: String, val preview: String?) : RunEvent
    data class ToolCompleted(override val seq: Int?, val tool: String, val preview: String?, val error: Boolean, val durationSec: Double?) : RunEvent
    data class ApprovalRequested(override val seq: Int?, val request: ApprovalRequest) : RunEvent
    data class ApprovalResolved(override val seq: Int?, val choice: String?) : RunEvent
    data class Terminal(override val seq: Int?, val status: String, val output: String?, val error: String?) : RunEvent
    data class StreamClosed(val reason: String, val message: String?) : RunEvent {
        override val seq: Int? = null
    }
    data class Other(override val seq: Int?, val type: String, val text: String?) : RunEvent

    companion object {
        fun parse(data: String): RunEvent? {
            val o = runCatching { JarvisJson.parseToJsonElement(data) as? JsonObject }.getOrNull() ?: return null
            fun s(k: String) = o[k]?.let { runCatching { it.jsonPrimitive.contentOrNull }.getOrNull() }
            val seq = o["seq"]?.jsonPrimitive?.intOrNull
            return when (val type = s("type")) {
                "text.delta" -> TextDelta(seq, s("delta") ?: "")
                "tool.started" -> ToolStarted(seq, s("tool") ?: "tool", s("preview"))
                "tool.completed" -> ToolCompleted(seq, s("tool") ?: "tool", s("preview"), o["error"]?.jsonPrimitive?.booleanOrNull ?: false, o["durationSec"]?.jsonPrimitive?.doubleOrNull)
                "approval.requested" -> ApprovalRequested(
                    seq,
                    ApprovalRequest(
                        requestId = s("requestId"),
                        command = s("command"),
                        description = s("description"),
                        choices = o["choices"]?.let { c -> runCatching { c.jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull } }.getOrNull() } ?: listOf("once", "deny"),
                    ),
                )
                "approval.resolved" -> ApprovalResolved(seq, s("choice"))
                "run.terminal" -> Terminal(seq, s("status") ?: "completed", s("output"), s("error"))
                "stream.closed" -> StreamClosed(s("reason") ?: "error", s("message"))
                null -> null
                else -> Other(seq, type, s("text") ?: s("goal") ?: s("summary"))
            }
        }
    }
}

val TERMINAL_STATUSES = setOf("completed", "failed", "cancelled", "interrupted")

/** Sources the app can attach to a Hermes message ("Ask about …"); mirrors server/context.ts. */
enum class ContextSource(val id: String, val label: String) {
    Overview("overview", "Today"),
    Skylight("skylight", "Skylight"),
    HomeAssistant("home_assistant", "Home"),
    Todos("todos", "Todos"),
    DailyCompass("daily_compass", "Daily Compass"),
    Paperclip("paperclip", "Initiatives"),
    ;

    companion object {
        fun forSource(source: String) = entries.firstOrNull { it.id == source }
    }
}


/* ------------------------------------------------------------- people */

@Serializable
data class AuthUser(val id: String, val name: String, val username: String? = null, val role: String = "admin", val via: String = "device")

/** GET /api/auth/me: who this phone is signed in as and what they can use. */
@Serializable
data class AuthMe(
    val user: AuthUser,
    val capabilities: List<String> = emptyList(),
    val modules: List<String> = emptyList(),
    val authMode: String = "local",
    val onboarded: Boolean = true,
) {
    fun can(capability: String) = capability in capabilities
}

/* ------------------------------------------------------------- search */

@Serializable
data class SearchResult(val id: String, val kind: String, val module: String, val title: String, val subtitle: String? = null, val href: String)

@Serializable
data class SearchResponse(val query: String = "", val results: List<SearchResult> = emptyList(), val partial: List<String> = emptyList())

/* ------------------------------------------------------------ finance */

@Serializable
data class FinanceSetup(
    val accounts: Int = 0,
    val cushionSet: Boolean = false,
    val balanceSource: String = "manual",
    val monarchValidatedAt: String? = null,
    val releaseBlocker: Boolean = false,
)

@Serializable
data class FinanceCheckinSummary(
    val id: String,
    val month: String,
    val status: String,
    val blocking: Int = 0,
    val warnings: Int = 0,
    val open: Int = 0,
    val canClose: Boolean = false,
)

/** Integer cents. Net position = all accounts; Liquid cash = banks only. */
@Serializable
data class FinanceTotals(val net: Long, val liquid: Long, val reserve: Long? = null, val unrestricted: Long? = null, val inTransit: Long = 0)

@Serializable
data class FundSummary(val fundId: String, val name: String, val protected: Boolean = false, val held: Long = 0, val reserved: Long = 0, val available: Long = 0)

@Serializable
data class FinanceIssue(val code: String, val blocking: Boolean, val message: String, val ref: String? = null)

@Serializable
data class FinanceUpcoming(val id: String, val label: String, val date: String, val kind: String, val amount: Long? = null)

@Serializable
data class FinanceRun(val kind: String, val status: String, val outcome: String? = null, val at: String, val error: String? = null)

@Serializable
data class FinanceOverview(
    val month: String = "",
    /** ready | attention | failed | setup */
    val status: String,
    val statusText: String = "",
    val asOf: String? = null,
    val setup: FinanceSetup = FinanceSetup(),
    val checkin: FinanceCheckinSummary? = null,
    val totals: FinanceTotals? = null,
    val funds: List<FundSummary> = emptyList(),
    val upcoming: List<FinanceUpcoming> = emptyList(),
    val issues: List<FinanceIssue> = emptyList(),
    val lastRun: FinanceRun? = null,
)

@Serializable
data class FinanceRefreshResult(val runId: String = "", val outcome: String = "", val stored: Int = 0, val unmapped: Int = 0)

/* ------------------------------------------------------- home devices */

@Serializable
data class DeviceView(
    val entityId: String,
    val name: String,
    /** lock | garage | door | window | cover | light | camera */
    val kind: String,
    val state: String,
    val lastChanged: String? = null,
    val brightness: Int? = null,
    val stateToken: String = "",
    val services: List<ControlService> = emptyList(),
)

@Serializable
data class DevicesResponse(
    val fetchedAt: String = "",
    val lightControl: String = "all",
    val doors: List<DeviceView> = emptyList(),
    val lights: List<DeviceView> = emptyList(),
    val cameras: List<DeviceView> = emptyList(),
)

/* ---------------------------------------------------------- assistant */

@Serializable
data class AssistantBackendStatus(val id: String, val label: String, val available: Boolean, val reason: String? = null)

@Serializable
data class ClaudeStatus(val model: String = "", val effort: String = "", val keySet: Boolean = false, val keyFromEnv: Boolean = false)

/** Which AI new conversations can go to (Hermes, or Claude directly). */
@Serializable
data class AssistantStatus(
    val defaultBackend: String = "hermes",
    val backends: List<AssistantBackendStatus> = emptyList(),
    val claude: ClaudeStatus = ClaudeStatus(),
) {
    val available: List<AssistantBackendStatus> get() = backends.filter { it.available }
}
