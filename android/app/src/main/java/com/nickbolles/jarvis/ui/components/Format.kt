package com.nickbolles.jarvis.ui.components

import androidx.compose.runtime.staticCompositionLocalOf
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/** The app's notion of "now"; screenshot tests pin it so relative times are stable. */
fun interface Clock {
    fun now(): Instant
}

val SystemClock = Clock { Instant.now() }
val LocalClock = staticCompositionLocalOf<Clock> { SystemClock }
val LocalZone = staticCompositionLocalOf<ZoneId> { ZoneId.systemDefault() }

val PRIORITY_LABELS = mapOf(
    "critical" to "Needs attention now",
    "awaiting_user" to "Waiting on you",
    "overdue" to "Overdue",
    "due_soon" to "Due soon",
    "checkin_window" to "Check-in open",
    "today" to "Today",
    "upcoming" to "Upcoming",
)

val SOURCE_LABELS = mapOf(
    "hermes" to "Hermes",
    "paperclip" to "Paperclip",
    "todos" to "Todos",
    "skylight" to "Skylight",
    "daily_compass" to "Daily Compass",
    "home_assistant" to "Home",
    "jarvis" to "Jarvis",
)

fun parseInstant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

private val TIME = DateTimeFormatter.ofPattern("h:mm a", Locale.US)
private val DAY = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US)

fun relativeTime(target: Instant, now: Instant): String {
    val d = Duration.between(now, target)
    val abs = d.abs()
    val past = d.isNegative
    fun fmt(n: Long, unit: String) = if (past) "$n $unit${if (n == 1L) "" else "s"} ago" else "in $n $unit${if (n == 1L) "" else "s"}"
    return when {
        abs.toMinutes() < 1 -> if (past) "just now" else "in a moment"
        abs.toHours() < 1 -> fmt(abs.toMinutes(), "min")
        abs.toDays() < 1 -> fmt(abs.toHours(), "hour")
        abs.toDays() == 1L -> if (past) "yesterday" else "tomorrow"
        else -> fmt(abs.toDays(), "day")
    }
}

fun formatDue(dueAt: String?, dueIsDate: Boolean, now: Instant, zone: ZoneId): String? {
    val d = parseInstant(dueAt) ?: return null
    if (dueIsDate) {
        val days = ChronoUnit.DAYS.between(now.atZone(zone).toLocalDate(), d.atZone(zone).toLocalDate())
        return when {
            days == 0L -> "Due today"
            days == -1L -> "Due yesterday"
            days == 1L -> "Due tomorrow"
            days < 0 -> "Due ${-days} days ago"
            else -> "Due ${DAY.format(d.atZone(zone))}"
        }
    }
    return "Due ${relativeTime(d, now)}"
}

fun formatClock(iso: String?, zone: ZoneId): String = parseInstant(iso)?.atZone(zone)?.let { TIME.format(it) } ?: ""

/** "Today · 5:30 PM", "Tomorrow · all day", "Thu, Oct 9 · 9:00 AM" */
fun formatWhen(startsAt: String, allDay: Boolean, now: Instant, zone: ZoneId): String {
    val today = now.atZone(zone).toLocalDate()
    val date: LocalDate
    val time: String?
    if (allDay) {
        date = runCatching { LocalDate.parse(startsAt.take(10)) }.getOrElse { today }
        time = null
    } else {
        val z = parseInstant(startsAt)?.atZone(zone) ?: return startsAt
        date = z.toLocalDate()
        time = TIME.format(z)
    }
    val day = when (date) {
        today -> "Today"
        today.plusDays(1) -> "Tomorrow"
        else -> DAY.format(date)
    }
    return if (time == null) "$day · all day" else "$day · $time"
}

fun greeting(now: Instant, zone: ZoneId): String = when (now.atZone(zone).hour) {
    in 0..11 -> "Good morning"
    in 12..17 -> "Good afternoon"
    else -> "Good evening"
}

fun longDate(now: Instant, zone: ZoneId): String = DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.US).format(now.atZone(zone))
