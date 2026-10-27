package com.nickbolles.jarvis.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp

/** A parsed Markdown block. Chat replies use a small, predictable subset (no HTML, no images). */
sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Paragraph(val text: String) : MdBlock
    /** `marker` is "•" or "3." etc.; `indent` counts nesting levels */
    data class ListItem(val marker: String, val text: String, val indent: Int, val checked: Boolean? = null) : MdBlock
    data class Quote(val text: String) : MdBlock
    data class Code(val text: String, val lang: String?) : MdBlock
    data class Table(val header: List<String>, val rows: List<List<String>>) : MdBlock
    data object Rule : MdBlock
}

object Markdown {
    private val heading = Regex("^(#{1,6})\\s+(.*?)\\s*#*\\s*$")
    private val bullet = Regex("^(\\s*)([-*+])\\s+(.*)$")
    private val ordered = Regex("^(\\s*)(\\d{1,4})[.)]\\s+(.*)$")
    private val task = Regex("^\\[([ xX])]\\s+(.*)$")
    private val rule = Regex("^\\s*([-*_])(\\s*\\1){2,}\\s*$")
    private val tableSep = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")

    fun parse(src: String): List<MdBlock> {
        val lines = src.replace("\r\n", "\n").split("\n")
        val out = ArrayList<MdBlock>()
        val para = ArrayList<String>()
        fun flush() {
            if (para.isNotEmpty()) out.add(MdBlock.Paragraph(para.joinToString("\n")))
            para.clear()
        }
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val t = line.trim()
            when {
                t.startsWith("```") || t.startsWith("~~~") -> {
                    flush()
                    val fence = t.take(3)
                    val lang = t.drop(3).trim().ifEmpty { null }
                    val body = ArrayList<String>()
                    i++
                    while (i < lines.size && !lines[i].trim().startsWith(fence)) body.add(lines[i++])
                    out.add(MdBlock.Code(body.joinToString("\n"), lang))
                }
                t.isEmpty() -> flush()
                heading.matches(t) -> {
                    flush()
                    val m = heading.find(t)!!
                    out.add(MdBlock.Heading(m.groupValues[1].length, m.groupValues[2]))
                }
                rule.matches(line) -> { flush(); out.add(MdBlock.Rule) }
                t.startsWith("|") && i + 1 < lines.size && tableSep.matches(lines[i + 1]) -> {
                    flush()
                    val header = cells(t)
                    i += 2
                    val rows = ArrayList<List<String>>()
                    while (i < lines.size && lines[i].trim().startsWith("|")) rows.add(cells(lines[i++].trim()))
                    out.add(MdBlock.Table(header, rows))
                    continue
                }
                bullet.matches(line) -> {
                    flush()
                    val m = bullet.find(line)!!
                    val body = m.groupValues[3]
                    val tm = task.find(body)
                    out.add(MdBlock.ListItem("•", tm?.groupValues?.get(2) ?: body, indentOf(m.groupValues[1]), tm?.let { it.groupValues[1] != " " }))
                }
                ordered.matches(line) -> {
                    flush()
                    val m = ordered.find(line)!!
                    out.add(MdBlock.ListItem("${m.groupValues[2]}.", m.groupValues[3], indentOf(m.groupValues[1])))
                }
                t.startsWith(">") -> {
                    flush()
                    val q = ArrayList<String>()
                    while (i < lines.size && lines[i].trim().startsWith(">")) q.add(lines[i++].trim().removePrefix(">").trimStart())
                    out.add(MdBlock.Quote(q.joinToString("\n")))
                    continue
                }
                // A continuation line under a list item belongs to it.
                line.startsWith("  ") && para.isEmpty() && out.lastOrNull() is MdBlock.ListItem -> {
                    val last = out.removeAt(out.size - 1) as MdBlock.ListItem
                    out.add(last.copy(text = last.text + "\n" + t))
                }
                else -> para.add(t)
            }
            i++
        }
        flush()
        return out
    }

    private fun indentOf(ws: String) = (ws.replace("\t", "    ").length / 2).coerceAtMost(4)

    private fun cells(row: String) = row.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

    private val inline = Regex(
        "(`[^`\\n]+`)" + // 1 code
            "|(\\*\\*(.+?)\\*\\*)" + // 2,3 bold
            "|(__(.+?)__)" + // 4,5 bold
            "|(~~(.+?)~~)" + // 6,7 strike
            "|(\\[([^\\]\\n]+)]\\(([^)\\s]+)\\))" + // 8,9,10 link
            "|((?<![\\w*])\\*(?![\\s*])(.+?)(?<![\\s*])\\*(?![\\w*]))" + // 11,12 italic
            "|((?<![\\w_])_(?![\\s_])(.+?)(?<![\\s_])_(?![\\w_]))" + // 13,14 italic
            "|(https?://[^\\s<>()]+[^\\s<>().,;:!?'\"])", // 15 bare url
    )

    /** Inline spans: **bold**, *italic*, `code`, ~~strike~~, [links](url) and bare URLs. */
    fun inline(text: String, codeBg: Color = Color(0x22888888), link: Color = Color(0xFF3B82F6)): AnnotatedString = buildAnnotatedString { appendInline(text, codeBg, link) }

    private fun AnnotatedString.Builder.appendInline(text: String, codeBg: Color, link: Color) {
        var at = 0
        for (m in inline.findAll(text)) {
            if (m.range.first > at) append(text.substring(at, m.range.first))
            val g = m.groups
            when {
                g[1] != null -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg)) { append(g[1]!!.value.trim('`')) }
                g[3] != null -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { appendInline(g[3]!!.value, codeBg, link) }
                g[5] != null -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { appendInline(g[5]!!.value, codeBg, link) }
                g[7] != null -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendInline(g[7]!!.value, codeBg, link) }
                g[9] != null -> {
                    val url = g[10]!!.value
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline)))) { appendInline(g[9]!!.value, codeBg, link) }
                    } else appendInline(g[9]!!.value, codeBg, link)
                }
                g[12] != null -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendInline(g[12]!!.value, codeBg, link) }
                g[14] != null -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendInline(g[14]!!.value, codeBg, link) }
                g[15] != null -> withLink(LinkAnnotation.Url(g[15]!!.value, TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline)))) { append(g[15]!!.value) }
            }
            at = m.range.last + 1
        }
        if (at < text.length) append(text.substring(at))
    }
}

/** Renders chat/summary Markdown with the app's type scale. Selection is up to the caller. */
@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier, style: TextStyle = MaterialTheme.typography.bodyLarge, color: Color = Color.Unspecified) {
    val blocks = remember(text) { Markdown.parse(text) }
    val scheme = MaterialTheme.colorScheme
    val codeBg = scheme.surfaceContainerHighest
    val linkColor = scheme.primary
    fun span(s: String) = Markdown.inline(s, codeBg, linkColor)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEach { b ->
            when (b) {
                is MdBlock.Heading -> Text(
                    span(b.text),
                    style = when (b.level) { 1 -> MaterialTheme.typography.titleLarge; 2 -> MaterialTheme.typography.titleMedium; else -> MaterialTheme.typography.titleSmall },
                    fontWeight = FontWeight.SemiBold,
                    color = color,
                    modifier = Modifier.padding(top = 4.dp),
                )
                is MdBlock.Paragraph -> Text(span(b.text), style = style, color = color)
                is MdBlock.ListItem -> Row(Modifier.padding(start = (b.indent * 16).dp)) {
                    val marker = when (b.checked) { true -> "☑"; false -> "☐"; null -> b.marker }
                    Text(marker, style = style, color = color, modifier = Modifier.widthIn(min = if (b.marker == "•") 16.dp else 24.dp).padding(end = 4.dp))
                    Text(span(b.text), style = style, color = color, textDecoration = if (b.checked == true) TextDecoration.LineThrough else null)
                }
                is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(scheme.outlineVariant))
                    Text(span(b.text), style = style, color = scheme.onSurfaceVariant, modifier = Modifier.padding(start = 10.dp))
                }
                is MdBlock.Code -> Surface(color = codeBg, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth()) {
                    Text(
                        b.text,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        color = color,
                        softWrap = false,
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(10.dp),
                    )
                }
                is MdBlock.Table -> Column(Modifier.horizontalScroll(rememberScrollState())) {
                    (listOf(b.header) + b.rows).forEachIndexed { r, cells ->
                        Row {
                            cells.forEach { c ->
                                Text(
                                    span(c),
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = if (r == 0) FontWeight.SemiBold else null,
                                    color = color,
                                    modifier = Modifier.widthIn(min = 72.dp, max = 220.dp).padding(horizontal = 6.dp, vertical = 4.dp),
                                )
                            }
                        }
                        if (r == 0) HorizontalDivider()
                    }
                }
                MdBlock.Rule -> HorizontalDivider(Modifier.padding(vertical = 4.dp))
            }
        }
    }
}
