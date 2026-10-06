package com.nickbolles.jarvis

import com.nickbolles.jarvis.data.JarvisJson
import java.io.File
import java.time.Instant
import kotlinx.serialization.KSerializer

/** Server-recorded API responses (contracts/api), shared with the server's contract checks. */
object Fixtures {
    val dir: File = File(System.getProperty("jarvis.contracts") ?: "../../contracts/api")

    fun text(name: String): String = File(dir, name).readText()

    fun <T> load(name: String, serializer: KSerializer<T>): T = JarvisJson.decodeFromString(serializer, text("$name.json"))

    /** "Now" for screenshots: when the fixtures were recorded, so relative times are stable. */
    val now: Instant by lazy {
        val raw = Regex("\"generatedAt\":\\s*\"([^\"]+)\"").find(text("home.json"))!!.groupValues[1]
        Instant.parse(raw)
    }
}
