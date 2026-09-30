/**
 * Trusted Web Activity wrapper for the Jarvis PWA. There is no app code:
 * Chrome renders Jarvis full-screen once /.well-known/assetlinks.json on
 * `jarvisHost` lists this package and signing key (JARVIS_TWA_ASSETLINKS).
 *
 *   ./gradlew assembleRelease -PjarvisHost=jarvis.example.com
 *
 * Signing: set JARVIS_KEYSTORE (path), JARVIS_KEYSTORE_PASSWORD,
 * JARVIS_KEY_ALIAS and JARVIS_KEY_PASSWORD, or the release APK is unsigned.
 */
plugins {
    id("com.android.application")
}

val host = (findProperty("jarvisHost") as String).removePrefix("https://").trimEnd('/')
val origin = "https://$host"
val appId = (findProperty("jarvisAppId") as String?) ?: "com.nickbolles.jarvis"

// Mirrors app/manifest.ts shortcuts and share_target.
val shortcuts = listOf(
    Triple("hermes", "Ask Hermes", "/chat?new=1"),
    Triple("alerts", "Alerts", "/alerts"),
    Triple("home", "Home controls", "/home-control"),
)
val shareTarget = """{"action":"$origin/share","method":"GET","params":{"title":"title","text":"text","url":"url"}}"""
val assetStatements = """[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"web","site":"$origin"}}]"""

android {
    namespace = "com.nickbolles.jarvis"
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        minSdk = 24
        targetSdk = 36
        versionCode = ((findProperty("versionCode") as String?) ?: "1").toInt()
        versionName = (findProperty("versionName") as String?) ?: "1.0"
        manifestPlaceholders["hostName"] = host
        manifestPlaceholders["launchUrl"] = "$origin/home?source=twa"
        manifestPlaceholders["providerAuthority"] = "$appId.fileprovider"
        // Android string resources drop unescaped double quotes.
        resValue("string", "assetStatements", assetStatements.replace("\"", "\\\""))
        resValue("string", "shareTarget", shareTarget.replace("\"", "\\\""))
    }

    val keystore = System.getenv("JARVIS_KEYSTORE")
    signingConfigs {
        if (!keystore.isNullOrBlank()) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("JARVIS_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("JARVIS_KEY_ALIAS")
                keyPassword = System.getenv("JARVIS_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (!keystore.isNullOrBlank()) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// App shortcuts need absolute URLs and the literal package name, so generate them.
abstract class GenerateShortcuts : DefaultTask() {
    @get:Input abstract val origin: Property<String>

    @get:Input abstract val appId: Property<String>

    /** "id|label|path" per shortcut */
    @get:Input abstract val shortcuts: ListProperty<String>

    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        val items = shortcuts.get().map { it.split("|") }
        val xml = outputDir.get().dir("xml").asFile.apply { mkdirs() }
        val entries = items.joinToString("\n") { (id, _, path) ->
            """
            |  <shortcut android:shortcutId="$id" android:enabled="true" android:icon="@mipmap/ic_launcher" android:shortcutShortLabel="@string/shortcut_$id">
            |    <intent android:action="android.intent.action.VIEW" android:targetPackage="${appId.get()}" android:targetClass="com.google.androidbrowserhelper.trusted.LauncherActivity" android:data="${origin.get()}$path" />
            |  </shortcut>""".trimMargin()
        }
        File(xml, "shortcuts.xml").writeText(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<shortcuts xmlns:android=\"http://schemas.android.com/apk/res/android\">\n$entries\n</shortcuts>\n",
        )
        val values = outputDir.get().dir("values").asFile.apply { mkdirs() }
        File(values, "shortcuts.xml").writeText(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<resources>\n" +
                items.joinToString("\n") { (id, label, _) -> "    <string name=\"shortcut_$id\">$label</string>" } +
                "\n</resources>\n",
        )
    }
}

val shortcutOrigin = origin
val shortcutAppId = appId
val shortcutSpecs = shortcuts.map { (id, label, path) -> "$id|$label|$path" }
val generateShortcuts = tasks.register<GenerateShortcuts>("generateShortcuts") {
    origin.set(shortcutOrigin)
    appId.set(shortcutAppId)
    shortcuts.set(shortcutSpecs)
}

androidComponents {
    onVariants { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(generateShortcuts, GenerateShortcuts::outputDir)
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.3")
}
