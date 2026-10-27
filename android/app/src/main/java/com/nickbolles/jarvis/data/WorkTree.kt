package com.nickbolles.jarvis.data

/** Pure Areas logic (mirrors lib/work.ts), kept free of Android so it is unit-tested on the JVM. */
object WorkTree {
    /**
     * Split quick-add text into path segments. Only a slash with spaces around it
     * separates levels, so titles like "CI/CD" stay whole. Max 6 levels.
     */
    fun parseQuickPath(text: String): List<String> =
        text.split(Regex("\\s/(?=\\s)")).map { it.replace(Regex("\\s+"), " ").trim() }.filter { it.isNotEmpty() }.take(6)

    /** Areas hold projects; everything else holds threads; the top level holds areas. */
    fun defaultChildKind(parent: WorkItem?): String = when {
        parent == null -> "area"
        parent.parentId == null || parent.kind == "area" -> "project"
        else -> "thread"
    }

    fun children(items: List<WorkItem>, parentId: String?, includeClosed: Boolean = true): List<WorkItem> =
        items.filter { it.parentId == parentId && !it.archived && (includeClosed || !it.isClosed) }.sortedWith(compareBy({ it.sortOrder }, { it.createdAt }))

    fun breadcrumb(items: List<WorkItem>, id: String): List<WorkItem> {
        val byId = items.associateBy { it.id }
        val out = ArrayList<WorkItem>()
        var p = byId[id]?.parentId?.let { byId[it] }
        while (p != null && out.size < 50) {
            out.add(0, p)
            p = p.parentId?.let { byId[it] }
        }
        return out
    }

    fun path(items: List<WorkItem>, id: String): String =
        (breadcrumb(items, id) + listOfNotNull(items.firstOrNull { it.id == id })).joinToString(" / ") { it.title }

    /** Everything under `rootId` (not including it). */
    fun descendants(items: List<WorkItem>, rootId: String): List<WorkItem> {
        val kids = items.filter { !it.archived && it.parentId != null }.groupBy { it.parentId!! }
        val out = ArrayList<WorkItem>()
        val seen = hashSetOf(rootId)
        val stack = ArrayDeque(kids[rootId].orEmpty())
        while (stack.isNotEmpty()) {
            val i = stack.removeFirst()
            if (!seen.add(i.id)) continue
            out.add(i)
            stack.addAll(kids[i.id].orEmpty())
        }
        return out
    }

    data class Rollup(val open: Int, val active: Int, val proofDue: Int, val done: Int, val conversations: Int)

    fun rollup(items: List<WorkItem>, rootId: String): Rollup {
        var open = 0; var active = 0; var proof = 0; var done = 0; var convs = 0
        for (i in descendants(items, rootId)) {
            if (i.isConversation) { convs++; continue }
            if (i.kind == "area" || i.kind == "project") continue
            if (i.isClosed) done++ else open++
            if (i.status == "in_progress" || i.status == "in_review") active++
            if (i.status == "awaiting_validation" || i.status == "ready_to_settle") proof++
        }
        return Rollup(open, active, proof, done, convs)
    }

    /** Open work with a next action under `rootId` (or everywhere), in-progress first, then soonest target date. */
    fun nextActions(items: List<WorkItem>, rootId: String? = null, limit: Int = 20): List<WorkItem> =
        (if (rootId == null) items.filter { !it.archived } else descendants(items, rootId))
            .filter { !it.isContainer && !it.isConversation && !it.isClosed && it.nextAction.isNotBlank() }
            .sortedWith(compareBy({ if (it.status == "in_progress") 0 else 1 }, { it.targetDate ?: "9999" }, { it.title.lowercase() }))
            .take(limit)

    data class Row(val item: WorkItem, val depth: Int, val hasChildren: Boolean, val expanded: Boolean)

    /**
     * The visible tree: rows in order with their depth. A filter shows every
     * match with its ancestors (expanded); otherwise only expanded nodes open.
     * `rootId` walks one item's subtree (depth 0 = its children); items keep their real parents.
     */
    fun rows(items: List<WorkItem>, expanded: Set<String>, filter: String = "", showClosed: Boolean = false, rootId: String? = null): List<Row> {
        // Closed work stays visible while it holds open work (its children aren't closed with it).
        val byIdAll = items.associateBy { it.id }
        val holdsOpen = hashSetOf<String>()
        if (!showClosed) for (i in items) if (!i.archived && !i.isClosed) {
            var p = i.parentId?.let { byIdAll[it] }
            while (p != null && holdsOpen.add(p.id)) p = p.parentId?.let { byIdAll[it] }
        }
        val live = items.filter { !it.archived && (showClosed || !it.isClosed || it.isContainer || it.id in holdsOpen) }
        val kids = live.groupBy { it.parentId }.mapValues { (_, v) -> v.sortedWith(compareBy({ it.sortOrder }, { it.createdAt })) }
        val q = filter.trim().lowercase()
        val keep: Set<String>? = if (q.isEmpty()) null else {
            val byId = live.associateBy { it.id }
            val s = hashSetOf<String>()
            live.filter { it.title.lowercase().contains(q) || it.nextAction.lowercase().contains(q) }.forEach { m ->
                var p: WorkItem? = m
                while (p != null && s.add(p.id)) p = p.parentId?.let { byId[it] }
            }
            s
        }
        val out = ArrayList<Row>()
        fun walk(parent: String?, depth: Int) {
            for (i in kids[parent].orEmpty()) {
                if (keep != null && i.id !in keep) continue
                val has = kids[i.id].orEmpty().any { keep == null || it.id in keep }
                val open = has && (keep != null || i.id in expanded)
                out.add(Row(i, depth, has, open))
                if (open && depth < 20) walk(i.id, depth + 1)
            }
        }
        walk(rootId, 0)
        return out
    }

    /** Notes and conversation nodes can't hold other items (the server refuses them as parents). */
    fun canHold(i: WorkItem) = !i.isConversation && i.kind != "note"

    /**
     * Where `item` may move: anything but itself, its descendants, notes,
     * conversation nodes and its current parent. Only areas may go to the top level (null).
     */
    fun moveTargets(items: List<WorkItem>, item: WorkItem): List<WorkItem> {
        val banned = descendants(items, item.id).map { it.id }.toHashSet() + item.id
        return rows(items, expanded = items.map { it.id }.toSet(), showClosed = true)
            .map { it.item }
            .filter { it.id !in banned && canHold(it) && it.id != item.parentId }
    }
}
