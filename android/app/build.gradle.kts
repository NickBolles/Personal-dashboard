/**
 * Jarvis for Android: a native client for the Jarvis server. All logic
 * (integrations, ranking, readback) stays on the server; the app is screens,
 * a local cache, widgets and notifications. The server address comes from
 * pairing, so one APK works with any Jarvis.
 *
 *   ./gradlew assembleRelease            # APK
 *   ./gradlew testDebugUnitTest          # unit, UI and contract tests
 *   ./gradlew verifyRoborazziDebug       # screenshot comparison (record: recordRoborazziDebug)
 *
 * Signing: JARVIS_KEYSTORE, JARVIS_KEYSTORE_PASSWORD, JARVIS_KEY_ALIAS,
 * JARVIS_KEY_PASSWORD (release is unsigned otherwise).
 */
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.roborazzi)
}

android {
    namespace = "com.nickbolles.jarvis"
    // Current Compose/Navigation need the 37.2 SDK to compile; targetSdk (runtime behavior) stays 36.
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }

    defaultConfig {
        applicationId = "com.nickbolles.jarvis"
        minSdk = 29
        targetSdk = 36
        versionCode = ((findProperty("versionCode") as String?) ?: "1").toInt()
        versionName = (findProperty("versionName") as String?) ?: "1.0.0"
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
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (!keystore.isNullOrBlank()) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            all {
                // Contract tests parse the API fixtures the server tests record.
                it.systemProperty("jarvis.contracts", rootProject.file("../contracts/api").absolutePath)
                it.systemProperty("robolectric.pixelCopyRenderMode", "hardware")
                it.maxHeapSize = "3g"
                // Robolectric (SDK 36 shared memory) reaches into JDK internals on Java 21.
                it.jvmArgs("--add-opens=java.base/jdk.internal.access=ALL-UNNAMED", "--add-exports=java.base/jdk.internal.access=ALL-UNNAMED")
            }
        }
    }
}

roborazzi {
    outputDir.set(file("src/test/screenshots"))
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.glance.material3)
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidx.datastore.preferences)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.icons.extended)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.code.scanner)
    // The scanner pulls an old Fragment; ActivityResult APIs need a current one.
    implementation(libs.androidx.fragment)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.androidx.test.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(libs.roborazzi.junit.rule)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
